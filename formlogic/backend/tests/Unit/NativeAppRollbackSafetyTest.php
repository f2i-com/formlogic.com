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
        $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertFileDoesNotExist($database);
        $this->assertSame('synthetic orphan WAL', file_get_contents($database . '-wal'));
        $this->assertSame('synthetic orphan shared memory', file_get_contents($database . '-shm'));
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
    }

    public function testCorruptSnapshotRefusesBeforeChangingTheDestination(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        file_put_contents($snapshot, str_repeat('synthetic corrupt snapshot ', 200));
        $snapshotHash = hash_file('sha256', $snapshot);
        $before = $this->databaseFiles($database);
        $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertSame($snapshotHash, hash_file('sha256', $snapshot));
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
    }

    public function testMissingSnapshotRefusesWithoutChangingTheDestination(): void
    {
        [$snapshot, $database] = $this->databases('DELETE');
        $this->assertTrue(unlink($snapshot));
        $before = $this->databaseFiles($database);
        $this->assertRestoreFails($this->helper(), $snapshot, $database);
        $this->assertFileDoesNotExist($snapshot);
        $this->assertSame($before, $this->databaseFiles($database));
        $this->assertSame(['current'], $this->values($database));
    }

    /** @return list<array{string}> */
    public static function backupFaults(): array { return [['false'], ['throw'], ['destination-transaction']]; }

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

    private function assertRestoreFails(RollbackFixtureNativeAppService $service, string $snapshot, string $database): void
    {
        $started = microtime(true);
        $error = null;
        try { $service->restoreSnapshot($snapshot, $database); }
        catch (\Throwable $caught) { $error = $caught; }
        $this->assertNotNull($error, 'Unsafe restore reported success');
        $this->assertNotSame('', $error->getMessage());
        $this->assertLessThan(5.0, microtime(true) - $started, 'a blocked restore must return within its bounded busy timeout');
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

/** Real backup with deterministic false/throw faults and an install-failure seam. */
final class RollbackFixtureNativeAppService extends NativeAppService
{
    public int $backupCalls = 0;

    public function __construct(?string $storage, ?string $runtime, ?string $node, private ?string $fault = null, private ?string $failStep = null)
    {
        parent::__construct($storage, $runtime, $node);
    }

    public function restoreSnapshot(string $snapshot, string $database): void
    {
        $this->restoreDatabaseSnapshot($snapshot, $database);
    }

    protected function backupDatabaseChecked(\SQLite3 $source, \SQLite3 $destination): bool
    {
        $this->backupCalls++;
        if ($this->fault === 'false') return false;
        if ($this->fault === 'throw') throw new \RuntimeException('Injected SQLite backup failure');
        // PHP can report true even though backup_step failed. The real API leaves a SQLite error.
        if ($this->fault === 'destination-transaction') $destination->exec('BEGIN IMMEDIATE');
        return parent::backupDatabaseChecked($source, $destination);
    }

    protected function afterStep(string $root, string $step): void
    {
        if ($step === $this->failStep) throw new \RuntimeException('Injected failure at ' . $step);
    }
}
