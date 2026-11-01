<?php
declare(strict_types=1);
namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\HostedAppController;
use FormLogic\Database\SqliteSnapshot;
use FormLogic\Services\{HostedAppService, SandboxRunner};
use FormLogic\Support\SqlErrorText;
use PHPUnit\Framework\TestCase;

class HostedAppTest extends TestCase
{
    private HostedAppService $host;
    private string $root;
    protected function setUp(): void
    {
        ini_set('zend.exception_ignore_args', '1');
        $this->root = sys_get_temp_dir() . '/fl-hosted-' . bin2hex(random_bytes(6));
        $this->host = new HostedAppService(new SandboxRunner(), $this->root);
    }
    protected function tearDown(): void
    {
        foreach (glob($this->root . '/*') ?: [] as $file) unlink($file);
        if (is_dir($this->root)) rmdir($this->root);
    }
    private function package(): array
    {
        return ['version' => 1, 'client' => [
            'manifest.json' => '{"main":"ui/main.ui","name":"Test","config":{"server":{"token":"private"}}}',
            'ui/main.ui' => '<Text>Hello</Text>',
        ], 'actions' => [
            'save' => ['access' => 'owner', 'mode' => 'write', 'source' => 'function onRequest(ctx) { return ctx.db.put("notes",ctx.input.id,{text:ctx.input.text,author:ctx.user.id}); }'],
            'list' => ['access' => 'member', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return ctx.db.list("notes",10,0); }'],
        ]];
    }
    public function testRealScriptPersistenceIsolationAndClientPrivacy(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        self::assertSame(['id' => 'one'], $this->host->run('app-a', 'save', ['id' => 'one', 'text' => "A quote: '"], 'owner', true));
        $reopened = new HostedAppService(new SandboxRunner(), $this->root);
        $rows = $reopened->run('app-a', 'list', [], 'member', false);
        self::assertSame("A quote: '", $rows[0]['data']['text']);
        self::assertSame('owner', $rows[0]['data']['author']);
        $this->host->publish('app-b', $this->package(), 0);
        self::assertSame([], $this->host->run('app-b', 'list', [], 'owner', true));
        self::assertArrayNotHasKey('actions', $this->host->get('app-a'));
        self::assertStringNotContainsString('private', json_encode($this->host->get('app-a')));
        $this->host->publish('app-a', $this->package(), 1);
        self::assertSame(1, $this->host->get('app-a', true)['recordCount']);
    }
    private function connection(string $appId = 'app-a'): \PDO
    {
        $db = new \PDO('sqlite:' . HostedAppService::databasePath($appId, $this->root), null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA busy_timeout=0');
        return $db;
    }
    public function testAppDatabasesUseWal(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        self::assertSame('wal', strtolower((string) $this->connection()->query('PRAGMA journal_mode')->fetchColumn()));
    }
    public function testAReadActionRunsWhileAWriterHoldsTheLock(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'kept'], 'owner', true);
        $writer = $this->connection();
        $writer->exec('BEGIN IMMEDIATE');
        $writer->exec("UPDATE records SET updated_at = 'not committed'");
        $started = microtime(true);
        $rows = $this->host->run('app-a', 'list', [], 'member', false);
        self::assertLessThan(1.5, microtime(true) - $started, 'it waits for nothing');
        self::assertSame('kept', $rows[0]['data']['text']);
        self::assertNotSame('not committed', $rows[0]['updatedAt']);
        $writer->exec('ROLLBACK');
    }
    public function testAWriteActionGoesAheadWhileAReadIsOpen(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $reader = $this->connection();
        $reader->exec('BEGIN');
        $reader->query('SELECT COUNT(*) FROM records')->fetchAll();
        self::assertSame(['id' => 'one'], $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'kept'], 'owner', true));
        $reader->exec('COMMIT');
    }
    public function testAReadActionStillCannotWrite(): void
    {
        $p = $this->package();
        $p['actions']['sneak'] = ['access' => 'member', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return ctx.db.put("notes","x",{}); }'];
        $this->host->publish('app-a', $p, 0);
        try {
            $this->host->run('app-a', 'sneak', [], 'member', false);
            self::fail('A read action writes nothing');
        } catch (\RuntimeException $refused) {
            self::assertStringContainsString('read only', $refused->getMessage());
        }
        self::assertSame([], $this->host->run('app-a', 'list', [], 'owner', true));
    }
    public function testAWriteActionThatCannotGetTheLockIsBusyAndNotARefusal(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $writer = $this->connection();
        $writer->exec('BEGIN IMMEDIATE');
        try {
            $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'text'], 'owner', true);
            self::fail('The lock is taken');
        } catch (\PDOException $busy) {
            self::assertTrue(SqlErrorText::isBusy($busy->getMessage()), $busy->getMessage());
        }
        $writer->exec('ROLLBACK');
        self::assertSame([], $this->host->run('app-a', 'list', [], 'owner', true));
    }
    public function testABusyDatabaseAnswersSomethingAClientCanRetry(): void
    {
        $controller = (new \ReflectionClass(HostedAppController::class))->newInstanceWithoutConstructor();
        $respond = new \ReflectionMethod(HostedAppController::class, 'respond');
        $busy = static function (): array {
            throw new \PDOException('SQLSTATE[HY000]: General error: 5 database is locked');
        };
        $answer = $respond->invoke($controller, new \Slim\Psr7\Response(), $busy, ['id' => 'actor']);
        self::assertSame(503, $answer->getStatusCode());
        self::assertSame('2', $answer->getHeaderLine('Retry-After'));
        $body = json_decode((string) $answer->getBody(), true);
        self::assertSame('app_busy', $body['code']);
        self::assertStringNotContainsString('SQLSTATE', (string) $answer->getBody());
    }
    public function testEveryCopyHoldsWhatIsStillInTheWal(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        // An open connection keeps the -wal, so the record is in it and not yet in the file.
        $open = $this->connection();
        $open->query('SELECT COUNT(*) FROM records')->fetchAll();
        $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'only-in-the-wal'], 'owner', true);
        $path = HostedAppService::databasePath('app-a', $this->root);
        self::assertStringNotContainsString('only-in-the-wal', (string) file_get_contents($path));

        $download = $this->host->snapshot('app-a');
        self::assertStringContainsString('only-in-the-wal', (string) file_get_contents($download));
        unlink($download);

        $staged = $this->root . '/staged.bak';
        $snapshot = (new SqliteSnapshot())->snapshot($path, $staged, ['deployment', 'records'], static function (string $copy): void {
            HostedAppService::decryptCopy($copy, 'app-a');
        });
        self::assertSame('delete', strtolower((string) (new \PDO('sqlite:' . $staged))->query('PRAGMA journal_mode')->fetchColumn()), $snapshot['method']);
        self::assertStringContainsString('only-in-the-wal', (string) file_get_contents($staged));
        self::assertFileDoesNotExist($staged . '-wal');

        // A restore is handed a copy like this one: under a key, the live file's rows are sealed.
        self::assertTrue(HostedAppService::restoreDatabase('app-b', $staged, $this->root, false));
        unlink($staged);
        self::assertSame('only-in-the-wal', $this->host->run('app-b', 'list', [], 'owner', true)[0]['data']['text']);
    }
    public function testARestoreIsNotJoinedByAWalLeftBehind(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'kept'], 'owner', true);
        $target = HostedAppService::databasePath('app-b', $this->root);
        file_put_contents($target . '-wal', 'a leftover of the database that was here');
        file_put_contents($target . '-shm', 'and its index');

        $copy = $this->host->snapshot('app-a');
        self::assertTrue(HostedAppService::restoreDatabase('app-b', $copy, $this->root, false));
        unlink($copy);

        self::assertFileDoesNotExist($target . '-shm');
        self::assertSame('kept', $this->host->run('app-b', 'list', [], 'owner', true)[0]['data']['text']);
    }
    public function testErasingAnAppTakesItsWalWithIt(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $path = HostedAppService::databasePath('app-a', $this->root);
        file_put_contents($path . '-wal', 'records');
        file_put_contents($path . '-shm', 'index');
        HostedAppService::eraseStorage('app-a', $this->root);
        foreach ([$path, $path . '-wal', $path . '-shm'] as $file) {
            self::assertFileDoesNotExist($file);
        }
    }
    public function testMemberCannotCallOwnerAction(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $this->expectExceptionCode(404);
        $this->host->run('app-a', 'save', ['id' => 'one', 'text' => 'secret'], 'member', false);
    }
    public function testPortableManifestRetainsMultipleScreensAndJsonResources(): void
    {
        $package = $this->package();
        $package['client']['ui/detail.ui'] = '<Text>Record details</Text>';
        $package['client']['data/options.json'] = '{"choices":["First","Second"]}';
        $this->host->publish('multi-screen', $package, 0);
        $client = $this->host->get('multi-screen')['client'];
        $manifest = json_decode($client['manifest.json'], true);
        self::assertSame(['ui/main.ui', 'ui/detail.ui'], $manifest['files']['ui']);
        self::assertSame(['data/options.json'], $manifest['files']['json']);
        self::assertArrayNotHasKey('config', $manifest, 'Private manifest configuration stays excluded');
    }
    public function testAScriptCannotCarryOnWritingAfterAFailedOperationAndIsToldWhy(): void
    {
        $p = $this->package();
        $p['actions']['carryOn'] = ['access' => 'owner', 'mode' => 'write', 'source' => 'function onRequest(ctx) { try { ctx.db.put("not a collection!","x",{}); } catch (e) {} ctx.db.put("notes","after",{text:"after"}); return "done"; }'];
        $this->host->publish('app-a', $p, 0);
        try {
            $this->host->run('app-a', 'carryOn', [], 'owner', true);
            self::fail('The action should have failed');
        } catch (\RuntimeException $failed) {
            self::assertStringContainsString('Invalid collection', $failed->getMessage());
            self::assertStringContainsString('rolled back', $failed->getMessage());
            self::assertSame(422, $failed->getCode());
        }
        self::assertSame([], $this->host->run('app-a', 'list', [], 'owner', true));
    }
    public function testNoOperationRunsAfterOneHasFailed(): void
    {
        // What matters is the case no script can stage: SQLite ended the transaction itself, so a
        // write that ran now would commit on its own. The rollback at the end can't undo that.
        $this->host->publish('app-a', $this->package(), 0);
        $runner = $this->createMock(SandboxRunner::class);
        $after = null;
        $runner->method('runScript')->willReturnCallback(function (string $script, array $context, callable $handler) use (&$after): array {
            $operation = static fn (string $collection): array => [json_encode(['op' => 'list', 'collection' => $collection])];
            try { $handler('db', 'getField', $operation('not a collection!')); } catch (\Throwable) { /* The script carries on. */ }
            try { $handler('db', 'getField', $operation('notes')); } catch (\Throwable $refused) { $after = $refused->getMessage(); }
            return ['result' => 'done'];
        });
        try {
            (new HostedAppService($runner, $this->root))->run('app-a', 'list', [], 'owner', true);
            self::fail('The action should have failed');
        } catch (\RuntimeException $failed) {
            self::assertStringContainsString('Invalid collection', $failed->getMessage());
        }
        self::assertSame('An earlier operation failed', $after);
    }
    public function testFailedScriptRollsBack(): void
    {
        $p = $this->package();
        $p['actions']['fail'] = ['access' => 'owner', 'mode' => 'write', 'source' => 'function onRequest(ctx) {ctx.db.put("notes","bad",{text:"bad"}); throw new Error("stop");}'];
        $this->host->publish('app-a', $p, 0);
        try { $this->host->run('app-a', 'fail', [], 'owner', true); self::fail('Expected failure'); }
        catch (\RuntimeException $e) { self::assertSame(422, $e->getCode()); }
        self::assertSame(0, $this->host->get('app-a', true)['recordCount']);
    }
    public function testReadOnlyActionCannotWriteEvenWhenErrorCaught(): void
    {
        $p = $this->package();
        $p['actions']['list']['source'] = 'function onRequest(ctx) {try {ctx.db.put("notes","bad",{text:"bad"});} catch(e) {} return true;}';
        $this->host->publish('app-a', $p, 0);
        try { $this->host->run('app-a', 'list', [], 'owner', true); self::fail('Expected failure'); }
        catch (\RuntimeException $e) { self::assertSame(422, $e->getCode()); }
        self::assertSame(0, $this->host->get('app-a', true)['recordCount']);
    }
    public function testConcurrentPublishCannotOverwrite(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $this->expectExceptionCode(409);
        $this->host->publish('app-a', $this->package(), 0);
    }
    /**
     * Python as a client logic language: the file NAME is the whole declaration, and it is what
     * RuntimeEngineService::languagesOf reads to clamp this app onto the ZIPP web-python engine.
     */
    public function testPythonClientLogicIsAcceptedAndListedInTheRebuiltManifest(): void
    {
        $p = $this->package();
        $p['client']['logic/counter.py'] = "count = 0\n";
        $p['client']['manifest.json'] = '{"main":"ui/main.ui","name":"Test","files":{"logic":["logic/counter.py"]}}';
        $clean = $this->host->validate($p);
        $this->assertArrayHasKey('logic/counter.py', $clean['client']);
        $manifest = json_decode($clean['client']['manifest.json'], true);
        $this->assertSame(['logic/counter.py'], $manifest['files']['logic']);
        $this->assertSame(['ui/main.ui'], $manifest['files']['ui'], 'a .py is logic, never a screen');
        $this->assertNotContains('logic/counter.py', $manifest['files']['json']);
    }

    public function testAPythonFileOutsideTheLogicListIsKeptButNotDeclared(): void
    {
        $p = $this->package();
        $p['client']['extra/unused.py'] = "x = 1\n";
        $clean = $this->host->validate($p);
        $this->assertArrayHasKey('extra/unused.py', $clean['client']);
        $this->assertSame([], json_decode($clean['client']['manifest.json'], true)['files']['logic']);
    }

    public function testAPythonFileUnderThePrivateServerTreeIsStillRefused(): void
    {
        // Backend actions are JavaScript and are run server-side by the sandbox; the client-only
        // rule that keeps a server/ file out of a download does not change for Python.
        $p = $this->package(); $p['client']['server/secret.py'] = 'token = 1';
        $this->expectException(\InvalidArgumentException::class);
        $this->host->validate($p);
    }

    public function testAnUpperCasePythonExtensionIsRefusedAtPublishRatherThanRunAsJavaScript(): void
    {
        $p = $this->package(); $p['client']['logic/Counter.PY'] = 'count = 0';
        $this->expectException(\InvalidArgumentException::class);
        $this->host->validate($p);
    }

    public function testALogicListEntryMustStillNameAnIncludedLogicOrPythonFile(): void
    {
        foreach ([['logic/missing.py'], ['ui/main.ui'], ['manifest.json']] as $logic) {
            $p = $this->package();
            $p['client']['manifest.json'] = '{"main":"ui/main.ui","name":"Test","files":{"logic":' . json_encode($logic) . '}}';
            try { $this->host->validate($p); $this->fail('accepted ' . json_encode($logic)); }
            catch (\InvalidArgumentException $e) { $this->assertStringContainsString('logic file', $e->getMessage()); }
        }
    }

    public function testPrivateClientFileIsRefused(): void
    {
        $p = $this->package(); $p['client']['server/main.logic'] = 'secret';
        $this->expectException(\InvalidArgumentException::class);
        $this->host->validate($p);
    }
    public function testTraversalIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->host->get('../other-app');
    }
    public function testBrokenScriptDoesNotReplacePublishedVersion(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $p = $this->package();
        $p['actions']['save']['source'] = 'function onRequest( {';
        try { $this->host->publish('app-a', $p, 1); self::fail('Expected invalid script'); }
        catch (\InvalidArgumentException $e) { self::assertStringContainsString('save', $e->getMessage()); }
        self::assertSame(1, $this->host->get('app-a')['version']);
    }
    public function testDatabaseSnapshotContainsPrivateCodeAndSavedData(): void
    {
        $this->host->publish('app-a', $this->package(), 0);
        $this->host->run('app-a', 'save', ['id'=>'one','text'=>'kept'], 'owner', true);
        $path = $this->host->snapshot('app-a');
        try {
            $snapshot = new \PDO('sqlite:' . $path);
            self::assertSame(1, (int) $snapshot->query('SELECT COUNT(*) FROM records')->fetchColumn());
            self::assertStringContainsString('onRequest', $snapshot->query('SELECT package FROM deployment')->fetchColumn());
            self::assertSame('ok', $snapshot->query('PRAGMA integrity_check')->fetchColumn());
            $snapshot = null;
        } finally { unlink($path); }
    }
}
