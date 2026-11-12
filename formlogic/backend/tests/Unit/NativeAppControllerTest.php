<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Models\User;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService, RuntimeEngineService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

final class NativeAppControllerTest extends TestCase
{
    private ?string $storage = null;

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-controller-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** The engine this install serves. Nothing here reaches MySQL: the resolver's own rules are pinned in Unit\RuntimeEngineServiceTest. */
    private const ENGINE = ['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef'];

    private function engines(): RuntimeEngineService
    {
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(self::ENGINE);
        $engines->method('ownerPolicy')->willReturn(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python'], 'installed' => ['zipp-web-python']]);
        return $engines;
    }

    private function fixture(string $access, ?NativeAppService $service = null, array $settings = ['softnApp' => true], ?RuntimeEngineService $engines = null): array
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => $settings]);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => $settings]);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $users = $this->createMock(AppUserService::class);
        $native = $service ?? $this->createMock(NativeAppService::class);
        if ($service === null) {
            $project = ['access' => $access, 'version' => 1, 'assets' => [], 'files' => [
                'manifest.json' => '{"id":"notes","server":{"entry":"server/main.logic"}}',
                'ui/main.ui' => '<Text>Notes</Text>', 'server/main.logic' => 'private source',
            ]];
            $native->method('get')->willReturn($project);
            $native->method('project')->willReturn($project);
            $native->method('runtimeProject')->willReturn(['project' => $project, 'media' => ['file' => '', 'sha256' => '', 'size' => 0, 'count' => 0]]);
        }
        return [new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines ?? $this->engines()), $users, $native];
    }

    private function request(string $method, bool $demo = false, string $user = 'owner'): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/', ['REMOTE_ADDR' => '203.0.113.5'])->withAttribute('userId', $user);
        return $request->withAttribute('user', new User(id: $user, email: $demo ? ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local') : 'owner@example.com'));
    }

    private static function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true);
    }

    public function testPublishedApplicationKeepsItsOwnSignInAndPrivateBackend(): void
    {
        [$controller] = $this->fixture('application');
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/');
        $response = $controller->runtime($request, new Response(), ['slug' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $data = json_decode((string) $response->getBody(), true);
        $this->assertArrayNotHasKey('server/main.logic', $data['project']['client']);
        $this->assertArrayNotHasKey('server', json_decode($data['project']['client']['manifest.json'], true));
    }

    public function testThePublishedManifestCannotNameItsOwnEngine(): void
    {
        // The engine is the server's decision (RuntimeEngineService), so a manifest that names one
        // is stripped the way the private server block is — a published project must never be able
        // to talk its own shell into another engine.
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $native = $this->createMock(NativeAppService::class);
        $project = ['access' => 'application', 'version' => 1, 'assets' => [], 'files' => [
            'manifest.json' => '{"id":"notes","engine":"host-js","logicEngine":"host-js","config":{"engine":"host-js","theme":"dark"}}',
            'ui/main.ui' => '<Text>Notes</Text>',
        ]];
        $native->method('get')->willReturn($project);
        $native->method('project')->willReturn($project);
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $this->engines());
        $response = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $manifest = json_decode(self::body($response)['project']['client']['manifest.json'], true);
        $this->assertArrayNotHasKey('engine', $manifest);
        $this->assertArrayNotHasKey('logicEngine', $manifest);
        $this->assertArrayNotHasKey('engine', $manifest['config']);
        $this->assertSame('dark', $manifest['config']['theme'], 'the rest of the manifest is untouched');
    }

    public function testTheRuntimeGetCarriesTheEngineTheServerDecided(): void
    {
        [$controller] = $this->fixture('application');
        $response = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame(['id' => 'zipp-web-python', 'revision' => '0123456789abcdef'], self::body($response)['engine']);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
    }

    public function testTheOwnerGetCarriesTheChoiceAndWhatMayBeChosen(): void
    {
        [$controller] = $this->fixture('application');
        $body = self::body($controller->manage($this->request('GET'), new Response(), ['id' => 'notes']));
        $this->assertSame(self::ENGINE, $body['engine']);
        $this->assertSame(['zipp-web-python'], $body['enginePolicy']['allowed']);
    }

    public function testAnAppRequestWithNoEngineHeaderIsAnsweredAsBeforeAndAStaleOneIsRefused(): void
    {
        [$controller, $users, $native] = $this->fixture('members');
        $users->method('getAppUser')->willReturn(['status' => 'active', 'roleId' => 'editor']);
        $native->method('request')->willReturn(['status' => 200, 'body' => []]);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/', ['REMOTE_ADDR' => '127.0.0.1'])
            ->withAttribute('userId', 'member')->withParsedBody(['method' => 'GET', 'path' => '/api/notes']);
        $this->assertSame(200, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
        $this->assertSame(200, $controller->runtime($request->withHeader('X-FormLogic-Client-Engine', 'zipp-web-python;0123456789abcdef'), new Response(), ['slug' => 'notes'])->getStatusCode());
        // What a page loaded before a revocation or a policy edit would still be sending.
        $stale = $controller->runtime($request->withHeader('X-FormLogic-Client-Engine', 'host-js;0123456789abcdef'), new Response(), ['slug' => 'notes']);
        $this->assertSame(409, $stale->getStatusCode());
        $this->assertSame('engine_changed', self::body($stale)['code']);
        $this->assertSame('no-store', $stale->getHeaderLine('Cache-Control'));
    }

    // ── what the app's logic is written in ───────────────────────────────────

    /**
     * A controller over one project, recording every ($appId, $languages) the resolver was asked.
     *
     * @return array{0: NativeAppController, 1: AppUserService&\PHPUnit\Framework\MockObject\MockObject, 2: \ArrayObject}
     */
    private function recordingFixture(array $files, string $access = 'application'): array
    {
        $asked = new \ArrayObject();
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturnCallback(static function (string $appId, array $languages = []) use ($asked) {
            $asked[] = $languages;
            return self::ENGINE;
        });
        $engines->method('ownerPolicy')->willReturn(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python'], 'installed' => ['zipp-web-python']]);
        $engines->method('assertInstalledRuns');
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $users = $this->createMock(AppUserService::class);
        $native = $this->createMock(NativeAppService::class);
        $project = ['access' => $access, 'version' => 1, 'assets' => [], 'files' => $files + ['manifest.json' => '{"id":"notes","server":{"entry":"server/main.logic"}}']];
        $native->method('get')->willReturn($project);
        $native->method('project')->willReturn($project);
        $native->method('runtimeProject')->willReturn(['project' => $project, 'media' => ['file' => '', 'sha256' => '', 'size' => 0, 'count' => 0]]);
        $native->method('request')->willReturn(['status' => 200, 'body' => []]);
        // The REAL rule over this fixture's files, not a canned answer: the mock stands in for the
        // store, never for the derivation. NativeAppServiceTest pins the same two helpers against
        // a real project on disk.
        $native->method('clientLanguages')->willReturnCallback(
            static fn () => RuntimeEngineService::languagesOf(NativeAppService::clientFiles($project))
        );
        $controller = new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
        return [$controller, $users, $asked];
    }

    /**
     * The whole point of this slice: the server is told an app needs Python by the app's own client
     * file NAMES, and nothing else. Softn's shell derives the same list from the same names
     * (apps/formlogic-host/src/engineInit.ts bundleLanguages), so the engine the server decides and
     * the engine the shell will accept cannot disagree.
     */
    public function testTheRuntimeGetTellsTheResolverThatAPyClientFileMeansPython(): void
    {
        [$controller, , $asked] = $this->recordingFixture(['ui/main.ui' => '<Text/>', 'logic/counter.py' => 'count = 0']);
        $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame([['javascript', 'python']], $asked->getArrayCopy());
    }

    public function testAnAppWithNoPyClientFileIsJavaScriptOnly(): void
    {
        [$controller, , $asked] = $this->recordingFixture(['ui/main.ui' => '<Text/>', 'logic/counter.logic' => 'let a = 0;']);
        $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame([['javascript']], $asked->getArrayCopy());
    }

    public function testAPyFileInThePrivateServerTreeIsNotTheAppsClientLogic(): void
    {
        // The member's frame never receives it, so it cannot be what the frame will run, and a
        // server tree that somehow held one must not clamp a JavaScript app onto the Python engine.
        [$controller, , $asked] = $this->recordingFixture(['ui/main.ui' => '<Text/>', 'server/main.logic' => 'x', 'server/helper.py' => 'y']);
        $response = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertArrayNotHasKey('server/helper.py', self::body($response)['project']['client']);
        $this->assertSame([['javascript']], $asked->getArrayCopy());
    }

    public function testTheOwnerGetIsToldTheSameLanguagesTheMembersFrameIs(): void
    {
        // Otherwise the settings screen would show the owner their stored choice as effective while
        // every member was served the clamped engine.
        [$controller, , $asked] = $this->recordingFixture(['ui/main.ui' => '<Text/>', 'logic/counter.py' => 'count = 0']);
        $controller->manage($this->request('GET'), new Response(), ['id' => 'notes']);
        $this->assertSame([['javascript', 'python']], $asked->getArrayCopy());
    }

    public function testTheActionTimeStaleCheckAsksTheSameQuestionTheGetDid(): void
    {
        // Without the languages the check would compute a different engine than the GET answered
        // with, and every action on a Python app would be told the engine had changed — a remount
        // loop, not a revocation.
        [$controller, $users, $asked] = $this->recordingFixture(['ui/main.ui' => '<Text/>', 'logic/counter.py' => 'count = 0'], 'members');
        $users->method('getAppUser')->willReturn(['status' => 'active', 'roleId' => 'editor']);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/', ['REMOTE_ADDR' => '127.0.0.1'])
            ->withAttribute('userId', 'member')->withParsedBody(['method' => 'GET', 'path' => '/api/notes'])
            ->withHeader('X-FormLogic-Client-Engine', 'zipp-web-python;0123456789abcdef');
        $this->assertSame(200, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
        $this->assertSame([['javascript', 'python']], $asked->getArrayCopy());
    }

    public function testAnAppWhoseLogicThisInstallCannotRunIsNotServedAtAll(): void
    {
        // Fail closed: the resolver refuses, and the runtime GET carries no project at all rather
        // than handing a member's frame Python that the installed runtime would read as JavaScript.
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(self::ENGINE);
        $engines->method('assertInstalledRuns')->willThrowException(new \RuntimeException('no python-logic/1', 503));
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $native = $this->createMock(NativeAppService::class);
        $project = ['access' => 'application', 'version' => 1, 'assets' => [], 'files' => ['manifest.json' => '{"id":"notes"}', 'ui/main.ui' => '<Text/>', 'logic/counter.py' => 'count = 0']];
        $native->method('get')->willReturn($project);
        $native->method('project')->willReturn($project);
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
        $response = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame(503, $response->getStatusCode());
        $this->assertArrayNotHasKey('project', self::body($response));
    }

    public function testMemberAppRequiresAnActiveMembership(): void
    {
        [$controller, $users, $native] = $this->fixture('members');
        $users->method('getAppUser')->willReturn(['status' => 'pending']);
        $native->expects($this->never())->method('request');
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/');
        $this->assertSame(403, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
        $this->assertSame(403, $controller->runtime($request->withAttribute('userId', 'new-member'), new Response(), ['slug' => 'notes'])->getStatusCode());
    }

    public function testActiveMembershipSuppliesIdentityFromFormLogic(): void
    {
        [$controller, $users, $native] = $this->fixture('members');
        $users->method('getAppUser')->with('notes', 'member')->willReturn(['status' => 'active', 'roleId' => 'editor']);
        $native->expects($this->once())->method('request')->with('notes', $this->callback(static fn($input) => $input['body']['title'] === 'My note'), [
            'formlogic' => ['appId' => 'notes', 'userId' => 'member', 'roleId' => 'editor'],
        ])->willReturn(['status' => 201, 'body' => ['saved' => true]]);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/', ['REMOTE_ADDR' => '127.0.0.1'])
            ->withAttribute('userId', 'member')->withParsedBody(['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'My note']]);
        $this->assertSame(200, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
    }

    // ── The shared demo: read-only native hosting ────────────────────────────

    public function testTheDemoBrowsesTheProjectReadOnlyWithoutForkingThePreflight(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->method('available')->willReturn(true);
        $native->expects($this->never())->method('preflight');
        $response = $controller->manage($this->request('GET', true), new Response(), ['id' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $data = self::body($response);
        $this->assertTrue($data['readOnly']);
        $this->assertFalse($data['ready']);
        $this->assertNull($data['preflight']);
        $this->assertSame(1, $data['project']['version']);
    }

    public function testTheDemoBrowsesRecordsAndAnAppWithoutAnInstallationIsNotAnError(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->method('records')->with('notes', 'notes', 50)->willReturn(['tables' => ['notes'], 'columns' => ['id'], 'rows' => [['id' => 1]], 'hasMore' => false]);
        $response = $controller->manage($this->request('GET', true)->withQueryParams(['table' => 'notes', 'offset' => '50']), new Response(), ['id' => 'notes', 'operation' => 'records']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['tables' => ['notes'], 'columns' => ['id'], 'rows' => [['id' => 1]], 'hasMore' => false, 'readOnly' => true], self::body($response));

        // A seeded demo app with no native installation: an answer, not a 403.
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'plain', 'ownerId' => 'owner']);
        $empty = $this->createMock(NativeAppService::class);
        $empty->method('get')->willReturn(null);
        $plain = new NativeAppController($apps, $this->createMock(AppUserService::class), $empty, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $this->engines());
        $response = $plain->manage($this->request('GET', true), new Response(), ['id' => 'plain', 'operation' => 'records']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['installed' => false, 'tables' => [], 'readOnly' => true], self::body($response));
    }

    /** The controller's own guard. A real demo write is refused before it, by DemoReadOnlyMiddleware and its own text (same code). */
    public function testTheDemoCannotInstallOrChangeRecords(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->expects($this->never())->method('install');
        $native->expects($this->never())->method('manageRecord');
        $install = $controller->manage($this->request('PUT', true)->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 1]), new Response(), ['id' => 'notes']);
        $this->assertSame(403, $install->getStatusCode());
        $this->assertSame('demo_readonly', self::body($install)['code']);
        $this->assertStringContainsString('The shared demo is read-only', self::body($install)['message']);
        foreach (['read', 'create', 'update', 'delete', 'deleteMany'] as $action) {
            $record = $controller->manage($this->request('POST', true)->withParsedBody(['table' => 'notes', 'action' => $action]), new Response(), ['id' => 'notes', 'operation' => 'records']);
            $this->assertSame(403, $record->getStatusCode(), $action);
            $this->assertSame('demo_readonly', self::body($record)['code'], $action);
        }
    }

    /** Any visitor holds the demo's session: it browses the tables, and downloads none of them. */
    public function testTheDemoCannotExportATable(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->expects($this->never())->method('exportRecords');
        foreach ([['table' => 'notes', 'export' => 'csv'], ['table' => '*', 'export' => 'json']] as $query) {
            $response = $controller->manage($this->request('GET', true)->withQueryParams($query), new Response(), ['id' => 'notes', 'operation' => 'records']);
            $this->assertSame(403, $response->getStatusCode(), $query['export']);
            $this->assertSame('Data export is disabled on the shared live demo.', self::body($response)['message']);
            $this->assertSame('', $response->getHeaderLine('Content-Disposition'));
        }
    }

    /** Browsing is the owner's management view only: the installed app's runtime is still not served to the demo. */
    public function testTheDemoStillCannotRunTheInstalledApp(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->expects($this->never())->method('project');
        $native->expects($this->never())->method('runtimeProject');
        $native->expects($this->never())->method('request');
        foreach (['GET', 'POST'] as $method) {
            $request = $this->request($method, true)->withParsedBody(['method' => 'GET', 'path' => '/api/notes']);
            $response = $controller->runtime($request, new Response(), ['slug' => 'notes']);
            $this->assertSame(403, $response->getStatusCode(), $method);
            $this->assertSame('demo_readonly', self::body($response)['code'], $method);
            $this->assertSame('Native hosting is unavailable in the shared demo.', self::body($response)['message'], $method);
        }
    }

    public function testAnOwnerKeepsThePreflightAndTheWrites(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->method('available')->willReturn(true);
        $native->expects($this->once())->method('preflight')->willReturn(['ok' => true, 'checks' => []]);
        $native->expects($this->once())->method('install')->with('notes', ['files' => []], 1)->willReturn(['version' => 2]);
        $data = self::body($controller->manage($this->request('GET'), new Response(), ['id' => 'notes']));
        $this->assertFalse($data['readOnly']);
        $this->assertTrue($data['ready']);
        $this->assertSame(200, $controller->manage($this->request('PUT')->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 1]), new Response(), ['id' => 'notes'])->getStatusCode());
        // Someone else's app is still not found, demo or not.
        $this->assertSame(404, $controller->manage($this->request('GET', true, 'someone-else'), new Response(), ['id' => 'notes'])->getStatusCode());
    }

    public function testAVersionUsingTorchWhereItIsOffIsRefusedBeforeItIsInstalledAndTheAppIsNotServed(): void
    {
        $engines = $this->engines();
        $engines->method('torchRefusal')->willReturn('This app uses torch, which this site does not allow.');
        $engines->method('assertTorchAllowed')->willThrowException(new \RuntimeException('This app uses torch, which this site does not allow.', 403));
        [$controller, , $native] = $this->fixture('application', null, ['softnApp' => true], $engines);
        $native->expects($this->never())->method('install');
        $response = $controller->manage($this->request('PUT')->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 1]), new Response(), ['id' => 'notes']);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('torch', self::body($response)['message']);
        $served = $controller->runtime($this->request('GET'), new Response(), ['slug' => 'notes']);
        $this->assertSame(403, $served->getStatusCode());
        $this->assertStringContainsString('torch', self::body($served)['message']);
    }

    public function testTheOwnerIsToldOperatorRecoveryIsRequiredAndVisitorsAreNot(): void
    {
        $recovery = 'The app needs operator recovery: An update could not be rolled back (the previous update was interrupted at phase migrated). Unfinished: the project metadata backup is missing. Inputs are kept under the installation\'s private/ folder and its staging/previous directories; see private/install.json.';
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner']);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willThrowException(new \RuntimeException($recovery));
        $native->method('runtimeProject')->willThrowException(new \RuntimeException($recovery));
        $native->method('install')->willThrowException(new \RuntimeException('Restore the app database before installing another update'));
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $this->engines());

        $owner = $controller->manage($this->request('GET'), new Response(), ['id' => 'notes']);
        $this->assertSame(503, $owner->getStatusCode());
        $this->assertSame(['error' => true, 'message' => $recovery, 'code' => 'recovery_required'], self::body($owner));
        $install = $controller->manage($this->request('PUT')->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 1]), new Response(), ['id' => 'notes']);
        $this->assertSame(503, $install->getStatusCode());
        $this->assertSame('Restore the app database before installing another update', self::body($install)['message']);

        $generic = 'The native app host is unavailable. Check its runtime configuration.';
        $visitor = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame(503, $visitor->getStatusCode());
        $this->assertSame($generic, self::body($visitor)['message']);
        $this->assertSame($generic, self::body($controller->runtime($this->request('GET'), new Response(), ['slug' => 'notes']))['message'], 'the public runtime stays generic, for its owner too');
        $this->assertSame($generic, self::body($controller->manage($this->request('GET', true), new Response(), ['id' => 'notes']))['message'], 'the public demo is not an operator');
    }

    /** The installation root of app notes under a fresh temporary storage. */
    private function installation(): string
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-controller-' . bin2hex(random_bytes(8));
        return $this->storage . '/' . hash('sha256', 'notes');
    }

    /**
     * A controller over a real service whose installation ($root) has project.json at version
     * $installed (null: none) and the install journal $journal. No runtime needed: settling these
     * journals only restores or removes project.json.
     */
    private function unfinished(string $root, ?int $installed, array $journal): NativeAppController
    {
        mkdir($root . '/private', 0700, true);
        $version = static fn(int $number) => json_encode(['home' => false, 'version' => $number, 'files' => ['manifest.json' => '{"id":"notes"}'], 'assets' => [], 'access' => 'application']);
        if ($installed !== null) file_put_contents($root . '/project.json', $version($installed));
        if ($installed === 2) file_put_contents($root . '/private/project.previous-x.json', $version(1));
        file_put_contents($root . '/private/install.json', json_encode($journal + ['operation' => 'x', 'firstInstall' => false, 'oldVersion' => 1, 'newVersion' => 2, 'staging' => 'staging-x', 'previous' => null, 'snapshot' => null, 'configBackup' => null, 'projectBackup' => 'project.previous-x.json', 'hadConfig' => false, 'hadDatabase' => false]));
        return $this->fixture('application', new NativeAppService($this->storage, $this->storage . '/no-runtime'))[0];
    }

    /**
     * FL-S04 for the owner's read: a process killed after it wrote the new project.json (journal
     * phase migrated) left version 2 on disk. The editor must see the version the journal settles
     * to, not the leftover.
     */
    public function testTheOwnersProjectIsReadAfterAnUnfinishedUpdateIsSettled(): void
    {
        $controller = $this->unfinished($root = $this->installation(), 2, ['phase' => 'migrated']);

        $response = $controller->manage($this->request('GET'), new Response(), ['id' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(1, self::body($response)['project']['version'], 'the leftover version 2 is never shown');
        $this->assertFileDoesNotExist($root . '/private/install.json', 'the read settled the journal');
        $this->assertFileDoesNotExist($root . '/private/project.previous-x.json');
        $this->assertSame(1, json_decode((string) file_get_contents($root . '/project.json'), true)['version']);
    }

    /** The same for a visitor: the runtime serves, and decides access against, the settled project. */
    public function testTheRuntimeServesTheSettledProjectAfterAnUnfinishedUpdate(): void
    {
        $controller = $this->unfinished($root = $this->installation(), 2, ['phase' => 'migrated']);

        $response = $controller->runtime((new ServerRequestFactory())->createServerRequest('GET', '/'), new Response(), ['slug' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(1, self::body($response)['project']['version'], 'the leftover version 2 is never served');
        $this->assertFileDoesNotExist($root . '/private/install.json', 'the runtime read settled the journal');
        $this->assertFileDoesNotExist($root . '/private/project.previous-x.json');
    }

    /**
     * A first install killed after it wrote project.json: the records GET's quick existence check
     * still sees that file, and the locked read then rolls the install back. That is an app with
     * nothing installed, not a 404 error in the Data step.
     */
    public function testTheRecordsOfAFirstInstallThatIsRolledBackAreNotAnError(): void
    {
        $controller = $this->unfinished($root = $this->installation(), 1, ['phase' => 'migrated', 'firstInstall' => true, 'oldVersion' => 0, 'newVersion' => 1, 'projectBackup' => null]);

        $response = $controller->manage($this->request('GET'), new Response(), ['id' => 'notes', 'operation' => 'records']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['installed' => false, 'tables' => [], 'readOnly' => false], self::body($response));
        $this->assertFileDoesNotExist($root . '/project.json', 'the first install was rolled back');
        $this->assertFileDoesNotExist($root . '/private/install.json');
    }

    /**
     * The recovery refusal the owner sees names no absolute server location, even when the reason
     * recorded for it is a live install's exception that named a file by its full path (SQLite's
     * VACUUM INTO does). The operator's marker keeps the full text.
     */
    public function testTheOwnersRecoveryMessageCarriesNoServerPath(): void
    {
        $root = $this->installation();
        $slashed = str_replace('\\', '/', $root);
        $backslashed = str_replace('/', '\\', $root);
        $controller = $this->unfinished($root, 1, [
            'phase' => 'recovery',
            'reason' => 'SQLSTATE[HY000]: General error: 14 unable to open database: ' . $root . '/private/pre-install-x.sqlite',
            'problems' => ['the configuration backup is missing', 'restore the database: unable to open ' . $backslashed . '\\private\\data\\application.sqlite'],
        ]);
        $leaks = static function (string $text) use ($root, $slashed, $backslashed): bool {
            foreach (array_filter([$root, $slashed, $backslashed, realpath($root), basename(dirname($root))]) as $path) if (stripos($text, $path) !== false) return true;
            return false;
        };

        $response = $controller->manage($this->request('GET'), new Response(), ['id' => 'notes']);
        $this->assertSame(503, $response->getStatusCode());
        $body = self::body($response);
        $this->assertSame('recovery_required', $body['code']);
        $this->assertFalse($leaks($body['message']), $body['message']);
        $this->assertStringContainsString("unable to open database: the installation's private/pre-install-x.sqlite", $body['message']);
        $this->assertStringContainsString("unable to open the installation's private\\data\\application.sqlite", $body['message']);
        $this->assertTrue($leaks((string) file_get_contents($root . '/private/recovery-required')), 'the operator\'s marker keeps the full path');

        // A marker written before paths were removed, in the platform's own spelling of the path.
        file_put_contents($root . '/private/recovery-required', 'An update could not be rolled back (unable to open database: ' . (realpath($root) ?: $root) . DIRECTORY_SEPARATOR . 'private' . DIRECTORY_SEPARATOR . 'pre-install-x.sqlite).');
        $records = self::body($controller->manage($this->request('GET')->withQueryParams(['table' => 'notes']), new Response(), ['id' => 'notes', 'operation' => 'records']));
        $this->assertSame('recovery_required', $records['code']);
        $this->assertFalse($leaks($records['message']), $records['message']);
        $this->assertStringContainsString("unable to open database: the installation's private", $records['message']);
    }

    public function testTheInstallAnswerCarriesTheEngineDecidedFromTheProjectJustInstalled(): void
    {
        // An owner installs a project that adds a `.py` file: the server now decides zipp-web-python
        // for it, and the PUT's answer must say so — derived from the INSTALLED files, not from what
        // the GET saw before the install — or the panel keeps showing the engine of the old project.
        $asked = new \ArrayObject();
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturnCallback(static function (string $appId, array $languages = []) use ($asked) {
            $asked[] = $languages;
            return self::ENGINE;
        });
        $engines->method('ownerPolicy')->willReturn(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python'], 'installed' => ['zipp-web-python']]);
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $native = $this->createMock(NativeAppService::class);
        $installed = ['version' => 2, 'access' => 'application', 'assets' => [], 'files' => ['manifest.json' => '{"id":"notes"}', 'ui/main.ui' => '<Text/>', 'logic/counter.py' => 'count = 0']];
        $native->method('install')->with('notes', ['files' => []], 1)->willReturn($installed);
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
        $response = $controller->manage($this->request('PUT')->withParsedBody(['project' => ['files' => []], 'expectedVersion' => 1]), new Response(), ['id' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $body = self::body($response);
        $this->assertSame(2, $body['project']['version']);
        $this->assertSame(self::ENGINE, $body['engine']);
        $this->assertSame(['zipp-web-python'], $body['enginePolicy']['allowed']);
        $this->assertSame([['javascript', 'python']], $asked->getArrayCopy(), 'the resolver was asked about the installed project\'s files');
    }

    public function testAResolverThatCannotAnswerTheStaleCheckIsTheGeneric503EveryOtherFailureIs(): void
    {
        // The stale-engine check runs inside respond(): a resolver that cannot read its rows is the
        // same generic 503 every other failure here is, not a 500 with a database message.
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(['access' => 'application']);
        $native->method('runtimeProject')->willReturn(['project' => ['access' => 'application'], 'media' => ['file' => '', 'sha256' => '', 'size' => 0, 'count' => 0]]);
        $native->method('clientLanguages')->willReturn(['javascript']);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willThrowException(new \PDOException('SQLSTATE[HY000] [2002] Connection refused'));
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/', ['REMOTE_ADDR' => '127.0.0.1'])
            ->withAttribute('userId', 'owner')->withParsedBody(['method' => 'GET', 'path' => '/api/notes'])
            ->withHeader('X-FormLogic-Client-Engine', 'zipp-web-python;0123456789abcdef');
        $response = $controller->runtime($request, new Response(), ['slug' => 'notes']);
        $this->assertSame(503, $response->getStatusCode());
        $this->assertSame('The native app host is unavailable. Check its runtime configuration.', self::body($response)['message']);
        $this->assertArrayNotHasKey('code', self::body($response));
    }

    public function testTheStarterIsANewSoftnAppsFirstVersionNamedAfterIt(): void
    {
        $native = $this->createMock(NativeAppService::class);
        $installed = null;
        $native->expects($this->once())->method('install')->willReturnCallback(function (string $appId, array $project, int $expectedVersion) use (&$installed): array {
            $this->assertSame('notes', $appId);
            $this->assertSame(0, $expectedVersion);
            $installed = $project;
            return ['version' => 1] + $project;
        });
        [$controller] = $this->fixture('members', $native);
        $response = $controller->manage($this->request('POST'), new Response(), ['id' => 'notes', 'operation' => 'starter']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(1, self::body($response)['data']['project']['version'] ?? self::body($response)['project']['version'] ?? null);
        $manifest = json_decode($installed['files']['manifest.json'], true);
        $this->assertSame('Notes', $manifest['name']);
        $this->assertSame('formlogic.app.notes', $manifest['id']);
        $this->assertTrue($installed['home']);
        $this->assertSame('members', $installed['access']);
        $this->assertStringContainsString('<Text>Notes</Text>', $installed['files']['ui/main.ui']);
    }

    public function testTheStarterIsOnlyForASoftnApp(): void
    {
        $native = $this->createMock(NativeAppService::class);
        $native->expects($this->never())->method('install');
        [$controller] = $this->fixture('members', $native, []);
        $response = $controller->manage($this->request('POST'), new Response(), ['id' => 'notes', 'operation' => 'starter']);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('SoftN app', self::body($response)['message']);
    }

    public function testTheSharedDemoCannotInstallAStarter(): void
    {
        $native = $this->createMock(NativeAppService::class);
        $native->expects($this->never())->method('install');
        [$controller] = $this->fixture('members', $native);
        $response = $controller->manage($this->request('POST', true), new Response(), ['id' => 'notes', 'operation' => 'starter']);
        $this->assertSame(403, $response->getStatusCode());
    }

    public function testTheStarterKeepsMarkupAndExpressionsOutOfTheHeadingAndAnIdOutOfTheManifest(): void
    {
        $project = NativeAppService::starterProject('  Recipes {secret()} <b>&amp;</b>  ', '0f0e-!!/..');
        $manifest = json_decode($project['files']['manifest.json'], true);
        $this->assertSame('Recipes {secret()} <b>&amp;</b>', $manifest['name']);
        $this->assertSame('formlogic.app.0f0e-..', $manifest['id']);
        $this->assertMatchesRegularExpression('/^[a-zA-Z0-9._-]{1,120}$/D', $manifest['id']);
        $this->assertStringContainsString('<Text>Recipes secret() bamp;/b</Text>', $project['files']['ui/main.ui']);
        // Every server file of the starter is kept, and nothing is published by default.
        $this->assertArrayHasKey('server/main.logic', $project['files']);
        $this->assertArrayHasKey('server/migrations/001.sql', $project['files']);
        $this->assertSame(0, $project['version']);
        $this->assertSame('My app', json_decode(NativeAppService::starterProject("\t ", 'a')['files']['manifest.json'], true)['name']);
    }

    // ── The data manager: browse parameters, export, deleteMany ───────────────

    /**
     * A controller over mocks whose plan and automations a test sets.
     *
     * @return array{0: NativeAppController, 1: NativeAppService&\PHPUnit\Framework\MockObject\MockObject, 2: PlanService&\PHPUnit\Framework\MockObject\MockObject, 3: FlowService&\PHPUnit\Framework\MockObject\MockObject}
     */
    private function recordsFixture(string $slug = 'notes-app'): array
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'slug' => $slug, 'status' => 'published', 'settings' => ['softnApp' => true]]);
        $native = $this->createMock(NativeAppService::class);
        $plans = $this->createMock(PlanService::class);
        $flows = $this->createMock(FlowService::class);
        return [new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $plans, $flows, $this->engines()), $native, $plans, $flows];
    }

    /** A controller over a real service and an installation that holds this database. Records need no runtime. */
    private function withDatabase(string $sql, string $slug = 'notes-app'): NativeAppController
    {
        $root = $this->installation();
        mkdir($root . '/private/data', 0700, true);
        file_put_contents($root . '/project.json', json_encode(['home' => false, 'version' => 1, 'files' => ['manifest.json' => '{"id":"notes","server":{"entry":"server/main.logic"}}'], 'assets' => [], 'access' => 'application']));
        (new \PDO('sqlite:' . $root . '/private/data/application.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]))->exec($sql);
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'slug' => $slug, 'status' => 'published', 'settings' => ['softnApp' => true]]);
        return new NativeAppController($apps, $this->createMock(AppUserService::class), new NativeAppService($this->storage, $this->storage . '/no-runtime'), $this->createMock(PlanService::class), $this->createMock(FlowService::class), $this->engines());
    }

    private function records(NativeAppController $controller, array $query, bool $demo = false): ResponseInterface
    {
        return $controller->manage($this->request('GET', $demo)->withQueryParams($query), new Response(), ['id' => 'notes', 'operation' => 'records']);
    }

    public function testTheRecordsGetHandsTheDataManagersQuestionsToTheService(): void
    {
        [$controller, $native] = $this->recordsFixture();
        $native->method('get')->willReturn(['version' => 1]);
        $asked = [];
        $native->method('records')->willReturnCallback(function (...$arguments) use (&$asked): array { $asked[] = $arguments; return ['tables' => ['notes']]; });
        $this->assertSame(['tables' => ['notes'], 'readOnly' => false], self::body($this->records($controller, ['table' => 'notes', 'offset' => '50'])));
        $this->records($controller, ['table' => 'notes', 'offset' => '100', 'limit' => '250', 'sort' => 'title', 'dir' => 'desc', 'q' => '50%', 'filter' => '[{"column":"title","op":"empty"}]']);
        $this->records($controller, ['table' => 'notes', 'view' => 'structure']);
        $this->records($controller, ['summary' => '1']);
        $this->records($controller, ['summary' => 'yes', 'limit' => 'many', 'unknown' => 'x']);
        $this->assertSame([
            // A caller that sends nothing new: its table, its offset, and no options.
            ['notes', 'notes', 50, null, []],
            ['notes', 'notes', 100, null, ['sort' => 'title', 'dir' => 'desc', 'q' => '50%', 'filter' => '[{"column":"title","op":"empty"}]', 'limit' => 250]],
            ['notes', 'notes', 0, null, ['view' => 'structure']],
            ['notes', null, 0, null, ['summary' => true]],
            ['notes', null, 0, null, ['limit' => 0]],
        ], $asked);
    }

    public function testWhatTheStoreRefusesIsA400WithItsSentence(): void
    {
        [$controller, $native] = $this->recordsFixture();
        $native->method('get')->willReturn(['version' => 1]);
        $native->method('records')->willThrowException(new \InvalidArgumentException('Unknown column'));
        $response = $this->records($controller, ['table' => 'notes', 'sort' => 'session_token']);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertSame(['error' => true, 'message' => 'Unknown column'], self::body($response));
    }

    public function testBrowsingAndDeletingSeveralRowsThroughTheController(): void
    {
        $controller = $this->withDatabase("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT, session_token TEXT); INSERT INTO notes(title, session_token) VALUES ('One', 'tok-1'), ('Two', 'tok-2'), ('Three', 'tok-3')");
        $summary = self::body($this->records($controller, ['summary' => '1']));
        $this->assertSame([['name' => 'notes', 'rows' => 3, 'columns' => 2]], $summary['summary']['tables']);
        $this->assertSame([true, ['notes'], false, 0], [$summary['installed'], $summary['tables'], $summary['readOnly'], $summary['summary']['hiddenTables']]);
        $this->assertArrayNotHasKey('summary', self::body($this->records($controller, [])));

        $response = $this->records($controller, ['table' => 'notes', 'sort' => 'title', 'dir' => 'desc', 'limit' => '25']);
        $page = self::body($response);
        $this->assertSame([['id' => 2, 'title' => 'Two'], ['id' => 3, 'title' => 'Three'], ['id' => 1, 'title' => 'One']], $page['rows']);
        $this->assertSame([3, 3, 25, ['column' => 'title', 'dir' => 'desc'], 1, false], [$page['total'], $page['matching'], $page['limit'], $page['sort'], $page['hiddenColumns'], $page['readOnly']]);
        $this->assertStringContainsString('"cut":{}', (string) $response->getBody(), 'an object in JSON, with nothing in it');
        $this->assertStringNotContainsString('tok-', (string) $response->getBody());
        $this->assertTrue(self::body($this->records($controller, ['table' => 'notes'], true))['readOnly'], 'the demo browses, read-only');
        $this->assertSame(400, $this->records($controller, ['table' => 'notes', 'sort' => 'session_token'])->getStatusCode());
        $this->assertSame(['error' => true, 'message' => 'Unknown column'], self::body($this->records($controller, ['table' => 'notes', 'sort' => 'session_token'])));
        $this->assertSame('Filter 1 names an unknown column.', self::body($this->records($controller, ['table' => 'notes', 'filter' => '[{"column":"session_token","op":"notEmpty"}]']))['message']);
        $this->assertSame(['id', 'title', 'session_token'], array_column(self::body($this->records($controller, ['table' => 'notes', 'view' => 'structure']))['columns'], 'name'));

        $rows = array_map(static fn($key, $stamp) => ['key' => $key, 'stamp' => $stamp], $page['keys'], $page['stamps']);
        $delete = fn(array $rows) => $controller->manage($this->request('POST')->withParsedBody(['table' => 'notes', 'action' => 'deleteMany', 'rows' => $rows]), new Response(), ['id' => 'notes', 'operation' => 'records']);
        $stale = $delete([$rows[0], ['key' => $rows[1]['key'], 'stamp' => $rows[2]['stamp']]]);
        $this->assertSame(409, $stale->getStatusCode());
        $this->assertSame('1 record has changed or gone since the list was loaded, so nothing was deleted. Refresh the records and try again.', self::body($stale)['message']);
        $this->assertSame(400, $delete([])->getStatusCode());
        $this->assertSame(3, self::body($this->records($controller, ['table' => 'notes']))['total']);
        $deleted = $delete([$rows[0], $rows[1]]);
        $this->assertSame([200, ['saved' => true, 'deleted' => 2]], [$deleted->getStatusCode(), self::body($deleted)]);
        $this->assertSame([['id' => 1, 'title' => 'One']], self::body($this->records($controller, ['table' => 'notes']))['rows']);
    }

    public function testAnExportIsAFileNotThisControllersJson(): void
    {
        // A slug and a table's name that would end the quoted file name and start a header of their own.
        $controller = $this->withDatabase("CREATE TABLE \"we\"\"ird\r\nname.csv\"(id INTEGER PRIMARY KEY, label TEXT, api_key TEXT); INSERT INTO \"we\"\"ird\r\nname.csv\"(label, api_key) VALUES ('a, b', 'k-1'), (NULL, 'k-2'); CREATE TABLE plain(id INTEGER PRIMARY KEY)", "my\"app\r\nX-Evil: 1");
        $csv = $this->records($controller, ['table' => "we\"ird\r\nname.csv", 'export' => 'csv', 'sort' => 'id', 'dir' => 'desc']);
        $body = (string) $csv->getBody();
        $this->assertSame(200, $csv->getStatusCode());
        $this->assertSame("\xEF\xBB\xBF" . "id,label\r\n2,\r\n1,\"a, b\"\r\n", $body);
        $this->assertSame([
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="my-app-X-Evil-1-we-ird-name-csv.csv"',
            'Content-Length' => (string) strlen($body),
            'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
        ], array_map(static fn(array $values): string => implode(', ', $values), $csv->getHeaders()));

        $all = $this->records($controller, ['table' => '*', 'export' => 'json']);
        $this->assertSame('{"tables":{"plain":[],"we\"ird\r\nname.csv":[{"id":1,"label":"a, b"},{"id":2,"label":null}]}}', (string) $all->getBody());
        $this->assertSame(['application/json; charset=utf-8', 'attachment; filename="my-app-X-Evil-1-all-tables.json"', false], [$all->getHeaderLine('Content-Type'), $all->getHeaderLine('Content-Disposition'), $all->hasHeader('X-FormLogic-Export-Truncated')]);
        $this->assertSame('attachment; filename="my-app-X-Evil-1-plain.json"', $this->records($controller, ['table' => 'plain', 'export' => 'json'])->getHeaderLine('Content-Disposition'));

        // What cannot be exported is refused as every other request here is: JSON, with a sentence.
        foreach ([
            [['table' => 'plain', 'export' => 'xml'], 400, 'Export as csv or json.'],
            [['table' => '*', 'export' => 'csv'], 400, 'Every table at once is exported as json.'],
            [['export' => 'csv'], 400, 'Choose a table to export, or * for every table.'],
            [['table' => 'plain', 'export' => 'csv', 'sort' => 'nope'], 400, 'Unknown column'],
            [['table' => 'nowhere', 'export' => 'csv'], 404, 'Table not found'],
        ] as [$query, $status, $message]) {
            $refused = $this->records($controller, $query);
            $this->assertSame([$status, 'application/json', ['error' => true, 'message' => $message]], [$refused->getStatusCode(), $refused->getHeaderLine('Content-Type'), self::body($refused)], json_encode($query));
            $this->assertFalse($refused->hasHeader('Content-Disposition'));
        }
    }

    public function testAnExportThatALimitCutSaysSoInAHeader(): void
    {
        [$controller, $native] = $this->recordsFixture('');
        $cut = true;
        $native->method('exportRecords')->willReturnCallback(function (string $appId, ?string $table, string $format, array $options) use (&$cut): array {
            $this->assertSame(['notes', 'notes', 'json', ['q' => 'x', 'limit' => 25]], [$appId, $table, $format, $options]);
            $stream = fopen('php://temp', 'w+b');
            fwrite($stream, '[]');
            rewind($stream);
            return ['stream' => $stream, 'truncated' => $cut];
        });
        $response = $this->records($controller, ['table' => 'notes', 'export' => 'json', 'q' => 'x', 'limit' => '25']);
        $this->assertSame(['1', '[]', 'attachment; filename="app-notes.json"'], [$response->getHeaderLine('X-FormLogic-Export-Truncated'), (string) $response->getBody(), $response->getHeaderLine('Content-Disposition')]);
        $cut = false;
        $this->assertFalse($this->records($controller, ['table' => 'notes', 'export' => 'json', 'q' => 'x', 'limit' => '25'])->hasHeader('X-FormLogic-Export-Truncated'));
    }

    public function testDeleteManyIsAWriteRefusedWhenThePlanHasLapsedAndFollowedByItsAutomations(): void
    {
        [$controller, $native, $plans, $flows] = $this->recordsFixture();
        $subscriptions = [['event' => 'app.record.deleted.notes', 'bindings' => ['binding-1']]];
        $flows->method('nativeRecordSubscriptions')->willReturn($subscriptions);
        $input = ['table' => 'notes', 'action' => 'deleteMany', 'rows' => [['key' => ['id' => '1'], 'stamp' => str_repeat('a', 64)]]];
        $post = fn(array $body) => $controller->manage($this->request('POST')->withParsedBody($body), new Response(), ['id' => 'notes', 'operation' => 'records']);
        $managed = [];
        $native->method('manageRecord')->willReturnCallback(function (string $appId, array $body, array $given) use (&$managed, $subscriptions): array {
            $this->assertSame(['notes', $subscriptions], [$appId, $given]);
            $managed[] = $body['action'];
            return $body['action'] === 'read' ? ['record' => []] : ['saved' => true, 'deleted' => 1];
        });
        // The automations are delivered after a deleteMany as after any other write, and not after a read.
        $native->expects($this->once())->method('dispatchRecordEvents')->with('notes', $this->callback('is_callable'));
        $deleted = $post($input);
        $this->assertSame([200, ['saved' => true, 'deleted' => 1]], [$deleted->getStatusCode(), self::body($deleted)]);
        $this->assertSame(['record' => []], self::body($post(['action' => 'read'] + $input)));
        $this->assertSame(['deleteMany', 'read'], $managed);

        // With the plan lapsed: no write, deleteMany among them; a read still answers.
        $plans->method('isEnforced')->willReturn(true);
        $plans->method('isCloudActive')->willReturn(false);
        $refused = $post($input);
        $this->assertSame([402, 'Cloud access has expired. Records remain available to read.'], [$refused->getStatusCode(), self::body($refused)['message']]);
        $this->assertSame(200, $post(['action' => 'read'] + $input)->getStatusCode());
        $this->assertSame(['deleteMany', 'read', 'read'], $managed);
    }

    public function testAHostThatStoppedSaysWhatTheAuthorCanDo(): void
    {
        $this->assertStringStartsWith("The app's backend could not start", NativeAppService::startupFailure('application_source'));
        $this->assertStringEndsWith('(application_source)', NativeAppService::startupFailure('application_source'));
        $this->assertStringContainsString('check its SQL', NativeAppService::startupFailure('database_migrations'));
        // A newer app host's own label for a migration it stopped at its deadline and no longer
        // retries: the SQL is sound, so "check its SQL" and "ask your administrator" both
        // send the author the wrong way.
        $this->assertStringContainsString('smaller migrations', NativeAppService::startupFailure('migration_stopped'));
        $this->assertStringNotContainsString('administrator', NativeAppService::startupFailure('migration_stopped'));
        $this->assertStringContainsString('matched exactly', NativeAppService::startupFailure('route_configuration'));
        $this->assertStringContainsString('Ask your administrator', NativeAppService::startupFailure('wasm_initialization'));
        $this->assertStringNotContainsString('()', NativeAppService::startupFailure(''));
    }
}
