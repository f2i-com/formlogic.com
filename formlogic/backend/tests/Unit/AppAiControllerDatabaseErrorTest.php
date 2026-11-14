<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppAiController;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * An owner's or the administrator's test that the database fails to queue is told as a test that
 * did not start. PDO's own message names the database's tables and server, so it is logged and
 * never shown; the reasons App AI gives for refusing a test are still said as they are.
 */
final class AppAiControllerDatabaseErrorTest extends TestCase
{
    private const DATABASE_SAYS = 'SQLSTATE[HY000] [2002] No connection could be made because the target machine actively refused it (db.internal:3306)';

    private string $results = '';
    private string $log = '';

    protected function setUp(): void
    {
        $this->results = sys_get_temp_dir() . '/app-ai-db-error-' . bin2hex(random_bytes(4));
        mkdir($this->results, 0700, true);
        // A worker that runs this code: the administrator's test is let start.
        file_put_contents($this->results . '/.alive', json_encode(['fingerprint' => 'code-1', 'mode' => 'watch']));
        $this->log = (string) tempnam(sys_get_temp_dir(), 'app-ai-db-error-log-');
        ini_set('error_log', $this->log);
    }

    protected function tearDown(): void
    {
        ini_restore('error_log');
        @unlink($this->log);
        @unlink($this->results . '/.alive');
        @rmdir($this->results);
    }

    private function controller(\Throwable $queueing): AppAiController
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'app-1', 'ownerId' => 'u-owner']);
        $ai = $this->createMock(AppAiService::class);
        $ai->method('queueTest')->willThrowException($queueing);
        $ai->method('queueSiteTest')->willThrowException($queueing);
        $site = new AppAiSiteSettings($this->results . '/settings.json');
        return new AppAiController($apps, $ai, $site, null, $this->results, null, static fn(): string => 'code-1');
    }

    private static function read(Response $response): array
    {
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    private static function post(): \Psr\Http\Message\ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', 'http://127.0.0.1/api')->withAttribute('userId', 'u-owner')->withParsedBody(['kind' => 'picture']);
    }

    public function testADatabaseFailureIsLoggedAndTheTestToldItDidNotStart(): void
    {
        $failing = $this->controller(new \PDOException(self::DATABASE_SAYS));
        foreach ([$failing->ownerTest(self::post(), new Response(), ['id' => 'app-1']), $failing->adminTest(self::post(), new Response())] as $response) {
            [$status, $body] = self::read($response);
            $this->assertSame([500, 'test_failed', 'The test could not be started. Try again in a moment.'], [$status, $body['code'], $body['message']]);
            $this->assertStringNotContainsString('SQLSTATE', json_encode($body));
        }
        $this->assertSame(2, substr_count((string) file_get_contents($this->log), 'db.internal:3306'), 'each logged for the administrator');
    }

    public function testAppAisOwnReasonsAreStillSaid(): void
    {
        [$status, $body] = self::read($this->controller(new \RuntimeException('A test is already running. Wait for it to finish.'))->ownerTest(self::post(), new Response(), ['id' => 'app-1']));
        $this->assertSame([409, 'ai_unavailable', 'A test is already running. Wait for it to finish.'], [$status, $body['code'], $body['message']]);
    }
}
