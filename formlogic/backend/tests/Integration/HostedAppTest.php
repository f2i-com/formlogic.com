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
