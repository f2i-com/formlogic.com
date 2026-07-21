<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\ApiKeyService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * External-API key lifecycle + scope/expiry/revocation against a real MySQL DB. The per-route
 * scope ENFORCEMENT lives in ApiKeyMiddleware (in_array(requiredScope, key.scopes)); these tests
 * pin the storage/validation those checks rely on — e.g. a forms:read key never carries
 * responses:write. Skipped without a test DB (same setup as PlanEnforcementTest).
 */
class ApiKeyTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static ApiKeyService $svc;
    private string $userId = '';

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
        self::$svc = new ApiKeyService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(14));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM api_keys WHERE user_id = ?')->execute([$this->userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    public function testCreateAndValidateRoundTrip(): void
    {
        $created = self::$svc->createKey($this->userId, 'CI', ['forms:read', 'responses:write']);
        $this->assertStringStartsWith('flk_', $created['key']);

        $validated = self::$svc->validateKey($created['key']);
        $this->assertNotNull($validated);
        $this->assertSame($this->userId, $validated['userId']);
        $this->assertEqualsCanonicalizing(['forms:read', 'responses:write'], $validated['scopes']);
    }

    public function testScopesArePreservedExactly(): void
    {
        // A forms:read key must NOT carry responses:write — this is what the middleware's
        // per-route scope check relies on to reject a write from a read-only key.
        $created = self::$svc->createKey($this->userId, 'ReadOnly', ['forms:read']);
        $validated = self::$svc->validateKey($created['key']);
        $this->assertContains('forms:read', $validated['scopes']);
        $this->assertNotContains('responses:write', $validated['scopes']);
    }

    public function testFlowsRelayScopeIsAccepted(): void
    {
        // The Phase-5 desktop flow lane (plan §5.7) needs its own scope; new desktop links
        // request the full set (ai:relay + flows:relay), legacy connector:relay keys are
        // grandfathered controller-side, never by this allow-list.
        $created = self::$svc->createKey($this->userId, 'DesktopFlow', ['ai:relay', 'flows:relay']);
        $validated = self::$svc->validateKey($created['key']);
        $this->assertContains('flows:relay', $validated['scopes']);
        $this->assertContains('ai:relay', $validated['scopes']);
    }

    public function testInvalidScopeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::$svc->createKey($this->userId, 'Bad', ['forms:read', 'do:anything']);
    }

    public function testEmptyScopesRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::$svc->createKey($this->userId, 'Empty', []);
    }

    public function testUnknownOrMalformedKeyReturnsNull(): void
    {
        $this->assertNull(self::$svc->validateKey('flk_does_not_exist_0000000000'));
        $this->assertNull(self::$svc->validateKey('not-a-formlogic-key'));
        $this->assertNull(self::$svc->validateKey(''));
    }

    public function testRevokedKeyFails(): void
    {
        $created = self::$svc->createKey($this->userId, 'ToRevoke', ['forms:read']);
        $this->assertNotNull(self::$svc->validateKey($created['key']));

        $this->assertTrue(self::$svc->revokeKey($created['id'], $this->userId));
        $this->assertNull(self::$svc->validateKey($created['key']), 'revoked key must not validate');
    }

    public function testCannotRevokeAnotherUsersKey(): void
    {
        $created = self::$svc->createKey($this->userId, 'Mine', ['forms:read']);
        $this->assertFalse(self::$svc->revokeKey($created['id'], 'someone-else'));
        $this->assertNotNull(self::$svc->validateKey($created['key']), 'key must remain valid');
    }

    public function testExpiredKeyFails(): void
    {
        // createKey rejects a past expiry, so create a live key then age it out directly to
        // exercise validateKey()'s expiry check.
        $created = self::$svc->createKey($this->userId, 'Expired', ['forms:read']);
        self::$pdo->prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?')
            ->execute([date('Y-m-d H:i:s', time() - 3600), $created['id']]);
        $this->assertNull(self::$svc->validateKey($created['key']), 'expired key must not validate');
    }

    public function testFormIdRestrictionStored(): void
    {
        $formId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // formIds must be valid UUIDs
        $created = self::$svc->createKey($this->userId, 'Scoped', ['responses:read'], [$formId]);
        $validated = self::$svc->validateKey($created['key']);
        $this->assertSame([$formId], $validated['formIds']);
    }
}
