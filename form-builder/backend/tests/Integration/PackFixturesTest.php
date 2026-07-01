<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Every example pack under tests/fixtures/apps/ must validate + import cleanly (a CI guard against pack
 * schema/import regressions, and living documentation of the format). Skipped without a test DB.
 */
class PackFixturesTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static PackService $packs;
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-fixtures-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$packs = new PackService($conn, self::$forms, self::$apps, new AppUserService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $owned->execute([$this->userId]);
        foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public static function fixtureProvider(): array
    {
        $dirs = [
            dirname(__DIR__) . '/fixtures/apps',        // test fixtures
            dirname(__DIR__, 2) . '/resources/sample-apps', // bundled "Try a sample app" packs (shipped)
        ];
        $out = [];
        foreach ($dirs as $dir) {
            foreach (glob($dir . '/*.json') ?: [] as $file) {
                $out[basename($file)] = [$file];
            }
        }
        return $out;
    }

    /** @dataProvider fixtureProvider */
    public function testFixtureImports(string $file): void
    {
        $pack = json_decode((string) file_get_contents($file), true);
        $this->assertIsArray($pack, "$file must be valid JSON");

        // importPack runs validatePack internally, so a bad fixture throws here.
        $result = self::$packs->importPack($pack, $this->userId);

        $this->assertCount(count($pack['forms']), $result['forms'], 'all forms import');
        $this->assertCount(count($pack['apps'] ?? []), $result['apps'], 'all apps import');
    }
}
