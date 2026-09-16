<?php
declare(strict_types=1);
namespace FormLogic\Tests\Integration;

use FormLogic\Services\{HostedAppService, SandboxRunner};
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
