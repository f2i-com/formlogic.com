<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-01 — desktop instance identity is BOUND to its authenticated API key:
 *   - a heartbeat can bind an instance to a key exactly once; a sibling key can
 *     never re-bind (impersonate) another install's identity;
 *   - resolveDesktopIdentity derives the caller's instance from the key binding and
 *     refuses a claimed id that belongs to a different key;
 *   - omitting the identity never bypasses a claimant lease (commands + AI lane).
 * Skipped without a test DB.
 */
class DesktopIdentityBindingTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;
    private static DesktopCommandService $commands;
    private static DesktopAiRelayService $aiRelay;

    private string $ownerId = '';
    private string $keyA = '';
    private string $keyB = '';

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
        self::$flows = new FlowService($conn);
        self::$commands = new DesktopCommandService($conn);
        self::$aiRelay = new DesktopAiRelayService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->keyA = $this->makeKey('Key A');
        $this->keyB = $this->makeKey('Key B');
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM api_keys WHERE user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    private function makeKey(string $name): string
    {
        $id = 'k-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("
            INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes)
            VALUES (?, ?, ?, 'flk_test', ?, '[\"connector:relay\"]')
        ")->execute([$id, $this->ownerId, $name, hash('sha256', $id)]);
        return $id;
    }

    private function heartbeat(string $instanceId, string $apiKeyId): array
    {
        return self::$flows->upsertDesktopConnection($this->ownerId, [
            'desktopInstanceId' => $instanceId,
            'deviceName' => "Desktop {$instanceId}",
        ], $apiKeyId);
    }

    // ── Bind-once heartbeats ──

    public function testHeartbeatBindsOnceAndRefusesASiblingKey(): void
    {
        $this->heartbeat('inst-a', $this->keyA);

        // Key A re-heartbeating its own instance keeps working.
        $again = $this->heartbeat('inst-a', $this->keyA);
        $this->assertSame('inst-a', $again['desktopInstanceId'] ?? $again['instanceId'] ?? 'inst-a');

        // Key B must NOT be able to rebind (impersonate) A's instance.
        $this->expectException(\InvalidArgumentException::class);
        $this->heartbeat('inst-a', $this->keyB);
    }

    public function testLegacyUnboundRowBindsOnceAndCannotMoveLater(): void
    {
        // Legacy row with no key binding (pre-upgrade install).
        self::$pdo->prepare("
            INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, api_key_id, last_seen_at)
            VALUES (UUID(), ?, 'Legacy', 'inst-legacy', NULL, NOW())
        ")->execute([$this->ownerId]);

        // First keyed heartbeat binds once…
        $this->heartbeat('inst-legacy', $this->keyA);
        $bound = self::$pdo->prepare('SELECT api_key_id FROM desktop_connections WHERE owner_user_id = ? AND desktop_instance_id = ?');
        $bound->execute([$this->ownerId, 'inst-legacy']);
        $this->assertSame($this->keyA, $bound->fetchColumn());

        // …and can never move to a different key afterwards.
        $this->expectException(\InvalidArgumentException::class);
        $this->heartbeat('inst-legacy', $this->keyB);
    }

    // ── Identity resolution ──

    public function testResolveDerivesFromTheKeyAndRefusesImpersonation(): void
    {
        $this->heartbeat('inst-a', $this->keyA);
        $this->heartbeat('inst-b', $this->keyB);

        // Derivation: an omitted claim resolves to the key's bound instance.
        $this->assertSame('inst-a', self::$commands->resolveDesktopIdentity($this->ownerId, $this->keyA, null));
        $this->assertSame('inst-b', self::$commands->resolveDesktopIdentity($this->ownerId, $this->keyB, null));

        // A matching claim passes.
        $this->assertSame('inst-a', self::$commands->resolveDesktopIdentity($this->ownerId, $this->keyA, 'inst-a'));

        // Key B claiming A's instance is refused.
        try {
            self::$commands->resolveDesktopIdentity($this->ownerId, $this->keyB, 'inst-a');
            $this->fail('expected instance_mismatch');
        } catch (\RuntimeException $e) {
            $this->assertSame('instance_mismatch', $e->getMessage());
        }

        // An UNBOUND key claiming a bound instance is refused too.
        $keyC = $this->makeKey('Key C');
        try {
            self::$commands->resolveDesktopIdentity($this->ownerId, $keyC, 'inst-a');
            $this->fail('expected instance_mismatch');
        } catch (\RuntimeException $e) {
            $this->assertSame('instance_mismatch', $e->getMessage());
        }

        // Legacy: unbound key + unknown instance passes through (bind-once upgrades later).
        $this->assertSame('inst-new', self::$commands->resolveDesktopIdentity($this->ownerId, $keyC, 'inst-new'));
    }

    // ── Omitted identity never bypasses a claimant lease ──

    public function testAnonymousCompletionCannotBypassACommandLease(): void
    {
        $cmd = self::$commands->enqueue($this->ownerId, $this->ownerId, null, [
            'connectorId' => 'test-connector',
            'command' => 'services.list',
        ])['command'];
        self::$commands->claim($cmd['commandId'], $this->ownerId, ['instanceId' => 'inst-a']);

        try {
            self::$commands->complete($cmd['commandId'], $this->ownerId, ['status' => 'done']);
            $this->fail('expected claimed_elsewhere');
        } catch (\RuntimeException $e) {
            $this->assertSame('claimed_elsewhere', $e->getMessage());
        }

        // A different identity cannot complete it either.
        try {
            self::$commands->complete($cmd['commandId'], $this->ownerId, ['status' => 'done', 'instanceId' => 'inst-b']);
            $this->fail('expected claimed_elsewhere');
        } catch (\RuntimeException $e) {
            $this->assertSame('claimed_elsewhere', $e->getMessage());
        }

        // The claimant completes normally.
        $done = self::$commands->complete($cmd['commandId'], $this->ownerId, ['status' => 'done', 'instanceId' => 'inst-a']);
        $this->assertSame('done', $done['status']);
    }

    public function testAnonymousActionsCannotBypassAnAiLaneLease(): void
    {
        $req = self::$aiRelay->enqueue($this->ownerId, $this->ownerId, [
            'kind' => 'chat',
            'providerId' => 'openai-api',
            'ephPub' => base64_encode(random_bytes(32)),
            'envelope' => base64_encode('sealed'),
        ])['request'];
        self::$aiRelay->claim($req['requestId'], $this->ownerId, ['instanceId' => 'inst-a']);

        // Anonymous frame append is refused.
        try {
            self::$aiRelay->appendFrame($req['requestId'], $this->ownerId, base64_encode('frame'), null);
            $this->fail('expected claimed_elsewhere');
        } catch (\RuntimeException $e) {
            $this->assertSame('claimed_elsewhere', $e->getMessage());
        }

        // Anonymous input read is refused.
        try {
            self::$aiRelay->fetchInput($req['requestId'], $this->ownerId, 0, null);
            $this->fail('expected claimed_elsewhere');
        } catch (\RuntimeException $e) {
            $this->assertSame('claimed_elsewhere', $e->getMessage());
        }

        // Anonymous completion is refused.
        try {
            self::$aiRelay->complete($req['requestId'], $this->ownerId, ['status' => 'done']);
            $this->fail('expected claimed_elsewhere');
        } catch (\RuntimeException $e) {
            $this->assertSame('claimed_elsewhere', $e->getMessage());
        }

        // The claimant streams + completes normally.
        $frame = self::$aiRelay->appendFrame($req['requestId'], $this->ownerId, base64_encode('frame'), 'inst-a');
        $this->assertSame('streaming', $frame['status']);
        $done = self::$aiRelay->complete($req['requestId'], $this->ownerId, ['status' => 'done', 'instanceId' => 'inst-a']);
        $this->assertSame('done', $done['status']);
    }
}
