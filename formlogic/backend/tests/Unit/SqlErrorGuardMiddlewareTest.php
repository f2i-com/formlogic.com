<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CorsMiddleware;
use FormLogic\Middleware\SqlErrorGuardMiddleware;
use FormLogic\Support\SqlErrorText;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\AbstractLogger;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Runs the guard the way the site does: outermost on a real Slim app, around a route shaped like
 * the catch blocks it is there for, which answer a RuntimeException with its message as a 400.
 */
final class SqlErrorGuardMiddlewareTest extends TestCase
{
    private AbstractLogger $logger;

    protected function setUp(): void
    {
        $this->logger = new class () extends AbstractLogger {
            /** @var list<array{message: string, context: array<string, mixed>}> */
            public array $records = [];

            public function log($level, \Stringable|string $message, array $context = []): void
            {
                $this->records[] = ['message' => (string) $message, 'context' => $context];
            }
        };
    }

    /** @param callable(): Response $route */
    private function send(string $path, callable $route): Response
    {
        $app = AppFactory::create();
        $app->any($path, static fn (Request $request, Response $response) => $route($response));
        // Inside the guard, as CORS is on the site: its header has to survive.
        $app->add(static fn (Request $request, $handler) => $handler->handle($request)->withHeader('Access-Control-Allow-Origin', 'https://a.example'));
        $app->add(new SqlErrorGuardMiddleware($this->logger));
        return $app->handle((new ServerRequestFactory())->createServerRequest('POST', $path));
    }

    private static function json(Response $response, array $body, int $status): Response
    {
        $response->getBody()->write((string) json_encode($body));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }

