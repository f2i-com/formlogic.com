<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppDomainController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Who may connect which name. A domain that verifies takes sign-ins with it, so the checks in front
 * of it are as sensitive as the sign-in. Skipped without a test database.
 */
class AppDomainClaimTest extends TestCase
{
    private const PLATFORM = 'https://forms.formlogic-claim.com';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppDomainController $ctrl;
    private static AppDomainService $domains;
    private static string $root = '';

    private string $ownerId = '';
    private string $appId = '';
    /** @var array<string, string|null> */
    private array $saved = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$root = sys_get_temp_dir() . '/formlogic-domain-claim-' . bin2hex(random_bytes(4));
        mkdir(self::$root, 0777, true);
        self::$domains = new AppDomainService($conn);
        self::$ctrl = new AppDomainController(self::$domains, new AppService($conn, new FormService($conn, new SQLiteConnection(self::$root))));
    }

    public static function tearDownAfterClass(): void
    {
        foreach (glob(self::$root . '/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir(self::$root);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        foreach (['APP_URL', 'CORS_ORIGIN', 'APP_ENV'] as $key) {
            $this->saved[$key] = $_ENV[$key] ?? null;
        }
        $this->setEnv('APP_URL', self::PLATFORM);
        $this->setEnv('CORS_ORIGIN', 'https://www.formlogic-claim.com');
        $this->setEnv('APP_ENV', 'development');

        $this->ownerId = 'u' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$this->ownerId, $this->ownerId . '@formlogic.test']);
        $this->appId = 'app' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', '{}')")
            ->execute([$this->appId, $this->ownerId, 'claim' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        foreach ($this->saved as $key => $value) {
            $this->setEnv($key, $value);
        }
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM app_domains WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    private function setEnv(string $key, ?string $value): void
    {
        if ($value === null) {
            unset($_ENV[$key]);
            putenv($key);
            return;
        }
        $_ENV[$key] = $value;
        putenv("$key=$value");
    }

    private function create(string $domain): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api')
            ->withAttribute('userId', $this->ownerId)
            ->withParsedBody(['domain' => $domain, 'mode' => 'runtime_direct']);
        $response = self::$ctrl->create($request, new Response(), ['id' => $this->appId]);
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    private function verify(string $domainId): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api')
            ->withAttribute('userId', $this->ownerId);
        $response = self::$ctrl->verify($request, new Response(), ['id' => $this->appId, 'domainId' => $domainId]);
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    private function freshName(): string
    {
        return 'claim-' . bin2hex(random_bytes(5)) . '.formlogic-claim-tests.com';
    }

    public function testThisSitesOwnNamesCannotBeConnected(): void
    {
        foreach (['forms.formlogic-claim.com', 'FORMS.formlogic-claim.com.', 'https://forms.formlogic-claim.com/login', 'www.formlogic-claim.com'] as $name) {
            [$status, $body] = $this->create($name);
            $this->assertSame(400, $status, $name);
            $this->assertStringContainsString('not allowed', $body['message']);
        }
        $this->assertSame(201, $this->create($this->freshName())[0]);
    }

    public function testADomainWaitsForAppUrl(): void
    {
        $name = $this->freshName();
        [, $created] = $this->create($name);
        $this->setEnv('APP_URL', null);
        [$status, $body] = $this->create($this->freshName());
        $this->assertSame(409, $status);
        $this->assertStringContainsString('APP_URL', $body['message']);
        $this->assertSame(409, $this->verify($created['domain']['id'])[0]);
        $this->assertSame('pending', self::$domains->getDomain($created['domain']['id'], $this->ownerId)['status']);
    }

    public function testOnlyDevelopmentSkipsTheDnsProof(): void
    {
        foreach (['staging', 'prod', 'live', 'production', ''] as $env) {
            $this->setEnv('APP_ENV', $env === '' ? null : $env);
            [, $created] = $this->create($this->freshName());
            [, $body] = $this->verify($created['domain']['id']);
            $this->assertFalse($body['ok'], "APP_ENV=$env");
            $this->assertSame('failed', $body['status'], "APP_ENV=$env");
        }
        $this->setEnv('APP_ENV', 'development');
        [, $created] = $this->create($this->freshName());
        $this->assertTrue($this->verify($created['domain']['id'])[1]['ok']);
    }
}
