<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-06 + FL-08 regression coverage for the desktop relay lanes.
 *
 * FL-06: the long-poll cursor is a composite (created_at, id) — created_at is
 * second-precision, so the old "strictly after the cursor's timestamp" filter
 * permanently skipped jobs created in the same second, and an unknown/deleted
 * cursor id nulled the scalar subquery into an empty stream forever.
 *
 * FL-08: idempotency keys are scoped per owner — one tenant reusing another
 * tenant's (predictable) key must enqueue its OWN row, never collide with or
 * observe the foreign one. Same-owner replays still dedupe.
 *
 * Skipped without a test DB.
 */
class DesktopRelayCursorScopeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopCommandService $commands;
    private static DesktopAiRelayService $aiRelay;

    private string $ownerA = '';
    private string $ownerB = '';

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
        self::$commands = new DesktopCommandService($conn);
        self::$aiRelay = new DesktopAiRelayService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerA = 'u-' . bin2hex(random_bytes(12));
        $this->ownerB = 'u-' . bin2hex(random_bytes(12));
        foreach ([$this->ownerA, $this->ownerB] as $uid) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$uid, $uid . '@test.local']);
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerA === '') {
            return;
        }
        foreach ([$this->ownerA, $this->ownerB] as $uid) {
            self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──

    private function enqueueCommand(string $ownerId, ?string $key = null): array
    {
        return self::$commands->enqueue($ownerId, $ownerId, null, [
            'connectorId' => 'test-connector',
            'command' => 'services.list',
            'idempotencyKey' => $key,
        ]);
    }

    private function enqueueAiRequest(string $ownerId, ?string $key = null): array
    {
        return self::$aiRelay->enqueue($ownerId, $ownerId, [
            'kind' => 'chat',
            'providerId' => 'openai-api',
            'ephPub' => base64_encode(random_bytes(32)),
            'envelope' => base64_encode('sealed'),
            'idempotencyKey' => $key,
        ]);
    }

    /** Pin every row of the owner's lane to ONE second so ordering falls to the id tiebreak. */
    private function pinSameSecond(string $table, string $ownerId): void
    {
        self::$pdo->prepare("UPDATE {$table} SET created_at = (NOW() - INTERVAL 5 SECOND) WHERE owner_user_id = ?")
            ->execute([$ownerId]);
    }

    // ── FL-06: composite cursor ──

    public function testSameSecondCommandsAreAllDeliveredThroughTheCursor(): void
    {
        $ids = [];
        for ($i = 0; $i < 4; $i++) {
            $ids[] = $this->enqueueCommand($this->ownerA)['command']['commandId'];
        }
        $this->pinSameSecond('desktop_commands', $this->ownerA);

        // Page with limit 1 through the cursor — every job must appear exactly once.
        $seen = [];
        $cursor = null;
        for ($page = 0; $page < 10; $page++) {
            $rows = self::$commands->listPending($this->ownerA, $cursor, 1);
            if ($rows === []) {
                break;
            }
            $seen[] = $rows[0]['commandId'];
            $cursor = $rows[0]['commandId'];
        }
        sort($ids);
        sort($seen);
        $this->assertSame($ids, $seen, 'same-second jobs after the cursor must not be skipped');
    }

    public function testUnknownCursorResetsInsteadOfEmptyingTheStream(): void
    {
        $created = $this->enqueueCommand($this->ownerA)['command']['commandId'];

        // A cursor id that never existed (or was deleted) must NOT null the filter
        // into a permanently empty stream — it resets to cursor-less delivery.
        $rows = self::$commands->listPending($this->ownerA, 'cmd-never-existed', 50);
        $this->assertSame([$created], array_column($rows, 'commandId'));
    }

    public function testSameSecondAiRequestsAreAllDeliveredThroughTheCursor(): void
    {
        $ids = [];
        // The AI lane caps at MAX_IN_FLIGHT_PER_USER (2) — two same-second rows are
        // enough to prove the cursor advances through a shared timestamp.
        for ($i = 0; $i < DesktopAiRelayService::MAX_IN_FLIGHT_PER_USER; $i++) {
            $ids[] = $this->enqueueAiRequest($this->ownerA)['request']['requestId'];
        }
        $this->pinSameSecond('desktop_ai_requests', $this->ownerA);

        $seen = [];
        $cursor = null;
        for ($page = 0; $page < 10; $page++) {
            $rows = self::$aiRelay->listPending($this->ownerA, $cursor, 1);
            if ($rows === []) {
                break;
            }
            $seen[] = $rows[0]['requestId'];
            $cursor = $rows[0]['requestId'];
        }
        sort($ids);
        sort($seen);
        $this->assertSame($ids, $seen);
    }

    // ── FL-08: tenant-scoped idempotency keys ──

    public function testSameIdempotencyKeySucceedsIndependentlyAcrossOwners(): void
    {
        $key = 'shared-key-' . bin2hex(random_bytes(6));

        $a = $this->enqueueCommand($this->ownerA, $key);
        $b = $this->enqueueCommand($this->ownerB, $key);
        $this->assertTrue($a['created']);
        $this->assertTrue($b['created'], 'a foreign owner\'s key must never block this tenant');
        $this->assertNotSame($a['command']['commandId'], $b['command']['commandId']);
        $this->assertSame($this->ownerB, $b['command']['ownerUserId']);

        // Same-owner replay still dedupes onto the owner's OWN row.
        $replay = $this->enqueueCommand($this->ownerA, $key);
        $this->assertFalse($replay['created']);
        $this->assertSame($a['command']['commandId'], $replay['command']['commandId']);
    }

    public function testSameAiRelayKeySucceedsIndependentlyAcrossOwners(): void
    {
        $key = 'shared-ai-key-' . bin2hex(random_bytes(6));

        $a = $this->enqueueAiRequest($this->ownerA, $key);
        $b = $this->enqueueAiRequest($this->ownerB, $key);
        $this->assertTrue($a['created']);
        $this->assertTrue($b['created']);
        $this->assertNotSame($a['request']['requestId'], $b['request']['requestId']);

        $replay = $this->enqueueAiRequest($this->ownerA, $key);
        $this->assertFalse($replay['created']);
        $this->assertSame($a['request']['requestId'], $replay['request']['requestId']);
    }
}
