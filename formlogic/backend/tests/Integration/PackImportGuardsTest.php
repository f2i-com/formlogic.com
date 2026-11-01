<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Response as SlimResponse;

/** What an import refuses, and what it won't take from a pack. */
final class PackImportGuardsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];
    private static FormService $forms;
    private static PackService $packs;

    private string $userId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-pack-guards-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$packs = new PackService($conn, self::$forms, new AppService($conn, self::$forms), new AppUserService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function pack(array $form = []): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['id' => 'guards-' . bin2hex(random_bytes(6)), 'name' => 'Guards', 'version' => '1.0.0'],
            'forms' => [$form + ['packFormId' => 'f1', 'title' => 'F1', 'fields' => [
                ['id' => 'email', 'type' => 'email', 'label' => 'Email', 'order' => 0, 'properties' => []],
            ]]],
        ];
    }

    private function installations(): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM pack_installations WHERE user_id = ?');
        $stmt->execute([$this->userId]);
        return (int) $stmt->fetchColumn();
    }

    public function testAnImportThatCannotGetTheLockRefusesInsteadOfInstallingTwice(): void
    {
        $pack = $this->pack();
        $lock = substr('fl_pack_install_' . hash('sha256', $pack['packMeta']['id'] . '|' . $this->userId), 0, 60);
        $other = new PDO(
            sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', self::$config['host'], self::$config['port'], self::$config['database']),
            self::$config['username'],
            self::$config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        $other->query("SELECT GET_LOCK('{$lock}', 0)")->fetchAll();

        try {
            self::$packs->importPack($pack, $this->userId);
            self::fail('Another import of this pack has the lock');
        } catch (\RuntimeException $e) {
            self::assertSame(409, $e->getCode());
            self::assertStringContainsString('already installing', $e->getMessage());
        } finally {
            $other->query("SELECT RELEASE_LOCK('{$lock}')")->fetchAll();
        }

        self::assertSame(0, $this->installations());
        self::assertFalse(self::$pdo->inTransaction());
        $forms = self::$pdo->prepare('SELECT COUNT(*) FROM forms WHERE user_id = ?');
        $forms->execute([$this->userId]);
        self::assertSame(0, (int) $forms->fetchColumn(), 'nothing was installed');

        $result = self::$packs->importPack($pack, $this->userId);
        self::assertSame(1, $this->installations(), 'and once the first is done it goes ahead');
        self::$forms->deleteForm($result['forms'][0]['id']);
    }

    public function testTheRefusalReachesAClientAsAConflict(): void
    {
        $controller = (new \ReflectionClass(PackController::class))->newInstanceWithoutConstructor();
        $refuse = new \ReflectionMethod(PackController::class, 'importRefusal');

        $installing = $refuse->invoke($controller, new SlimResponse(), new \RuntimeException('This pack is already installing.', 409));
        self::assertSame(409, $installing->getStatusCode());

        $other = $refuse->invoke($controller, new SlimResponse(), new \RuntimeException('This pack is already installed'));
        self::assertSame(400, $other->getStatusCode(), 'every other refusal stays as it was');
    }

    public function testAPackCannotShipAFormWithPublicRecordsOn(): void
    {
        $result = self::$packs->importPack($this->pack([
            'customScreen' => ['enabled' => true, 'html' => '<p>Hi</p>', 'publicRecords' => true, 'publicRecordFields' => ['email']],
        ]), $this->userId);

        $screen = self::$forms->getForm($result['forms'][0]['id'])['customScreen'];
        self::assertSame('<p>Hi</p>', $screen['html'], 'the rest of the screen arrives');
        self::assertArrayNotHasKey('publicRecords', $screen);
        self::assertArrayNotHasKey('publicRecordFields', $screen);
        self::$forms->deleteForm($result['forms'][0]['id']);
    }
}
