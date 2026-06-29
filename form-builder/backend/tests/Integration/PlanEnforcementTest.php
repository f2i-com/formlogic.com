<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\PlanService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Exercises PlanService against a real MySQL database (form-count + storage limits,
 * enterprise bypass, cloud active/expired). Skipped unless a test database is reachable —
 * set DB_TEST_DATABASE (default 'formlogic_test') plus the usual DB_HOST/DB_USERNAME/
 * DB_PASSWORD. CI provides a MySQL service; locally create an empty 'formlogic_test' DB.
 *
 * Scenarios (from the launch review): personal user cannot create the (N+1)th form;
 * cannot upload past the storage cap; enterprise bypasses both; expired owner is inactive
 * while a future expiry is active.
 */
class PlanEnforcementTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static string $userId = '';

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
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        // Fresh user per test; cascade cleans forms.
        self::$userId = 'test-' . bin2hex(random_bytes(8));
        $pdo = self::$mysql->getConnection();
        $stmt = $pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, ?, ?, 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))");
        $stmt->execute([self::$userId, self::$userId . '@test.local', 'x', 'Test']);
    }

    protected function tearDown(): void
    {
        if (self::$mysql) {
            self::$mysql->getConnection()->prepare('DELETE FROM users WHERE id = ?')->execute([self::$userId]);
        }
    }

    private function plan(array $cloud): PlanService
    {
        $files = new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']);
        return new PlanService(self::$mysql, $files, $cloud);
    }

    private function seedForms(int $n): void
    {
        $pdo = self::$mysql->getConnection();
        $stmt = $pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, ?, 'draft')");
        for ($i = 0; $i < $n; $i++) {
            $stmt->execute(['form-' . bin2hex(random_bytes(8)), self::$userId, 'F' . $i]);
        }
    }

    public function testPersonalCannotExceedFormLimit(): void
    {
        $this->seedForms(3);
        $plan = $this->plan(['planEnforced' => true, 'maxForms' => 3, 'maxStorageBytes' => 1 << 30]);
        $this->assertSame(3, $plan->getFormCount(self::$userId));
        $this->assertFalse($plan->canCreateForms(self::$userId, 1), 'at the limit, cannot create one more');
    }

    public function testPersonalUnderFormLimitCanCreate(): void
    {
        $this->seedForms(2);
        $plan = $this->plan(['planEnforced' => true, 'maxForms' => 5, 'maxStorageBytes' => 1 << 30]);
        $this->assertTrue($plan->canCreateForms(self::$userId, 1));
    }

    public function testStorageLimitEnforced(): void
    {
        $plan = $this->plan(['planEnforced' => true, 'maxForms' => 100, 'maxStorageBytes' => 1 << 30]); // 1 GB
        $this->assertTrue($plan->canUpload(self::$userId, 100), 'small upload fits');
        $this->assertFalse($plan->canUpload(self::$userId, 2 * (1 << 30)), '2 GB exceeds the 1 GB cap');
    }

    public function testEnterpriseBypassesAllLimits(): void
    {
        $this->seedForms(3);
        self::$mysql->getConnection()->prepare("UPDATE users SET plan='enterprise' WHERE id=?")->execute([self::$userId]);
        $plan = $this->plan(['planEnforced' => true, 'maxForms' => 1, 'maxStorageBytes' => 1]);
        $this->assertNull($plan->formLimit(self::$userId));
        $this->assertNull($plan->storageLimitBytes(self::$userId));
        $this->assertTrue($plan->canCreateForms(self::$userId, 10));
        $this->assertTrue($plan->canUpload(self::$userId, 5 * (1 << 30)));
    }

    public function testCloudActiveVersusExpired(): void
    {
        $plan = $this->plan(['planEnforced' => true, 'maxForms' => 100, 'maxStorageBytes' => 1 << 30]);
        $this->assertTrue($plan->isCloudActive(self::$userId), 'future expiry is active');

        self::$mysql->getConnection()->prepare("UPDATE users SET cloud_until=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=?")->execute([self::$userId]);
        $expired = $this->plan(['planEnforced' => true, 'maxForms' => 100, 'maxStorageBytes' => 1 << 30]);
        $this->assertFalse($expired->isCloudActive(self::$userId), 'past expiry is inactive');
    }

    public function testEnforcementOffIsUnlimited(): void
    {
        $this->seedForms(3);
        $plan = $this->plan(['planEnforced' => false, 'maxForms' => 1, 'maxStorageBytes' => 1]);
        $this->assertNull($plan->formLimit(self::$userId));
        $this->assertTrue($plan->canCreateForms(self::$userId, 999));
        $this->assertTrue($plan->isCloudActive(self::$userId));
    }
}
