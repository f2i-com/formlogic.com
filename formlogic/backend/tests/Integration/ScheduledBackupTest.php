<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\BackupAlreadyRunningException;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScheduledBackupService;
use FormLogic\Services\UpgradeService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Scheduled nightly backups (bin/backup-accounts.php's ScheduledBackupService):
 * dated day-folders of per-account zips (Settings-restorable) + a whole-site
 * MySQL dump + manifest; retention pruning; heartbeat; per-account restore.
 */
class ScheduledBackupTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AccountBackupService $accountBackup;
    private static string $tmpRoot = '';

    private string $scheduledDir = '';
    private string $userId = '';
    private string $emptyUserId = '';
    private string $demoId = '';
    private bool $createdDemo = false;
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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-schedbackup-test-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        mkdir(self::$tmpRoot . '/uploads', 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$accountBackup = new AccountBackupService(
            $conn, self::$sqlite, self::$forms, self::$apps,
            new AppUserService($conn), new FlowService($conn), self::$responses,
            [], self::$tmpRoot . '/sqlite', self::$tmpRoot . '/uploads'
        );
    }

    private function service(array $configOverride = []): ScheduledBackupService
    {
        $maintenance = new MaintenanceService(self::$tmpRoot . '/maintenance-' . bin2hex(random_bytes(3)) . '.json');
        return new ScheduledBackupService(
            self::$mysql,
            self::$accountBackup,
            new UpgradeService(self::$tmpRoot . '/nowhere', self::$mysql, $maintenance),
            $configOverride + ['scheduledDir' => $this->scheduledDir, 'retentionDays' => 7],
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->scheduledDir = self::$tmpRoot . '/scheduled-' . bin2hex(random_bytes(3));

        $this->userId = $this->makeUser('user');
        $this->emptyUserId = $this->makeUser('empty');

        // The shared demo account must be SKIPPED by the run.
        $demoEmail = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        $stmt = self::$pdo->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$demoEmail]);
        $existing = $stmt->fetchColumn();
        if ($existing === false) {
            $this->demoId = 'u-' . bin2hex(random_bytes(12));
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Demo')")
                ->execute([$this->demoId, $demoEmail]);
            $this->createdDemo = true;
        } else {
            $this->demoId = (string) $existing;
            $this->createdDemo = false;
        }

        $form = self::$forms->createForm([
            'title' => 'Nightly Fixture', 'userId' => $this->userId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $this->formId = (string) $form['id'];
        self::$responses->createResponse($this->formId, ['answers' => ['name' => 'Alice']], null);
        self::$responses->createResponse($this->formId, ['answers' => ['name' => 'Bob']], null);
        self::$apps->createApp(['name' => 'Nightly App'], $this->userId);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->exec("DELETE FROM system_meta WHERE meta_key IN ('scheduled_backup_last_run', 'scheduled_backup_last_status')");
        $ids = [$this->userId, $this->emptyUserId];
        if ($this->createdDemo) {
            $ids[] = $this->demoId;
        }
        foreach ($ids as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id IN (SELECT id FROM forms WHERE user_id = ?)')->execute([$uid]);
            $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $owned->execute([$uid]);
            foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
                self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            }
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function makeUser(string $tag): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', ?)")
            ->execute([$id, "{$id}@test.local", $tag]);
        return $id;
    }

    public function testRunProducesRestorableDayFolderAndSkipsDemo(): void
    {
        $svc = $this->service();
        $summary = $svc->run();
        // The run's OWN stamped date, not a recomputed gmdate(): a suite running across
        // UTC midnight would otherwise look in the wrong day folder (flaked 2026-07-23).
        $date = (string) $summary['date'];
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}$/', $date);
        $dayDir = $this->scheduledDir . '/' . $date;

        $this->assertSame(0, $summary['failed']);
        $this->assertFileExists("{$dayDir}/accounts/{$this->userId}.zip");
        $this->assertFileExists("{$dayDir}/accounts/{$this->emptyUserId}.zip");
        $this->assertFileDoesNotExist("{$dayDir}/accounts/{$this->demoId}.zip", 'the shared demo account is skipped');
        $this->assertFileExists("{$dayDir}/RESTORE.txt");

        // The whole-site dump gunzips and contains schema.
        $dump = (string) gzdecode((string) file_get_contents("{$dayDir}/database.sql.gz"));
        $this->assertStringContainsString('CREATE TABLE', $dump);
        $this->assertStringContainsString('users', $dump);

        // Manifest entries carry verifiable hashes + this user's zip.
        $manifest = json_decode((string) file_get_contents("{$dayDir}/site-manifest.json"), true);
        $this->assertSame('formlogic.scheduledBackup', $manifest['kind']);
        $mine = null;
        foreach ($manifest['usersDetail'] as $u) {
            if (($u['id'] ?? null) === $this->userId) {
                $mine = $u;
            }
            $this->assertNotSame($this->demoId, $u['id'] ?? null);
        }
        $this->assertNotNull($mine);
        $this->assertSame(hash_file('sha256', "{$dayDir}/accounts/{$this->userId}.zip"), $mine['sha256']);

        // Heartbeat stamped.
        $last = $svc->lastRun();
        $this->assertNotNull($last['lastRun']);
        $this->assertSame($date, $last['lastStatus']['date'] ?? null);

        // listRuns surfaces the day with this account listed.
        $runs = $svc->listRuns();
        $this->assertSame($date, $runs[0]['date']);
        $this->assertContains($this->userId, array_column($runs[0]['accounts'], 'id'));
    }

    public function testNightlyZipRestoresThroughTheNormalImportPipeline(): void
    {
        $svc = $this->service();
        $summary = $svc->run();
        // The run's own stamped date — immune to the UTC-midnight race (see above).
        $date = (string) $summary['date'];

        // The admin recovery path: restore the day's zip INTO the account.
        $result = $svc->restoreAccount($date, $this->userId);
        $this->assertCount(1, $result['apps']);
        $this->assertCount(1, $result['forms']);
        $this->assertSame(2, $result['responses']);

        // The account now holds the originals + the restored copies.
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM forms WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(2, (int) $count->fetchColumn());
    }

    public function testRestoreRejectsUnknownDateAndMissingAccount(): void
    {
        $svc = $this->service();
        $svc->run();

        try {
            $svc->restoreAccount('not-a-date', $this->userId);
            $this->fail('expected invalid date rejection');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Invalid backup date', $e->getMessage());
        }
        try {
            $svc->restoreAccount('1999-01-01', $this->userId);
            $this->fail('expected missing-day rejection');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('No backup', $e->getMessage());
        }
    }

    public function testRetentionPrunesOldDayFoldersOnly(): void
    {
        // 9 fake old day-folders + one non-date folder that must survive.
        mkdir($this->scheduledDir, 0750, true);
        for ($i = 1; $i <= 9; $i++) {
            mkdir($this->scheduledDir . '/' . gmdate('Y-m-d', strtotime("-{$i} days") ?: 0), 0750, true);
        }
        mkdir($this->scheduledDir . '/not-a-date-keep-me', 0750, true);

        $summary = $this->service(['retentionDays' => 7])->run();

        $days = array_values(array_filter(scandir($this->scheduledDir) ?: [], fn ($e) => preg_match('/^\d{4}-\d{2}-\d{2}$/', $e) === 1));
        $this->assertCount(7, $days, 'only retentionDays day-folders remain');
        $this->assertContains(gmdate('Y-m-d'), $days, 'today survives');
        $this->assertCount(3, $summary['prunedDays'], 'the three oldest were pruned');
        $this->assertDirectoryExists($this->scheduledDir . '/not-a-date-keep-me');
    }

    public function testSameDayRerunRefreshesInPlace(): void
    {
        $svc = $this->service();
        $svc->run();
        $first = json_decode((string) file_get_contents($this->scheduledDir . '/' . gmdate('Y-m-d') . '/site-manifest.json'), true);
        $svc->run();
        $second = json_decode((string) file_get_contents($this->scheduledDir . '/' . gmdate('Y-m-d') . '/site-manifest.json'), true);
        $this->assertGreaterThanOrEqual($first['startedAt'], $second['startedAt'], 'the same-day folder is refreshed');
        $this->assertCount(1, $svc->listRuns(), 'no duplicate day folders');
    }

    /**
     * A genuinely SEPARATE MySQL session (MySQLConnection holds a static PDO
     * singleton, so it can never provide one) — the stand-in for "another
     * process" in the lock/barrier tests.
     */
    private static function rawPdo(): PDO
    {
        $pdo = new PDO(
            sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                $_ENV['DB_HOST'] ?? '127.0.0.1',
                $_ENV['DB_PORT'] ?? '3306',
                $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            ),
            $_ENV['DB_USERNAME'] ?? 'root',
            $_ENV['DB_PASSWORD'] ?? '',
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
        );
        $pdo->exec("SET time_zone = '+00:00'");
        return $pdo;
    }

    public function testFailedRunPreservesPriorBackupAndHeartbeat(): void
    {
        // Review FL-003: a good run exists…
        $svc = $this->service();
        $first = $svc->run();
        $date = (string) $first['date'];
        $dayDir = $this->scheduledDir . '/' . $date;
        $manifestBefore = hash_file('sha256', "{$dayDir}/site-manifest.json");
        $zipBefore = hash_file('sha256', "{$dayDir}/accounts/{$this->userId}.zip");
        $heartbeatBefore = $svc->lastRun();

        // …then a rerun fails FATALLY mid-build (injected dump failure).
        $maintenance = new MaintenanceService(self::$tmpRoot . '/m-' . bin2hex(random_bytes(3)) . '.json');
        $brokenUpgrade = new class(self::$tmpRoot . '/nowhere', self::$mysql, $maintenance) extends UpgradeService {
            public function dumpDatabase(string $outGzPath, ?callable $afterTable = null): void
            {
                throw new \RuntimeException('boom: injected dump failure');
            }
        };
        $broken = new ScheduledBackupService(
            self::$mysql,
            self::$accountBackup,
            $brokenUpgrade,
            ['scheduledDir' => $this->scheduledDir, 'retentionDays' => 7],
        );
        try {
            $broken->run();
            $this->fail('the injected failure must propagate');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('boom', $e->getMessage());
        }

        // The prior backup is byte-identical, the heartbeat did not advance,
        // a content-free diagnostic exists, and no staging residue remains.
        $this->assertSame($manifestBefore, hash_file('sha256', "{$dayDir}/site-manifest.json"));
        $this->assertSame($zipBefore, hash_file('sha256', "{$dayDir}/accounts/{$this->userId}.zip"));
        $this->assertEquals($heartbeatBefore, $svc->lastRun(), 'heartbeat advances only after atomic publication');
        $this->assertFileExists($this->scheduledDir . '/.failed-' . $date . '.json');
        $diagnostic = (string) file_get_contents($this->scheduledDir . '/.failed-' . $date . '.json');
        $this->assertStringNotContainsString($this->userId, $diagnostic, 'diagnostics carry no backup content');
        $staging = array_filter(scandir($this->scheduledDir) ?: [], fn ($e) => str_starts_with((string) $e, '.staging-'));
        $this->assertSame([], array_values($staging), 'failed staging is removed');

        // A later successful rerun atomically replaces the backup and clears
        // the failure diagnostic.
        $svc->run();
        $this->assertFileDoesNotExist($this->scheduledDir . '/.failed-' . $date . '.json');
        $this->assertFileExists("{$dayDir}/accounts/{$this->userId}.zip");
    }

    public function testConcurrentRunIsRefusedWithTypedError(): void
    {
        // Review FL-005: a second CONNECTION (≙ another process) holds the lock.
        $otherPdo = self::rawPdo();
        $db = (string) $otherPdo->query('SELECT DATABASE()')->fetchColumn();
        $lockName = 'formlogic.scheduled_backup.' . $db;
        $stmt = $otherPdo->prepare('SELECT GET_LOCK(?, 0)');
        $stmt->execute([$lockName]);
        $this->assertSame(1, (int) $stmt->fetchColumn(), 'fixture lock acquired');

        try {
            try {
                $this->service()->run();
                $this->fail('a concurrent run must be refused');
            } catch (BackupAlreadyRunningException $e) {
                $this->assertStringContainsString('already in progress', $e->getMessage());
            }
            // The loser wrote nothing.
            $this->assertDirectoryDoesNotExist($this->scheduledDir . '/' . gmdate('Y-m-d'));
        } finally {
            $release = $otherPdo->prepare('SELECT RELEASE_LOCK(?)');
            $release->execute([$lockName]);
            $release->fetchColumn();
        }

        // After release (≙ exception paths released the lock) the run succeeds.
        $summary = $this->service()->run();
        $this->assertSame(0, $summary['failed']);
        $this->assertFileExists($this->scheduledDir . '/' . $summary['date'] . '/site-manifest.json');
    }

    public function testDatabaseDumpUsesOneConsistentSnapshotAndFailsAtomically(): void
    {
        // Review FL-004: rows written AFTER the snapshot begins are invisible
        // in EVERY table of the dump — no mixed-instant restores.
        $maintenance = new MaintenanceService(self::$tmpRoot . '/m-' . bin2hex(random_bytes(3)) . '.json');
        $upgrade = new UpgradeService(self::$tmpRoot . '/nowhere', self::$mysql, $maintenance);
        $out = self::$tmpRoot . '/dump-' . bin2hex(random_bytes(3)) . '.sql.gz';

        $beforeMarker = 'barrier-before-' . bin2hex(random_bytes(6));
        $beforeId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'B')")
            ->execute([$beforeId, "{$beforeMarker}@test.local"]);

        $afterMarker = 'barrier-after-' . bin2hex(random_bytes(6));
        $afterId = 'u-' . bin2hex(random_bytes(12));
        $writerPdo = self::rawPdo();
        $injected = false;
        try {
            $upgrade->dumpDatabase($out, function () use (&$injected, $writerPdo, $afterId, $afterMarker): void {
                if ($injected) {
                    return;
                }
                $injected = true;
                // A CONCURRENT writer commits while the dump is mid-flight
                // ('users' is dumped later in SHOW TABLES order).
                $writerPdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'A')")
                    ->execute([$afterId, "{$afterMarker}@test.local"]);
            });
            $this->assertTrue($injected, 'the barrier writer ran');
            // Sanity: the concurrent write really committed…
            $check = self::$pdo->prepare('SELECT COUNT(*) FROM users WHERE id = ?');
            $check->execute([$afterId]);
            $this->assertSame(1, (int) $check->fetchColumn());
            // …but the snapshot dump shows the pre-change state only.
            $dump = (string) gzdecode((string) file_get_contents($out));
            // str_contains inside assertTrue, NOT assertStringContainsString: PHPUnit exports the
            // asserted value into its event stream on every assertion — pass or fail — and this
            // one is a whole-database SQL dump. Handing it over duplicates megabytes per call and
            // exhausts the CLI memory limit as the suite grows. The assertion is identical; only
            // what PHPUnit is asked to stringify changes.
            $this->assertTrue(str_contains($dump, $beforeMarker), 'the pre-snapshot row is in the dump');
            $this->assertFalse(str_contains($dump, $afterMarker), 'post-snapshot writes must not leak into the dump');
            unset($dump); // release before the second dump below allocates its own

            // A mid-dump failure publishes nothing and leaves no temp files.
            $failOut = self::$tmpRoot . '/dump-fail-' . bin2hex(random_bytes(3)) . '.sql.gz';
            try {
                $upgrade->dumpDatabase($failOut, function (): void {
                    throw new \RuntimeException('boom: injected mid-dump failure');
                });
                $this->fail('the injected failure must propagate');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('boom', $e->getMessage());
            }
            $this->assertFileDoesNotExist($failOut);
            $this->assertSame([], glob($failOut . '.tmp-*') ?: [], 'no temp residue after a failed dump');
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id IN (?, ?)')->execute([$beforeId, $afterId]);
        }
    }

    public function testIncludeFilesFalseSkipsUploads(): void
    {
        // Give the fixture form an uploaded file on disk.
        $safeId = preg_replace('/[^a-zA-Z0-9\-]/', '', $this->formId);
        mkdir(self::$tmpRoot . '/uploads/' . $safeId, 0777, true);
        file_put_contents(self::$tmpRoot . '/uploads/' . $safeId . '/file-abc.pdf', 'PDF');

        $this->service(['scheduledIncludeFiles' => false])->run();

        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($this->scheduledDir . '/' . gmdate('Y-m-d') . "/accounts/{$this->userId}.zip") === true);
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $this->assertStringStartsNotWith('files/', (string) $zip->getNameIndex($i), 'records-only backups carry no uploads');
        }
        $zip->close();
    }
}
