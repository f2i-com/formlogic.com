<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDataExportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * App "Export data" acceptance:
 *  - the SQLite bundle zip carries a snapshot per member form + schema.json
 *    (field definitions) + uploaded files + README;
 *  - the MySQL dump actually EXECUTES against a real MySQL server and lands
 *    the records with typed values (numbers numeric, datetimes as DATETIME,
 *    multi-values as JSON text, computed + tags columns);
 *  - the SQL Server dump has the T-SQL shape ([brackets], N'…' strings,
 *    IF OBJECT_ID drops).
 */
class AppDataExportTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AppDataExportService $export;
    private static string $tmpRoot = '';
    private static string $uploadsPath = '';

    private string $userId = '';
    private string $appId = '';
    private string $f1 = '';
    private string $f2 = '';
    /** Tables created by executing the MySQL dump, dropped in tearDown. */
    private array $createdTables = [];

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-appdataexport-test-' . bin2hex(random_bytes(4));
        self::$uploadsPath = self::$tmpRoot . '/uploads';
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        mkdir(self::$uploadsPath, 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$export = new AppDataExportService($conn, self::$sqlite, self::$forms, self::$apps, self::$uploadsPath);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);

        $f1 = self::$forms->createForm([
            'title' => 'Job Sheets', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'customer', 'type' => 'short_text', 'label' => 'Customer', 'required' => false],
                ['id' => 'hours', 'type' => 'number', 'label' => 'Hours', 'required' => false],
                ['id' => 'services', 'type' => 'checkboxes', 'label' => 'Services', 'required' => false,
                 'properties' => ['options' => [
                     ['id' => 'o1', 'label' => 'Mow', 'value' => 'mow'],
                     ['id' => 'o2', 'label' => 'Trim', 'value' => 'trim'],
                 ]]],
                ['id' => 'when_booked', 'type' => 'datetime', 'label' => 'Booked for', 'required' => false],
                // Field id colliding with a reserved meta column — must be renamed, not clobbered.
                ['id' => 'status', 'type' => 'dropdown', 'label' => 'Job status', 'required' => false,
                 'properties' => ['options' => [['id' => 'o1', 'label' => 'Open', 'value' => 'open']]]],
            ],
        ]);
        $this->f1 = (string) $f1['id'];
        $f2 = self::$forms->createForm([
            'title' => 'Job Sheets', 'userId' => $this->userId, 'status' => 'published', // duplicate title → table name deduped
            'fields' => [['id' => 'note', 'type' => 'long_text', 'label' => 'Note', 'required' => false]],
        ]);
        $this->f2 = (string) $f2['id'];

        $app = self::$apps->createApp(['name' => 'Field Ops', 'slug' => 'field-ops-' . bin2hex(random_bytes(3))], $this->userId);
        $this->appId = (string) $app['id'];
        self::$apps->addFormToApp($this->appId, $this->f1, 'Job Sheets');
        self::$apps->addFormToApp($this->appId, $this->f2);

        self::$responses->createResponse($this->f1, ['answers' => [
            'customer' => "O'Brien & Sons\nUnit 2", // exercises quote + newline escaping
            'hours' => 3.5,
            'services' => ['mow', 'trim'],
            'when_booked' => '2026-07-14T09:30',
            'status' => 'open',
        ]], null);
        self::$responses->createResponse($this->f1, ['answers' => ['customer' => 'Beta', 'hours' => 2]], null);
        self::$responses->createResponse($this->f2, ['answers' => ['note' => 'hello']], null);

        $db = self::$sqlite->getFormDatabase($this->f1);
        $ids = $db->query('SELECT id FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
        $db->prepare('INSERT INTO computed (response_id, field_name, field_value) VALUES (?, ?, ?)')
            ->execute([$ids[0], 'quote_total', json_encode(180.5)]);
        $db->prepare('INSERT INTO tags (response_id, tag) VALUES (?, ?)')->execute([$ids[0], 'vip']);

        $uploadDir = self::$uploadsPath . '/' . $this->f1;
        mkdir($uploadDir, 0777, true);
        file_put_contents($uploadDir . '/file-abc123.pdf', 'PDF');
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->createdTables as $t) {
            self::$pdo->exec("DROP TABLE IF EXISTS `{$t}`");
        }
        if ($this->userId !== '') {
            $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $owned->execute([$this->userId]);
            foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            }
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    private function app(): array
    {
        $app = self::$apps->getApp($this->appId);
        $this->assertNotNull($app);
        return $app;
    }

    public function testSqliteBundleCarriesSnapshotsSchemaAndFiles(): void
    {
        $zipPath = self::$export->exportSqliteBundle($this->app());
        try {
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($zipPath) === true);

            $schema = json_decode((string) $zip->getFromName('schema.json'), true);
            $this->assertSame('formlogic.appDataExport', $schema['kind']);
            $this->assertCount(2, $schema['forms']);
            // Duplicate display names dedupe into distinct table/file names.
            $names = array_column($schema['forms'], 'sqliteFile');
            $this->assertContains('data/job_sheets.sqlite', $names);
            $this->assertContains('data/job_sheets_2.sqlite', $names);
            $this->assertNotFalse($zip->locateName('data/job_sheets.sqlite'));
            $this->assertNotFalse($zip->locateName('data/job_sheets_2.sqlite'));
            $this->assertNotFalse($zip->locateName('README.txt'));
            $this->assertNotFalse($zip->locateName('files/job_sheets/file-abc123.pdf'));

            // The snapshot is a readable SQLite db with the records inside.
            $byFile = array_column($schema['forms'], null, 'sqliteFile');
            $this->assertSame(2, $byFile['data/job_sheets.sqlite']['responseCount']);
            $this->assertSame(5, count($byFile['data/job_sheets.sqlite']['fields']));

            $zip->close();
        } finally {
            @unlink($zipPath);
        }
    }

    public function testMysqlDumpExecutesAgainstARealServer(): void
    {
        $statements = [];
        self::$export->generateSqlDump($this->app(), 'mysql', function (string $text, bool $isStatement) use (&$statements): void {
            if ($isStatement) {
                $statements[] = $text;
            }
        });

        // Register the tables for cleanup BEFORE executing (so a failure still drops).
        $this->createdTables = ['job_sheets', 'job_sheets_2'];
        foreach ($statements as $sql) {
            self::$pdo->exec($sql);
        }

        $rows = self::$pdo->query('SELECT * FROM `job_sheets` ORDER BY `submitted_at`')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(2, $rows);
        $first = null;
        foreach ($rows as $r) {
            if (str_starts_with((string) $r['customer'], "O'Brien")) {
                $first = $r;
            }
        }
        $this->assertNotNull($first, 'escaped-text row landed');
        $this->assertSame("O'Brien & Sons\nUnit 2", $first['customer']);
        $this->assertSame(3.5, (float) $first['hours']);
        $this->assertSame(['mow', 'trim'], json_decode((string) $first['services'], true));
        $this->assertSame('2026-07-14 09:30:00', $first['when_booked']);
        // The colliding "status" FIELD kept its data in a renamed column;
        // the meta status column still holds the record status.
        $this->assertSame('submitted', $first['status']);
        $this->assertSame('open', $first['status_2']);
        $this->assertSame('180.5', (string) json_decode((string) $first['computed_quote_total'], true));
        $this->assertSame(['vip'], json_decode((string) $first['tags'], true));

        $count2 = (int) self::$pdo->query('SELECT COUNT(*) FROM `job_sheets_2`')->fetchColumn();
        $this->assertSame(1, $count2);
    }

    public function testMssqlDumpHasTSqlShape(): void
    {
        $chunks = '';
        $statements = [];
        self::$export->generateSqlDump($this->app(), 'mssql', function (string $text, bool $isStatement) use (&$chunks, &$statements): void {
            $chunks .= $text . "\n";
            if ($isStatement) {
                $statements[] = $text;
            }
        });

        $this->assertStringContainsString("IF OBJECT_ID(N'dbo.job_sheets', N'U') IS NOT NULL DROP TABLE [dbo].[job_sheets]", $chunks);
        $this->assertStringContainsString('CREATE TABLE [dbo].[job_sheets]', $chunks);
        $this->assertStringContainsString('[id] NVARCHAR(36) NOT NULL PRIMARY KEY', $chunks);
        $this->assertStringContainsString('NVARCHAR(MAX)', $chunks);
        $this->assertStringContainsString('DATETIME2', $chunks);
        // Quote escaping is quote-doubling, with the N unicode prefix.
        $this->assertStringContainsString("N'O''Brien & Sons", $chunks);
        // No MySQL-isms in the T-SQL dialect.
        $this->assertStringNotContainsString('ENGINE=InnoDB', $chunks);
        $this->assertStringNotContainsString('SET FOREIGN_KEY_CHECKS', $chunks);
        $this->assertStringNotContainsString('`', $chunks);
        $this->assertGreaterThan(4, count($statements));
    }
}
