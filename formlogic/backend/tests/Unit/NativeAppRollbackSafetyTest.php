<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Synthetic databases only. The helper checks do not require the native runtime. */
final class NativeAppRollbackSafetyTest extends TestCase
{
    private string $storage;

    protected function setUp(): void
    {
        $this->assertTrue(extension_loaded('sqlite3'), 'The rollback helper requires ext-sqlite3.');
        $this->storage = sys_get_temp_dir() . '/formlogic-rollback-test-' . bin2hex(random_bytes(10));
        mkdir($this->storage, 0700);
    }

    protected function tearDown(): void
    {
        if (!isset($this->storage) || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-rollback-test-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) {
            if ($file->isLink() || !$file->isDir()) unlink($file->getPathname());
            else rmdir($file->getPathname());
        }
        rmdir($root);
    }

    public function testAnIdleRetainedConnectionSeesTheRestoredDatabaseAndRemainsWritable(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $sourceHash = hash_file('sha256', $snapshot);
        $retained = $this->database($database);
        try {
            $this->assertSame('current', $retained->querySingle('SELECT value FROM records'));
            $this->helper()->restoreSnapshot($snapshot, $database);
            $this->assertSame('snapshot', $retained->querySingle('SELECT value FROM records'));
            $this->assertSame(0, $retained->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='introduced'"));
            $retained->exec("INSERT INTO records(id, value) VALUES(2, 'after rollback')");
            $this->assertSame(['snapshot', 'after rollback'], $this->values($database));
            $this->assertSame('ok', $retained->querySingle('PRAGMA integrity_check'));
            $this->assertSame($sourceHash, hash_file('sha256', $snapshot), 'the recovery snapshot is immutable');
        } finally { $retained->close(); }
    }

    public function testAWalReaderKeepsItsSnapshotWhileNewAndLaterReadsSeeTheRestore(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $reader = $this->database($database);
        $writer = $this->database($database);
        $sourceHash = hash_file('sha256', $snapshot);
        try {
            $reader->exec('BEGIN');
            $this->assertSame('current', $reader->querySingle('SELECT value FROM records'));
            $writer->exec("UPDATE records SET value='committed after reader'; INSERT INTO introduced VALUES('later frame')");
            $this->assertSame(['committed after reader'], $this->values($database));
            $this->helper()->restoreSnapshot($snapshot, $database);
            $this->assertSame('current', $reader->querySingle('SELECT value FROM records'), 'the old read transaction remains consistent');
            $this->assertSame(0, $reader->querySingle('SELECT COUNT(*) FROM introduced'), 'later frames do not leak into the old reader');
            $this->assertSame(['snapshot'], $this->values($database), 'new connections see the restored generation');
            $reader->exec('COMMIT');
            $this->assertSame('snapshot', $reader->querySingle('SELECT value FROM records'), 'the retained connection can enter the restored generation');
            $this->assertSame(0, $reader->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='introduced'"));
            $writer->exec("INSERT INTO records(id, value) VALUES(2, 'still usable')");
            $this->assertSame(['snapshot', 'still usable'], $this->values($database));
            $this->assertSame($sourceHash, hash_file('sha256', $snapshot));
        } finally { $reader->close(); $writer->close(); }
    }

    public function testAWalWriterCausesBoundedFailureWithoutChangingTheDatabaseAndReleaseAllowsRetry(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $writer = $this->database($database);
        try {
            $writer->exec("BEGIN IMMEDIATE; UPDATE records SET value='uncommitted'");
            $before = $this->databaseFiles($database);
            $sourceHash = hash_file('sha256', $snapshot);
            $this->assertRestoreFails($this->helper(), $snapshot, $database);
            $this->assertSame($before, $this->databaseFiles($database), 'failed backup changes neither main file nor committed WAL');
            $this->assertSame(['current'], $this->values($database));
            $this->assertSame('uncommitted', $writer->querySingle('SELECT value FROM records'));
            $this->assertSame($sourceHash, hash_file('sha256', $snapshot));
            $writer->exec('ROLLBACK');
            $this->helper()->restoreSnapshot($snapshot, $database);
            $this->assertSame(['snapshot'], $this->values($database));
        } finally { $writer->close(); }
    }

    public function testARollbackJournalReaderCausesBoundedFailureAndReleaseAllowsRetry(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $reader = $this->database($database);
        try {
            $reader->exec('BEGIN');
            $this->assertSame('current', $reader->querySingle('SELECT value FROM records'));
            $before = $this->databaseFiles($database);
            $this->assertRestoreFails($this->helper(), $snapshot, $database);
            $this->assertSame($before, $this->databaseFiles($database));
            $this->assertSame(['current'], $this->values($database));
            $this->assertSame('current', $reader->querySingle('SELECT value FROM records'));
            $reader->exec('COMMIT');
            $this->helper()->restoreSnapshot($snapshot, $database);
            $this->assertSame(['snapshot'], $this->values($database));
        } finally { $reader->close(); }
    }

    public function testMissingDestinationRefusesWithoutCreatingItOrChangingOrphanSidecars(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $this->assertTrue(unlink($database));
        file_put_contents($database . '-wal', 'synthetic orphan WAL');
        file_put_contents($database . '-shm', 'synthetic orphan shared memory');
        $snapshotHash = hash_file('sha256', $snapshot);
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('The live database could not be opened:', $error->getMessage(), 'it says which file is missing');
        $this->assertStringNotContainsString('snapshot', $error->getMessage());
        $this->assertFileDoesNotExist($database);
        $this->assertSame('synthetic orphan WAL', file_get_contents($database . '-wal'));
        $this->assertSame('synthetic orphan shared memory', file_get_contents($database . '-shm'));
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
    }

    public function testAGarbageLiveDatabaseIsNamedAsTheLiveDatabaseAndLeftAsItWas(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        file_put_contents($database, str_repeat('synthetic garbage in place of the live database ', 200));
        $liveHash = hash_file('sha256', $database);
        $snapshotHash = hash_file('sha256', $snapshot);
        $service = $this->helper();
        $error = $this->assertRestoreFails($service, $snapshot, $database);
        $this->assertStringContainsString('The live database could not be', $error->getMessage(), 'it says which file is garbage');
        $this->assertStringContainsString('file is not a database', $error->getMessage());
        $this->assertStringNotContainsString('snapshot', $error->getMessage());
        $this->assertSame($liveHash, hash_file('sha256', $database));
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
        // Nothing here can pass, so a rollback gives up on it at once.
        $started = microtime(true);
        try { $service->restoreSnapshotWithRetry($snapshot, $database); $this->fail('A garbage live database was restored over'); }
        catch (\RuntimeException $retried) { $this->assertStringContainsString('The live database could not be', $retried->getMessage()); }
        $this->assertLessThan(1.0, microtime(true) - $started);
    }

    public function testCorruptSnapshotRefusesBeforeChangingTheDestination(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        file_put_contents($snapshot, str_repeat('synthetic corrupt snapshot ', 200));
        $snapshotHash = hash_file('sha256', $snapshot);
        $before = $this->databaseFiles($database);
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('snapshot', $error->getMessage(), 'it says which file is damaged');
        $this->assertStringNotContainsString('live database', $error->getMessage());
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
    }

    public function testMissingSnapshotRefusesWithoutChangingTheDestination(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $this->assertTrue(unlink($snapshot));
        $before = $this->databaseFiles($database);
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('The snapshot could not be opened:', $error->getMessage(), 'it says which file is missing');
        $this->assertStringNotContainsString('live database', $error->getMessage());
        $this->assertFileDoesNotExist($snapshot);
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
    }

    public function testAnEmptySnapshotIsRefusedBecauseRestoringItWouldEmptyTheDatabase(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        file_put_contents($snapshot, '');
        $before = $this->databaseFiles($database);
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('snapshot is empty', $error->getMessage());
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
    }

    /** Guard: the pre-restore check is what keeps a damaged snapshot from replacing healthy data. */
    public function testASnapshotThatIsReadableButFailsQuickCheckLeavesTheLiveDataAlone(): void
    {
        $snapshot = $this->storage . '/snapshot.sqlite';
        $database = $this->storage . '/application.sqlite';
        $source = new \SQLite3($snapshot);
        $source->enableExceptions(true);
        try {
            $source->exec('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); BEGIN');
            for ($i = 1; $i <= 600; $i++) $source->exec("INSERT INTO records VALUES($i, '" . str_repeat('x', 40) . "$i')");
            $source->exec('COMMIT');
            $pageSize = (int) $source->querySingle('PRAGMA page_size');
            $pages = (int) $source->querySingle('PRAGMA page_count');
        } finally { $source->close(); }
        $this->assertGreaterThan(3, $pages);
        // The last page is a leaf of the table's b-tree: give it a page type SQLite does not have.
        $handle = fopen($snapshot, 'r+b');
        fseek($handle, ($pages - 1) * $pageSize);
        fwrite($handle, "\x01");
        fclose($handle);
        $reader = new \SQLite3($snapshot, SQLITE3_OPEN_READONLY);
        try {
            $this->assertSame($pages, $reader->querySingle('PRAGMA page_count'), 'the snapshot still opens and reads');
            $this->assertNotSame('ok', $reader->querySingle('PRAGMA quick_check'));
        } finally { $reader->close(); }
        $live = new \SQLite3($database);
        $live->enableExceptions(true);
        try { $live->exec("PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES(1, 'live and healthy')"); }
        finally { $live->close(); }
        $snapshotHash = hash_file('sha256', $snapshot);
        $before = $this->databaseFiles($database);
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('failed its integrity check', $error->getMessage());
        $this->assertSame($before, $this->databaseFiles($database), 'the check runs before the restore, so nothing of the live database is written');
        $this->assertSame(['live and healthy'], $this->values($database));
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
    }

    public function testASnapshotThatStaysLockedIsReportedAsUncheckedNotAsDamaged(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $lock = $this->database($snapshot);
        try {
            $lock->exec('BEGIN EXCLUSIVE');
            $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
            $lock->exec('ROLLBACK');
        } finally { $lock->close(); }
        $this->assertStringContainsString('could not be checked because it is locked', $error->getMessage());
        $this->assertStringNotContainsString('failed its integrity check', $error->getMessage());
        $this->assertSame(5, $error->getCode() & 0xFF);
        $this->assertSame(['current'], $this->values($database));
    }

    // ── Waiting out locks: SQLite's busy timeouts and the rollback's bounded retry ───────────────

    public function testALockHeldBrieflyByAnotherProcessIsWaitedOut(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $holder = $this->holdLock($database, "BEGIN IMMEDIATE; UPDATE records SET value='held'", 700);
        try {
            $started = microtime(true);
            $this->helper()->restoreSnapshot($snapshot, $database);
            $elapsed = microtime(true) - $started;
        } finally { $this->releaseLock($holder); }
        $this->assertGreaterThanOrEqual(0.4, $elapsed, 'the restore waited for the writer instead of failing at once');
        $this->assertLessThan(5.0, $elapsed);
        $this->assertSame(['snapshot'], $this->values($database), 'the writer rolled back and the snapshot was restored');
    }

    public function testALockOnTheSnapshotWhileItIsBeingCopiedIsWaitedOut(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $snapshotHash = hash_file('sha256', $snapshot);
        $service = $this->helper();
        $holder = null;
        $service->beforeBackup = function () use (&$holder, $snapshot): void { $holder = $this->holdLock($snapshot, 'BEGIN EXCLUSIVE', 600); };
        try {
            $started = microtime(true);
            $service->restoreSnapshot($snapshot, $database);
            $elapsed = microtime(true) - $started;
        } finally { if ($holder !== null) $this->releaseLock($holder); }
        $this->assertGreaterThanOrEqual(0.4, $elapsed, 'the restore waited for the lock on the snapshot');
        $this->assertSame(['snapshot'], $this->values($database));
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
    }

    public function testALockOnTheSnapshotBeforeTheRestoreIsWaitedOutByItsHealthCheck(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $holder = $this->holdLock($snapshot, 'BEGIN EXCLUSIVE', 600);
        try {
            $started = microtime(true);
            $this->helper()->restoreSnapshot($snapshot, $database);
            $elapsed = microtime(true) - $started;
        } finally { $this->releaseLock($holder); }
        $this->assertGreaterThanOrEqual(0.4, $elapsed);
        $this->assertSame(['snapshot'], $this->values($database));
    }

    public function testALockThatOutlastsTheRetriesFailsWithinTheBudgetAndLeavesTheDatabaseAlone(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $writer = $this->database($database);
        $service = $this->helper();
        try {
            $writer->exec("BEGIN IMMEDIATE; UPDATE records SET value='uncommitted'");
            $before = $this->databaseFiles($database);
            $snapshotHash = hash_file('sha256', $snapshot);
            $error = null;
            $started = microtime(true);
            try { $service->restoreSnapshotWithRetry($snapshot, $database); }
            catch (\RuntimeException $caught) { $error = $caught; }
            $elapsed = microtime(true) - $started;
            $this->assertNotNull($error, 'a lock that never passes must not report success');
            $this->assertGreaterThanOrEqual(2.0, $elapsed, 'it was retried inside its budget');
            $this->assertLessThan(5.0, $elapsed, 'and gave up inside it');
            $this->assertGreaterThanOrEqual(2, $service->backupCalls);
            $this->assertLessThanOrEqual(3, $service->backupCalls);
            $this->assertSame(5, $error->getCode(), 'SQLite BUSY travels with the exception');
            $this->assertStringContainsString('The live database could not be restored', $error->getMessage());
            $this->assertStringContainsString('database is locked (SQLite error 5)', $error->getMessage());
            $this->assertStringContainsString('attempts', $error->getMessage());
            $this->assertStringContainsString('NATIVE_ROLLBACK_SAFETY.md', $error->getMessage());
            $this->assertStringNotContainsString('source database is busy', $error->getMessage(), 'it is the live database that was busy');
            $this->assertNotNull($error->getPrevious());
            $this->assertSame($before, $this->databaseFiles($database), 'failed attempts change neither the main file nor the committed WAL');
            $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
            $writer->exec('ROLLBACK');
        } finally { $writer->close(); }
        $this->assertSame(['current'], $this->values($database));
    }

    public function testAWriterInAnotherProcessThatHoldsItForThreeSecondsFailsTheRollbackInBoundedTime(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $service = $this->helper();
        $holder = $this->holdLock($database, "BEGIN IMMEDIATE; UPDATE records SET value='held'", 3300);
        try {
            $before = $this->databaseFiles($database);
            $started = microtime(true);
            try { $service->restoreSnapshotWithRetry($snapshot, $database); $this->fail('A lock that outlasts the budget must not report success'); }
            catch (\RuntimeException $error) { $this->assertSame(5, $error->getCode()); }
            $elapsed = microtime(true) - $started;
            $this->assertGreaterThanOrEqual(2.0, $elapsed, 'the lock was waited for');
            $this->assertLessThan(5.0, $elapsed, 'and given up on inside the budget, not when the writer let go');
            $this->assertSame($before, $this->databaseFiles($database), 'nothing of the live database was written');
        } finally { $this->releaseLock($holder); }
        $this->assertSame(['current'], $this->values($database), 'the writer rolled back and the live data is as it was');
    }

    public function testALockThatPassesDuringARetryIsWaitedOutAndTheRestoreSucceeds(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $writer = $this->database($database);
        $service = $this->helper();
        // The first attempt meets the writer and fails with BUSY; the writer goes before the second.
        $service->beforeBackup = static function (int $call) use ($writer): void { if ($call === 2) $writer->exec('ROLLBACK'); };
        try {
            $writer->exec("BEGIN IMMEDIATE; UPDATE records SET value='uncommitted'");
            $service->restoreSnapshotWithRetry($snapshot, $database);
        } finally { $writer->close(); }
        $this->assertSame(2, $service->backupCalls);
        $this->assertSame(['snapshot'], $this->values($database));
    }

    /** @return list<array{string}> */
    public static function backupFaults(): array { return [['false'], ['throw'], ['destination-transaction']]; }

    #[DataProvider('backupFaults')]
    public function testAFailureThatCannotPassIsAttemptedOnceAndNamesTheLiveDatabase(string $fault): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $service = $this->helper($fault);
        $started = microtime(true);
        try { $service->restoreSnapshotWithRetry($snapshot, $database); $this->fail('Unsafe restore reported success'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('The live database could not be restored', $error->getMessage()); }
        $this->assertSame(1, $service->backupCalls);
        $this->assertLessThan(1.0, microtime(true) - $started, 'no pause or wait follows a failure that cannot pass');
        $this->assertSame(['current'], $this->values($database));
    }

    public function testOnlyBusyAndLockedAreTreatedAsTransient(): void
    {
        $transient = new \ReflectionMethod(NativeAppService::class, 'isTransientSqliteError');
        // 261 BUSY_RECOVERY, 517 BUSY_SNAPSHOT, 262 LOCKED_SHAREDCACHE; 1 ERROR, 8 READONLY, 11 CORRUPT, 14 CANTOPEN, 26 NOTADB
        foreach ([5 => true, 6 => true, 261 => true, 517 => true, 262 => true, 0 => false, 1 => false, 8 => false, 11 => false, 14 => false, 26 => false] as $code => $expected) {
            $this->assertSame($expected, $transient->invoke(null, $code), 'SQLite code ' . $code);
        }
    }

    public function testAFailedBackupNamesTheLiveDatabaseAndSQLitesOwnReason(): void
    {
        // A WAL database with 8192-byte pages cannot take a 4096-byte-page snapshot. PHP's own
        // message for that is "Backup failed: not an error"; SQLite's is what the operator needs.
        [$snapshot, $database] = $this->databases('DELETE');
        $live = $this->database($database);
        try { $live->exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=8192; VACUUM; PRAGMA journal_mode=WAL'); }
        finally { $live->close(); }
        $error = $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertStringContainsString('The live database could not be restored', $error->getMessage());
        $this->assertStringContainsString('(SQLite error 8)', $error->getMessage());
        $this->assertStringNotContainsString('not an error', $error->getMessage());
        $this->assertStringNotContainsString('source database is busy', $error->getMessage());
        $this->assertSame(8, $error->getCode());
        $this->assertSame(['current'], $this->values($database));
    }

    public function testTheSnapshotIsOpenedReadOnlyAndCannotBeWrittenThroughTheRestore(): void
    {
        [$snapshot, $database] = $this->databases('WAL');
        $snapshotHash = hash_file('sha256', $snapshot);
        $service = $this->helper();
        $writeRefused = null;
        $service->beforeBackup = static function (int $call, \SQLite3 $source) use (&$writeRefused): void {
            try { $source->exec('CREATE TABLE intruder(value TEXT)'); $writeRefused = false; }
            catch (\Throwable $refused) { $writeRefused = true; }
            // The refusal is the handle's last error; a clean statement clears it, as it would have been.
            $source->querySingle('SELECT 1');
        };
        $service->restoreSnapshot($snapshot, $database);
        $this->assertTrue($writeRefused, 'the handle on the recovery snapshot cannot write');
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
        $this->assertSame(['snapshot'], $this->values($database));
    }

    public function testAnErrorLeftOnTheSnapshotHandleFailsTheRestoreEvenWhenTheBackupReportsSuccess(): void
    {
        // The error codes of both handles are read right after the backup, whatever it returned.
        // The destination's is rewritten by the backup itself (the destination-transaction fault
        // covers it); the snapshot handle's is not, so a refused write left on it before the
        // backup, SQLite error 8, is still there afterwards although the backup completed and
        // returned true. Failing is the safe answer: the caller keeps the journal in recovery.
        [$snapshot, $database] = $this->databases('DELETE');
        $service = $this->helper();
        $service->beforeBackup = static function (int $call, \SQLite3 $source): void {
            try { $source->exec('CREATE TABLE intruder(value TEXT)'); } catch (\Throwable $refused) { /* the error stays on the handle */ }
        };
        $error = $this->assertRestoreFails($service, $snapshot, $database);
        $this->assertStringContainsString('The live database could not be restored', $error->getMessage());
        $this->assertStringContainsString('(SQLite error 8)', $error->getMessage());
        $this->assertSame(1, $service->backupCalls);
    }

    public function testARestoreThatLeavesAnUnhealthyDatabaseIsReportedAsFailed(): void
    {
        // The snapshot passes its own check and the backup completes; the damage appears in the
        // restored database, so only the check after the restore can catch it. The page type of
        // the table's root is spoiled on disk and a second connection's write makes the
        // restoring handle drop its cached pages and read what is really there.
        [$snapshot, $database] = $this->databases('DELETE');
        $source = new \SQLite3($snapshot, SQLITE3_OPEN_READONLY);
        try { $pageSize = (int) $source->querySingle('PRAGMA page_size'); $root = (int) $source->querySingle("SELECT rootpage FROM sqlite_master WHERE name='records'"); }
        finally { $source->close(); }
        $service = $this->helper();
        $service->afterBackup = function () use ($database, $pageSize, $root): void {
            $handle = fopen($database, 'r+b');
            fseek($handle, ($root - 1) * $pageSize);
            fwrite($handle, "\x01");
            fclose($handle);
            $other = $this->database($database);
            try { $other->exec('PRAGMA user_version=7'); } finally { $other->close(); }
        };
        $error = $this->assertRestoreFails($service, $snapshot, $database);
        $this->assertSame(1, $service->backupCalls, 'the backup itself completed');
        $this->assertStringContainsString('The restored database failed its health check', $error->getMessage());
    }

    /** @return list<array{string}> */
    public static function restoreOutcomes(): array { return [['success'], ['failure']]; }

    /**
     * No SQLite handle may outlive a restore. After a success PHP's reference counting would close
     * them anyway; a failure whose exception is kept (a test, a logger) keeps its trace arguments,
     * so only close() in the helper releases them. An open handle stops WAL being left and, on
     * Windows, the files being renamed.
     */
    #[DataProvider('restoreOutcomes')]
    public function testNoSQLiteHandleOutlivesARestore(string $outcome): void
    {
        $previous = ini_set('zend.exception_ignore_args', '0');
        try {
            [$snapshot, $database] = $this->databases('WAL');
            $service = $this->helper($outcome === 'failure' ? 'throw' : null);
            $kept = null;
            try { $service->restoreSnapshot($snapshot, $database); }
            catch (\Throwable $caught) { $kept = $caught; }
            $this->assertSame($outcome === 'failure', $kept !== null);
            $probe = new \SQLite3($database);
            $probe->enableExceptions(true);
            $probe->busyTimeout(0);
            try { $this->assertSame('delete', $probe->querySingle('PRAGMA journal_mode=DELETE'), 'every other handle is closed, so WAL can be left'); }
            finally { $probe->close(); }
            foreach ([$database, $snapshot] as $file) {
                $this->assertTrue(rename($file, $file . '.moved'), 'a file with no open handle can be renamed');
                $this->assertTrue(rename($file . '.moved', $file));
            }
            unset($kept);
        } finally { if ($previous !== false) ini_set('zend.exception_ignore_args', $previous); }
    }


    #[DataProvider('backupFaults')]
    public function testBackupFailureKeepsBothDatabasesAndCanBeRetried(string $fault): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $sourceHash = hash_file('sha256', $snapshot);
        $before = $this->databaseFiles($database);
        $failing = $this->helper($fault);
        $this->assertRestoreFails($failing, $snapshot, $database);
        $this->assertSame(1, $failing->backupCalls, 'the failure seam was reached');
        $this->assertSame($sourceHash, hash_file('sha256', $snapshot));
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
        $this->helper()->restoreSnapshot($snapshot, $database);
        $this->assertSame(['snapshot'], $this->values($database));
    }

    /** @return list<array{string}> */
    public static function retainedConnections(): array { return [['closed'], ['idle'], ['reader']]; }

    #[DataProvider('retainedConnections')]
    public function testARealFailedMigrationRestoresDataSchemaAndSyntheticAuthorization(string $mode): void
    {
        $service = $this->runtimeService();
        $service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote($service, 'Kept')['status']);
        $oldProject = file_get_contents($this->root() . '/project.json');
        $oldConfig = file_get_contents($this->root() . '/private/config.json');
        $retained = $this->retain($mode);
        try {
            $broken = $this->projectV2();
            $broken['files']['server/migrations/002.sql'] .= ' THIS IS INVALID SQL;';
            try { $service->install('notes', $broken, 1); $this->fail('An invalid migration was installed'); }
            catch (\RuntimeException $error) { $this->assertSame(422, $error->getCode()); }
            $this->assertRestoredRuntime($service, $oldProject, $oldConfig);
            if ($retained !== null) {
                $this->assertSame('Kept', $retained->querySingle('SELECT title FROM notes'));
                if ($mode === 'reader') $retained->exec('COMMIT');
                $this->assertSame(0, $retained->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='tags'"));
            }
        } finally { $retained?->close(); }
    }

    #[DataProvider('retainedConnections')]
    public function testAFailureAfterCommittedMigrationRestoresDataSchemaAndSyntheticAuthorization(string $mode): void
    {
        $service = $this->runtimeService();
        $service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote($service, 'Kept')['status']);
        $oldProject = file_get_contents($this->root() . '/project.json');
        $oldConfig = file_get_contents($this->root() . '/private/config.json');
        $retained = $this->retain($mode);
        try {
            $failing = $this->runtimeService(null, 'project-written');
            try { $failing->install('notes', $this->projectV2(), 1); $this->fail('The injected failure did not run'); }
            catch (\RuntimeException $error) { $this->assertSame('Injected failure at project-written', $error->getMessage()); }
            $this->assertRestoredRuntime($service, $oldProject, $oldConfig);
            if ($retained !== null) {
                $this->assertSame('Kept', $retained->querySingle('SELECT title FROM notes'));
                if ($mode === 'reader') $retained->exec('COMMIT');
                $this->assertSame(0, $retained->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='tags'"));
                $this->assertSame('Bearer own-fixture-token', $retained->querySingle('SELECT token FROM sessions WHERE owner_id=1'));
            }
        } finally { $retained?->close(); }
    }

    #[DataProvider('backupFaults')]
    public function testRollbackBackupFailureKeepsRecoveryInputsAndBlocksEveryEntryPoint(string $fault): void
    {
        $service = $this->runtimeService();
        $service->install('notes', $this->project(), 0);
        $this->createNote($service, 'Kept');
        $oldProject = file_get_contents($this->root() . '/project.json');
        $oldConfig = file_get_contents($this->root() . '/private/config.json');
        $failing = $this->runtimeService($fault, 'project-written');
        try { $failing->install('notes', $this->projectV2(), 1); $this->fail('The injected failure did not run'); }
        catch (\RuntimeException $error) { $this->assertSame('Injected failure at project-written', $error->getMessage()); }
        $this->assertSame(1, $failing->backupCalls);
        $journalPath = $this->root() . '/private/install.json';
        $journalBytes = file_get_contents($journalPath);
        $journal = json_decode($journalBytes, true, 64, JSON_THROW_ON_ERROR);
        $this->assertSame('recovery', $journal['phase']);
        $this->assertStringContainsString('restore the database', implode(' ', $journal['problems']));
        $this->assertSame($oldProject, file_get_contents($this->root() . '/project.json'));
        $this->assertSame($oldConfig, file_get_contents($this->root() . '/private/config.json'));
        $this->assertStringContainsString('<Text>Notes</Text>', file_get_contents($this->root() . '/app/ui/main.ui'));
        $this->assertDirectoryExists($this->root() . '/' . $journal['staging']);
        $this->assertStringContainsString('Notes v2', file_get_contents($this->root() . '/' . $journal['staging'] . '/ui/main.ui'));
        foreach (['snapshot', 'configBackup', 'projectBackup'] as $artifact) $this->assertFileExists($this->root() . '/private/' . $journal[$artifact]);
        $this->assertSame($oldConfig, file_get_contents($this->root() . '/private/' . $journal['configBackup']));
        $this->assertSame($oldProject, file_get_contents($this->root() . '/private/' . $journal['projectBackup']));
        $snapshot = $this->root() . '/private/' . $journal['snapshot'];
        $snapshotDb = $this->database($snapshot);
        try {
            $this->assertSame('Kept', $snapshotDb->querySingle('SELECT title FROM notes'));
            $this->assertSame('Bearer own-fixture-token', $snapshotDb->querySingle('SELECT token FROM sessions WHERE owner_id=1'));
            $this->assertSame(0, $snapshotDb->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='tags'"));
            $this->assertSame('ok', $snapshotDb->querySingle('PRAGMA integrity_check'));
        } finally { $snapshotDb->close(); }
        $inputs = $this->recoveryInputs();
        $this->assertRecoveryBlocksEveryEntryPoint($service, $journalBytes, $inputs);
        $this->assertRestoreRefusesRecoveryJournal($service, $journalBytes);
        // Releasing handles permits an operator's restore, but does not authorize serving a recovery journal.
        $this->helper()->restoreSnapshot($snapshot, $this->root() . '/private/data/application.sqlite');
        $this->assertRecoveryBlocksEveryEntryPoint($service, $journalBytes, $inputs);
    }

    public function testALockThatOutlastsTheRollbackLeavesRecoveryInputsAndAMessageAnOperatorCanActOn(): void
    {
        $service = $this->runtimeService();
        $service->install('notes', $this->project(), 0);
        $this->createNote($service, 'Kept');
        $oldProject = file_get_contents($this->root() . '/project.json');
        $oldConfig = file_get_contents($this->root() . '/private/config.json');
        $live = $this->root() . '/private/data/application.sqlite';
        $failing = $this->runtimeService(null, 'project-written');
        $writer = null;
        // An unmanaged writer (an editor, a sync tool, a stuck worker) takes the lock as the update fails.
        $failing->onStep = function (string $step) use (&$writer, $live): void {
            if ($step !== 'project-written') return;
            $writer = $this->database($live);
            $writer->exec("BEGIN IMMEDIATE; UPDATE notes SET title='unmanaged writer'");
        };
        try {
            $started = microtime(true);
            try { $failing->install('notes', $this->projectV2(), 1); $this->fail('The injected failure did not run'); }
            catch (\RuntimeException $error) { $this->assertSame('Injected failure at project-written', $error->getMessage()); }
            $this->assertLessThan(20.0, microtime(true) - $started, 'the rollback gave up inside its budget');
            $this->assertGreaterThanOrEqual(2, $failing->backupCalls, 'the lock was retried');
            $journal = json_decode(file_get_contents($this->root() . '/private/install.json'), true, 64, JSON_THROW_ON_ERROR);
            $this->assertSame('recovery', $journal['phase']);
            $this->assertCount(1, $journal['problems']);
            $this->assertStringContainsString('restore the database: The live database could not be restored: database is locked (SQLite error 5)', $journal['problems'][0]);
            $this->assertStringNotContainsString('source database is busy', $journal['problems'][0]);
            $marker = file_get_contents($this->root() . '/private/recovery-required');
            $this->assertStringContainsString('stop whatever has the app database open', $marker);
            $this->assertStringContainsString('NATIVE_ROLLBACK_SAFETY.md', $marker);
            foreach (['snapshot', 'configBackup', 'projectBackup'] as $artifact) $this->assertFileExists($this->root() . '/private/' . $journal[$artifact]);
            $this->assertDirectoryExists($this->root() . '/' . $journal['staging']);
            $this->assertSame($oldProject, file_get_contents($this->root() . '/project.json'));
            $this->assertSame($oldConfig, file_get_contents($this->root() . '/private/config.json'));
            $writer->exec('ROLLBACK');
        } finally { $writer?->close(); }
        // The failed restore changed nothing: the database is still as the failed migration left it.
        $database = $this->database($live);
        try {
            $this->assertSame(1, $database->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='tags'"));
            $this->assertSame('Changed by migration', $database->querySingle('SELECT title FROM notes'));
        } finally { $database->close(); }
        try { $this->createNote($service, 'Blocked'); $this->fail('A recovery journal was served'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('needs operator recovery', $error->getMessage()); }
        // The operator's step (docs/NATIVE_ROLLBACK_SAFETY.md) works once the writer is gone.
        $this->helper()->restoreSnapshot($this->root() . '/private/' . $journal['snapshot'], $live);
        $database = $this->database($live);
        try {
            $this->assertSame('Kept', $database->querySingle('SELECT title FROM notes'));
            $this->assertSame(0, $database->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name='tags'"));
        } finally { $database->close(); }
    }

    public function testARollbackWaitsOutALockThatPassesWhileItRetries(): void
    {
        $service = $this->runtimeService();
        $service->install('notes', $this->project(), 0);
        $this->createNote($service, 'Kept');
        $oldProject = file_get_contents($this->root() . '/project.json');
        $oldConfig = file_get_contents($this->root() . '/private/config.json');
        $live = $this->root() . '/private/data/application.sqlite';
        $failing = $this->runtimeService(null, 'project-written');
        $writer = null;
        $failing->onStep = function (string $step) use (&$writer, $live): void {
            if ($step !== 'project-written') return;
            $writer = $this->database($live);
            $writer->exec("BEGIN IMMEDIATE; UPDATE notes SET title='unmanaged writer'");
        };
        // The first attempt meets the writer and fails with BUSY; the writer is gone before the second.
        $failing->beforeBackup = static function (int $call) use (&$writer): void { if ($call === 2) $writer->exec('ROLLBACK'); };
        try {
            try { $failing->install('notes', $this->projectV2(), 1); $this->fail('The injected failure did not run'); }
            catch (\RuntimeException $error) { $this->assertSame('Injected failure at project-written', $error->getMessage()); }
        } finally { $writer?->close(); }
        $this->assertSame(2, $failing->backupCalls);
        $this->assertRestoredRuntime($service, $oldProject, $oldConfig);
    }

    /**
     * A host with pdo_sqlite and without the sqlite3 extension, as a separate PHP process (the
     * extension cannot be unloaded here). Updating an installed app is refused first, as a 422
     * that reaches the owner, with nothing created, locked or changed. Everything that needs no
     * restore keeps working: available(), a first install, serving requests and restore().
     */
    public function testWithoutTheSqlite3ExtensionAnUpdateIsRefusedUntouchedWhileEverythingElseKeepsWorking(): void
    {
        $this->runtimeService();   // skips when the prepared runtime or Node is missing
        $php = $this->phpWithoutSqlite3();
        $directory = $this->storage . '/no-sqlite3';
        mkdir($directory, 0700);
        file_put_contents($directory . '/v1.json', json_encode($this->project(), JSON_THROW_ON_ERROR));
        file_put_contents($directory . '/v2.json', json_encode($this->projectV2(), JSON_THROW_ON_ERROR));
        file_put_contents($directory . '/child.php', <<<'PHP'
<?php
declare(strict_types=1);
[$self, $autoload, $storage, $runtime, $node, $v1File, $v2File] = $argv;
require $autoload;
use FormLogic\Services\NativeAppService;

final class Probe extends NativeAppService
{
    public function restoreSnapshot(string $snapshot, string $database): void { $this->restoreDatabaseSnapshot($snapshot, $database); }
}
/** A database that appears between the first look and the lock: what a first install that finishes at that moment leaves. */
final class Racing extends NativeAppService
{
    protected function beforeLock(string $root, string $operation): void
    {
        if ($operation !== 'install') return;
        $pdo = new PDO('sqlite:' . $root . '/private/data/application.sqlite');
        $pdo->exec('CREATE TABLE raced(x)');
        $pdo = null;
    }
}
function tree(string $directory): array
{
    $files = [];
    $base = strlen(str_replace('\\', '/', $directory)) + 1;
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS)) as $file) {
        $path = substr(str_replace('\\', '/', $file->getPathname()), $base);
        // A lock file is compared by size: another process may hold it, and Windows then refuses to read it.
        if ($file->isFile() && !str_ends_with($path, '-shm')) $files[$path] = str_ends_with($path, '.lock') ? 'lock file, ' . $file->getSize() . ' bytes' : hash_file('sha256', $file->getPathname());
    }
    ksort($files);
    return $files;
}
$v1 = json_decode(file_get_contents($v1File), true, 64, JSON_THROW_ON_ERROR);
$v2 = json_decode(file_get_contents($v2File), true, 64, JSON_THROW_ON_ERROR);
$out = ['sqlite3' => extension_loaded('sqlite3'), 'pdoSqlite' => extension_loaded('pdo_sqlite')];
$service = new NativeAppService($storage, $runtime, $node);
$out['available'] = $service->available();
$preflight = $service->preflight(true);
$out['preflightOk'] = $preflight['ok'];
foreach ($preflight['checks'] as $check) if ($check['id'] === 'php.sqlite3') $out['sqlite3Check'] = $check;
try { $out['firstInstall'] = $service->install('notes', $v1, 0)['version']; } catch (Throwable $e) { $out['firstInstall'] = get_class($e) . ': ' . $e->getMessage(); }
try { $out['serving'] = $service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Kept'], 'client_ip' => '127.0.0.1'])['status']; } catch (Throwable $e) { $out['serving'] = get_class($e) . ': ' . $e->getMessage(); }
$before = tree($storage);
try { $service->install('notes', $v2, 1); $out['update'] = 'installed'; } catch (Throwable $e) { $out['update'] = [get_class($e), $e->getCode(), $e->getMessage()]; }
$out['storageUnchanged'] = tree($storage) === $before;
try { (new Racing($storage, $runtime, $node))->install('raced', $v1, 0); $out['race'] = 'installed'; } catch (Throwable $e) { $out['race'] = [get_class($e), $e->getCode(), $e->getMessage()]; }
try { $out['restore'] = $service->restore('restored', $v1, null, null)['database']; } catch (Throwable $e) { $out['restore'] = get_class($e) . ': ' . $e->getMessage(); }
try { (new Probe($storage, $runtime, $node))->restoreSnapshot($storage . '/missing-snapshot.sqlite', $storage . '/missing.sqlite'); $out['guard'] = 'no error'; } catch (Throwable $e) { $out['guard'] = [get_class($e), $e->getMessage()]; }
echo json_encode($out, JSON_THROW_ON_ERROR);
PHP);
        $process = proc_open(
            [...$php, $directory . '/child.php', dirname(__DIR__, 2) . '/vendor/autoload.php', $directory . '/storage', dirname(__DIR__, 2) . '/resources/softn-native', (string) getenv('FORMLOGIC_NODE_BIN'), $directory . '/v1.json', $directory . '/v2.json'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );
        $this->assertIsResource($process);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
        $out = json_decode($stdout, true);
        $this->assertIsArray($out, 'the child reported nothing usable: ' . $stdout . $stderr);
        $this->assertFalse($out['sqlite3'], 'the child runs without ext-sqlite3');
        $this->assertTrue($out['pdoSqlite']);
        $this->assertTrue($out['available'], 'the host is still available: serving and first installs need no sqlite3');
        $this->assertFalse($out['preflightOk']);
        $this->assertFalse($out['sqlite3Check']['ok'], 'the missing extension is a failed preflight check, which the panel lists');
        $this->assertStringContainsString('sqlite3 PHP extension', $out['sqlite3Check']['message']);
        $this->assertSame(1, $out['firstInstall'], 'a first install needs no restore');
        $this->assertSame(201, $out['serving']);
        $this->assertSame(['RuntimeException', 422, 'Updating this app needs the sqlite3 PHP extension (it restores the database if an update fails). Enable it and try again.'], $out['update']);
        $this->assertTrue($out['storageUnchanged'], 'the refused update created, locked and changed nothing');
        $this->assertSame($out['update'], $out['race'], 'a database that appears after the first look is refused under the lock, as an update');
        $this->assertSame('none', $out['restore'], 'account-backup restore does not use the backup API');
// The same refusal while another process holds the app's management lock: it comes before the lock is tried, so it is still the 422, not the busy 409.
$holder = proc_open([PHP_BINARY, '-n', '-r', '$f = fopen($argv[1], "c"); flock($f, LOCK_EX); echo "held\n"; sleep(8);', $storage . '/' . hash('sha256', 'notes') . '/private/manage.lock'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $holderPipes);
$holderPid = proc_get_status($holder)['pid'];
stream_set_timeout($holderPipes[1], 15);
$out['holderHeld'] = fgets($holderPipes[1]) === "held\n";
$beforeLocked = tree($storage);
try { $service->install('notes', $v2, 1); $out['updateLocked'] = 'installed'; } catch (Throwable $e) { $out['updateLocked'] = [get_class($e), $e->getCode(), $e->getMessage()]; }
$out['storageUnchangedLocked'] = tree($storage) === $beforeLocked;
proc_terminate($holder);
proc_close($holder);
$out['holderPid'] = $holderPid;
        $this->assertSame('RuntimeException', $out['guard'][0]);
        $this->assertStringContainsString('sqlite3 PHP extension', $out['guard'][1]);
    }

    /**
     * The arguments of a PHP process with pdo_sqlite and without sqlite3, or a skip when this PHP
     * cannot be started that way (sqlite3 compiled in, or an extension that is not a shared file).
     *
     * @return list<string>
     */
    private function phpWithoutSqlite3(): array
    {
        $extensionDir = (string) ini_get('extension_dir');
        $arguments = [PHP_BINARY, '-n', '-d', 'extension_dir=' . $extensionDir, '-d', 'xdebug.mode=off'];
        foreach (get_loaded_extensions() as $extension) {
            $name = strtolower($extension);
            if (in_array($name, ['sqlite3', 'xdebug'], true)) continue;
            foreach (['php_' . $name . '.dll', $name . '.so'] as $file) {
                if (is_file($extensionDir . DIRECTORY_SEPARATOR . $file)) { array_push($arguments, '-d', 'extension=' . $name); break; }
            }
        }
        $process = proc_open([...$arguments, '-r', 'echo json_encode([extension_loaded("pdo_sqlite"), extension_loaded("sqlite3"), extension_loaded("sodium")]);'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($process);
        $stdout = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
        $loaded = json_decode($stdout, true);
        if ($loaded !== [true, false, true]) $this->markTestSkipped('This PHP cannot be started with pdo_sqlite and without sqlite3 (' . $stdout . ').');
        return $arguments;
    }

        $this->assertTrue($out['holderHeld'], 'another process held the app\'s management lock');
        $this->assertSame($out['update'], $out['updateLocked'], 'refused before the lock is tried: 422, not the busy 409');
        $this->assertTrue($out['storageUnchangedLocked']);
        $this->assertGreaterThan(0, $out['holderPid']);
    private function helper(?string $fault = null): RollbackFixtureNativeAppService
    {
        return new RollbackFixtureNativeAppService($this->storage, null, null, $fault);
    }

    private function runtimeService(?string $fault = null, ?string $failStep = null): RollbackFixtureNativeAppService
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $node = getenv('FORMLOGIC_NODE_BIN');
        foreach (['runner.mjs', 'host-protocol.json', 'wasm/zipp_wasm_bg.wasm'] as $file) {
            if (!is_file($runtime . '/' . $file)) $this->markTestSkipped('Native rollback integration requires prepared runtime: missing ' . $file . '.');
        }
        if (!$node) $this->markTestSkipped('Native rollback integration requires FORMLOGIC_NODE_BIN. Standalone SQLite helper tests still run.');
        return new RollbackFixtureNativeAppService($this->storage, $runtime, $node, $fault, $failStep);
    }

    private function database(string $path): \SQLite3
    {
        $db = new \SQLite3($path, SQLITE3_OPEN_READWRITE);
        $db->enableExceptions(true);
        $db->busyTimeout(1500);
        return $db;
    }

    /** @return array{string, string} */
    private function databases(string $journalMode): array
    {
        $snapshot = $this->storage . '/snapshot.sqlite';
        $database = $this->storage . '/application.sqlite';
        $source = new \SQLite3($snapshot);
        $source->enableExceptions(true);
        try { $source->exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES(1, 'snapshot')"); }
        finally { $source->close(); }
        $this->assertTrue(copy($snapshot, $database));
        $db = $this->database($database);
        try {
            $this->assertSame(strtolower($journalMode), $db->querySingle('PRAGMA journal_mode=' . $journalMode));
            $db->exec("UPDATE records SET value='current'; CREATE TABLE introduced(value TEXT)");
        } finally { $db->close(); }
        return [$snapshot, $database];
    }

    /** @return list<string> */
    private function values(string $database): array
    {
        $db = $this->database($database);
        try {
            $result = $db->query('SELECT value FROM records ORDER BY id');
            $values = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) $values[] = $row['value'];
            $result->finalize();
            $this->assertSame('ok', $db->querySingle('PRAGMA integrity_check'));
            return $values;
        } finally { $db->close(); }
    }

    /** @return array<string, string> Ignore shared-memory reader counters; preserve data files. */
    private function databaseFiles(string $database): array
    {
        $files = [];
        foreach (['', '-wal', '-journal'] as $suffix) {
            clearstatcache(true, $database . $suffix);
            if (is_file($database . $suffix)) $files[$suffix] = hash_file('sha256', $database . $suffix);
        }
        return $files;
    }

    private function assertRestoreFails(RollbackFixtureNativeAppService $service, string $snapshot, string $database): \Throwable
    {
        $started = microtime(true);
        $error = null;
        try { $service->restoreSnapshot($snapshot, $database); }
        catch (\Throwable $caught) { $error = $caught; }
        $this->assertNotNull($error, 'Unsafe restore reported success');
        $this->assertNotSame('', $error->getMessage());
        $this->assertLessThan(5.0, microtime(true) - $started, 'a blocked restore must return within its bounded busy timeout');
        return $error;
    }

    /**
     * Another PROCESS that takes a lock on $database with $sql, says so, keeps it for $millis and
     * rolls back. Only a separate process can hold a lock while this one waits for it.
     *
     * @return array{resource, list<resource>}
     */
    private function holdLock(string $database, string $sql, int $millis): array
    {
        $code = '$c = new SQLite3($argv[1]); $c->busyTimeout(3000); $c->exec($argv[2]); fwrite(STDOUT, "held\n"); fflush(STDOUT); usleep((int) $argv[3] * 1000); $c->exec("ROLLBACK"); $c->close();';
        $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', '-r', $code, $database, $sql, (string) $millis], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($process, 'a lock holder process could not be started');
        stream_set_timeout($pipes[1], 20);
        if (fgets($pipes[1]) !== "held\n") {
            $error = stream_get_contents($pipes[2]);
            $this->releaseLock([$process, $pipes]);
            $this->fail('The lock holder never held its lock: ' . $error);
        }
        return [$process, $pipes];
    }

    /** @param array{resource, list<resource>} $holder */
    private function releaseLock(array $holder): void
    {
        [$process, $pipes] = $holder;
        foreach ($pipes as $pipe) fclose($pipe);
        proc_terminate($process);
        proc_close($process);
    }

    private function root(): string { return $this->storage . '/' . hash('sha256', 'notes'); }

    private function project(): array
    {
        return ['access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode(['id' => 'test.rollback.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => [
                'entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [
                    ['path' => '/api/notes', 'method' => 'POST', 'handler' => 'createNote', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/protected', 'method' => 'GET', 'handler' => 'protectedNote', 'transaction' => 'read', 'authorization' => 'anonymous'],
                ],
            ]]),
            'ui/main.ui' => '<Text>Notes</Text>',
            'server/migrations/001.sql' => "CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY, owner_id INTEGER); INSERT INTO sessions VALUES('Bearer own-fixture-token',1),('Bearer cross-fixture-token',2);",
            'server/main.logic' => 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",[req.body.title]); return {status:201,body:softn.sql.first("SELECT id,title FROM notes ORDER BY id DESC",[])}; } function protectedNote(req) { var session=softn.sql.first("SELECT owner_id FROM sessions WHERE token=?",[req.headers.authorization]); if (!session || session.owner_id !== 1) { return {status:401,body:{error:"Unauthorized"}}; } return {status:200,body:{title:softn.sql.first("SELECT title FROM notes ORDER BY id",[]).title}}; }',
        ]];
    }

    private function projectV2(): array
    {
        $project = $this->project();
        $project['files']['ui/main.ui'] = '<Text>Notes v2</Text>';
        $manifest = json_decode($project['files']['manifest.json'], true, 64, JSON_THROW_ON_ERROR);
        $manifest['server']['database']['migrations'][] = 'server/migrations/002.sql';
        $project['files']['manifest.json'] = json_encode($manifest, JSON_THROW_ON_ERROR);
        $project['files']['server/migrations/002.sql'] = "CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT); UPDATE sessions SET token='changed-by-migration' WHERE owner_id=1; UPDATE notes SET title='Changed by migration';";
        return $project;
    }

    private function createNote(NativeAppService $service, string $title): array
    {
        return $service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1']);
    }

    private function retain(string $mode): ?\SQLite3
    {
        if ($mode === 'closed') return null;
        $db = $this->database($this->root() . '/private/data/application.sqlite');
        if ($mode === 'reader') $db->exec('BEGIN');
        $this->assertSame('Kept', $db->querySingle('SELECT title FROM notes'));
        return $db;
    }

    private function assertRestoredRuntime(NativeAppService $service, string $project, string $config): void
    {
        $this->assertFileDoesNotExist($this->root() . '/private/recovery-required');
        $this->assertFileDoesNotExist($this->root() . '/private/install.json');
        $this->assertSame($project, file_get_contents($this->root() . '/project.json'));
        $this->assertSame($config, file_get_contents($this->root() . '/private/config.json'), 'keys and the complete original host configuration survive');
        $this->assertSame(1, $service->get('notes')['version']);
        $this->assertSame(['notes', 'sessions'], $service->records('notes')['tables']);
        $this->assertSame(['Kept'], array_column($service->records('notes', 'notes')['rows'], 'title'));
        foreach (['Bearer own-fixture-token' => 200, 'Bearer cross-fixture-token' => 401] as $token => $status) {
            $response = $service->request('notes', ['method' => 'GET', 'path' => '/api/protected', 'headers' => ['authorization' => $token], 'client_ip' => '127.0.0.1']);
            $this->assertSame($status, $response['status'], 'synthetic authorization is preserved after restore');
        }
        $this->assertSame([], glob($this->root() . '/private/pre-install-*') ?: []);
        $this->assertSame([], glob($this->root() . '/staging-*') ?: []);
        $this->assertSame(201, $this->createNote($service, 'After rollback')['status']);
    }

    /** @return array<string, string> All recovery inputs, excluding marker, lock and live data files. */
    private function recoveryInputs(): array
    {
        $files = [];
        $base = strlen(str_replace('\\', '/', $this->root())) + 1;
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root(), \FilesystemIterator::SKIP_DOTS)) as $file) {
            if (!$file->isFile()) continue;
            $path = substr(str_replace('\\', '/', $file->getPathname()), $base);
            if ($path === 'private/recovery-required' || str_ends_with($path, '.lock') || str_starts_with($path, 'private/data/')) continue;
            $files[$path] = hash_file('sha256', $file->getPathname());
        }
        ksort($files);
        return $files;
    }

    private function assertRecoveryBlocksEveryEntryPoint(NativeAppService $service, string $journal, array $inputs): void
    {
        $operations = [
            'request' => fn() => $this->createNote($service, 'Blocked'),
            'project' => fn() => $service->project('notes'),
            'records' => fn() => $service->records('notes', 'notes'),
            'manageRecord' => fn() => $service->manageRecord('notes', ['table' => 'notes', 'action' => 'create', 'values' => ['title' => 'Blocked']]),
            'captureForBackup' => fn() => $service->captureForBackup('notes', $this->storage . '/blocked.sqlite'),
            'snapshotDatabase' => fn() => $service->snapshotDatabase('notes', $this->storage . '/blocked.sqlite'),
            'dispatchRecordEvents' => fn() => $service->dispatchRecordEvents('notes', static fn() => throw new \LogicException('Event delivered during recovery')),
            'install' => fn() => $service->install('notes', $this->projectV2(), 1),
        ];
        foreach ($operations as $name => $operation) {
            if (is_file($this->root() . '/private/recovery-required')) unlink($this->root() . '/private/recovery-required');
            $this->assertTrue($service->describe('notes')['recoveryRequired'], $name . ': the journal requires recovery without its marker');
            try { $operation(); $this->fail($name . ' bypassed a recovery journal'); }
            catch (\RuntimeException $error) {
                $this->assertNotSame(409, $error->getCode(), $name . ': installer released its lock');
                $this->assertStringContainsString('needs operator recovery', $error->getMessage(), $name);
            }
            $this->assertFileExists($this->root() . '/private/recovery-required');
            $this->assertSame($journal, file_get_contents($this->root() . '/private/install.json'));
            $this->assertSame($inputs, $this->recoveryInputs(), $name . ': all recovery inputs stay intact');
            $this->assertSame([], glob($this->root() . '/private/request-*') ?: [], $name . ': no worker starts');
        }
        $this->assertFileDoesNotExist($this->storage . '/blocked.sqlite');
    }

    private function assertRestoreRefusesRecoveryJournal(NativeAppService $service, string $journal): void
    {
        $root = $this->storage . '/' . hash('sha256', 'restored');
        mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/private/install.json', $journal);
        try { $service->restore('restored', $this->project(), null, null); $this->fail('Restore bypassed a recovery journal'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('needs operator recovery', $error->getMessage()); }
        $this->assertSame($journal, file_get_contents($root . '/private/install.json'));
        $this->assertFileExists($root . '/private/recovery-required');
        foreach (['project.json', 'app', 'private/config.json', 'private/data/application.sqlite'] as $path) $this->assertFileDoesNotExist($root . '/' . $path);
    }
}

/** Real backup with deterministic false/throw faults, hooks around each attempt and an install-failure seam. */
final class RollbackFixtureNativeAppService extends NativeAppService
{
    public int $backupCalls = 0;
    /** @var (\Closure(int, \SQLite3, \SQLite3): void)|null Runs before each backup attempt, given the attempt's number. */
    public ?\Closure $beforeBackup = null;
    /** @var (\Closure(): void)|null Runs after the backup returned and before the health check. */
    public ?\Closure $afterBackup = null;
    /** @var (\Closure(string): void)|null Runs at each install step, before the injected failure. */
    public ?\Closure $onStep = null;

    public function __construct(?string $storage, ?string $runtime, ?string $node, private ?string $fault = null, private ?string $failStep = null)
    {
        parent::__construct($storage, $runtime, $node);
    }

    public function restoreSnapshot(string $snapshot, string $database): void
    {
        $this->restoreDatabaseSnapshot($snapshot, $database);
    }

    /** What a rollback does: the same, with the bounded retry of a lock that passes. */
    public function restoreSnapshotWithRetry(string $snapshot, string $database): void
    {
        $this->restoreDatabaseWithRetry($snapshot, $database);
    }

    protected function backupDatabaseChecked(\SQLite3 $source, \SQLite3 $destination): bool
    {
        $this->backupCalls++;
        if ($this->beforeBackup !== null) ($this->beforeBackup)($this->backupCalls, $source, $destination);
        if ($this->fault === 'false') return false;
        if ($this->fault === 'throw') throw new \RuntimeException('Injected SQLite backup failure');
        // PHP can report true even though backup_step failed. The real API leaves a SQLite error.
        if ($this->fault === 'destination-transaction') $destination->exec('BEGIN IMMEDIATE');
        $restored = parent::backupDatabaseChecked($source, $destination);
        if ($this->afterBackup !== null) ($this->afterBackup)();
        return $restored;
    }

    protected function afterStep(string $root, string $step): void
    {
        if ($this->onStep !== null) ($this->onStep)($step);
        if ($step === $this->failStep) throw new \RuntimeException('Injected failure at ' . $step);
    }
}
