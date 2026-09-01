<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\FormService;
use FormLogic\Services\SandboxRunner;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScriptRejection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * onSubmit {store:false} semantics (backend-script storage takeover):
 *  - a script returning {store:false} ACCEPTS the submission but persists
 *    NOTHING — no SQLite response row, no MySQL response_metadata mirror —
 *    and the result carries stored:false so callers skip links/notify;
 *  - {reject:true} still rejects (nothing stored, ScriptRejection returned);
 *  - a plain script (no store key) still stores exactly as before.
 *
 * Runs the REAL QuickJS sandbox (vendored qjs + harness); skipped when the
 * runtime binary is unavailable.
 */
class ScriptStoreOptOutTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static string $tmpRoot = '';

    private string $userId = '';
    private string $formId = '';

    public static function setUpBeforeClass(): void
    {
        if (!(new SandboxRunner())->isAvailable()) {
            self::markTestSkipped('FormLogic script runtime unavailable');
        }
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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-storeoptout-test-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite, new FormLogicRuntime());
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $form = self::$forms->createForm([
            'title' => 'Store opt-out', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
            ],
        ]);
        $this->formId = (string) $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function rowCounts(): array
    {
        $sqliteCount = (int) self::$sqlite->getFormDatabase($this->formId)
            ->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        $meta = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = ?');
        $meta->execute([$this->formId]);
        return [$sqliteCount, (int) $meta->fetchColumn()];
    }

    public function testStoreFalseAcceptsButPersistsNothing(): void
    {
        $script = 'function onSubmit(ctx) { return { store: false, forwarded: true }; }';
        $result = self::$responses->createResponse($this->formId, ['answers' => ['name' => 'Ada']], $script);

        $this->assertIsArray($result);
        $this->assertFalse($result['stored']);
        $this->assertNotEmpty($result['id']);
        $this->assertSame(['name' => 'Ada'], $result['answers']);

        [$sqliteCount, $metaCount] = $this->rowCounts();
        $this->assertSame(0, $sqliteCount, 'no SQLite response row');
        $this->assertSame(0, $metaCount, 'no MySQL metadata mirror');
    }

    public function testRejectStillRejectsWithoutStoring(): void
    {
        $script = 'function onSubmit(ctx) { return { reject: true, message: "no thanks" }; }';
        $result = self::$responses->createResponse($this->formId, ['answers' => ['name' => 'Bob']], $script);

        $this->assertInstanceOf(ScriptRejection::class, $result);
        $this->assertSame('no thanks', $result->message);

        [$sqliteCount, $metaCount] = $this->rowCounts();
        $this->assertSame(0, $sqliteCount);
        $this->assertSame(0, $metaCount);
    }

    public function testPlainScriptStillStores(): void
    {
        $script = 'function onSubmit(ctx) { ctx.db.addTag("kept"); return { note: "ok" }; }';
        $result = self::$responses->createResponse($this->formId, ['answers' => ['name' => 'Cara']], $script);

        $this->assertIsArray($result);
        $this->assertNotFalse($result['stored'] ?? true, 'default path stays stored');

        [$sqliteCount, $metaCount] = $this->rowCounts();
        $this->assertSame(1, $sqliteCount, 'response row persisted');
        $this->assertSame(1, $metaCount, 'metadata mirror persisted');
    }
}
