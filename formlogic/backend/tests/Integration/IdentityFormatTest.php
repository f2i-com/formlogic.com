<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A slug and a form id go into URLs that carry a viewer's session, so what a client chooses for
 * them is one path segment and nothing more. A slug like `x\..\victim-app` turned a member's
 * requests into requests against another app. Skipped without a test database.
 */
class IdentityFormatTest extends TestCase
{
    private const HOSTILE = ['x\\..\\victim-app', '../victim-app', 'x/../victim-app', "vic\ttim-app", 'x?y', 'x#y', 'x y', '.', '..', '-leading', 'under_score', "trailing\n", 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];

    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static FormService $forms;
    private static string $root = '';
    private string $userId = '';

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
        self::$root = sys_get_temp_dir() . '/formlogic-identity-' . bin2hex(random_bytes(4));
        mkdir(self::$root, 0777, true);
        self::$forms = new FormService($conn, new SQLiteConnection(self::$root));
        self::$apps = new AppService($conn, self::$forms);
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
        $this->userId = 'u' . bin2hex(random_bytes(8));
        self::$mysql->getConnection()->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$this->userId, $this->userId . '@formlogic.test']);
    }

    public function testAnAppNeverGetsASlugThatIsMoreThanOneSegment(): void
    {
        foreach (self::HOSTILE as $slug) {
            $app = self::$apps->createApp(['name' => 'Named app', 'slug' => $slug], $this->userId);
            self::assertMatchesRegularExpression(AppService::SLUG_FORMAT, $app['slug'], json_encode($slug));
            self::assertNotSame($slug, $app['slug']);
        }
    }

    public function testAGoodSlugIsKept(): void
    {
        $slug = 'good-' . bin2hex(random_bytes(4));
        self::assertSame($slug, self::$apps->createApp(['name' => 'Kept', 'slug' => $slug], $this->userId)['slug']);
        $mixed = 'Mixed-' . bin2hex(random_bytes(4));
        self::assertSame(strtolower($mixed), self::$apps->createApp(['name' => 'Lowered', 'slug' => "  $mixed "], $this->userId)['slug']);
    }

    public function testASlugInUseFallsBackToAFreshOne(): void
    {
        $slug = 'taken-' . bin2hex(random_bytes(4));
        self::$apps->createApp(['name' => 'First', 'slug' => $slug], $this->userId);
        self::assertNotSame($slug, self::$apps->createApp(['name' => 'Second', 'slug' => $slug], $this->userId)['slug']);
    }

    public function testAFormIdIsOneSegment(): void
    {
        foreach (['../../forms/x', 'a/b', 'a\\b', "a\tb", 'a?b', 'a#b', 'a b', '.', '..', '', str_repeat('a', 65)] as $id) {
            try {
                self::$forms->createForm(['id' => $id, 'title' => 'Refused', 'userId' => $this->userId]);
                self::fail('Accepted ' . json_encode($id));
            } catch (\InvalidArgumentException $refused) {
                self::assertSame('Invalid form id', $refused->getMessage());
            }
        }
    }

    public function testAClientsOrdinaryFormIdIsKept(): void
    {
        $uuid = substr(bin2hex(random_bytes(4)), 0, 8) . '-7a44-4d21-9f0e-1c2d3e4f5a6b';
        foreach ([$uuid, 'form_' . bin2hex(random_bytes(4)), 'l9x' . bin2hex(random_bytes(6))] as $id) {
            self::assertSame($id, self::$forms->createForm(['id' => $id, 'title' => 'Offline', 'userId' => $this->userId])['id']);
        }
    }
}
