<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppDomainService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Custom-domain hardening #5: active-vs-TLS activation policy.
 *
 * verifyDomain() must respect APP_DOMAIN_REQUIRE_TLS_ACTIVE:
 *  - flexible (default / '0'): ownership proven → status='active' immediately (tls_status surfaced separately);
 *  - strict ('1'): in production, ownership proven but HTTPS not live → status='verified' (held back); the
 *    public resolvers (which require status='active') must NOT surface it. A dev-override verify satisfies
 *    the gate so the activation path stays testable locally (tls_status stays 'external', truthfully).
 *
 * Uses the dev-override path so no real DNS / TLS is needed. Skipped without a test DB.
 */
class AppDomainActivationTest extends TestCase
{
    private static ?MySQLConnection $conn = null;
    private static ?PDO $pdo = null;
    private static AppDomainService $svc;

    private string $ownerId = '';
    private string $appId = '';
    /** @var string[] */ private array $domainIds = [];
    private ?string $savedStrict = null;

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
        self::$conn = $conn;
        self::$pdo = $conn->getConnection();
        self::$svc = new AppDomainService($conn);
    }

    protected function setUp(): void
    {
        if (self::$conn === null) {
            $this->markTestSkipped('No test database');
        }
        $get = getenv('APP_DOMAIN_REQUIRE_TLS_ACTIVE');
        $this->savedStrict = $get === false ? null : $get;

        $this->ownerId = 'u' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->appId = 'app' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', '{}')")
            ->execute([$this->appId, $this->ownerId, 'act' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        $this->setStrict($this->savedStrict);
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->domainIds as $id) {
            self::$pdo->prepare('DELETE FROM app_domains WHERE id = ?')->execute([$id]);
        }
        if ($this->appId !== '') {
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        }
        if ($this->ownerId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
        }
    }

    private function setStrict(?string $value): void
    {
        if ($value === null) {
            putenv('APP_DOMAIN_REQUIRE_TLS_ACTIVE');
            unset($_ENV['APP_DOMAIN_REQUIRE_TLS_ACTIVE']);
        } else {
            putenv('APP_DOMAIN_REQUIRE_TLS_ACTIVE=' . $value);
            $_ENV['APP_DOMAIN_REQUIRE_TLS_ACTIVE'] = $value;
        }
    }

    private function makeDomain(): array
    {
        $host = 'd' . bin2hex(random_bytes(6)) . '.example-app.com';
        $created = self::$svc->createDomain($this->appId, $this->ownerId, $host);
        $this->domainIds[] = $created['id'];
        return $created;
    }

    public function testRequireTlsActiveDefaultsToFlexible(): void
    {
        $this->setStrict(null);
        $this->assertFalse(self::$svc->requireTlsActive());
        $this->setStrict('0');
        $this->assertFalse(self::$svc->requireTlsActive());
        $this->setStrict('1');
        $this->assertTrue(self::$svc->requireTlsActive());
    }

    public function testFlexibleModeActivatesOnOwnershipEvenWhenTlsPending(): void
    {
        $this->setStrict('0');
        $d = $this->makeDomain();

        $res = self::$svc->verifyDomain($d['id'], $this->ownerId, true);

        $this->assertTrue($res['ok']);
        $this->assertSame('active', $res['status']);
        // Dev-override measures TLS as 'external' (nothing real to probe) — surfaced, not blocking.
        $this->assertSame('external', $res['domain']['tlsStatus']);
        // Public resolver requires status='active' — reachable now.
        $this->assertNotNull(self::$svc->resolveAppSlugByHost($d['normalizedDomain']));
    }

    public function testStrictModeDevOverrideActivatesForLocalTesting(): void
    {
        // Dev-override satisfies the strict gate so the activation/launch path is reachable in local dev
        // (review fix: under dev-override the strict path was previously stuck at 'verified' forever).
        // tls_status stays 'external' — truthful, nothing real was probed. In production (no dev-override)
        // a strict domain instead holds at 'verified' until a live HTTPS probe returns 'active'.
        $this->setStrict('1');
        $d = $this->makeDomain();

        $res = self::$svc->verifyDomain($d['id'], $this->ownerId, true);

        $this->assertTrue($res['ok']);
        $this->assertSame('active', $res['status']);
        $this->assertSame('external', $res['domain']['tlsStatus']);
        $this->assertNotNull(self::$svc->resolveAppSlugByHost($d['normalizedDomain']));
    }

    public function testUnknownDomainReturnsNotFound(): void
    {
        $res = self::$svc->verifyDomain('does-not-exist', $this->ownerId, true);
        $this->assertFalse($res['ok']);
        $this->assertSame('not_found', $res['status']);
    }
}