    /** The shape of about a hundred catch blocks. */
    private static function answerAsValidation(Response $response, callable $work): Response
    {
        try {
            $work();
            return self::json($response, ['ok' => true], 200);
        } catch (\RuntimeException $e) {
            return self::json($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function testALockedDatabaseSaysToTryAgain(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'fl-guard-');
        $holder = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $holder->exec('CREATE TABLE t (id INTEGER)');
        $holder->exec('BEGIN IMMEDIATE');
        $writer = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $writer->exec('PRAGMA busy_timeout = 0');

        $answer = $this->send('/api/forms/f1', static fn (Response $response) => self::answerAsValidation($response, static function () use ($writer): void {
            $writer->exec('INSERT INTO t VALUES (1)');
        }));

        $holder->exec('ROLLBACK');
        $holder = $writer = null;
        @unlink($path);
        self::assertSame(503, $answer->getStatusCode());
        self::assertSame('2', $answer->getHeaderLine('Retry-After'));
        $body = (string) $answer->getBody();
        self::assertStringNotContainsString('SQLSTATE', $body);
        self::assertStringContainsString('try again', $body);
        self::assertSame('https://a.example', $answer->getHeaderLine('Access-Control-Allow-Origin'));
        self::assertStringContainsString('database is locked', (string) $this->logger->records[0]['context']['message'], 'the original is logged');
    }

    public function testADeadlockAndALockWaitSayToTryAgain(): void
    {
        foreach ([
            'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction',
            'SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded; try restarting transaction',
            'SQLSTATE[HY000]: General error: 6 database table is locked',
        ] as $message) {
            $answer = $this->send('/api/forms', static fn (Response $response) => self::json($response, ['error' => true, 'message' => $message], 400));
            self::assertSame(503, $answer->getStatusCode(), $message);
            self::assertSame('2', $answer->getHeaderLine('Retry-After'));
        }
    }

    public function testAnyOtherSqlErrorIsAPlainServerError(): void
    {
        $sql = "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'database is locked' for key 'apps.slug'";
        $answer = $this->send('/api/apps', static fn (Response $response) => self::json($response, ['error' => true, 'message' => $sql], 400));

        self::assertSame(500, $answer->getStatusCode());
        self::assertFalse($answer->hasHeader('Retry-After'));
        self::assertSame(['error' => true, 'message' => 'An unexpected error occurred'], json_decode((string) $answer->getBody(), true));
        self::assertCount(1, $this->logger->records);
    }

    public function testAnAppsOwnWordsOnItsOwnRoutesStayAsTheyAre(): void
    {
        $words = 'SQLSTATE[HY000] is what my tutorial is about';
        foreach (['/api/app/shop/actions/ask', '/api/app/shop/native/request', '/api/app/shop/native'] as $path) {
            $answer = $this->send($path, static fn (Response $response) => self::json($response, ['error' => true, 'message' => $words], 422));
            self::assertSame(422, $answer->getStatusCode(), $path);
            self::assertSame($words, json_decode((string) $answer->getBody(), true)['message']);
        }
        self::assertSame([], $this->logger->records);
    }

    public function testTheAppRecordRoutesAreStillGuarded(): void
    {
        $sql = 'SQLSTATE[42S22]: Column not found: 1054 Unknown column';
        $answer = $this->send('/api/app/shop/forms/f1/responses/r1', static fn (Response $response) => self::json($response, ['error' => true, 'message' => $sql], 400));
        self::assertSame(500, $answer->getStatusCode());
    }

    public function testASuccessOrAnErrorWithNoSqlPassesUntouched(): void
    {
        $ok = $this->send('/api/forms', static fn (Response $response) => self::json($response, ['note' => 'SQLSTATE[ is a word here'], 200));
        self::assertSame(200, $ok->getStatusCode());
        self::assertStringContainsString('SQLSTATE[', (string) $ok->getBody());

        $refused = $this->send('/api/forms', static fn (Response $response) => self::json($response, ['error' => true, 'message' => 'Title is required'], 400));
        self::assertSame(400, $refused->getStatusCode());
        self::assertStringContainsString('Title is required', (string) $refused->getBody());
        self::assertSame([], $this->logger->records);
    }

    public function testARecordHoldingTheWordsIsNotADatabaseError(): void
    {
        $record = ['error' => true, 'code' => 'version_conflict', 'message' => 'The record has changed since it was read; nothing was written.',
            'response' => ['answers' => ['note' => 'SQLSTATE[HY000]: General error: 5 database is locked']]];

        $answer = $this->send('/api/v1/forms/f1/responses/r1', static fn (Response $response) => self::json($response, $record, 412));

        self::assertSame(412, $answer->getStatusCode());
        self::assertSame($record, json_decode((string) $answer->getBody(), true));
        self::assertSame([], $this->logger->records, 'and none of it goes into a log');
    }

    public function testAMessageThatMerelyMentionsItIsReadOnlyAtTheTop(): void
    {
        foreach ([['error' => ['message' => 'SQLSTATE[42S22]: nested']], ['errors' => ['name' => 'SQLSTATE[42S22]: a field']]] as $body) {
            $answer = $this->send('/api/forms', static fn (Response $response) => self::json($response, $body, 400));
            self::assertSame(400, $answer->getStatusCode(), json_encode($body));
        }
        self::assertSame([], $this->logger->records);
    }

    public function testAnErrorFieldHoldingSqlIsCaught(): void
    {
        $answer = $this->send('/api/forms', static fn (Response $response) => self::json($response, ['error' => 'SQLSTATE[42S22]: Column not found: 1054 Unknown column'], 400));

        self::assertSame(500, $answer->getStatusCode());
        self::assertStringNotContainsString('SQLSTATE', (string) $answer->getBody());
    }

    public function testATextAnswerHoldingTheWordsPassesUntouched(): void
    {
        $answer = $this->send('/api/forms', static function (Response $response): Response {
            $response->getBody()->write('SQLSTATE[HY000] is what my tutorial is about');
            return $response->withStatus(400)->withHeader('Content-Type', 'text/plain');
        });

        self::assertSame(400, $answer->getStatusCode());
        self::assertSame('SQLSTATE[HY000] is what my tutorial is about', (string) $answer->getBody());
    }

    public function testOnlyTheMessageIsLogged(): void
    {
        $sql = 'SQLSTATE[42S22]: Column not found: 1054 Unknown column';
        $this->send('/api/forms', static fn (Response $response) => self::json($response, ['error' => true, 'message' => $sql, 'answers' => ['card' => '4242 4242']], 400));

        self::assertCount(1, $this->logger->records);
        self::assertSame($sql, $this->logger->records[0]['context']['message']);
        self::assertStringNotContainsString('4242', (string) json_encode($this->logger->records));
    }

    /** A database error thrown from middleware that sits outside Slim's error handler. */
    private function sendThrough(\Throwable $thrown): Response
    {
        $app = AppFactory::create();
        $app->any('/api/forms', static fn (Request $request, Response $response) => $response);
        $app->add(static function (Request $request, $handler) use ($thrown): Response {
            throw $thrown;
        });
        $app->add(new SqlErrorGuardMiddleware($this->logger));
        return $app->handle((new ServerRequestFactory())->createServerRequest('POST', '/api/forms'));
    }

    public function testABusyDatabaseThrownThroughItSaysToTryAgain(): void
    {
        $answer = $this->sendThrough(new \PDOException('SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded; try restarting transaction'));

        self::assertSame(503, $answer->getStatusCode());
        self::assertSame('2', $answer->getHeaderLine('Retry-After'));
        self::assertStringNotContainsString('SQLSTATE', (string) $answer->getBody());
        self::assertSame('application/json', $answer->getHeaderLine('Content-Type'));
        self::assertStringContainsString('1205', (string) $this->logger->records[0]['context']['message']);
    }

    public function testAnyOtherDatabaseErrorThrownThroughItIsAPlainServerError(): void
    {
        $answer = $this->sendThrough(new \PDOException('SQLSTATE[42S22]: Column not found: 1054 Unknown column'));

        self::assertSame(500, $answer->getStatusCode());
        self::assertSame(['error' => true, 'message' => 'An unexpected error occurred'], json_decode((string) $answer->getBody(), true));
    }

    public function testAnAnswerMadeOutsideCorsStillCarriesItsHeaders(): void
    {
        CorsMiddleware::setActive(new CorsMiddleware('https://a.example'));
        try {
            $app = AppFactory::create();
            $app->any('/api/forms', static fn (Request $request, Response $response) => $response);
            $app->add(static function (Request $request, $handler): Response {
                throw new \PDOException('SQLSTATE[42S22]: Column not found');
            });
            $app->add(new SqlErrorGuardMiddleware($this->logger));
            $answer = $app->handle((new ServerRequestFactory())->createServerRequest('POST', '/api/forms')->withHeader('Origin', 'https://a.example'));
        } finally {
            CorsMiddleware::setActive(null);
        }

        self::assertSame('https://a.example', $answer->getHeaderLine('Access-Control-Allow-Origin'), 'or the browser can\'t read it');
    }

    public function testSomethingElseThrownThroughItIsNotItsToAnswer(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('not a database');
        $this->sendThrough(new \RuntimeException('not a database'));
    }

    public function testAnErrorTooBigToBeOneIsNotRead(): void
    {
        $large = str_repeat('x', 1048577) . 'SQLSTATE[HY000]';
        $answer = $this->send('/api/forms', static function (Response $response) use ($large): Response {
            $response->getBody()->write($large);
            return $response->withStatus(400);
        });
        self::assertSame(400, $answer->getStatusCode());
    }

    public function testBusyMeansBusyAndNotAWordInSomethingElse(): void
    {
        self::assertTrue(SqlErrorText::isBusy('SQLSTATE[HY000]: General error: 5 database is locked'));
        self::assertFalse(SqlErrorText::isBusy('database is locked'));
        self::assertFalse(SqlErrorText::isBusy("SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry '5 ' for key 'x'"));
        self::assertFalse(SqlErrorText::isBusy('SQLSTATE[HY000]: General error: 1 no such table: t'));
    }

    public function testALostConnectionIsToldFromABusyOne(): void
    {
        foreach ([
            'SQLSTATE[HY000]: General error: 2006 MySQL server has gone away',
            'SQLSTATE[HY000]: General error: 2013 Lost connection to MySQL server during query',
            'SQLSTATE[HY000] [2002] Connection refused',
            'SQLSTATE[08S01]: Communication link failure: 1053 Server shutdown in progress',
            'SQLSTATE[HY000]: General error: 4031 The client was disconnected by the server because of inactivity',
        ] as $lost) {
            self::assertTrue(SqlErrorText::isConnectionLost($lost), $lost);
            self::assertFalse(SqlErrorText::isBusy($lost), $lost);
        }
        foreach ([
            'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction',
            'SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded; try restarting transaction',
            "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry '2006 ' for key 'x'",
            'SQLSTATE[42S02]: Base table or view not found: 1146 Table gone',
            '2006 MySQL server has gone away',
        ] as $notLost) {
            self::assertFalse(SqlErrorText::isConnectionLost($notLost), $notLost);
        }
    }

    public function testTheGuardIsTheOutermostMiddlewareOnTheSite(): void
    {
        $source = (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $global = [];
        preg_match_all('/^\$app->add\((.{0,60})/m', $source, $global);
        self::assertNotEmpty($global[1]);
        self::assertStringContainsString('SqlErrorGuardMiddleware', (string) end($global[1]), 'added last means it runs outermost');
    }
}
