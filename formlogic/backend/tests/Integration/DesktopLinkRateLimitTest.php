<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Middleware\ApiKeyMiddleware;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\RateLimiter;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\App;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RouteCollectorProxy;

/**
 * The desktop link's budgets against the real limiter store: one flk_ key, the two /api/v1
 * groups built as public/index.php builds them (DesktopLinkRateLimitWiringTest pins that file
 * to these numbers), and requests driven through Slim.
 *
 *  - A calendar-sync burst that spends the data API's 120/min (per key, per address) is
 *    refused with Retry-After, and the relay lane on the same key and address still answers.
 *  - Lanes busier than the old shared 120/min leave record writes their whole budget.
 */
final class DesktopLinkRateLimitTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static ApiKeyService $keys;
    private static RateLimiter $limiter;
    private static App $slim;

    private string $userId = '';
    private string $key = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$keys = new ApiKeyService($conn);
        self::$limiter = new RateLimiter(self::$pdo);

        $keys = self::$keys;
        $limiter = self::$limiter;
        $ok = static function ($request, $response) {
            $response->getBody()->write('{"ok":true}');
            return $response->withHeader('Content-Type', 'application/json');
        };
        self::$slim = AppFactory::create();
        self::$slim->group('/api/v1', function (RouteCollectorProxy $group) use ($keys, $limiter, $ok) {
            $group->get('/forms/{formId}/responses', $ok)->add(new ApiKeyMiddleware($keys, ['responses:read'], $limiter));
            $group->put('/forms/{formId}/responses/{id}', $ok)->add(new ApiKeyMiddleware($keys, ['responses:manage'], $limiter));
        })->add(new RateLimitMiddleware($limiter, 120, 60, 'api_v1'));
        self::$slim->group('/api/v1', function (RouteCollectorProxy $group) use ($keys, $limiter, $ok) {
            $desktopLinkAuth = fn (array $scopes): ApiKeyMiddleware => new ApiKeyMiddleware($keys, $scopes, $limiter, 600, 60, 'desktop_link');
            $group->get('/connector-commands/pending', $ok)->add($desktopLinkAuth(['connector:relay']));
            $group->post('/desktop-connections', $ok)->add($desktopLinkAuth(['connector:relay']));
        })->add(new RateLimitMiddleware($limiter, 1200, 60, 'desktop_link'));
        self::$slim->addRoutingMiddleware();
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(14));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->key = self::$keys->createKey($this->userId, 'Desktop', ['connector:relay', 'responses:read', 'responses:manage'])['key'];

        // The budgets are fixed one-minute windows; a burst straddling a boundary would be
        // counted in two and never refused. Start it at the top of a fresh window instead.
        $left = self::$limiter->secondsUntilReset(60);
        if ($left < 15) {
            sleep($left + 1);
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM api_keys WHERE user_id = ?')->execute([$this->userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    /** A fresh documentation address, so no other run's counts are in this one's buckets. */
    private static function address(): string
    {
        return sprintf('2001:db8:%x:%x::%x', random_int(1, 0xffff), random_int(1, 0xffff), random_int(1, 0xffff));
    }

    private function send(string $method, string $path, string $address): ResponseInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest($method, 'http://formlogic.local' . $path, ['REMOTE_ADDR' => $address])
            ->withHeader('Authorization', 'Bearer ' . $this->key);
        return self::$slim->handle($request);
    }

    public function testASyncBurstDoesNotStallTheRelay(): void
    {
        $desk = self::address();
        for ($i = 1; $i <= 120; $i++) {
            $this->assertSame(200, $this->send('GET', '/api/v1/forms/f1/responses?updatedSince=2026-09-01', $desk)->getStatusCode(), "sync call {$i}");
        }

        $refused = $this->send('PUT', '/api/v1/forms/f1/responses/r1', $desk);
        $this->assertSame(429, $refused->getStatusCode(), 'the data API is still bounded');
        $this->assertGreaterThan(0, (int) $refused->getHeaderLine('Retry-After'));

        // The same key's own budget is spent too: from another address the refusal is the key's.
        $elsewhere = $this->send('PUT', '/api/v1/forms/f1/responses/r1', self::address());
        $this->assertSame(429, $elsewhere->getStatusCode());
        $this->assertGreaterThan(0, (int) $elsewhere->getHeaderLine('Retry-After'));
        $this->assertSame('rate_limited', json_decode((string) $elsewhere->getBody(), true)['code'] ?? null);
        $this->assertSame('120', $elsewhere->getHeaderLine('X-RateLimit-Limit'));

        // Same key, same address: the relay poll and the heartbeat still answer.
        $poll = $this->send('GET', '/api/v1/connector-commands/pending?wait=25000', $desk);
        $this->assertSame(200, $poll->getStatusCode());
        $this->assertSame('1200', $poll->getHeaderLine('X-RateLimit-Limit'), 'counted on the link budget');
        $this->assertSame(200, $this->send('POST', '/api/v1/desktop-connections', $desk)->getStatusCode());
    }

    public function testBusyLanesLeaveRecordWritesTheirBudget(): void
    {
        $desk = self::address();
        // More lane traffic than the whole shared budget used to allow.
        for ($i = 1; $i <= 150; $i++) {
            $this->assertSame(200, $this->send('GET', '/api/v1/connector-commands/pending?wait=1000', $desk)->getStatusCode(), "poll {$i}");
        }

        $write = $this->send('PUT', '/api/v1/forms/f1/responses/r1', $desk);
        $this->assertSame(200, $write->getStatusCode());
        $this->assertSame('120', $write->getHeaderLine('X-RateLimit-Limit'));
        $this->assertSame('119', $write->getHeaderLine('X-RateLimit-Remaining'), 'the polls took none of it');
    }
}
