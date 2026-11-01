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
 * An export takes pages of a form that keeps changing. A new record used to push one already read
 * onto the next page, so the file held it twice and a sum in a spreadsheet came out high, and a
 * deleted record hid the row after it. The writes here land between two pages, every time.
 *
 * Skipped unless a test database is reachable.
 */
class ExportPagingTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;

    private string $userId = '';
    private string $formId = '';

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-exportpaging-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->formId = 'form' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$this->formId, $this->userId]);
    }

    protected function tearDown(): void
    {
        self::$pdo?->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo?->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function db(): PDO
    {
        return self::$sqlite->getFormDatabase($this->formId);
    }

    /** Rows sharing their seconds, as a burst of submissions or an import does. */
    private function seed(int $rows, string $prefix = 'seed'): void
    {
        $db = $this->db();
        $db->beginTransaction();
        $insert = $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', ?)");
        for ($i = 0; $i < $rows; $i++) {
            $insert->execute([sprintf('%s-%05d', $prefix, $i), json_encode(['t1' => "Row $i"]), gmdate('Y-m-d H:i:s', 1700000000 + (int) floor($i / 7))]);
        }
        $db->commit();
    }

    /** A service that lets something happen each time it hands over a page. */
    private function serviceWith(callable $betweenPages): ResponseService
    {
        return new class (self::$mysql, self::$sqlite, $betweenPages) extends ResponseService {
            /** @var callable */ private $betweenPages;
            public function __construct(MySQLConnection $mysql, SQLiteConnection $sqlite, callable $betweenPages)
            {
                parent::__construct($mysql, $sqlite);
                $this->betweenPages = $betweenPages;
            }
            public function getFormResponses(string $formId, array $options = []): array
            {
                $page = parent::getFormResponses($formId, $options);
                ($this->betweenPages)();
                return $page;
            }
        };
    }

    /** @return array{header: string[], ids: string[]} */
    private function export(ResponseService $service, ?string $onlyUser = null, int $maxRows = 100000): array
    {
        $stream = fopen('php://temp', 'r+');
        $service->exportResponsesStreaming($this->formId, [['id' => 't1', 'type' => 'short_text', 'label' => 'Name']], $stream, $onlyUser, null, $maxRows);
        rewind($stream);
        fread($stream, 3); // the BOM
        $header = fgetcsv($stream, null, ',', '"', '');
        $ids = [];
        while (($row = fgetcsv($stream, null, ',', '"', '')) !== false) {
            $ids[] = (string) $row[0];
        }
        fclose($stream);
        return ['header' => $header, 'ids' => $ids];
    }

    public function testARecordArrivingDuringAnExportRepeatsNothing(): void
    {
        $this->seed(1300);
        $n = 0;
        $service = $this->serviceWith(function () use (&$n): void {
            $at = gmdate('Y-m-d H:i:s');
            $this->db()->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, '{}', '{}', 'submitted', ?)")
                ->execute(['live-' . ++$n, $at]);
        });

        $ids = $this->export($service)['ids'];

        $seeded = array_values(array_filter($ids, static fn (string $id) => str_starts_with($id, 'seed-')));
        $this->assertCount(1300, $seeded, 'every record that was there is in the file');
        $this->assertSame($ids, array_values(array_unique($ids)), 'and none of them twice');
    }

    public function testARecordDeletedDuringAnExportHidesNoOther(): void
    {
        $this->seed(1300);
        $deleted = [];
        $service = $this->serviceWith(function () use (&$deleted): void {
            // The newest row, already read: by offset, this moved every later row back one.
            $id = $this->db()->query('SELECT id FROM responses ORDER BY submitted_at DESC, id DESC LIMIT 1')->fetchColumn();
            if ($id !== false) {
                $this->db()->prepare('DELETE FROM responses WHERE id = ?')->execute([$id]);
                $deleted[] = $id;
            }
        });

        $ids = $this->export($service)['ids'];

        $expected = array_map(static fn (int $i) => sprintf('seed-%05d', $i), range(0, 1299));
        $this->assertSame([], array_values(array_diff($expected, $ids)), 'no record went missing');
        $this->assertNotSame([], $deleted);
    }

    public function testTheTimeColumnSaysItsZone(): void
    {
        $this->seed(1);
        $this->assertSame('Submitted At (UTC)', $this->export(new ResponseService(self::$mysql, self::$sqlite))['header'][1]);
    }

    public function testAMemberStillGetsOnlyTheirOwnRowsAcrossPages(): void
    {
        $db = $this->db();
        $db->beginTransaction();
        $insert = $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, '{}', ?, 'submitted', '2026-01-01 00:00:00')");
        for ($i = 0; $i < 1200; $i++) {
            $insert->execute([sprintf('r-%05d', $i), json_encode(['submittedByUserId' => $i % 2 === 0 ? 'me' : 'them'])]);
        }
        $db->commit();

        $ids = $this->export(new ResponseService(self::$mysql, self::$sqlite), 'me')['ids'];

        $this->assertCount(600, $ids);
        $this->assertSame($ids, array_values(array_unique($ids)));
        $this->assertSame([], array_filter($ids, static fn (string $id) => (int) substr($id, 2) % 2 === 1));
    }

    public function testTheCapStillSaysWhenItStopped(): void
    {
        $this->seed(1200);
        $ids = $this->export(new ResponseService(self::$mysql, self::$sqlite), null, 1000)['ids'];
        $this->assertCount(1001, $ids); // 1000 rows, then the line that says it stopped
        $this->assertStringStartsWith('Export stopped at 1000 rows', $ids[1000]);

        $this->assertCount(1200, $this->export(new ResponseService(self::$mysql, self::$sqlite), null, 1200)['ids']);
    }

    public function testAnAppSqlDumpLosesNoRowToADelete(): void
    {
        $this->seed(1300);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', '{}')")
            ->execute([$appId = 'app' . bin2hex(random_bytes(8)), $this->userId, $slug = 'dump' . bin2hex(random_bytes(6))]);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af' . bin2hex(random_bytes(8)), $appId, $this->formId]);
        $apps = new AppService(self::$mysql, self::$forms);
        $export = new AppDataExportService(self::$mysql, self::$sqlite, self::$forms, $apps, sys_get_temp_dir());

        $text = '';
        $deletedOnce = false;
        $export->generateSqlDump($apps->getApp($appId), 'mysql', function (string $chunk, bool $isStatement) use (&$text, &$deletedOnce): void {
            $text .= $chunk . "\n";
            // After the first batch of rows has been read, one of them goes.
            if (!$deletedOnce && str_contains($chunk, "'seed-00000'")) {
                $deletedOnce = true;
                $this->db()->exec("DELETE FROM responses WHERE id = 'seed-00000'");
            }
        });

        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);

        $this->assertTrue($deletedOnce);
        for ($i = 0; $i < 1300; $i++) {
            $this->assertStringContainsString(sprintf("'seed-%05d'", $i), $text);
        }
    }
}
