<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\AuthService;
use FormLogic\Services\RateLimiter;
use FormLogic\Services\RateLimiterUnavailableException;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Audit RATE-001: a failing rate-limit store must not open an unlimited
 * brute-force window on high-risk actions. Login/password-reset (in-service
 * gates) and failClosed middleware refuse with retryable errors; low-risk
 * endpoints keep the fail-open behaviour; the store health is probeable.
 */
class RateLimitFailClosedTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static array $config = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    /** A MySQLConnection whose PDO fails every rate_limits statement. */
    private function failingConnection(): MySQLConnection
    {
        $proxy = new RateLimitFailingPdo(
            sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                self::$config['host'],
                self::$config['port'],
                self::$config['database']
            ),
            self::$config['username'],
            self::$config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
        return new class (self::$config, $proxy) extends MySQLConnection {
            private PDO $proxyPdo;
            public function __construct(array $config, PDO $proxy)
            {
                parent::__construct($config);
                $this->proxyPdo = $proxy;
            }
            public function getConnection(): PDO
            {
                return $this->proxyPdo;
            }
        };
    }

    private function authService(MySQLConnection $conn): AuthService
    {
        return new AuthService($conn, [
            'secret' => 'test-secret-key-for-rate-limit-test-0123456789',
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
            'expiry' => 3600,
        ]);
    }

    public function testHitReportsUnavailableAndHealthProbeFails(): void
    {
        $broken = new RateLimiter($this->failingConnection()->getConnection());
        $this->assertSame(RateLimiter::UNAVAILABLE, $broken->hit('any-key', 60));
        $this->assertFalse($broken->healthy());

        $working = new RateLimiter(self::$mysql->getConnection());
        $this->assertGreaterThan(0, $working->hit('health-test-' . bin2hex(random_bytes(4)), 60));
        $this->assertTrue($working->healthy());
    }

    public function testLoginFailsClosedWhenLimiterStoreIsDown(): void
    {
        $auth = $this->authService($this->failingConnection());
        $this->expectException(RateLimiterUnavailableException::class);
        $auth->login('nobody@test.local', 'irrelevant', '203.0.113.10');
    }

    public function testPasswordResetFailsClosedWhenLimiterStoreIsDown(): void
    {
        $auth = $this->authService($this->failingConnection());
        $this->expectException(RateLimiterUnavailableException::class);
        $auth->requestPasswordReset('nobody@test.local', 'https://example.test/reset');
    }

    public function testFailClosedMiddlewareRefusesAndFailOpenDegrades(): void
    {
        $broken = new RateLimiter($this->failingConnection()->getConnection());

        $closed = $this->dispatch(new RateLimitMiddleware($broken, 10, 60, 'high_risk_test', false, true));
        $this->assertSame(503, $closed['response']->getStatusCode(), 'high-risk endpoint refuses on limiter outage');
        $this->assertFalse($closed['handled'], 'the handler must never run behind a failed-closed gate');
        $body = json_decode((string) $closed['response']->getBody(), true);
        $this->assertTrue($body['retryable'] ?? false);

        $open = $this->dispatch(new RateLimitMiddleware($broken, 10, 60, 'low_risk_test', false, false));
        $this->assertSame(200, $open['response']->getStatusCode(), 'low-risk endpoint degrades open');
        $this->assertTrue($open['handled']);
    }

    /** @return array{response: ResponseInterface, handled: bool} */
    private function dispatch(RateLimitMiddleware $middleware): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local/api/test')
            ->withAttribute('ip_address', '203.0.113.99');
        $handled = false;
        $handler = new class($handled) implements RequestHandlerInterface {
            public function __construct(private bool &$handled)
            {
            }
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->handled = true;
                return (new SlimResponse())->withStatus(200);
            }
        };
        $response = $middleware->process($request, $handler);
        return ['response' => $response, 'handled' => $handled];
    }
}

/** PDO double failing every statement that touches the rate_limits table. */
class RateLimitFailingPdo extends PDO
{
    #[\ReturnTypeWillChange]
    public function prepare($query, $options = [])
    {
        if (str_contains($query, 'rate_limits')) {
            throw new \RuntimeException('injected rate_limits store failure');
        }
        return parent::prepare($query, $options);
    }
}
