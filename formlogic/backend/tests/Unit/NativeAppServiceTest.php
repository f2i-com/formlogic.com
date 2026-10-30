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

    public function testAPublishThatSaysNothingAboutAccessKeepsWhatTheAppHas(): void
    {
        $this->assertSame('members', $this->service->install('notes', ['access' => 'members'] + $this->project(), 0)['access']);
        $silent = $this->project();
        unset($silent['access']);
        $this->assertSame('members', $this->service->install('notes', $silent, 1)['access'], 'a members-only app must not open to everyone');
        $this->assertSame('application', $this->service->install('notes', $this->project(), 2)['access'], 'saying so still changes it');
        $this->assertSame('application', $this->service->install('notes', $silent, 3)['access']);
    }

    public function testANewAppThatSaysNothingAboutAccessIsForMembers(): void
    {
        $silent = $this->project();
        unset($silent['access']);
        $this->assertSame('members', $this->service->install('notes', $silent, 0)['access']);
    }

    private function createNote(string $title): array
    {
        return $this->service->request('notes', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1']);
    }

    /**
     * The installed runtime run by Node, whatever else it carries: for the tests of what this
     * service does with Node (a runtime from Softn v0.0.26 also carries softn-runner, which the
     * default service starts instead).
     */
    private function nodeService(): NativeAppService
    {
        return new NativeAppService($this->storage, dirname(__DIR__, 2) . '/resources/softn-native', getenv('FORMLOGIC_NODE_BIN'), 'node');
    }

    /**
     * Python as a client logic language. The file NAME is the whole declaration — it is what
     * RuntimeEngineService::languagesOf reads to clamp the app onto the ZIPP web-python engine, and
     * what Softn's shell reads to hold the engine to the same answer.
     */
    public function testPythonClientLogicIsAcceptedAndThePrivateServerTreeStaysJavaScript(): void
    {
        $project = $this->project();
        $project['files']['logic/counter.py'] = "count = 0\n";
        [$files] = NativeAppService::validateProject($project);
        $this->assertArrayHasKey('logic/counter.py', $files);

        // The native backend is executed by the Node runner as JavaScript and nothing derives a
        // language from it, so a Python file there is refused rather than installed unrunnable.
        foreach (['server/helper.py', 'backend/helper.py', 'private/helper.py', 'Server/helper.py'] as $path) {
            $private = $this->project();
            $private['files'][$path] = 'x = 1';
            try { NativeAppService::validateProject($private); $this->fail('accepted ' . $path); }
            catch (\InvalidArgumentException $e) { $this->assertStringContainsString('client logic language', $e->getMessage(), $path); }
        }

        // Lower case only, like every other extension in the rule: a `.PY` is refused at install
        // rather than accepted and then read as JavaScript by something comparing case-sensitively.
        $upper = $this->project();
        $upper['files']['logic/Counter.PY'] = 'count = 0';
        $this->expectException(\InvalidArgumentException::class);
        NativeAppService::validateProject($upper);
    }

    /**
     * The other half of the same rule, on a real installed project: what the frame receives, and
     * what that says the app's logic is written in. Everything that decides an engine — both
     * controllers' runtime GETs, the owner's settings view, the action-time staleness check, the
     * write endpoint's audit row and the admin's per-app list — reads these two and nothing else.
     */
    public function testTheInstalledProjectAnswersWhatItsClientLogicIsWrittenIn(): void
    {
        $project = $this->project();
        $project['files']['logic/counter.py'] = "count = 0\n";
        $this->service->install('languages', $project, 0);

        $client = NativeAppService::clientFiles($this->service->get('languages'));
        $this->assertArrayHasKey('logic/counter.py', $client);
        $this->assertArrayNotHasKey('server/main.logic', $client, 'the private backend is not the frame\'s');
        $this->assertArrayNotHasKey('server/migrations/001.sql', $client);
        $this->assertSame(['javascript', 'python'], $this->service->clientLanguages('languages'));

        // An app with no installation at all is not a Python app, and says so without throwing:
        // every caller is deciding an engine, not serving source.
        $this->assertSame(['javascript'], $this->service->clientLanguages('never-installed'));
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
        $this->service = $this->nodeService();
        $first = $this->service->preflight(true);
        $this->assertTrue($first['ok'], json_encode($first['checks']));
        $this->assertFalse($first['cached']);
        $ids = array_column($first['checks'], 'id');
        foreach (['php.proc_open', 'php.pdo_sqlite', 'php.sqlite3', 'runtime.files', 'runtime.protocol', 'node.executable', 'node.version', 'node.options', 'node.capabilities', 'storage.writable', 'worker.startup'] as $id) {
            $this->assertContains($id, $ids);
        }
        $this->assertSame([], $first['warnings'], 'with sqlite3 loaded there is nothing to warn about');
        $this->assertSame([], array_filter($first['checks'], static fn ($c) => !empty($c['warning'])));
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
        $badNode = new NativeAppService($this->storage, $runtime, $this->storage . '/no-such-node.exe', 'node');
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

    /**
     * A worker lives for one request. Left to itself V8 begins optimizing the engine's dispatch
     * loop (one WebAssembly function of 280 KB) as soon as it runs hot: a compile of about 450 ms
     * that the process cannot exit during, for code nothing would run. Every native request
     * waited about a third of a second after its answer was written. The worker is started
     * without that compile, from one definition that preflight starts Node with as well, so a
     * Node that refuses an option fails the check and not every request.
     */
    public function testTheWorkerIsStartedWithoutTheOptimizingCompileItNeverLivesToUse(): void
    {
        $command = NativeAppService::runnerCommand('node-binary', '/the/runtime');
        $this->assertSame('node-binary', $command[0]);
        $this->assertSame('/the/runtime/runner.mjs', $command[count($command) - 1], 'the script is last: everything before it is an option of Node, never of the app');
        foreach (['--max-old-space-size=128', '--disable-proto=throw', '--no-wasm-tier-up', '--no-wasm-dynamic-tiering'] as $option) {
            $this->assertContains($option, $command);
        }
        // Both, not one: without tier-up alone V8 still tiers up dynamically.
        $this->assertCount(6, $command);

        // The real Node takes them, and says so in preflight.
        $this->service = $this->nodeService();
        $checks = array_column($this->service->preflight(true)['checks'], null, 'id');
        $this->assertTrue($checks['node.options']['ok'], $checks['node.options']['message']);
        $this->assertStringNotContainsString($this->storage, $checks['node.options']['message']);

        // And a request is still answered when started that way.
        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('Started lean')['status']);
    }

    /**
     * A runtime that carries softn-runner for this server (Softn v0.0.26 on) runs on it: preflight
     * asks for no Node and starts a worker, and a request is answered with no Node to start, here
     * one that does not exist. Asked for Node, the same runtime is run by Node again.
     */
    public function testARuntimeThatCarriesTheRunnerRunsWithoutNode(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $name = ['Linux' => 'softn-runner-linux-x86_64', 'Windows' => 'softn-runner-windows-x86_64.exe'][PHP_OS_FAMILY] ?? null;
        if ($name === null || !in_array(strtolower(php_uname('m')), ['x86_64', 'amd64'], true) || !is_file($runtime . '/bin/' . $name)) {
            $this->markTestSkipped('The installed Softn runtime carries no softn-runner for this server (Softn v0.0.26 on, Linux or Windows x86-64).');
        }
        $failing = static fn (array $result): array => array_column(array_filter($result['checks'], static fn ($c) => !$c['ok']), 'message', 'id');

        // 'auto' whatever FORMLOGIC_NATIVE_RUNNER says: this is the runner's own test.
        $this->service = new NativeAppService($this->storage, $runtime, $this->storage . '/no-such-node.exe', 'auto');
        $result = $this->service->preflight(true);
        $this->assertTrue($result['ok'], json_encode($result['checks']));
        $ids = array_column($result['checks'], 'id');
        $this->assertContains('runner.executable', $ids);
        $this->assertContains('worker.startup', $ids);
        $this->assertSame([], array_values(array_filter($ids, static fn ($id) => str_starts_with($id, 'node.'))), 'no Node is asked for');
        $this->assertSame($name, $result['runtime']['runner']);
        foreach ($result['checks'] as $check) $this->assertStringNotContainsString($this->storage, $check['message']);

        $this->service->install('notes', $this->project(), 0);
        $this->assertSame(201, $this->createNote('No Node')['status']);

        $node = new NativeAppService($this->storage, $runtime, $this->storage . '/no-such-node.exe', 'node');
        $this->assertArrayHasKey('node.executable', $failing($node->preflight(true)));
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
        // Every module the runtime ships (a release can add one, as Softn v0.0.16 added sql.mjs), and the engine.
        foreach ([...array_map('basename', glob($runtime . '/*.mjs')), 'wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm'] as $file) copy($runtime . '/' . $file, $strict . '/' . $file);
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

    /** A SoftN app with no backend: its pages, logic, seed data and a picture, and no id, as most declare none. */
    private function clientProject(): array
    {
        return ['access' => 'application', 'assets' => ['assets/dot.png' => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='], 'files' => [
            'manifest.json' => json_encode(['name' => 'Field notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'files' => ['ui' => ['ui/main.ui'], 'xdb' => ['xdb/tasks.xdb']]]),
            'ui/main.ui' => '<logic>var count = 0;</logic><Text>Field notes {count}</Text>',
            'xdb/tasks.xdb' => '{"collection":"tasks","records":[]}',
        ]];
    }

    /**
     * A SoftN app with no server block is all client: it installs, keeps every file it came with,
     * and has no backend and no database. Nothing starts a runner for it, which this service
     * shows: the Node it would start is a path that does not exist.
     */
    public function testAClientOnlyAppInstallsWithNoBackendAndKeepsItsFiles(): void
    {
        $service = new NativeAppService($this->storage, dirname(__DIR__, 2) . '/resources/softn-native', $this->storage . '/no-such-node', 'node');
        $project = $this->clientProject();
        $saved = $service->install('fieldnotes', $project, 0);
        $this->assertSame(1, $saved['version']);
        $this->assertSame($project['files'], $service->get('fieldnotes')['files']);
        $this->assertSame($project['assets'], $service->get('fieldnotes')['assets']);
        $this->assertFalse(NativeAppService::hasBackend($saved));
        $this->assertFileDoesNotExist($this->storage . '/' . hash('sha256', 'fieldnotes') . '/private/data/application.sqlite');
        $this->assertSame(['installed' => true, 'tables' => [], 'backend' => false], $service->records('fieldnotes'));
        foreach ([
            'request' => fn() => $service->request('fieldnotes', ['method' => 'GET', 'path' => '/api/notes', 'client_ip' => '127.0.0.1']),
            'records of a table' => fn() => $service->records('fieldnotes', 'tasks'),
        ] as $call => $run) {
            try { $run(); $this->fail("{$call} answered for a client-only app"); }
            catch (\RuntimeException $refused) { $this->assertSame(404, $refused->getCode(), $call . ': ' . $refused->getMessage()); }
        }
        $described = $service->describe('fieldnotes');
        $this->assertSame([], $described['capabilities']);
        $this->assertFalse($described['hasDatabase']);
        $this->assertSame(0, $service->dispatchRecordEvents('fieldnotes', fn() => $this->fail('A client-only app has no events')));
        $this->assertNull($service->captureForBackup('fieldnotes', $this->storage . '/backup.sqlite')['databasePath']);
        // An update installs the same way, and so does a restore.
        $project['files']['ui/main.ui'] = '<Text>Field notes, again</Text>';
        $this->assertSame(2, $service->install('fieldnotes', $project, 1)['version']);
        $service->remove('fieldnotes');
        $this->assertSame('none', $service->restore('fieldnotes', $project, null, null)['database']);
        $this->assertSame($project['files'], $service->get('fieldnotes')['files']);
    }

    /**
     * Client-only is a manifest with no server block at all. An empty or partial block is a backend
     * that does not meet the rules, and backend code with no block to run it is refused by name.
     */
    public function testOnlyAManifestWithNoServerBlockIsClientOnly(): void
    {
        $project = $this->clientProject();
        $manifest = json_decode($project['files']['manifest.json'], true);
        foreach ([[], ['entry' => 'server/main.logic']] as $server) {
            $partial = $project;
            $partial['files']['manifest.json'] = json_encode($manifest + ['id' => 'test.fieldnotes', 'server' => $server]);
            try { NativeAppService::validateProject($partial); $this->fail('A partial server block was taken for client-only'); }
            catch (\InvalidArgumentException $refused) { $this->assertSame('Include a server API v1 .logic entry', $refused->getMessage()); }
        }
        $stray = $project;
        $stray['files']['server/main.logic'] = 'function createNote() {}';
        try { NativeAppService::validateProject($stray); $this->fail('Backend code with no server block was accepted'); }
        catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('server/main.logic is backend code', $refused->getMessage()); }
        $this->assertSame([], NativeAppService::validateProject($project)[3]);
        $this->assertTrue(NativeAppService::hasBackend($this->project()));
    }

    /**
     * Most SoftN apps declare no id, those with a backend too. Such an app runs under the
     * identity named after this app: the runner's copy of the manifest carries it, and the
     * project as stored, and downloaded, stays exactly as it was uploaded.
     */
    public function testABackendThatDeclaresNoIdRunsUnderTheAppsOwnIdentity(): void
    {
        $nameless = $this->project();
        $nameless['files']['manifest.json'] = json_encode(array_diff_key(json_decode($nameless['files']['manifest.json'], true), ['id' => true]));
        $this->service->install('nameless', $nameless, 0);
        $this->assertSame($nameless['files'], $this->service->get('nameless')['files']);
        $root = $this->storage . '/' . hash('sha256', 'nameless');
        $this->assertSame('formlogic.app.nameless', json_decode((string) file_get_contents($root . '/private/config.json'), true)['appId']);
        $this->assertSame('formlogic.app.nameless', json_decode((string) file_get_contents($root . '/app/manifest.json'), true)['id']);
        $this->assertSame(201, $this->service->request('nameless', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'No id'], 'client_ip' => '127.0.0.1'])['status']);
        // The same file again is an update of the same app.
        $this->assertSame(2, $this->service->install('nameless', $nameless, 1)['version']);
        $this->assertCount(1, $this->service->records('nameless', 'notes')['rows']);
    }

    /**
     * An account backup restores each app under a NEW app id. One that declares no id keeps the
     * identity its keys were made under (the captured configuration names it): the key-preserving
     * restore is accepted, its backend runs on its records, and a later update keeps that identity
     * rather than taking one named after the new app.
     */
    public function testAnAppThatDeclaresNoIdKeepsItsIdentityThroughARestoreUnderANewAppId(): void
    {
        $nameless = $this->project();
        $nameless['files']['manifest.json'] = json_encode(array_diff_key(json_decode($nameless['files']['manifest.json'], true), ['id' => true]));
        $this->service->install('before', $nameless, 0);
        $this->assertSame(201, $this->service->request('before', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Kept'], 'client_ip' => '127.0.0.1'])['status']);
        $captured = $this->service->captureForBackup('before', $this->storage . '/before.sqlite', null, true);
        $this->assertSame('formlogic.app.before', $captured['hostConfig']['appId']);
        $restored = $this->service->restore('after', $captured['project'], $captured['databasePath'], $captured['hostConfig']);
        $this->assertSame(NativeAppService::CRYPTO_RESTORED, $restored['cryptoMaterial']);
        $config = $this->storage . '/' . hash('sha256', 'after') . '/private/config.json';
        $this->assertSame('formlogic.app.before', json_decode((string) file_get_contents($config), true)['appId']);
        $this->assertSame(201, $this->service->request('after', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'After the restore'], 'client_ip' => '127.0.0.1'])['status']);
        $this->assertCount(2, $this->service->records('after', 'notes')['rows']);
        $this->service->install('after', $nameless, $restored['version']);
        $this->assertSame('formlogic.app.before', json_decode((string) file_get_contents($config), true)['appId']);
        $this->assertCount(2, $this->service->records('after', 'notes')['rows']);
    }

    /**
     * A client-only app that declares no id runs under one named after the app. When a later
     * version brings a backend and an id of its own, the installation takes it (nothing was kept
     * under the old one), and the backend then runs. From there its identity is fixed.
     */
    public function testAClientOnlyAppCanGainABackendAndThenKeepsItsIdentity(): void
    {
        $this->service->install('grows', $this->clientProject(), 0);
        $config = $this->storage . '/' . hash('sha256', 'grows') . '/private/config.json';
        $this->assertSame('formlogic.app.grows', json_decode((string) file_get_contents($config), true)['appId']);
        $backend = $this->project();
        $this->assertSame(2, $this->service->install('grows', $backend, 1)['version']);
        $this->assertSame('test.notes', json_decode((string) file_get_contents($config), true)['appId']);
        $this->assertSame(201, $this->service->request('grows', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Now with a backend'], 'client_ip' => '127.0.0.1'])['status']);
        $renamed = $backend;
        $renamed['files']['manifest.json'] = str_replace('"test.notes"', '"test.other"', $renamed['files']['manifest.json']);
        try { $this->service->install('grows', $renamed, 2); $this->fail('An app with a database took another identity'); }
        catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('This app runs as test.notes, and its data and keys are kept under that identity', $refused->getMessage()); }
    }

    /**
     * An app installed with an id may drop it in a later version: it keeps running under that id
     * (its configuration names it). A key-preserving restore of it, under a new app id, takes the
     * identity its captured keys name, and its backend runs on the restored records.
     */
    public function testAnAppThatDroppedItsIdRestoresWithItsKeys(): void
    {
        $this->service->install('named', $this->project(), 0);
        $this->assertSame(201, $this->createNoteIn('named', 'Before'));
        $nameless = $this->project();
        $nameless['files']['manifest.json'] = json_encode(array_diff_key(json_decode($nameless['files']['manifest.json'], true), ['id' => true]));
        $this->service->install('named', $nameless, 1);
        $captured = $this->service->captureForBackup('named', $this->storage . '/named.sqlite', null, true);
        $this->assertSame('test.notes', $captured['hostConfig']['appId']);
        $restored = $this->service->restore('elsewhere', $captured['project'], $captured['databasePath'], $captured['hostConfig']);
        $this->assertSame(NativeAppService::CRYPTO_RESTORED, $restored['cryptoMaterial']);
        $this->assertSame(201, $this->createNoteIn('elsewhere', 'After'));
        $this->assertCount(2, $this->service->records('elsewhere', 'notes')['rows']);
        // A captured configuration whose identity is not one a manifest could name is refused.
        $this->service->remove('elsewhere');
        try { $this->service->restore('elsewhere', $captured['project'], $captured['databasePath'], ['appId' => 'bad id!'] + $captured['hostConfig']); $this->fail('An identity no manifest could name was restored'); }
        catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('does not belong to this app', $refused->getMessage()); }
    }

    /**
     * A backend whose migrations have run keeps its server block: the runner holds every later
     * version to those migrations. A version without one is refused, and says why.
     */
    public function testABackendWhoseMigrationsRanKeepsItsServerBlock(): void
    {
        $this->service->install('kept', $this->project(), 0);
        $this->assertSame(201, $this->createNoteIn('kept', 'Stored'));
        try { $this->service->install('kept', $this->clientProject(), 1); $this->fail('The backend was dropped from a database whose migrations ran'); }
        catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('database migrations have already run', $refused->getMessage()); }
        $this->assertCount(1, $this->service->records('kept', 'notes')['rows']);
    }

    /**
     * An app with no backend needs no runner: a server that cannot start one (no Node, no
     * proc_open) still installs and restores it, and still refuses a backend.
     */
    public function testAClientOnlyAppNeedsNoRuntime(): void
    {
        $empty = $this->storage . '/no-runtime';
        mkdir($empty);
        $service = new NativeAppService($this->storage, $empty, $this->storage . '/no-such-node', 'node');
        $this->assertFalse($service->available());
        $this->assertSame(1, $service->install('browser-only', $this->clientProject(), 0)['version']);
        $service->remove('browser-only');
        $this->assertSame('none', $service->restore('browser-only', $this->clientProject(), null, null)['database']);
        try { $service->install('server-side', $this->project(), 0); $this->fail('A backend installed with no runtime'); }
        catch (\RuntimeException $refused) { $this->assertStringContainsString('Prepare the native app runtime', $refused->getMessage()); }
    }

    /**
     * A manifest with no id is given to the runner with one named; one the runner's copy cannot
     * be written back from (a number past what JSON can carry) is refused as the owner's to fix,
     * not answered with a server error.
     */
    public function testAManifestWithNoIdThatCannotBeWrittenBackIsRefusedPlainly(): void
    {
        $odd = $this->project();
        $manifest = json_decode($odd['files']['manifest.json'], true);
        unset($manifest['id']);
        $odd['files']['manifest.json'] = substr(json_encode($manifest), 0, -1) . ',"weight":1e400}';
        try { $this->service->install('odd', $odd, 0); $this->fail('An unwritable manifest was installed'); }
        catch (\InvalidArgumentException $refused) { $this->assertStringContainsString('give it an id', $refused->getMessage()); }
        $this->assertNull($this->service->get('odd'), 'nothing was installed');
    }

    /**
     * The app's page gets the backend's body as it was written: an empty object stays an object,
     * going in and coming back, and the key an app retries a write with reaches its handler.
     */
    public function testAnEmptyObjectStaysAnObjectAndTheIdempotencyKeyReachesTheHandler(): void
    {
        $echo = $this->project();
        $manifest = json_decode($echo['files']['manifest.json'], true);
        $manifest['server']['routes'][] = ['path' => '/api/echo', 'method' => 'POST', 'handler' => 'echo', 'transaction' => 'read', 'authorization' => 'anonymous'];
        $echo['files']['manifest.json'] = json_encode($manifest);
        $echo['files']['server/main.logic'] .= "\nfunction echo(req) { return {status:200,body:{sent:req.body,isList:Array.isArray(req.body.tags),key:req.headers['idempotency-key'],none:{}}}; }";
        $this->service->install('echo', $echo, 0);
        $request = ['method' => 'POST', 'path' => '/api/echo', 'body' => (object) ['tags' => (object) []], 'headers' => (object) ['authorization' => '', 'idempotency-key' => 'invite-7'], 'client_ip' => '127.0.0.1'];
        $page = $this->service->request('echo', $request, [], [], null, true);
        $this->assertSame('{"sent":{"tags":{}},"isList":false,"key":"invite-7","none":{}}', json_encode($page['body']));
        // Read for this server's own use, the body is arrays, as it always was.
        $this->assertSame([], $this->service->request('echo', $request)['body']['none']);
    }

    private function createNoteIn(string $app, string $title): int
    {
        return $this->service->request($app, ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1'])['status'];
    }

    /**
     * An app's database is the file in its own data folder. A link in its place (one the app's
     * server logic left there, were it ever out of its sandbox) is refused by the records,
     * management, backup and event paths, where PHP followed it into another app's database.
     */
    public function testALinkInPlaceOfTheAppDatabaseIsRefused(): void
    {
        $this->service->install('mine', $this->project(), 0);
        $this->service->install('theirs', $this->project(), 0);
        $this->service->request('theirs', ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'Theirs'], 'client_ip' => '127.0.0.1'], [], [['event' => 'app.record.created.notes', 'bindings' => ['b']]]);
        $database = $this->storage . '/' . hash('sha256', 'mine') . '/private/data/application.sqlite';
        $theirs = $this->storage . '/' . hash('sha256', 'theirs') . '/private/data/application.sqlite';
        unlink($database);
        if (!@symlink($theirs, $database)) $this->markTestSkipped('This system does not let this account make a symbolic link.');
        foreach ([
            'records' => fn() => $this->service->records('mine', 'notes'),
            'manageRecord' => fn() => $this->service->manageRecord('mine', ['operation' => 'list', 'table' => 'notes']),
            'captureForBackup' => fn() => $this->service->captureForBackup('mine', $this->storage . '/backup.sqlite'),
        ] as $path => $call) {
            try {
                $call();
                $this->fail($path . ' opened the database a link pointed at');
            } catch (\RuntimeException $refused) {
                $this->assertSame(409, $refused->getCode(), $path . ': ' . $refused->getMessage());
                $this->assertStringContainsString('is a link', $refused->getMessage(), $path);
            }
        }
        $this->assertSame(0, $this->service->dispatchRecordEvents('mine', fn() => $this->fail('An event was read through the link')));
        $this->assertFileDoesNotExist($this->storage . '/backup.sqlite');
        // Theirs is untouched, and its own paths still work.
        $this->assertSame([['id' => 1, 'title' => 'Theirs']], $this->service->records('theirs', 'notes')['rows']);
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
        catch (\RuntimeException $error) {
            $this->assertSame(422, $error->getCode());
            $this->assertStringStartsWith("The app's backend could not start", $error->getMessage());
        }
        $this->assertSame(1, $this->service->get('notes')['version']);
        $this->assertSame(['notes'], $this->service->records('notes')['tables']);
        $this->assertSame(201, $this->createNote('Still working')['status']);
    }

    public function testAnUpdateMustKeepEveryMigrationThatAlreadyRanAndIsToldHow(): void
    {
        $project = $this->project();
        $this->service->install('notes', $project, 0);
        $this->createNote('Keep this note');
        // Rewriting the applied migration, the way an AI rebuilding the app from scratch does.
        $changed = $project;
        $changed['files']['server/migrations/001.sql'] = 'CREATE TABLE recipes(id INTEGER PRIMARY KEY, title TEXT);';
        try { $this->service->install('notes', $changed, 1); $this->fail('A changed migration was installed'); }
        catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('server/migrations/001.sql has already run', $error->getMessage());
            $this->assertStringContainsString('server/migrations/002.sql', $error->getMessage());
        }
        // Dropping it from the manifest is refused the same way.
        $unlisted = $project;
        $manifest = json_decode($project['files']['manifest.json'], true);
        $manifest['server']['database']['migrations'] = [];
        $unlisted['files']['manifest.json'] = json_encode($manifest);
        try { $this->service->install('notes', $unlisted, 1); $this->fail('An unlisted migration was installed'); }
        catch (\InvalidArgumentException $error) { $this->assertStringContainsString('must keep it, listed in manifest.json', $error->getMessage()); }
        $this->assertSame(1, $this->service->get('notes')['version']);
        // Kept as it was, with the change as the next migration, it installs and the record stays.
        $manifest['server']['database']['migrations'] = ['server/migrations/001.sql', 'server/migrations/002.sql'];
        $project['files']['manifest.json'] = json_encode($manifest);
        $project['files']['server/migrations/002.sql'] = 'ALTER TABLE notes ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;';
        $this->assertSame(2, $this->service->install('notes', $project, 1)['version']);
        $this->assertSame(201, $this->createNote('Another note')['status']);
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
