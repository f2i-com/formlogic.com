<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppDomainController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Middleware\CsrfMiddleware;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Support\Environment;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
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
        foreach (['APP_URL', 'CORS_ORIGIN', 'CORS_ALLOWED_ORIGINS', 'APP_ENV'] as $key) {
            $this->saved[$key] = Environment::get($key);
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
        unset($_ENV[$key], $_SERVER[$key]);
        putenv($key);
        if ($value !== null) {
            $_ENV[$key] = $value;
        }
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

    /** What a v0.1.17 site could hold: a row for its own name, made before createDomain refused it. */
    private function ownNameRow(string $name, string $status, bool $proven): string
    {
        $id = bin2hex(random_bytes(16));
        self::$pdo->prepare('INSERT INTO app_domains (id, app_id, owner_id, domain, normalized_domain, mode, status, verification_method, verification_token, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$id, $this->appId, $this->ownerId, $name, $name, 'launch_page', $status, 'dns_txt', 'fl-domain-verification=old', $proven ? date('Y-m-d H:i:s') : null]);
        return $id;
    }

    /** What logging in on this host gets from the real middleware, as index.php builds it. */
    private function signIn(string $host): int
    {
        $middleware = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', 'a-secret', ['https://' . $host], null, true,
            static fn (string $name): bool => self::$domains->provenByAnOwner($name));
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . '/api/auth/login')
            ->withHeader('Host', $host)->withHeader('Origin', 'https://' . $host)->withHeader('Content-Type', 'application/json');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(200);
            }
        };
        return $middleware->process($request, $handler)->getStatusCode();
    }

    public function testASiteWhoseOwnNameWasConnectedKeepsItsSignIns(): void
    {
        $this->ownNameRow('forms.formlogic-claim.com', 'active', true);
        $this->ownNameRow('www.formlogic-claim.com', 'active', true);
        $customer = 'shop-' . bin2hex(random_bytes(4)) . '.formlogic-claim-tests.com';
        $this->ownNameRow($customer, 'active', true);

        $this->assertFalse(self::$domains->provenByAnOwner('forms.formlogic-claim.com'));
        $this->assertFalse(self::$domains->provenByAnOwner('WWW.formlogic-claim.com:443'), "CORS_ORIGIN's host is this site's too");
        $this->assertTrue(self::$domains->provenByAnOwner($customer));

        $this->assertSame(200, $this->signIn('forms.formlogic-claim.com'));
        $this->assertSame(403, $this->signIn($customer), 'a customer domain is still refused, listed or not');
    }

    public function testVerifyingCannotProveThisSitesOwnName(): void
    {
        $id = $this->ownNameRow('forms.formlogic-claim.com', 'pending', false);
        [$status, $body] = $this->verify($id);

        $this->assertSame(200, $status);
        $this->assertFalse($body['ok']);
        $this->assertStringContainsString('not allowed', $body['message']);
        $row = self::$domains->getDomain($id, $this->ownerId);
        $this->assertSame('pending', $row['status']);
        $this->assertNull($row['verifiedAt']);
    }

    public function testAnotherListedOriginStaysAClaimableCustomerDomain(): void
    {
        $listed = $this->freshName();
        $this->setEnv('CORS_ALLOWED_ORIGINS', 'https://' . $listed);
        [$status, $created] = $this->create($listed);
        $this->assertSame(201, $status);
        $this->assertTrue($this->verify($created['domain']['id'])[1]['ok']);
        $this->assertTrue(self::$domains->provenByAnOwner($listed));
    }

    public function testASiteKnownOnlyByItsFirstListedOriginKeepsItsSignIns(): void
    {
        // A hand-made .env: the example CORS_ORIGIN left in, and the real address in the list.
        $this->setEnv('APP_URL', null);
        $this->setEnv('APP_ENV', 'production');
        $this->setEnv('CORS_ORIGIN', 'http://localhost:5173');
        $this->setEnv('CORS_ALLOWED_ORIGINS', 'https://listed.formlogic-claim.com');
        $this->ownNameRow('listed.formlogic-claim.com', 'active', true);

        $this->assertSame('https://listed.formlogic-claim.com', \FormLogic\Helpers\AppUrl::configuredBase());
        $this->assertFalse(self::$domains->provenByAnOwner('listed.formlogic-claim.com'), 'what names the site in one place does in the other');
        $this->assertSame(200, $this->signIn('listed.formlogic-claim.com'));
    }

    /** @return array{0:int,1:array<string,mixed>} */
    private function lookUp(string $host): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/public/launch/by-host')
            ->withQueryParams(['host' => $host]);
        $response = self::$ctrl->resolveByHost($request, new Response());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    public function testTheLookupSaysWhenAnUnconnectedHostIsThisSiteItself(): void
    {
        $this->setEnv('CORS_ALLOWED_ORIGINS', 'https://first.formlogic-claim.com, https://second.formlogic-claim.com:8443');

        foreach (['forms.formlogic-claim.com', 'FORMS.formlogic-claim.com:443', 'www.formlogic-claim.com', 'first.formlogic-claim.com', 'second.formlogic-claim.com:8443'] as $host) {
            [$status, $body] = $this->lookUp($host);
            $this->assertSame(404, $status, $host);
            $this->assertSame('Domain not connected', $body['message'], $host);
            $this->assertTrue($body['platform'], $host);
        }
    }

    public function testTheLookupSaysNothingOfTheKindForAHostNobodyListed(): void
    {
        [$status, $body] = $this->lookUp($this->freshName());

        $this->assertSame(404, $status);
        $this->assertArrayNotHasKey('platform', $body);
    }

    public function testAListedOriginConnectedToAnAppIsThatApp(): void
    {
        $listed = $this->freshName();
        $this->setEnv('CORS_ALLOWED_ORIGINS', 'https://' . $listed);
        [, $created] = $this->create($listed);
        $this->assertTrue($this->verify($created['domain']['id'])[1]['ok']);

        [$status, $body] = $this->lookUp($listed);

        $this->assertSame(200, $status);
        $this->assertArrayNotHasKey('platform', $body);
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
