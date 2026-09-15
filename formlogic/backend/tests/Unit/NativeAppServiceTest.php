<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/** Real ZIPP/SQLite integration without an account database or external services. */
final class NativeAppServiceTest extends TestCase
{
    private string $storage;
    private NativeAppService $service;

    protected function setUp(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        if (!is_file($runtime . '/runner.mjs') || !getenv('FORMLOGIC_NODE_BIN')) $this->markTestSkipped('Prepare native runtime and set FORMLOGIC_NODE_BIN.');
        $this->storage = sys_get_temp_dir() . '/formlogic-native-test-' . bin2hex(random_bytes(10));
        mkdir($this->storage, 0700);
        $this->service = new NativeAppService($this->storage, $runtime, getenv('FORMLOGIC_NODE_BIN'));
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

    private function project(): array
    {
        return ['access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode(['id' => 'test.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => [
                'entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [['path' => '/api/notes', 'method' => 'POST', 'handler' => 'createNote', 'transaction' => 'write', 'authorization' => 'anonymous']],
            ]]),
            'ui/main.ui' => '<Text>Notes</Text>',
            'server/migrations/001.sql' => 'CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT, session_token TEXT);',
            'server/main.logic' => 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title,session_token) VALUES(?,?)",[req.body.title,"private-fixture-value"]); return {status:201,body:softn.sql.first("SELECT id,title FROM notes ORDER BY id DESC",[])}; }',
        ]];
    }

    private function createNote(string $title): array
    {
        return $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1']);
    }

    public function testAiToolsCreateAndEditTheStarterWithRealZippAndSqlite(): void
    {
        $apps = $this->createMock(\FormLogic\Services\AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'ai-app', 'ownerId' => 'owner']);
        $tools = new \FormLogic\Services\ChatToolsService(
            $this->createMock(\FormLogic\Services\FormService::class), $apps,
            $this->createMock(\FormLogic\Services\ResponseService::class), native: $this->service
        );
        $ctx = new \FormLogic\Services\ChatToolsContext('owner');
        $project = $tools->callChatTool('get_native_app_template', [], $ctx)['project'];
        $saved = $tools->callChatTool('publish_native_app_project', ['appId' => 'ai-app', 'expectedVersion' => 0, 'project' => $project], $ctx);
        $this->assertSame(1, $saved['version']);
        $result = $this->service->request('ai-app', ['method' => 'POST', 'path' => '/api/items', 'body' => ['title' => 'AI tool review'], 'client_ip' => '127.0.0.1']);
        $this->assertSame(201, $result['status'], json_encode($result));
        $read = $tools->callChatTool('get_native_app_project', ['appId' => 'ai-app', 'file' => 'ui/main.ui'], $ctx);
        $updated = $tools->callChatTool('update_native_app_files', ['appId' => 'ai-app', 'expectedVersion' => $read['version'], 'files' => ['ui/main.ui' => str_replace('My app', 'Edited with AI tools', $read['source'])]], $ctx);
        $this->assertSame(2, $updated['version']);
        $records = $tools->callChatTool('list_native_app_records', ['appId' => 'ai-app', 'table' => 'items'], $ctx);
        $this->assertSame('AI tool review', $records['rows'][0]['title']);
        $this->assertSame($project['files']['server/main.logic'], $this->service->get('ai-app')['files']['server/main.logic']);
        $listed = $this->service->request('ai-app', ['method' => 'GET', 'path' => '/api/items', 'client_ip' => '127.0.0.1']);
        $this->assertSame(200, $listed['status'], json_encode($listed));
        $this->assertStringContainsString('AI tool review', json_encode($listed['body']));
    }

    // ── audit FL-03: runtime preflight ────────────────────────────────────────

    public function testPreflightStartsARealWorkerAndCachesBriefly(): void
    {
        $first = $this->service->preflight(true);
        $this->assertTrue($first['ok'], json_encode($first['checks']));
        $this->assertFalse($first['cached']);
        $ids = array_column($first['checks'], 'id');
        foreach (['php.proc_open', 'php.pdo_sqlite', 'runtime.files', 'runtime.protocol', 'node.executable', 'node.version', 'node.capabilities', 'storage.writable', 'worker.startup'] as $id) {
            $this->assertContains($id, $ids);
        }
        $this->assertSame(1, $first['runtime']['nativeProtocol']);
        $this->assertMatchesRegularExpression('/^\d+\.\d+\.\d+$/', $first['runtime']['node']);
        // No probe app, worker file or record survives the check.
        $this->assertSame([], glob($this->storage . '/.preflight-*') ?: []);
        $this->assertSame([], glob($this->storage . '/*') ?: [], 'no app directories were created');
        foreach ($first['checks'] as $check) $this->assertStringNotContainsString($this->storage, $check['message'], 'no absolute paths leak into messages');

        $second = $this->service->preflight();
        $this->assertTrue($second['cached'], 'a public page must not fork a worker on every request');
        $this->assertSame($first['checkedAt'], $second['checkedAt']);
    }

    public function testPreflightReportsDistinctFailures(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $failing = static fn (array $result): array => array_column(array_filter($result['checks'], static fn ($c) => !$c['ok']), 'message', 'id');

        // Missing executable: distinct from missing artifacts.
        $badNode = new NativeAppService($this->storage, $runtime, $this->storage . '/no-such-node.exe');
        $result = $badNode->preflight(true);
        $this->assertFalse($result['ok']);
        $this->assertArrayHasKey('node.executable', $failing($result));
        $this->assertArrayNotHasKey('runtime.files', $failing($result));
        $this->assertArrayNotHasKey('worker.startup', $failing($result), 'no worker is started once an earlier check failed');

        // Unprepared runtime directory: names the missing files, never the path.
        $noRuntime = new NativeAppService($this->storage, $this->storage . '/empty-runtime', getenv('FORMLOGIC_NODE_BIN'));
        $result = $noRuntime->preflight(true);
        $this->assertFalse($result['ok']);
        $this->assertStringContainsString('runner.mjs', $failing($result)['runtime.files']);
        $this->assertStringNotContainsString($this->storage, $failing($result)['runtime.files']);

        // Unsupported runtime version: protocol mismatch is its own failure.
        $oldRuntime = $this->storage . '/old-runtime';
        mkdir($oldRuntime . '/wasm', 0700, true);
        foreach (['runner.mjs', 'request-worker.mjs', 'wasm-host.mjs', 'migrations.mjs', 'wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm'] as $file) copy($runtime . '/' . $file, $oldRuntime . '/' . $file);
        file_put_contents($oldRuntime . '/host-protocol.json', json_encode(['nativeProtocol' => 0, 'minimumNode' => '99.0.0']));
        $result = (new NativeAppService($this->storage, $oldRuntime, getenv('FORMLOGIC_NODE_BIN')))->preflight(true);
        $this->assertFalse($result['ok']);
        $this->assertArrayHasKey('runtime.protocol', $failing($result));

        // Too-old Node according to the runtime's own minimum.
        file_put_contents($oldRuntime . '/host-protocol.json', json_encode(['nativeProtocol' => 1, 'recordEvents' => 1, 'minimumNode' => '99.0.0']));
        $result = (new NativeAppService($this->storage, $oldRuntime, getenv('FORMLOGIC_NODE_BIN')))->preflight(true);
        $this->assertFalse($result['ok']);
        $this->assertStringContainsString('older than the runtime minimum 99.0.0', $failing($result)['node.version']);

        // Unwritable private storage (a FILE where the storage root should be).
        file_put_contents($this->storage . '/not-a-dir', 'x');
        $result = (new NativeAppService($this->storage . '/not-a-dir', $runtime, getenv('FORMLOGIC_NODE_BIN')))->preflight(true);
        $this->assertFalse($result['ok']);
        $this->assertArrayHasKey('storage.writable', $failing($result));
    }

    // ── integration audit M2/M3/L3: request-time guards and the shared protocol ──

    public function testRequestRefusesANodeBinaryOlderThanTheRuntimeMinimum(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('Before')['status']);

        // The same installed app, served by a runtime whose declared minimum no Node meets.
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $strict = $this->storage . '/strict-runtime';
        mkdir($strict . '/wasm', 0700, true);
        foreach (['runner.mjs', 'request-worker.mjs', 'request-hook.mjs', 'wasm-host.mjs', 'migrations.mjs', 'crypto.mjs', 'time.mjs', 'record-events.mjs', 'wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm'] as $file) copy($runtime . '/' . $file, $strict . '/' . $file);
        file_put_contents($strict . '/host-protocol.json', json_encode(['nativeProtocol' => NativeAppService::NATIVE_PROTOCOL, 'recordEvents' => NativeAppService::RECORD_EVENTS_PROTOCOL, 'minimumNode' => '99.0.0']));
        $service = new NativeAppService($this->storage, $strict, getenv('FORMLOGIC_NODE_BIN'));
        try {
            $service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Refused'], 'client_ip' => '127.0.0.1']);
            $this->fail('a too-old Node binary must be refused before the worker starts');
        } catch (\RuntimeException $e) {
            $this->assertSame(503, $e->getCode());
            $this->assertMatchesRegularExpression('/^Node\.js \d+\.\d+\.\d+ is older than the native runtime minimum 99\.0\.0/', $e->getMessage());
            $this->assertStringNotContainsString($this->storage, $e->getMessage());
        }
        $this->assertSame([['id' => 1, 'title' => 'Before']], $this->service->records('notes', 'notes')['rows'], 'nothing reached the database');

        // A runtime that declares no minimum, or one this Node meets, still serves requests.
        file_put_contents($strict . '/host-protocol.json', json_encode(['nativeProtocol' => NativeAppService::NATIVE_PROTOCOL, 'recordEvents' => NativeAppService::RECORD_EVENTS_PROTOCOL, 'minimumNode' => '22.5.0']));
        $this->assertSame(201, $service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Served'], 'client_ip' => '127.0.0.1'])['status']);
        $this->assertFileExists($this->storage . '/.node-version.json', 'the Node version is cached so a request does not spawn node --version every time');
    }

    public function testNodeEnvironmentPassesOnlyAllowlistedVariablesAndTheHostContext(): void
    {
        $source = [
            'Path' => 'C:\\nodejs;C:\\Windows', 'SystemRoot' => 'C:\\Windows', 'TEMP' => 'C:\\tmp', 'HOME' => '/home/php', 'NODE_OPTIONS' => '--stack-size=2000',
            'DB_PASSWORD' => 'hunter2', 'DB_USERNAME' => 'root', 'APP_KEY' => 'base64:secret', 'OPENAI_API_KEY' => 'sk-live', 'FORMLOGIC_NODE_BIN' => 'node',
            'SOFTN_HOST_CONTEXT' => '{"spoofed":true}', 'NODE_NO_WARNINGS' => '0', 'NOT_A_STRING' => ['x'],
        ];
        $env = NativeAppService::nodeEnvironment($source, ['SOFTN_BACKEND_ROOT' => '/apps/one', 'SOFTN_HOST_CONTEXT' => '{"userId":"u1"}', 'SOFTN_RECORD_EVENTS' => '[]']);
        $this->assertSame([
            'Path' => 'C:\\nodejs;C:\\Windows', 'SystemRoot' => 'C:\\Windows', 'TEMP' => 'C:\\tmp', 'HOME' => '/home/php', 'NODE_OPTIONS' => '--stack-size=2000',
            'NODE_NO_WARNINGS' => '1', 'SOFTN_BACKEND_ROOT' => '/apps/one', 'SOFTN_HOST_CONTEXT' => '{"userId":"u1"}', 'SOFTN_RECORD_EVENTS' => '[]',
        ], $env);
        foreach (['DB_PASSWORD', 'DB_USERNAME', 'APP_KEY', 'OPENAI_API_KEY', 'FORMLOGIC_NODE_BIN', 'NOT_A_STRING'] as $secret) $this->assertArrayNotHasKey($secret, $env);
        $this->assertSame('{"userId":"u1"}', $env['SOFTN_HOST_CONTEXT'], 'the host context comes from the host, never from the process environment');
    }

    public function testProtocolConstantsMatchTheUiAndThePreparedRuntime(): void
    {
        // formlogic/ui/src/lib/softn/protocol.json is the shared source of truth for the UI and the build scripts.
        $shared = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/ui/src/lib/softn/protocol.json'), true);
        $this->assertSame($shared['nativeProtocol'], NativeAppService::NATIVE_PROTOCOL);
        $this->assertSame($shared['recordEvents'], NativeAppService::RECORD_EVENTS_PROTOCOL);
        $runtime = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/resources/softn-native/host-protocol.json'), true);
        $this->assertSame(NativeAppService::NATIVE_PROTOCOL, $runtime['nativeProtocol']);
        $this->assertSame(NativeAppService::RECORD_EVENTS_PROTOCOL, $runtime['recordEvents']);
    }

    // ── audit FL-02: backup surface and restore ───────────────────────────────

    public function testDescribeSnapshotAndRestorePreserveRecordsAndKeyMaterial(): void
    {
        $this->assertNull($this->service->describe('notes'));
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('Kept')['status']);
        $described = $this->service->describe('notes');
        $this->assertSame(['manifestId' => 'test.notes', 'version' => 1, 'home' => false, 'access' => 'application', 'capabilities' => ['sql'], 'hasDatabase' => true, 'recoveryRequired' => false, 'updateUnfinished' => false], $described);
        $this->assertArrayNotHasKey('keyHex', $described);
        $config = $this->service->hostConfig('notes');
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $config['keyHex']);

        $snapshot = $this->storage . '/snapshot.sqlite';
        $meta = $this->service->snapshotDatabase('notes', $snapshot);
        $this->assertSame('ok', $meta['quickCheck']);
        $this->assertFileExists($snapshot);

        // Restore into a SECOND storage root (a fresh host) with the original keys.
        $otherStorage = $this->storage . '/other-host';
        mkdir($otherStorage);
        $other = new NativeAppService($otherStorage, dirname(__DIR__, 2) . '/resources/softn-native', getenv('FORMLOGIC_NODE_BIN'));
        $result = $other->restore('notes', $this->service->get('notes'), $snapshot, $config);
        $this->assertSame(['version' => 1, 'database' => 'restored', 'cryptoMaterial' => NativeAppService::CRYPTO_RESTORED], $result);
        $this->assertSame($config['keyHex'], $other->hostConfig('notes')['keyHex']);
        $this->assertSame([['id' => 1, 'title' => 'Kept']], $other->records('notes', 'notes')['rows']);
        $this->assertSame(201, $other->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'After'], 'client_ip' => '127.0.0.1'])['status']);

        // Never overwrite an existing installation.
        try { $other->restore('notes', $this->service->get('notes'), $snapshot, $config); $this->fail('restore overwrote an installation'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('already exists', $e->getMessage()); }
        $this->assertCount(2, $other->records('notes', 'notes')['rows'], 'the refused restore changed nothing');

        // Without key material the key is reissued and reported as such.
        $result = $other->restore('reissued', $this->service->get('notes'), $snapshot, null);
        $this->assertSame(NativeAppService::CRYPTO_REISSUED, $result['cryptoMaterial']);
        $this->assertNotSame($config['keyHex'], $other->hostConfig('reissued')['keyHex']);
        // Keys from a different app identity are refused.
        try { $other->restore('wrong-key', $this->service->get('notes'), null, ['appId' => 'someone.else', 'keyHex' => str_repeat('a', 64)]); $this->fail('foreign key material accepted'); }
        catch (\InvalidArgumentException $e) { $this->assertStringContainsString('does not belong', $e->getMessage()); }
        $this->assertNull($other->get('wrong-key'));
    }

    // ── R2-FL-01: one managed capture under the management lock ──

    public function testCaptureForBackupHoldsTheManagementLockAndIsVersionConsistent(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('captured')['status']);
        $capture = $this->service->captureForBackup('notes', $this->storage . '/capture.sqlite', null, true);
        $this->assertSame(1, $capture['version']);
        $this->assertSame('test.notes', $capture['manifestId']);
        $this->assertSame(1, $capture['project']['version']);
        $this->assertSame('ok', $capture['snapshot']['quickCheck']);
        $this->assertFileExists($capture['databasePath']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $capture['hostConfig']['keyHex']);
        $this->assertNull($this->service->captureForBackup('notes', $this->storage . '/capture-2.sqlite')['hostConfig'], 'host keys only when asked');
        // The lock is released after capture: an update proceeds.
        $this->assertSame(2, $this->service->install('notes', $this->project(), 1)['version']);
        $again = $this->service->captureForBackup('notes', $this->storage . '/capture-3.sqlite');
        $this->assertSame(2, $again['version']);
        $this->assertSame(2, $again['project']['version']);

        // While an install holds the exclusive lock, capture refuses with 409
        // instead of reading a half-activated installation.
        $root = $this->storage . '/' . hash('sha256', 'notes');
        $exclusive = fopen($root . '/private/manage.lock', 'c');
        $this->assertTrue(flock($exclusive, LOCK_EX | LOCK_NB));
        try {
            try { $this->service->captureForBackup('notes', $this->storage . '/capture-4.sqlite'); $this->fail('captured during an update'); }
            catch (\RuntimeException $e) { $this->assertSame(409, $e->getCode()); }
            $this->assertFileDoesNotExist($this->storage . '/capture-4.sqlite');
        } finally { flock($exclusive, LOCK_UN); fclose($exclusive); }
        // And a capture holds the SHARED lock: an exclusive install cannot slip in between its reads.
        $shared = fopen($root . '/private/manage.lock', 'c');
        $this->assertTrue(flock($shared, LOCK_SH | LOCK_NB));
        try {
            try { $this->service->install('notes', $this->project(), 2); $this->fail('installed under a shared lock'); }
            catch (\RuntimeException $e) { $this->assertSame(409, $e->getCode()); }
        } finally { flock($shared, LOCK_UN); fclose($shared); }
    }

    public function testFailedRestoreLeavesNoInstallation(): void
    {
        $project = $this->project();
        $project['files']['server/main.logic'] = 'this is not valid logic {{{';
        try { $this->service->restore('broken', $project, null, null); $this->fail('broken source restored'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('failed validation', $e->getMessage()); }
        $this->assertNull($this->service->get('broken'));
        $this->assertSame([], glob($this->storage . '/*') ?: [], 'nothing remains on disk');

        // A damaged snapshot is refused before anything is written.
        file_put_contents($this->storage . '/damaged.sqlite', 'not a database');
        try { $this->service->restore('damaged', $this->project(), $this->storage . '/damaged.sqlite', null); $this->fail('damaged snapshot restored'); }
        catch (\RuntimeException $e) { $this->assertStringContainsString('integrity check', $e->getMessage()); }
        $this->assertNull($this->service->get('damaged'));
    }

    public function testRuntimeRecordsAndUpdatesUseTheSameDatabase(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('First note')['status']);
        $records = $this->service->records('notes', 'notes');
        $this->assertSame(['id', 'title'], $records['columns']);
        $this->assertSame([['id' => 1, 'title' => 'First note']], $records['rows']);
        $saved = $this->service->install('notes', $this->project(), 1);
        $this->assertSame(2, $saved['version']);
        $this->assertSame(201, $this->createNote('After update')['status']);
        $this->assertCount(2, $this->service->records('notes', 'notes')['rows']);
    }

    public function testCommittedRecordEventsSurviveDeliveryFailureAndAreAcknowledged(): void
    {
        $this->service->install('notes', $this->project(), 0);
        $result = $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Event note'], 'client_ip' => '127.0.0.1'], [], [['event' => 'app.record.created.notes', 'bindings' => ['binding-1']]]);
        $this->assertSame(201, $result['status'], json_encode($result));
        $firstId = null;
        try {
            $this->service->dispatchRecordEvents('notes', function ($id) use (&$firstId) { $firstId = $id; throw new \RuntimeException('Queue temporarily unavailable'); });
            $this->fail('Delivery failure was swallowed');
        } catch (\RuntimeException $error) { $this->assertSame('Queue temporarily unavailable', $error->getMessage()); }
        $this->assertSame(1, $this->service->dispatchRecordEvents('notes', function ($id, $event, $data, $bindings) use ($firstId) {
            $this->assertSame($firstId, $id);
            $this->assertSame('app.record.created.notes', $event);
            $this->assertSame(['binding-1'], $bindings);
            $this->assertSame(['id' => 1, 'title' => 'Event note'], $data['record']);
            $this->assertTrue($data['recordPreview']);
        }));
        $this->assertSame(0, $this->service->dispatchRecordEvents('notes', fn() => $this->fail('Acknowledged event was delivered again')));
        $this->assertSame(['notes'], $this->service->records('notes')['tables']);
    }

    public function testRolledBackWriteDoesNotProduceAnEvent(): void
    {
        $project = $this->project();
        $project['files']['server/main.logic'] = 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",[req.body.title]); return {status:422,rollback:true,body:{error:"Cancelled"}}; }';
        $this->service->install('notes', $project, 0);
        $result = $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Cancelled'], 'client_ip' => '127.0.0.1'], [], [['event' => 'app.record.created.notes', 'bindings' => ['binding-1']]]);
        $this->assertSame(422, $result['status']);
        $this->assertSame([], $this->service->records('notes', 'notes')['rows']);
        $this->assertSame(0, $this->service->dispatchRecordEvents('notes', fn() => $this->fail('Rolled-back event was dispatched')));
    }

    public function testUpdatesAndDeletesCaptureTheCorrectRecordSnapshot(): void
    {
        $project = $this->project();
        $project['files']['server/main.logic'] = 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",["Before"]); softn.sql.execute("UPDATE notes SET title=? WHERE id=1",["After"]); softn.sql.execute("DELETE FROM notes WHERE id=1",[]); return {status:200,body:{ok:true}}; }';
        $this->service->install('notes', $project, 0);
        $subscriptions = array_map(fn($operation) => ['event' => "app.record.$operation.notes", 'bindings' => ['binding-' . $operation]], ['created', 'updated', 'deleted']);
        $result = $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => [], 'client_ip' => '127.0.0.1'], [], $subscriptions);
        $this->assertSame(200, $result['status']);
        $events = [];
        $this->assertSame(3, $this->service->dispatchRecordEvents('notes', function ($id, $event, $data) use (&$events) { $events[] = [$data['operation'], $data['record']['title']]; }));
        $this->assertSame([['created', 'Before'], ['updated', 'After'], ['deleted', 'After']], $events);
        $this->assertSame([], $this->service->records('notes', 'notes')['rows']);
    }

    public function testBrokenSourceDoesNotApplyNewMigrationOrReplaceWorkingProject(): void
    {
        $project = $this->project();
        $this->service->install('notes', $project, 0);
        $manifest = json_decode($project['files']['manifest.json'], true);
        $manifest['server']['database']['migrations'][] = 'server/migrations/002.sql';
        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/migrations/002.sql'] = 'CREATE TABLE later(id INTEGER PRIMARY KEY);';
        $project['files']['server/main.logic'] = 'function createNote( {';
        try { $this->service->install('notes', $project, 1); $this->fail('Broken source was installed'); }
        catch (\RuntimeException $error) { $this->assertSame(422, $error->getCode()); }
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertSame(['notes'], $this->service->records('notes')['tables']);
        $this->assertSame(201, $this->createNote('Still working')['status']);
    }

    public function testStaleVersionAndFailedMigrationPreserveExistingRecords(): void
    {
        $project = $this->project();
        $this->service->install('notes', $project, 0);
        $this->createNote('Keep this note');
        try { $this->service->install('notes', $project, 0); $this->fail('Stale version was installed'); }
        catch (\RuntimeException $error) { $this->assertSame(409, $error->getCode()); }
        $manifest = json_decode($project['files']['manifest.json'], true);
        $manifest['server']['database']['migrations'][] = 'server/migrations/002.sql';
        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/migrations/002.sql'] = 'CREATE TABLE later(id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES(1);';
        try { $this->service->install('notes', $project, 1); $this->fail('Failed migration was installed'); }
        catch (\RuntimeException $error) { $this->assertSame(422, $error->getCode()); }
        $this->assertSame(['notes'], $this->service->records('notes')['tables']);
        $this->assertSame('Keep this note', $this->service->records('notes', 'notes')['rows'][0]['title']);
        $this->assertSame(201, $this->createNote('Still writable')['status']);
    }

    public function testCapabilityUpdatesPreserveKeysAndRollBackWithFailedSource(): void
    {
        $project = $this->project();
        $this->service->install('notes', $project, 0);
        $configPath = $this->storage . '/' . hash('sha256', 'notes') . '/private/config.json';
        $original = json_decode(file_get_contents($configPath), true);
        $manifest = json_decode($project['files']['manifest.json'], true);
        $manifest['server']['requires']['capabilities'][] = 'time';
        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/main.logic'] = 'function createNote(req) { return {status:200,body:{now:softn.time.now()}}; }';
        $this->service->install('notes', $project, 1);
        $updated = json_decode(file_get_contents($configPath), true);
        self::assertSame(['sql', 'time'], $updated['capabilities']);
        self::assertSame($original['keyHex'], $updated['keyHex']);
        self::assertSame($original['cryptoDomains'], $updated['cryptoDomains']);
        self::assertGreaterThan(0, $this->createNote('Clock')['body']['now']);

        $manifest['server']['requires']['capabilities'] = ['sql'];
        $broken = $project;
        $broken['files']['manifest.json'] = json_encode($manifest);
        $broken['files']['server/main.logic'] = 'function createNote( {';
        try { $this->service->install('notes', $broken, 2); self::fail('Broken source was installed'); }
        catch (\RuntimeException $error) { self::assertSame(422, $error->getCode()); }
        self::assertSame($updated, json_decode(file_get_contents($configPath), true));
        self::assertSame(2, $this->service->get('notes')['version']);
        self::assertGreaterThan(0, $this->createNote('Clock after rollback')['body']['now']);

        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/main.logic'] = $this->project()['files']['server/main.logic'];
        $this->service->install('notes', $project, 2);
        self::assertSame(['sql'], json_decode(file_get_contents($configPath), true)['capabilities']);
        self::assertSame(201, $this->createNote('Still writable')['status']);
    }
}
