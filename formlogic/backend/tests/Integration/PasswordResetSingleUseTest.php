<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AuthService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-AUTH-002 — password-reset redemption is atomically single-use: the conditional
 * used_at claim is the gate, so a second redemption of the same token can never change the
 * password after the first, and the winning redemption revokes sessions (token_version bump).
 * Skipped without a test DB.
 */
class PasswordResetSingleUseTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AuthService $auth;

    private string $userId = '';
    private string $token = '';

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
        self::$auth = new AuthService($conn, ['secret' => 'test-secret-test-secret-test-secret!', 'issuer' => 't', 'audience' => 't']);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, token_version) VALUES (?, ?, 'old-hash', 'T', 3)")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->token = bin2hex(random_bytes(24));
        self::$pdo->prepare("
            INSERT INTO password_resets (id, user_id, token_hash, expires_at)
            VALUES (UUID(), ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))
        ")->execute([$this->userId, hash('sha256', $this->token)]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function userRow(): array
    {
        $stmt = self::$pdo->prepare('SELECT password_hash, token_version FROM users WHERE id = ?');
        $stmt->execute([$this->userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC);
    }

    public function testTokenRedeemsExactlyOnce(): void
    {
        self::$auth->resetPassword($this->token, 'FirstNewPass!42');
        $afterFirst = $this->userRow();
        $this->assertTrue(password_verify('FirstNewPass!42', $afterFirst['password_hash']));
        $this->assertSame(4, (int) $afterFirst['token_version'], 'redemption revokes existing sessions');

        // The same token can NEVER change the password again.
        try {
            self::$auth->resetPassword($this->token, 'SecondNewPass!42');
            $this->fail('a used token must be rejected');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('invalid or has expired', $e->getMessage());
        }
        $afterSecond = $this->userRow();
        $this->assertTrue(password_verify('FirstNewPass!42', $afterSecond['password_hash']), 'the losing redemption changed nothing');
        $this->assertSame(4, (int) $afterSecond['token_version']);
    }

    public function testExpiredTokenIsRejectedWithoutBurningIt(): void
    {
        self::$pdo->prepare('UPDATE password_resets SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE user_id = ?')
            ->execute([$this->userId]);
        try {
            self::$auth->resetPassword($this->token, 'NewPass!42abc');
            $this->fail('an expired token must be rejected');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('invalid or has expired', $e->getMessage());
        }
        $this->assertSame('old-hash', $this->userRow()['password_hash']);
        $used = self::$pdo->query("SELECT used_at FROM password_resets WHERE user_id = '{$this->userId}'")->fetchColumn();
        $this->assertNull($used, 'a rejected redemption never marks the token used');
    }
}
