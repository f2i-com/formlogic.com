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

    /** Run an update of `notes` (to the v2 project) in a child PHP process that exits once $phase is durable. */
    private function terminateInstallAt(string $phase, int $expectedVersion = 1): void
    {
        $script = $this->storage . '/terminate-' . $phase . '.php';
        $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
        $project = $expectedVersion === 0 ? $this->project() : $this->projectV2();
        file_put_contents($script, '<?php
declare(strict_types=1);
require ' . var_export($autoload, true) . ';
final class Terminating extends \FormLogic\Services\NativeAppService {
    protected function afterPhase(string $root, string $phase): void { if ($phase === ' . var_export($phase, true) . ') { fwrite(STDOUT, "terminated at " . $phase); exit(0); } }
}
$service = new Terminating(' . var_export($this->storage, true) . ', ' . var_export($this->runtime, true) . ', ' . var_export(getenv('FORMLOGIC_NODE_BIN'), true) . ');
$service->install("notes", ' . var_export($project, true) . ', ' . $expectedVersion . ');
fwrite(STDOUT, "completed");
');
        $php = PHP_BINARY;
        $output = shell_exec(escapeshellarg($php) . ' -d xdebug.mode=off ' . escapeshellarg($script) . ' 2>&1');
        $this->assertSame('terminated at ' . $phase, trim((string) $output), 'the child process must die at the requested phase');
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
