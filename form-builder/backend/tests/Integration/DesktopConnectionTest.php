<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * desktop_connections registry: upsert on (owner_user_id, desktop_instance_id) — re-pairing the
 * same install refreshes it in place — plus per-user isolation on list/delete. Skipped without a
 * test DB.
 */
class DesktopConnectionTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;

    private string $userId = '';
    private string $otherUserId = '';

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
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        foreach (['userId', 'otherUserId'] as $prop) {
            $id = 'u-' . bin2hex(random_bytes(12));
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$id, $id . '@test.local']);
            $this->$prop = $id;
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->userId, $this->otherUserId] as $uid) {
            if ($uid !== '') {
                self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
            }
        }
    }

    public function testUpsertCreatesThenRefreshesInPlace(): void
    {
        $created = self::$flows->upsertDesktopConnection($this->userId, [
            'desktopInstanceId' => 'inst-abc123',
            'deviceName' => 'Office PC',
            'capabilities' => ['model.llm.local', 'aokie.call'],
            'trustedOrigins' => ['https://formlogic.com'],
        ]);
        $this->assertSame('Office PC', $created['deviceName']);
        $this->assertSame(['model.llm.local', 'aokie.call'], $created['capabilities']);
        $this->assertNotEmpty($created['lastSeenAt'], 'pairing stamps last_seen_at');

        // Re-pairing the SAME instance updates in place (no second row, same id).
        $updated = self::$flows->upsertDesktopConnection($this->userId, [
            'desktopInstanceId' => 'inst-abc123',
            'deviceName' => 'Office PC (renamed)',
            'capabilities' => ['model.llm.local'],
        ]);
        $this->assertSame($created['id'], $updated['id'], 'upsert must not create a second row');
        $this->assertSame('Office PC (renamed)', $updated['deviceName']);
        $this->assertSame(['model.llm.local'], $updated['capabilities']);
        $this->assertCount(1, self::$flows->listDesktopConnections($this->userId));

        // A different instance id is a separate device.
        self::$flows->upsertDesktopConnection($this->userId, ['desktopInstanceId' => 'inst-second']);
        $this->assertCount(2, self::$flows->listDesktopConnections($this->userId));
    }

    public function testSameInstanceIdIsPerUser(): void
    {
        self::$flows->upsertDesktopConnection($this->userId, ['desktopInstanceId' => 'inst-shared']);
        self::$flows->upsertDesktopConnection($this->otherUserId, ['desktopInstanceId' => 'inst-shared']);
        $this->assertCount(1, self::$flows->listDesktopConnections($this->userId));
        $this->assertCount(1, self::$flows->listDesktopConnections($this->otherUserId));
    }

    public function testDeleteIsOwnerOnly(): void
    {
        $conn = self::$flows->upsertDesktopConnection($this->userId, ['desktopInstanceId' => 'inst-del']);
        $this->assertFalse(self::$flows->deleteDesktopConnection($conn['id'], $this->otherUserId), 'another user cannot delete');
        $this->assertCount(1, self::$flows->listDesktopConnections($this->userId));
        $this->assertTrue(self::$flows->deleteDesktopConnection($conn['id'], $this->userId));
        $this->assertCount(0, self::$flows->listDesktopConnections($this->userId));
    }

    public function testInvalidInstanceIdRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::$flows->upsertDesktopConnection($this->userId, ['desktopInstanceId' => 'bad id with spaces']);
    }
}
