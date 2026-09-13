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
 * Install/export every folder pack, verify rollback, and exercise a native SQLite backend.
 * Skipped without a test DB; an explicit override may use an existing local schema with isolated owners.
 */
class FolderPackInstallTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static PackService $packs;
    private static \FormLogic\Services\HostedAppService $hosting;
    private static \FormLogic\Services\NativeAppService $native;
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
            'database' => $_ENV['DB_TEST_DATABASE'] ?? (getenv('DB_TEST_DATABASE') ?: 'formlogic_test'),
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            if ($config['database'] === ($_ENV['DB_DATABASE'] ?? null)) {
                // Explicit DB_TEST_DATABASE override: use existing schema and isolate all rows by a temporary owner.
                $conn->getConnection()->query('SELECT id FROM apps LIMIT 1');
            } else { $conn->initializeSchema(); $conn->runMigrations(); }
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-fixtures-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$hosting = new \FormLogic\Services\HostedAppService(new \FormLogic\Services\SandboxRunner(), sys_get_temp_dir() . '/formlogic-pack-host-' . bin2hex(random_bytes(4)));
        self::$native = new \FormLogic\Services\NativeAppService(sys_get_temp_dir() . '/formlogic-pack-native-' . bin2hex(random_bytes(4)));
        self::$packs = new PackService($conn, self::$forms, self::$apps, new AppUserService($conn), self::$hosting, self::$native);
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
            self::$hosting->remove($aid);
            self::$native->remove($aid);
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

    public function testNativePackInstallsItsDatabaseAndRoundTripsBackendSource(): void
    {
        $folder = dirname(__DIR__) . '/fixtures/pack-projects';
        $catalog = (new \FormLogic\Services\FolderPackCatalog($folder, '/nonexistent'))->load();
        self::assertSame([], $catalog['errors']);
        $pack = $catalog['entries']['native-notes']['pack'];
        $installed = self::$packs->importPack($pack, $this->userId, null, null, null, []);
        $id = $installed['apps'][0]['id'];
        $saved = self::$native->get($id);
        self::assertSame('members', $saved['access']);
        self::assertSame(['items'], self::$native->records($id)['tables']);
        $result = self::$native->request($id, ['path' => '/api/items', 'method' => 'POST', 'body' => ['title' => 'Native pack test'], 'query' => (object)[], 'headers' => (object)[], 'client_ip' => '127.0.0.1']);
        self::assertSame(201, $result['status']);
        self::assertSame('Native pack test', self::$native->records($id, 'items')['rows'][0]['title']);
        $exported = self::$packs->exportApp($id, $this->userId);
        self::assertSame($saved['files'], $exported['apps'][0]['nativeProject']['files']);
        self::$packs->uninstallPack($installed['installationId'], $this->userId);
        self::assertNull(self::$native->get($id));
    }

    public function testFailedProjectInstallationRollsBackItsFormsAndApp(): void
    {
        $pack = (new \FormLogic\Services\FolderPackCatalog(null, '/nonexistent'))->load()['entries']['clinic-appointment-intake']['pack'];
        $hosting = $this->createMock(\FormLogic\Services\HostedAppService::class);
        $hosting->method('validate')->willReturn($pack['apps'][0]['hostedProject']);
        $hosting->method('publish')->willThrowException(new \RuntimeException('Test runtime unavailable'));
        $hosting->expects(self::once())->method('remove');
        $service = new PackService(self::$mysql, self::$forms, self::$apps, new AppUserService(self::$mysql), $hosting);
        try { $service->importPack($pack, $this->userId, null, null, null, []); self::fail('Expected the test runtime failure'); }
        catch (\RuntimeException $e) { self::assertSame('Test runtime unavailable', $e->getMessage()); }
        foreach (['forms' => 'user_id', 'apps' => 'owner_id', 'pack_installations' => 'user_id'] as $table => $owner) {
            $stmt = self::$pdo->prepare("SELECT COUNT(*) FROM $table WHERE $owner = ?");
            $stmt->execute([$this->userId]); self::assertSame(0, (int)$stmt->fetchColumn());
        }
    }

    public function testEveryFolderInstallsWithEditableProjectsAndPreservedLinks(): void
    {
        $entries = (new \FormLogic\Services\FolderPackCatalog(null, '/nonexistent'))->load()['entries'];
        self::assertCount(29, $entries);
        foreach ($entries as $id => $entry) {
            $pack = $entry['pack'];
            $result = self::$packs->importPack($pack, $this->userId, null, null, null, []);
            self::assertCount(count($pack['forms']), $result['forms'], $id);
            self::assertCount(count($pack['apps']), $result['apps'], $id);
            foreach ($result['apps'] as $i => $app) {
                $project = self::$hosting->get($app['id'], true);
                self::assertSame($pack['apps'][$i]['hostedProject']['actions'], $project['actions'], $id);
                self::assertSame(true, self::$apps->getApp($app['id'])['settings']['hostedDashboard']);
                $export = self::$packs->exportApp($app['id'], $this->userId);
                self::assertSame($project['actions'], $export['apps'][0]['hostedProject']['actions']);
                self::assertStringNotContainsString($app['id'], json_encode($export));
            }
            // Remove this isolated test installation before the next pack.
            self::$packs->uninstallPack($result['installationId'], $this->userId);
        }
    }
}
