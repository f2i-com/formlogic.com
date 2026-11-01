<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * bin/backup-accounts.php is also the only purge a quiet form gets, and a run that failed used to exit
 * before any of it: the disk too full to write the dump was the night nothing was freed. The real
 * script, run as cron runs it.
 */
final class NightlyMaintenanceTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];

    private string $userId = '';
    private string $formId = '';
    private string $recordId = '';
    private string $relativeStorage = '';
    private string $storage = '';
    private string $failureNote = '';
    private bool $failureNoteWasThere = false;

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
            $conn->ensureSchemaCurrent(true);
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $backend = dirname(__DIR__, 2);
        $this->relativeStorage = 'storage/fl-nightly-test-' . bin2hex(random_bytes(5));
        $this->storage = $backend . '/' . $this->relativeStorage;
        mkdir($this->storage, 0777, true);
        $this->failureNote = $backend . '/storage/backups/scheduled/.failed-' . gmdate('Y-m-d') . '.json';
        $this->failureNoteWasThere = is_file($this->failureNote);

        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $sqlite = new SQLiteConnection($this->storage);
        $forms = new FormService(self::$mysql, $sqlite);
        $this->formId = (string) $forms->createForm([
            'user_id' => $this->userId,
            'title' => 'Keeps a day',
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'order' => 0, 'properties' => []]],
            'settings' => ['retentionDays' => 1],
        ])['id'];

        // A record ten days old on a form that keeps them for one.
        $this->recordId = 'r' . bin2hex(random_bytes(10));
        $old = gmdate('Y-m-d H:i:s', time() - 10 * 86400);
        $db = $sqlite->getFormDatabase($this->formId);
        $sqlite->migrateFormDatabase($db);
        $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (?, '{\"name\":\"Old\"}', '{}', 'submitted', ?, ?)")
            ->execute([$this->recordId, $old, $old]);
        $db = null;
        self::$pdo->prepare("INSERT INTO response_metadata (id, form_id, status, submitted_at) VALUES (?, ?, 'submitted', ?)")
            ->execute([$this->recordId, $this->formId, $old]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        if (!$this->failureNoteWasThere) {
            @unlink($this->failureNote);
        }
        foreach (glob($this->storage . '/{,.}*', GLOB_BRACE) ?: [] as $file) {
            if (is_file($file)) {
                @unlink($file);
            }
        }
        @rmdir($this->storage);
    }

    /** @return array{0:int, 1:string} exit code, and what it wrote */
    private function runJob(array $env): array
    {
        $base = [
            'DB_HOST' => self::$config['host'], 'DB_PORT' => self::$config['port'], 'DB_DATABASE' => self::$config['database'],
            'DB_USERNAME' => self::$config['username'], 'DB_PASSWORD' => self::$config['password'],
            'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir(),
            'APP_ENV' => 'development', 'SQLITE_STORAGE_PATH' => $this->relativeStorage, 'DATA_ENCRYPTION_KEY' => '',
        ];
        // Two files: two handles on one would write over each other on Windows.
        $out = (string) tempnam(sys_get_temp_dir(), 'fl-nightly-');
        $errors = (string) tempnam(sys_get_temp_dir(), 'fl-nightly-');
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', dirname(__DIR__, 2) . '/bin/backup-accounts.php'],
            [1 => ['file', $out, 'a'], 2 => ['file', $errors, 'a']],
            $pipes,
            null,
            $env + $base
        );
        self::assertIsResource($process);
        $code = proc_close($process);
        $output = (string) file_get_contents($out) . (string) file_get_contents($errors);
        @unlink($out);
        @unlink($errors);
        return [$code, $output];
    }

    private function recordIsThere(): bool
    {
        $sqlite = new SQLiteConnection($this->storage);
        $stmt = $sqlite->getFormDatabase($this->formId)->prepare('SELECT COUNT(*) FROM responses WHERE id = ?');
        $stmt->execute([$this->recordId]);
        return (int) $stmt->fetchColumn() === 1;
    }

    public function testAFailedRunStillPurgesAndStillExitsNonZero(): void
    {
        [$code, $output] = $this->runJob(['BACKUP_PUBLIC_KEY' => 'not-a-key']);

        self::assertStringContainsString('backup run FAILED', $output);
        self::assertStringContainsString('trash purge:', $output);
        self::assertStringContainsString('upload GC:', $output);
        self::assertStringContainsString('webhook log:', $output);
        self::assertFalse($this->recordIsThere(), "the record past the form's retention went: {$output}");
        self::assertSame(1, $code, 'cron still hears about the failed backup');
    }

    public function testBesideAnotherBackupOnlyTheWebhookLogIsPruned(): void
    {
        $lock = 'formlogic.scheduled_backup.' . self::$config['database'];
        $stmt = self::$pdo->prepare('SELECT GET_LOCK(?, 0)');
        $stmt->execute([$lock]);
        self::assertSame(1, (int) $stmt->fetchColumn());
        try {
            [$code, $output] = $this->runJob([]);
        } finally {
            self::$pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lock]);
        }

        self::assertStringContainsString('another backup run is already in progress', $output);
        self::assertStringNotContainsString('trash purge:', $output);
        self::assertStringNotContainsString('retention:', $output);
        self::assertStringContainsString('webhook log:', $output);
        self::assertTrue($this->recordIsThere(), 'nothing a backup may be reading goes from under it');
        self::assertSame(0, $code);
    }
}
