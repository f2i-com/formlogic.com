<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/**
 * The install lifecycle under faults (FormLogic 0.1.6 handoff FL-S02, FL-S03, FL-S04, FL-S06):
 * short writes, termination at every phase, a rollback that cannot complete, a caller that
 * decided before an installer changed the installation, and the records paging window.
 * Real ZIPP/SQLite, no account database.
 */
final class NativeAppLifecycleTest extends TestCase
{
    private string $storage;
    private string $runtime;
    private NativeAppService $service;

    protected function setUp(): void
    {
        $this->runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        if (!is_file($this->runtime . '/runner.mjs') || !getenv('FORMLOGIC_NODE_BIN')) $this->markTestSkipped('Prepare native runtime and set FORMLOGIC_NODE_BIN.');
        $this->storage = sys_get_temp_dir() . '/formlogic-native-test-' . bin2hex(random_bytes(10));
        mkdir($this->storage, 0700);
        $this->service = new NativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'));
    }

    protected function tearDown(): void
    {
        if (!isset($this->storage) || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-test-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) {
            if ($file->isLink()) unlink($file->getPathname());
            elseif ($file->isDir()) rmdir($file->getPathname());
            else unlink($file->getPathname());
        }
        rmdir($root);
    }

    private function root(): string { return $this->storage . '/' . hash('sha256', 'notes'); }

