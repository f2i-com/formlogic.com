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
}
