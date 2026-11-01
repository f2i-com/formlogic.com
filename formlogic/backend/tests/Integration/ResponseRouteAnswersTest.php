<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\NotStoredAfterScript;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScriptRejection;
use PDO;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * What the record routes answer when a request can't be taken as it is: answers of the wrong
 * shape, and a database that is busy or has failed. Run through the real controllers.
 */
final class ResponseRouteAnswersTest extends E2eeTestCase
{
    private const BUSY = 'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction';
    private const BROKEN = "SQLSTATE[42S22]: Column not found: 1054 Unknown column 'secret_column' in 'field list'";

    private function aForm(): string
    {
        return (string) self::$forms->createForm([
            'title' => 'Routes',
            'userId' => $this->userId,
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ])['id'];
    }

    private function aRecord(string $formId): string
    {
        return (string) self::$responses->createResponse($formId, ['answers' => ['name' => 'Ada']])['id'];
    }

    private function request(string $method, string $path, array $body): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, $path)
            ->withAttribute('userId', $this->userId)
            ->withAttribute('apiKeyScopes', ['responses:read', 'responses:manage'])
            ->withParsedBody($body);
    }

    private function external(?ResponseService $responses = null): ExternalApiController
    {
        return new ExternalApiController(self::$forms, $responses ?? self::$responses, self::$webhooks);
    }

    private function publicRoutes(?ResponseService $responses = null): ResponseController
    {
        return new ResponseController($responses ?? self::$responses, self::$forms, self::$sqlite, null, null, null, self::$apps, self::$mysql);
    }

    private function appRoutes(ResponseService $responses): AppPublicController
    {
        return new AppPublicController(
            self::$apps,
            new AppUserService(self::$mysql),
            new AppResponseService(self::$mysql, self::$sqlite, $responses, null, self::$forms),
            self::$forms,
            $responses,
            self::$mysql,
            self::$sqlite,
            new AppDomainService(self::$mysql)
        );
    }

    /** A ResponseService whose next inserts each fail with one of these, and then go through. */
    private function failing(string ...$errors): ResponseService
    {
        return new class ($errors, self::$mysql, self::$sqlite) extends ResponseService {
            public function __construct(private array $errors, MySQLConnection $mysql, SQLiteConnection $sqlite)
            {
                parent::__construct($mysql, $sqlite);
            }

            public function createResponse(string $formId, array $data, ?string $script = null, ?string $sourceRunId = null, ?int $quotaLimit = null): array|ScriptRejection
            {
                $error = array_shift($this->errors);
                if ($error !== null) {
                    throw new \PDOException($error);
                }
                return parent::createResponse($formId, $data, $script, $sourceRunId, $quotaLimit);
            }
        };
    }

    /** A ResponseService whose database refused the record once the form's script had run. */
    private function afterTheScript(): ResponseService
    {
        return new class (self::$mysql, self::$sqlite) extends ResponseService {
            public function createResponse(string $formId, array $data, ?string $script = null, ?string $sourceRunId = null, ?int $quotaLimit = null): array|ScriptRejection
            {
                throw new NotStoredAfterScript(new \PDOException('SQLSTATE[HY000]: General error: 5 database is locked'));
            }
        };
    }

    private function assertNotSentAgain(ResponseInterface $response): void
    {
        $this->assertSame(409, $response->getStatusCode(), (string) $response->getBody());
        $this->assertTrue($this->body($response)['conflict'], 'the offline queues stop on this and show it');
        $this->assertFalse($response->hasHeader('Retry-After'));
        $this->assertStringContainsString('already run', $this->body($response)['message']);
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
    }

    private function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true);
    }

    private function assertARetry(ResponseInterface $response): void
    {
        $this->assertSame(503, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('2', $response->getHeaderLine('Retry-After'));
        $this->assertTrue($this->body($response)['retryable']);
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
    }

    private function assertAPlainServerError(ResponseInterface $response): void
    {
        $this->assertSame(500, $response->getStatusCode(), (string) $response->getBody());
        $this->assertFalse($response->hasHeader('Retry-After'));
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
    }

    // ── answers that aren't an object ─────────────────────────────────────────

    /** @return array<string, array{0: mixed}> */
    public static function notAnObject(): array
    {
        return ['text' => ['oops'], 'a number' => [12], 'zero' => [0], 'false' => [false], 'true' => [true], 'a list' => [['a', 'b']]];
    }

    /** @dataProvider notAnObject */
    public function testTheOwnersRouteRefusesAnswersThatAreNotAnObject(mixed $answers): void
    {
        $formId = $this->aForm();
        $id = $this->aRecord($formId);

        $response = $this->publicRoutes()->update($this->request('PUT', "/api/forms/{$formId}/responses/{$id}", ['answers' => $answers]), new SlimResponse(), ['formId' => $formId, 'id' => $id]);

        $this->assertSame(422, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('Answers must be an object', $this->body($response)['message']);
        $this->assertSame(['name' => 'Ada'], self::$responses->getResponse($formId, $id)['answers']);
    }

    /** @dataProvider notAnObject */
    public function testTheExternalRouteRefusesAnswersThatAreNotAnObject(mixed $answers): void
    {
        $formId = $this->aForm();
        $id = $this->aRecord($formId);

        $response = $this->external()->updateResponse($this->request('PUT', "/api/v1/forms/{$formId}/responses/{$id}", ['answers' => $answers]), new SlimResponse(), ['formId' => $formId, 'id' => $id]);

        $this->assertSame(422, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('Answers must be an object', $this->body($response)['message']);
        $this->assertSame(['name' => 'Ada'], self::$responses->getResponse($formId, $id)['answers']);
    }

    /** @dataProvider notAnObject */
    public function testNoRouteCanStoreThem(mixed $answers): void
    {
        $formId = $this->aForm();
        $id = $this->aRecord($formId);

        try {
            self::$responses->updateResponse($formId, $id, ['answers' => $answers]);
            $this->fail('They went in as the record');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('Answers must be an object', $e->getMessage());
        }
        $this->assertSame(['name' => 'Ada'], self::$responses->getResponse($formId, $id)['answers']);
    }

    public function testAnObjectAndAStatusAloneStillGoThrough(): void
    {
        $formId = $this->aForm();
        $id = $this->aRecord($formId);

        $edited = $this->publicRoutes()->update($this->request('PUT', '/x', ['answers' => ['name' => 'Grace']]), new SlimResponse(), ['formId' => $formId, 'id' => $id]);
        $this->assertSame(200, $edited->getStatusCode(), (string) $edited->getBody());
        $this->assertSame(['name' => 'Grace'], self::$responses->getResponse($formId, $id)['answers']);

        $status = $this->external()->updateResponse($this->request('PUT', '/x', ['status' => 'reviewed']), new SlimResponse(), ['formId' => $formId, 'id' => $id]);
        $this->assertSame(200, $status->getStatusCode(), (string) $status->getBody());
        $this->assertSame(['name' => 'Grace'], self::$responses->getResponse($formId, $id)['answers']);
    }

    // ── a busy database on the submit routes ──────────────────────────────────

    public function testAPublicSubmissionMeetingAReallyLockedDatabaseIsToldToRetryAndItsKeyIsFree(): void
    {
        $formId = $this->aForm();
        // Its own connection is the one the route uses, and a test needn't wait five seconds.
        self::$sqlite->getFormDatabase($formId)->exec('PRAGMA busy_timeout = 50');
        $holder = new PDO('sqlite:' . self::$sqlite->getFormDbPath($formId), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $holder->exec('BEGIN IMMEDIATE');
        $routes = $this->publicRoutes();
        $submit = fn () => $routes->create($this->request('POST', '/x', ['answers' => ['name' => 'Ada'], 'idempotencyKey' => 'one-try']), new SlimResponse(), ['formId' => $formId]);

        $busy = $submit();
        $holder->exec('ROLLBACK');

        $this->assertARetry($busy);
        $this->assertSame(201, $submit()->getStatusCode(), 'the same key, which the busy answer gave back');
        $this->assertSame(1, self::$responses->getResponseCount($formId));
    }

    public function testThePublicRouteSaysNotToSendAgainOnceAScriptHasRun(): void
    {
        $formId = $this->aForm();

        $this->assertNotSentAgain($this->publicRoutes($this->afterTheScript())->create($this->request('POST', '/x', ['answers' => ['name' => 'Ada']]), new SlimResponse(), ['formId' => $formId]));
    }

    public function testTheAppRouteSaysNotToSendAgainOnceAScriptHasRun(): void
    {
        $formId = $this->aForm();
        $app = self::$apps->createApp(['name' => 'Routes', 'status' => 'published', 'formIds' => [$formId]], $this->userId);

        $this->assertNotSentAgain($this->appRoutes($this->afterTheScript())->createResponse($this->request('POST', '/x', ['answers' => ['name' => 'Ada']]), new SlimResponse(), ['slug' => $app['slug'], 'formId' => $formId]));
    }

    public function testAnotherDatabaseErrorOnThePublicRouteIsNotARetry(): void
    {
        $formId = $this->aForm();

        $this->assertAPlainServerError($this->publicRoutes($this->failing(self::BROKEN))->create($this->request('POST', '/x', ['answers' => ['name' => 'Ada']]), new SlimResponse(), ['formId' => $formId]));
    }

    public function testAnAppSubmissionToABusyDatabaseIsToldToRetryAndItsKeyIsFree(): void
    {
        $formId = $this->aForm();
        $app = self::$apps->createApp(['name' => 'Routes', 'status' => 'published', 'formIds' => [$formId]], $this->userId);
        $routes = $this->appRoutes($this->failing(self::BUSY));
        $submit = fn () => $routes->createResponse($this->request('POST', '/x', ['answers' => ['name' => 'Ada'], 'idempotencyKey' => 'one-try']), new SlimResponse(), ['slug' => $app['slug'], 'formId' => $formId]);

        $this->assertARetry($submit());
        $this->assertSame(201, $submit()->getStatusCode(), 'the same key, which the busy answer gave back');
    }

    public function testAnotherDatabaseErrorOnTheAppRouteIsNotARetry(): void
    {
        $formId = $this->aForm();
        $app = self::$apps->createApp(['name' => 'Routes', 'status' => 'published', 'formIds' => [$formId]], $this->userId);

        $this->assertAPlainServerError($this->appRoutes($this->failing(self::BROKEN))->createResponse($this->request('POST', '/x', ['answers' => ['name' => 'Ada']]), new SlimResponse(), ['slug' => $app['slug'], 'formId' => $formId]));
    }

    // ── what a batch's 200 carries ────────────────────────────────────────────

    public function testABatchSaysWhatFailedWithNoSqlAndMarksWhatToRetry(): void
    {
        $formId = $this->aForm();
        $request = $this->request('POST', '/x', ['responses' => [['answers' => ['name' => 'a']], ['answers' => ['name' => 'b']], ['answers' => ['name' => 'c']]]]);

        $answer = $this->external($this->failing(self::BUSY, self::BROKEN))->batchSubmitResponses($request, new SlimResponse(), ['formId' => $formId]);

        $this->assertSame(200, $answer->getStatusCode());
        $this->assertStringNotContainsString('SQLSTATE', (string) $answer->getBody());
        $this->assertStringNotContainsString('secret_column', (string) $answer->getBody());
        $body = $this->body($answer);
        $this->assertSame(1, $body['succeeded']);
        $this->assertFalse($body['results'][0]['success']);
        $this->assertTrue($body['results'][0]['retryable'], 'the item that met a busy database can go again');
        $this->assertFalse($body['results'][1]['success']);
        $this->assertArrayNotHasKey('retryable', $body['results'][1]);
        $this->assertNotSame('', (string) $body['results'][1]['message']);
        $this->assertTrue($body['results'][2]['success']);
    }
}