    private function project(string $title = 'Notes', bool $withAsset = false): array
    {
        $project = ['access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode(['id' => 'test.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => [
                'entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [['path' => '/api/notes', 'method' => 'POST', 'handler' => 'createNote', 'transaction' => 'write', 'authorization' => 'anonymous']],
            ]]),
            'ui/main.ui' => '<Text>' . $title . '</Text>',
            'server/migrations/001.sql' => 'CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT);',
            'server/main.logic' => 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",[req.body.title]); return {status:201,body:softn.sql.first("SELECT id,title FROM notes ORDER BY id DESC",[])}; }',
        ]];
        if ($withAsset) $project['assets']['assets/logo.png'] = base64_encode(str_repeat("\x89PNG\r\n\x1a\n", 200));
        return $project;
    }

    /** A second version whose migration adds a table, so a rollback can be told from a roll-forward. */
    private function projectV2(): array
    {
        $project = $this->project('Notes v2');
        $manifest = json_decode($project['files']['manifest.json'], true);
        $manifest['server']['database']['migrations'][] = 'server/migrations/002.sql';
        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/migrations/002.sql'] = 'CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);';
        return $project;
    }

    private function createNote(NativeAppService $service, string $title): array
    {
        return $service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1']);
    }

    private function tables(NativeAppService $service): array
    {
        return $service->records('notes')['tables'];
    }

    // ── FL-S02: short writes ─────────────────────────────────────────────────

    public function testShortWriteOfProjectMetadataDuringAnUpdateIsRefusedAndThePreviousProjectStaysUsable(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Before');
        $short = new ShortWritingNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), '~/project\.json\.pending-~');
        try { $short->install('notes', $this->projectV2(), 1); $this->fail('A short metadata write was published'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('Short write to project.json', $error->getMessage()); }
        $this->assertSame(1, $this->service->get('notes')['version'], 'the previous project.json is intact');
        $this->assertSame([], glob($this->root() . '/project.json.pending-*') ?: [], 'no partial file left beside the metadata');
        $this->assertFileDoesNotExist($this->root() . '/private/recovery-required');
        $this->assertFileDoesNotExist($this->root() . '/private/install.json');
        $this->assertSame(['notes'], $this->tables($this->service), 'the rolled-back database has no v2 table');
        $this->assertSame(201, $this->createNote($this->service, 'After')['status']);
        $this->assertStringContainsString('<Text>Notes</Text>', file_get_contents($this->root() . '/app/ui/main.ui'), 'the previous source is active again');
    }

    public function testShortWriteOfAStagedAssetIsRefusedAndAFirstInstallLeavesNothingBehind(): void
    {
        $short = new ShortWritingNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), '~/assets/logo\.png\.pending-~');
        try { $short->install('notes', $this->project('Notes', true), 0); $this->fail('A truncated asset was installed'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('Short write to logo.png', $error->getMessage()); }
        $this->assertNull($this->service->get('notes'));
        $this->assertDirectoryDoesNotExist($this->root() . '/app');
        $this->assertSame([], glob($this->root() . '/staging-*') ?: [], 'staging is discarded');
        $this->assertFileDoesNotExist($this->root() . '/private/install.json');
        // Retry with a healthy writer: the failed first install left a clean, retryable state.
        $saved = $this->service->install('notes', $this->project('Notes', true), 0);
        $this->assertSame(1, $saved['version']);
        $this->assertSame(1600, filesize($this->root() . '/app/assets/logo.png'));
    }

    public function testShortWriteDuringRestoreLeavesNoInstallation(): void
    {
        $short = new ShortWritingNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), '~/project\.json\.pending-~');
        try { $short->restore('notes', $this->project(), null, null); $this->fail('A short restore write was published'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('Short write to project.json', $error->getMessage()); }
        $this->assertNull($this->service->describe('notes'));
        $this->assertDirectoryDoesNotExist($this->root());
    }

    // ── FL-S03: termination at every phase ───────────────────────────────────

    /** @return list<array{0:string}> */
    public static function phases(): array
    {
        return [['staged'], ['config-changed'], ['activating'], ['source-activated'], ['migrated'], ['metadata-promoted']];
    }

    /**
     * A separate PHP process runs the update and exits (no catch, no finally, locks released
     * by the OS) once the named phase is durable; the next operation settles the journal.
     * @dataProvider phases
     */
    public function testAnUpdateTerminatedAtAPhaseIsSettledBeforeTheNextOperation(string $phase): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote($this->service, 'Kept')['status']);
        $this->terminateInstallAt($phase);
        $root = $this->root();
        $this->assertFileExists($root . '/private/install.json', 'the terminated process left its journal');
        $this->assertSame($phase, json_decode(file_get_contents($root . '/private/install.json'), true)['phase']);

        $rolledForward = $phase === 'metadata-promoted';
        $expectedVersion = $rolledForward ? 2 : 1;
        // The first operation after the termination settles the journal and then runs normally.
        $response = $this->createNote($this->service, 'After ' . $phase);
        $this->assertSame(201, $response['status']);
        $this->assertFileDoesNotExist($root . '/private/install.json', 'the journal was settled');
        $this->assertFileDoesNotExist($root . '/private/recovery-required');
        $this->assertSame($expectedVersion, $this->service->get('notes')['version']);
        $this->assertSame($rolledForward ? ['notes', 'tags'] : ['notes'], $this->tables($this->service), 'source and schema belong to one generation');
        $this->assertStringContainsString($rolledForward ? 'Notes v2' : '<Text>Notes</Text>', file_get_contents($root . '/app/ui/main.ui'));
        $rows = $this->service->records('notes', 'notes')['rows'];
        $this->assertSame(['Kept', 'After ' . $phase], array_column($rows, 'title'), 'records from before the update survive');
        $this->assertSame([], glob($root . '/staging-*') ?: []);
        $this->assertSame([], glob($root . '/private/pre-install-*') ?: []);
        $this->assertSame([], glob($root . '/private/config.previous-*') ?: []);
        $this->assertSame([], glob($root . '/private/project.previous-*') ?: []);
        // And the installation is ready for the next update.
        $this->assertSame($expectedVersion + 1, $this->service->install('notes', $this->projectV2(), $expectedVersion)['version']);
    }

    public function testAFirstInstallTerminatedAfterMigrationRollsBackToNothingAndCanBeRetried(): void
    {
        $this->terminateInstallAt('migrated', 0);
        $root = $this->root();
        $this->assertFileExists($root . '/private/install.json');
        $this->assertFileExists($root . '/private/data/application.sqlite', 'the migration created a database');
        try { $this->createNote($this->service, 'x'); $this->fail('A half-installed app answered'); }
        catch (\RuntimeException $error) { $this->assertSame(404, $error->getCode()); }
        $this->assertFileDoesNotExist($root . '/private/install.json');
        $this->assertFileDoesNotExist($root . '/private/data/application.sqlite');
        $this->assertFileDoesNotExist($root . '/private/config.json');
        $this->assertDirectoryDoesNotExist($root . '/app');
        $this->assertSame(1, $this->service->install('notes', $this->project(), 0)['version']);
        $this->assertSame(201, $this->createNote($this->service, 'Retried')['status']);
    }

    public function testAnUpdateTerminatedAfterWritingProjectJsonRollsBackToThePreviousProject(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $this->terminateInstallAt('project-written', 1, 'afterStep');
        $root = $this->root();
        $this->assertSame('migrated', json_decode(file_get_contents($root . '/private/install.json'), true)['phase'], 'the journal never reached metadata-promoted');
        $this->assertSame(2, json_decode(file_get_contents($root . '/project.json'), true)['version'], 'the terminated process had replaced project.json');
        $this->assertSame(201, $this->createNote($this->service, 'After')['status']);
        $this->assertFileDoesNotExist($root . '/private/install.json');
        $this->assertFileDoesNotExist($root . '/private/recovery-required');
        $this->assertSame(1, $this->service->get('notes')['version'], 'project.json belongs to the generation that was rolled back to');
        $this->assertArrayNotHasKey('server/migrations/002.sql', $this->service->get('notes')['files']);
        $this->assertStringContainsString('<Text>Notes</Text>', file_get_contents($root . '/app/ui/main.ui'));
        $this->assertSame(['notes'], $this->tables($this->service));
        $this->assertSame(['Kept', 'After'], array_column($this->service->records('notes', 'notes')['rows'], 'title'));
        $this->assertSame([], glob($root . '/private/project.previous-*') ?: [], 'the project backup is retired');
        $this->assertSame(2, $this->service->install('notes', $this->projectV2(), 1)['version']);
    }

    public function testAFirstInstallTerminatedAfterWritingProjectJsonLeavesNoProject(): void
    {
        $this->terminateInstallAt('project-written', 0, 'afterStep');
        $root = $this->root();
        $this->assertFileExists($root . '/project.json');
        $this->assertFileExists($root . '/private/data/application.sqlite', 'the migration created a database');
        // Event delivery, which runs every minute for every app, is as likely as anything to settle it.
        $this->assertSame(0, $this->service->dispatchRecordEvents('notes', static fn() => throw new \LogicException('delivered')));
        $this->assertNull($this->service->get('notes'));
        foreach (['project.json', 'app', 'private/install.json', 'private/config.json', 'private/data/application.sqlite'] as $path) $this->assertFileDoesNotExist($root . '/' . $path, $path . ' (the rolled-back database is not reopened empty)');
        try { $this->createNote($this->service, 'x'); $this->fail('A half-installed app answered'); }
        catch (\RuntimeException $error) { $this->assertSame(404, $error->getCode()); }
        $this->assertSame(1, $this->service->install('notes', $this->project(), 0)['version']);
    }

    public function testAnUpdateTerminatedAfterWritingItsBackupsLeavesNone(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $this->terminateInstallAt('backups-written', 1, 'afterStep');
        $root = $this->root();
        $this->assertSame('staged', json_decode(file_get_contents($root . '/private/install.json'), true)['phase'], 'config-changed was never durable');
        $this->assertCount(1, glob($root . '/private/config.previous-*') ?: [], 'the terminated process had written the configuration backup');
        $this->assertCount(1, glob($root . '/private/project.previous-*') ?: [], 'and the project backup');
        $this->assertSame(201, $this->createNote($this->service, 'After')['status']);
        foreach (['config.previous-*', 'project.previous-*', 'install.json', 'recovery-required'] as $pattern) $this->assertSame([], glob($root . '/private/' . $pattern) ?: [], $pattern);
        $this->assertSame([], glob($root . '/staging-*') ?: []);
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertSame(['Kept', 'After'], array_column($this->service->records('notes', 'notes')['rows'], 'title'));
    }

    public function testAProjectJsonThatWasReplacedWithoutABackupRequiresRecovery(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->terminateInstallAt('project-written', 1, 'afterStep');
        $root = $this->root();
        $backups = glob($root . '/private/project.previous-*') ?: [];
        $this->assertCount(1, $backups);
        unlink($backups[0]);
        try { $this->createNote($this->service, 'x'); $this->fail('A rollback kept the new project.json over the previous generation'); }
        catch (\RuntimeException $error) {
            $this->assertNotSame(409, $error->getCode());
            $this->assertStringContainsString('the project metadata backup is missing', $error->getMessage());
        }
        $this->assertSame('recovery', json_decode(file_get_contents($root . '/private/install.json'), true)['phase']);
        $this->assertStringContainsString('the project metadata backup is missing', file_get_contents($root . '/private/recovery-required'));
    }

    public function testAJournalWithoutAProjectBackupSettlesWhenProjectJsonWasNotReplaced(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $this->terminateInstallAt('migrated');
        $root = $this->root();
        // As the code before project backups wrote it: no projectBackup, and none on disk.
        $journal = json_decode(file_get_contents($root . '/private/install.json'), true);
        unlink($root . '/private/' . $journal['projectBackup']);
        unset($journal['projectBackup']);
        file_put_contents($root . '/private/install.json', json_encode($journal));
        $this->assertSame(201, $this->createNote($this->service, 'After')['status']);
        $this->assertFileDoesNotExist($root . '/private/install.json');
        $this->assertFileDoesNotExist($root . '/private/recovery-required');
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertSame(['notes'], $this->tables($this->service));
    }

    public function testASnapshotThatWasNeverVerifiedIsDeletedWhenTheUpdateIsSettled(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $root = $this->root();
        $this->terminateInstallAt('snapshot-taken', 1, 'afterStep');
        $this->assertCount(1, glob($root . '/private/pre-install-*.sqlite') ?: [], 'the terminated process had written the snapshot');
        $this->assertSame(201, $this->createNote($this->service, 'After termination')['status']);
        foreach (['pre-install-*', 'config.previous-*', 'project.previous-*', 'install.json'] as $pattern) $this->assertSame([], glob($root . '/private/' . $pattern) ?: [], $pattern);

        // A snapshot that fails its health check in a live update goes the same way.
        $corrupt = new CorruptSnapshotNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'));
        try { $corrupt->install('notes', $this->projectV2(), 1); $this->fail('An update ran past a snapshot that failed its health check'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('integrity check', $error->getMessage()); }
        foreach (['pre-install-*', 'config.previous-*', 'project.previous-*', 'install.json', 'recovery-required'] as $pattern) $this->assertSame([], glob($root . '/private/' . $pattern) ?: [], $pattern);
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertSame(['Kept', 'After termination'], array_column($this->service->records('notes', 'notes')['rows'], 'title'));
    }

    public function testAFirstInstallTerminatedAfterCreatingItsConfigurationLeavesNone(): void
    {
        $this->terminateInstallAt('config-created', 0, 'afterStep');
        $root = $this->root();
        $this->assertSame('staged', json_decode(file_get_contents($root . '/private/install.json'), true)['phase']);
        $this->assertFileExists($root . '/private/config.json');
        try { $this->createNote($this->service, 'x'); $this->fail('A half-installed app answered'); }
        catch (\RuntimeException $error) { $this->assertSame(404, $error->getCode()); }
        foreach (['app', 'private/install.json', 'private/config.json'] as $path) $this->assertFileDoesNotExist($root . '/' . $path);
        $this->assertSame([], glob($root . '/staging-*') ?: []);
        $this->assertSame(1, $this->service->install('notes', $this->project(), 0)['version']);
    }

    public function testARollbackThatCannotRestoreTheSourceBlocksTheAppAndKeepsEveryInput(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $broken = $this->projectV2();
        $broken['files']['server/main.logic'] = 'function createNote( {';
        $stuck = new StuckRollbackNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'));
        try { $stuck->install('notes', $broken, 1); $this->fail('Broken source was installed'); }
        catch (\RuntimeException $error) { $this->assertSame(422, $error->getCode()); }
        $root = $this->root();
        $this->assertFileExists($root . '/private/recovery-required');
        $marker = file_get_contents($root . '/private/recovery-required');
        $this->assertStringContainsString('restore the previous source', $marker);
        $journal = json_decode(file_get_contents($root . '/private/install.json'), true);
        $this->assertSame('recovery', $journal['phase']);
        $this->assertDirectoryExists($root . '/' . $journal['previous'], 'the previous source is retained');
        $this->assertDirectoryExists($root . '/' . $journal['staging'], 'the new source is retained aside');
        $this->assertFileExists($root . '/private/' . $journal['snapshot'], 'the pre-install snapshot is retained');
        $this->assertFileExists($root . '/private/' . $journal['configBackup']);
        $this->assertFileExists($root . '/private/data/application.sqlite', 'the database was restored from the snapshot');
        foreach (['request' => fn() => $this->createNote($this->service, 'x'), 'records' => fn() => $this->service->records('notes'), 'install' => fn() => $this->service->install('notes', $this->project(), 1), 'backup' => fn() => $this->service->captureForBackup('notes', $this->storage . '/snap.sqlite'), 'dispatch' => fn() => $this->service->dispatchRecordEvents('notes', static fn() => null)] as $name => $operation) {
            try { $operation(); $this->fail($name . ' ran while recovery was required'); }
            catch (\RuntimeException $error) { $this->assertStringContainsString('recovery', $error->getMessage(), $name); }
        }
        $this->assertTrue($this->service->describe('notes')['recoveryRequired']);
        $this->assertTrue($this->service->describe('notes')['updateUnfinished']);
    }

    public function testRemovingOnlyTheRecoveryMarkerLeavesTheAppBlockedAndItsInputsKept(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $broken = $this->projectV2();
        $broken['files']['server/main.logic'] = 'function createNote( {';
        $stuck = new StuckRollbackNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'));
        try { $stuck->install('notes', $broken, 1); $this->fail('Broken source was installed'); }
        catch (\RuntimeException $error) { $this->assertSame(422, $error->getCode()); }
        $root = $this->root();
        $journal = json_decode(file_get_contents($root . '/private/install.json'), true);
        $this->assertSame('recovery', $journal['phase']);
        $this->assertDirectoryExists($root . '/' . $journal['previous']);
        $this->assertDirectoryExists($root . '/' . $journal['staging']);
        $this->assertRecoveryBlocksEveryEntryPoint();
        $this->assertRestoreRefusesOverTheJournal(file_get_contents($root . '/private/install.json'));
    }

    public function testAnUnreadableJournalIsRecoveryRequired(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $root = $this->root();
        file_put_contents($root . '/private/install.json', '{"phase": "migr');
        // A marker that cannot be written does not let anything through.
        $short = new ShortWritingNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), '~/recovery-required\.pending-~');
        try { $this->createNote($short, 'x'); $this->fail('A request ran over an unreadable journal whose marker could not be written'); }
        catch (\RuntimeException $error) {
            $this->assertNotSame(409, $error->getCode());
            $this->assertStringContainsString('the install journal could not be read', $error->getMessage());
        }
        $this->assertFileDoesNotExist($root . '/private/recovery-required');
        $this->assertRecoveryBlocksEveryEntryPoint();
        $this->assertStringContainsString('the install journal could not be read', file_get_contents($root . '/private/recovery-required'));
        $this->assertRestoreRefusesOverTheJournal('{"phase": "migr');
        // The operator finishes by removing the journal as well as the marker.
        unlink($root . '/private/install.json');
        unlink($root . '/private/recovery-required');
        $this->assertSame(201, $this->createNote($this->service, 'Recovered')['status']);
        $this->assertSame(['Kept', 'Recovered'], array_column($this->service->records('notes', 'notes')['rows'], 'title'));
    }

    public function testAJournalReadThatFailsIsNotRecovery(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Kept');
        $this->terminateInstallAt('source-activated');
        $root = $this->root();
        $journal = file_get_contents($root . '/private/install.json');
        // Still there but not readable just now: busy, with no marker and the journal untouched.
        $failing = new FailingJournalReadNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), false);
        foreach (['request' => fn() => $this->createNote($failing, 'x'), 'install' => fn() => $failing->install('notes', $this->projectV2(), 1)] as $name => $operation) {
            try { $operation(); $this->fail($name . ' ran past a journal it could not read'); }
            catch (\RuntimeException $error) { $this->assertSame(409, $error->getCode(), $name); }
            $this->assertFileDoesNotExist($root . '/private/recovery-required', $name);
            $this->assertSame($journal, file_get_contents($root . '/private/install.json'), $name);
        }
        $this->assertSame(201, $this->createNote($this->service, 'After')['status'], 'once it reads, the journal is settled');
        $this->assertSame(1, $this->service->get('notes')['version']);
        // describe() holds no lock: a journal its update retired between the check and the read is no journal.
        file_put_contents($root . '/private/install.json', $journal);
        $described = (new FailingJournalReadNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), true))->describe('notes');
        $this->assertSame([false, false], [$described['recoveryRequired'], $described['updateUnfinished']]);
    }

    // ── FL-S04: decided under the lock ───────────────────────────────────────

    public function testRecoveryRequiredWrittenBetweenTheCheckAndTheLockStopsEveryEntryPoint(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'Only');
        $root = $this->root();
        $barrier = new BarrierNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), static function () use ($root): void {
            file_put_contents($root . '/private/recovery-required', 'set by the barrier');
        });
        $operations = [
            'request' => fn() => $barrier->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Late'], 'client_ip' => '127.0.0.1']),
            'records' => fn() => $barrier->records('notes', 'notes'),
            'manageRecord' => fn() => $barrier->manageRecord('notes', ['table' => 'notes', 'action' => 'create', 'values' => ['title' => 'Late']]),
            'dispatch' => fn() => $barrier->dispatchRecordEvents('notes', static fn() => throw new \LogicException('delivered')),
            'snapshot' => fn() => $barrier->snapshotDatabase('notes', $this->storage . '/late.sqlite'),
            'install' => fn() => $barrier->install('notes', $this->projectV2(), 1),
        ];
        foreach ($operations as $name => $operation) {
            if (is_file($root . '/private/recovery-required')) unlink($root . '/private/recovery-required');
            try { $operation(); $this->fail($name . ' proceeded after recovery became required'); }
            catch (\RuntimeException $error) { $this->assertMatchesRegularExpression('/recovery|Restore the app database/', $error->getMessage(), $name); }
            $this->assertSame([], glob($root . '/private/request-*') ?: [], $name . ' started no worker');
        }
        unlink($root . '/private/recovery-required');
        $this->assertSame(['Only'], array_column($this->service->records('notes', 'notes')['rows'], 'title'), 'no mutation happened');
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertFileDoesNotExist($this->storage . '/late.sqlite');
    }

    public function testAnUnfinishedUpdateFoundUnderTheLockIsSettledByAReader(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->terminateInstallAt('source-activated');
        // The reader takes the shared lock, finds the journal, settles it exclusively, then reads.
        $result = $this->service->records('notes', 'notes');
        $this->assertSame([], $result['rows']);
        $this->assertFileDoesNotExist($this->root() . '/private/install.json');
        $this->assertSame(1, $this->service->get('notes')['version']);
    }

    public function testEventDeliveryAndSnapshotsTakeTheLockWithoutDecodingTheProject(): void
    {
        $this->service->install('notes', $this->project('Notes', true), 0);
        $this->createNote($this->service, 'One');
        $counting = new CountingNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'));
        $counting->dispatchRecordEvents('notes', static fn() => null);
        $this->assertNotNull($counting->snapshotDatabase('notes', $this->storage . '/counted.sqlite'));
        $this->assertSame(0, $counting->reads, 'the lock, journal and recovery checks need no project.json');
        $counting->records('notes', 'notes');
        $this->assertSame(1, $counting->reads, 'the records view decodes project.json once');
        $counting->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Two'], 'client_ip' => '127.0.0.1'], [], [], 1);
        $this->assertSame(2, $counting->reads, 'a request bound to a generation decodes it once');
    }

    public function testARequestDecidedAgainstAnOlderGenerationIsRefused(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $seen = $this->service->get('notes')['version'];
        $this->service->install('notes', $this->projectV2(), 1);
        try {
            $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Stale'], 'client_ip' => '127.0.0.1'], [], [], $seen);
            $this->fail('A request bound to an older generation ran');
        } catch (\RuntimeException $error) { $this->assertSame(409, $error->getCode()); }
        $this->assertSame([], $this->service->records('notes', 'notes')['rows']);
        $this->assertSame(201, $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Current'], 'client_ip' => '127.0.0.1'], [], [], 2)['status']);
    }

    public function testRestoreChecksItsCreateOnlyRuleUnderTheLock(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $root = $this->root();
        // Nothing exists before the lock is taken; the installation appears while it is.
        $project = $this->project();
        $barrier = new BarrierNativeAppService($this->storage, $this->runtime, getenv('FORMLOGIC_NODE_BIN'), function () use ($root): void {
            // restore() created empty root/private/data before the barrier; put the real installation back.
            rmdir($root . '/private/data'); rmdir($root . '/private'); rmdir($root);
            rename($this->storage . '/aside', $root);
        });
        rename($root, $this->storage . '/aside');
        try { $barrier->restore('notes', $project, null, null); $this->fail('Restore overwrote an installation that appeared under the lock'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('already exists', $error->getMessage()); }
        $this->assertSame(1, $this->service->get('notes')['version'], 'the existing installation survived the refused restore');
        $this->assertSame(201, $this->createNote($this->service, 'Still here')['status']);
    }

    public function testABusyInstallationAnswers409ToReadersAndAnotherInstaller(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $lock = fopen($this->root() . '/private/manage.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        try {
            foreach (['request' => fn() => $this->createNote($this->service, 'x'), 'records' => fn() => $this->service->records('notes'), 'install' => fn() => $this->service->install('notes', $this->projectV2(), 1)] as $name => $operation) {
                try { $operation(); $this->fail($name . ' ignored the exclusive lock'); }
                catch (\RuntimeException $error) { $this->assertSame(409, $error->getCode(), $name); }
            }
        } finally { flock($lock, LOCK_UN); fclose($lock); }
        $this->assertSame(201, $this->createNote($this->service, 'Free again')['status']);
    }

    // ── FL-S06: the records window ───────────────────────────────────────────

    public function testTheRecordsPagerReportsItsEffectiveOffsetAndWhyItStops(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $db = new \PDO('sqlite:' . $this->root() . '/private/data/application.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('BEGIN');
        $insert = $db->prepare('INSERT INTO notes(id, title) VALUES(?, ?)');
        for ($id = 1; $id <= 100120; $id++) $insert->execute([$id, 'n' . $id]);
        $db->exec('COMMIT');
        $db = null;

        $page = $this->service->records('notes', 'notes', 99950);
        $this->assertSame([99950, 50, 100000, 'more', true], [$page['offset'], $page['limit'], $page['offsetLimit'], $page['end'], $page['hasMore']]);
        $this->assertSame([99951, 100000], [$page['rows'][0]['id'], $page['rows'][49]['id']]);

        $page = $this->service->records('notes', 'notes', 100000);
        $this->assertSame([100000, 'limit', false], [$page['offset'], $page['end'], $page['hasMore']], 'the last page inside the window says rows exist beyond it');
        $this->assertSame([100001, 100050], [$page['rows'][0]['id'], $page['rows'][49]['id']]);
        $this->assertSame(['100001'], array_values($page['keys'][0]));

        foreach ([100050, 100100, 5000000] as $requested) {
            $page = $this->service->records('notes', 'notes', $requested);
            $this->assertSame(100000, $page['offset'], 'a request past the window is clamped and says so');
            $this->assertSame('limit', $page['end']);
            $this->assertFalse($page['hasMore']);
            $this->assertSame(100001, $page['rows'][0]['id']);
        }

        $page = $this->service->records('notes', 'notes', 0);
        $this->assertSame([0, 'more', true], [$page['offset'], $page['end'], $page['hasMore']]);
        $page = $this->service->records('notes', 'notes', -7);
        $this->assertSame(0, $page['offset']);
    }

    public function testASmallTableEndsInsideTheWindow(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->createNote($this->service, 'One');
        $page = $this->service->records('notes', 'notes', 0);
        $this->assertSame([0, 'end', false], [$page['offset'], $page['end'], $page['hasMore']]);
        $this->assertCount(1, $page['rows']);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /**
     * Every entry point to the installation refuses with the operator-recovery message (never a
     * 409), each with the marker removed first; the marker is back afterwards, and the journal and
     * everything beside it — previous and staged source, snapshot, backups — are as they were.
     */
    private function assertRecoveryBlocksEveryEntryPoint(): void
    {
        $root = $this->root();
        $journal = file_get_contents($root . '/private/install.json');
        $inputs = $this->listing($root);
        $operations = [
            'request' => fn() => $this->createNote($this->service, 'x'),
            'records' => fn() => $this->service->records('notes', 'notes'),
            'manageRecord' => fn() => $this->service->manageRecord('notes', ['table' => 'notes', 'action' => 'create', 'values' => ['title' => 'x']]),
            'backup' => fn() => $this->service->captureForBackup('notes', $this->storage . '/snap.sqlite'),
            'snapshot' => fn() => $this->service->snapshotDatabase('notes', $this->storage . '/snap.sqlite'),
            'dispatch' => fn() => $this->service->dispatchRecordEvents('notes', static fn() => null),
            'install' => fn() => $this->service->install('notes', $this->projectV2(), 1),
        ];
        foreach ($operations as $name => $operation) {
            if (is_file($root . '/private/recovery-required')) unlink($root . '/private/recovery-required');
            $this->assertTrue($this->service->describe('notes')['recoveryRequired'], $name . ': the journal alone means recovery is required');
            try { $operation(); $this->fail($name . ' ran with the journal in recovery'); }
            catch (\RuntimeException $error) {
                $this->assertNotSame(409, $error->getCode(), $name);
                $this->assertStringContainsString('needs operator recovery', $error->getMessage(), $name);
            }
            $this->assertFileExists($root . '/private/recovery-required', $name . ' wrote the marker again');
            $this->assertSame($journal, file_get_contents($root . '/private/install.json'), $name . ' left the journal as it was');
            $this->assertSame($inputs, $this->listing($root), $name . ' kept every input');
        }
        $this->assertFileDoesNotExist($this->storage . '/snap.sqlite');
    }

    /** restore() into an empty installation root that holds only $journal refuses, rewrites the marker and writes nothing. */
    private function assertRestoreRefusesOverTheJournal(string $journal): void
    {
        $root = $this->storage . '/' . hash('sha256', 'restored');
        mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/private/install.json', $journal);
        try { $this->service->restore('restored', $this->project(), null, null); $this->fail('A restore ran over a journal in recovery'); }
        catch (\RuntimeException $error) { $this->assertStringContainsString('needs operator recovery', $error->getMessage()); }
        $this->assertFileExists($root . '/private/recovery-required');
        $this->assertSame($journal, file_get_contents($root . '/private/install.json'));
        foreach (['project.json', 'app', 'private/config.json', 'private/data/application.sqlite'] as $path) $this->assertFileDoesNotExist($root . '/' . $path);
    }

    /** Every path under $root with its size (-1 for a directory), the recovery marker aside. @return array<string, int> */
    private function listing(string $root): array
    {
        clearstatcache();
        $base = strlen(str_replace('\\', '/', $root)) + 1;
        $paths = [];
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::SELF_FIRST) as $entry) {
            $path = substr(str_replace('\\', '/', $entry->getPathname()), $base);
            if ($path !== 'private/recovery-required') $paths[$path] = $entry->isDir() ? -1 : $entry->getSize();
        }
        ksort($paths);
        return $paths;
    }

    /**
     * Run an update of `notes` (to the v2 project) in a child PHP process that exits at $point:
     * a phase once it is durable (seam afterPhase), or a step inside a phase once it has changed
     * the disk (seam afterStep).
     */
    private function terminateInstallAt(string $point, int $expectedVersion = 1, string $seam = 'afterPhase'): void
    {
        $script = $this->storage . '/terminate-' . $point . '.php';
        $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
        $project = $expectedVersion === 0 ? $this->project() : $this->projectV2();
        file_put_contents($script, '<?php
declare(strict_types=1);
require ' . var_export($autoload, true) . ';
final class Terminating extends \FormLogic\Services\NativeAppService {
    protected function ' . $seam . '(string $root, string $point): void { if ($point === ' . var_export($point, true) . ') { fwrite(STDOUT, "terminated at " . $point); exit(0); } }
}
$service = new Terminating(' . var_export($this->storage, true) . ', ' . var_export($this->runtime, true) . ', ' . var_export(getenv('FORMLOGIC_NODE_BIN'), true) . ');
$service->install("notes", ' . var_export($project, true) . ', ' . $expectedVersion . ');
fwrite(STDOUT, "completed");
');
        $php = PHP_BINARY;
        $output = shell_exec(escapeshellarg($php) . ' -d xdebug.mode=off ' . escapeshellarg($script) . ' 2>&1');
        $this->assertSame('terminated at ' . $point, trim((string) $output), 'the child process must die at the requested point');
    }
}

/** Writes come up short (128 bytes) for any destination matching the pattern. */
final class ShortWritingNativeAppService extends NativeAppService
{
    public function __construct(?string $storage, ?string $runtime, ?string $node, private string $pattern)
    {
        parent::__construct($storage, $runtime, $node);
    }

    protected function writeStream(string $path, $stream, string $bytes): int|false
    {
        if (preg_match($this->pattern, str_replace('\\', '/', $path))) {
            $short = substr($bytes, 0, min(128, strlen($bytes) - 1));
            fwrite($stream, $short);
            return strlen($short);
        }
        return parent::writeStream($path, $stream, $bytes);
    }
}

/** The rollback's "previous source back into app/" rename fails, as a locked or vanished directory would make it. */
final class StuckRollbackNativeAppService extends NativeAppService
{
    protected function renameChecked(string $from, string $to): bool
    {
        if (str_contains(str_replace('\\', '/', $from), '/previous-') && str_ends_with(str_replace('\\', '/', $to), '/app')) return false;
        return parent::renameChecked($from, $to);
    }
}

/** Damages the pre-install snapshot as soon as VACUUM INTO has written it, so its health check fails. */
final class CorruptSnapshotNativeAppService extends NativeAppService
{
    protected function afterStep(string $root, string $step): void
    {
        if ($step === 'snapshot-taken') foreach (glob($root . '/private/pre-install-*.sqlite') ?: [] as $snapshot) file_put_contents($snapshot, str_repeat('not a database ', 512));
    }
}

/** Reading the install journal fails; with $vanish its update retires it first, as clearJournal() racing a reader would. */
final class FailingJournalReadNativeAppService extends NativeAppService
{
    public function __construct(?string $storage, ?string $runtime, ?string $node, private bool $vanish)
    {
        parent::__construct($storage, $runtime, $node);
    }

    protected function readChecked(string $path): string|false
    {
        if (!str_ends_with(str_replace('\\', '/', $path), '/private/install.json')) return parent::readChecked($path);
        if ($this->vanish) unlink($path);
        return false;
    }
}

/** Counts how often project.json is decoded through get(). */
final class CountingNativeAppService extends NativeAppService
{
    public int $reads = 0;

    public function get(string $appId): ?array
    {
        $this->reads++;
        return parent::get($appId);
    }
}

/** Runs a closure after the pre-lock checks and before the lock is taken: the deterministic barrier of FL-S04. */
final class BarrierNativeAppService extends NativeAppService
{
    /** @param \Closure(string, string): void $barrier */
    public function __construct(?string $storage, ?string $runtime, ?string $node, private \Closure $barrier)
    {
        parent::__construct($storage, $runtime, $node);
    }

    protected function beforeLock(string $root, string $operation): void
    {
        ($this->barrier)($root, $operation);
    }
}
