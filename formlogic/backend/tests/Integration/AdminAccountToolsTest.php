<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AdminService;
use FormLogic\Services\AuthService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Admin account tools (support operations): password set, email change with
 * format/uniqueness validation, payment-ledger listing, and the complimentary
 * -access toggle (cloud_until pushed decades out / reset to now).
 */
class AdminAccountToolsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AdminService $admin;
    private static AuthService $auth;

    private string $userId = '';
    private string $otherId = '';

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
        self::$admin = new AdminService($conn);
        self::$auth = new AuthService($conn, [
            'secret' => 'test-secret-key-for-admin-tools-test-0123456789',
            'algorithm' => 'HS256',
        ]);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        $this->otherId = 'u-' . bin2hex(random_bytes(12));
        $ins = self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, 'T')");
        $ins->execute([$this->userId, $this->userId . '@test.local', password_hash('original-pass', PASSWORD_DEFAULT)]);
        $ins->execute([$this->otherId, $this->otherId . '@test.local', password_hash('x', PASSWORD_DEFAULT)]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->userId, $this->otherId] as $uid) {
            if ($uid !== '') {
                self::$pdo->prepare('DELETE FROM payments WHERE user_id = ?')->execute([$uid]);
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
            }
        }
    }

    public function testPasswordSetReplacesTheHash(): void
    {
        $this->assertTrue(self::$auth->verifyPassword($this->userId, 'original-pass'));
        self::$admin->setUserPassword($this->userId, 'new-temp-password-1');
        $this->assertFalse(self::$auth->verifyPassword($this->userId, 'original-pass'));
        $this->assertTrue(self::$auth->verifyPassword($this->userId, 'new-temp-password-1'));
    }

    public function testEmailChangeValidatesFormatAndUniqueness(): void
    {
        try {
            self::$admin->setUserEmail($this->userId, 'not-an-email');
            $this->fail('invalid format accepted');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Invalid email', $e->getMessage());
        }
        try {
            self::$admin->setUserEmail($this->userId, $this->otherId . '@test.local');
            $this->fail('duplicate email accepted');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('already uses', $e->getMessage());
        }
        self::$admin->setUserEmail($this->userId, 'renamed-' . $this->userId . '@test.local');
        $row = self::$admin->accountRow($this->userId);
        $this->assertSame('renamed-' . $this->userId . '@test.local', $row['email']);
    }

    public function testComplimentaryToggleMovesCloudUntil(): void
    {
        $row = self::$admin->accountRow($this->userId);
        $this->assertFalse(self::$admin->isComplimentary($row['cloud_until'] ?? null));

        self::$admin->setComplimentary($this->userId, true);
        $row = self::$admin->accountRow($this->userId);
        $this->assertTrue(self::$admin->isComplimentary($row['cloud_until']));
        // The plan machinery reads it as active access.
        $this->assertGreaterThan(time() + 50 * 365 * 86400, strtotime((string) $row['cloud_until']));

        self::$admin->setComplimentary($this->userId, false);
        $row = self::$admin->accountRow($this->userId);
        $this->assertFalse(self::$admin->isComplimentary($row['cloud_until']));
        $this->assertLessThanOrEqual(time() + 60, strtotime((string) $row['cloud_until']));
    }

    public function testPaymentLedgerListsNewestFirst(): void
    {
        $ins = self::$pdo->prepare(
            "INSERT INTO payments (id, user_id, provider, order_id, capture_id, amount_cents, currency, months, status, created_at)
             VALUES (?, ?, 'paypal', ?, ?, ?, 'USD', ?, ?, ?)"
        );
        $ins->execute(['p-' . bin2hex(random_bytes(8)), $this->userId, 'ORD-1', 'CAP-1', 900, 1, 'completed', '2026-06-01 10:00:00']);
        $ins->execute(['p-' . bin2hex(random_bytes(8)), $this->userId, 'ORD-2', null, 2700, 3, 'pending', '2026-07-01 10:00:00']);
        // Another user's payment must not leak into the list.
        $ins->execute(['p-' . bin2hex(random_bytes(8)), $this->otherId, 'ORD-X', null, 900, 1, 'completed', '2026-07-02 10:00:00']);

        $payments = self::$admin->listPayments($this->userId);
        $this->assertCount(2, $payments);
        $this->assertSame('ORD-2', $payments[0]['orderId'], 'newest first');
        $this->assertSame(2700, $payments[0]['amountCents']);
        $this->assertSame('pending', $payments[0]['status']);
        $this->assertSame('ORD-1', $payments[1]['orderId']);
        $this->assertSame('CAP-1', $payments[1]['captureId']);
    }
}
