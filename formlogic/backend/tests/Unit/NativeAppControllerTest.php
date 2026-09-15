<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Models\User;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService};
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

    private function fixture(string $access, ?NativeAppService $service = null): array
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
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
        }
        return [new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class)), $users, $native];
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
        $plain = new NativeAppController($apps, $this->createMock(AppUserService::class), $empty, $this->createMock(PlanService::class), $this->createMock(FlowService::class));
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
        foreach (['read', 'create', 'update', 'delete'] as $action) {
            $record = $controller->manage($this->request('POST', true)->withParsedBody(['table' => 'notes', 'action' => $action]), new Response(), ['id' => 'notes', 'operation' => 'records']);
            $this->assertSame(403, $record->getStatusCode(), $action);
            $this->assertSame('demo_readonly', self::body($record)['code'], $action);
        }
    }

    /** Browsing is the owner's management view only: the installed app's runtime is still not served to the demo. */
    public function testTheDemoStillCannotRunTheInstalledApp(): void
    {
        [$controller, , $native] = $this->fixture('application');
        $native->expects($this->never())->method('project');
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

    public function testTheOwnerIsToldOperatorRecoveryIsRequiredAndVisitorsAreNot(): void
    {
        $recovery = 'The app needs operator recovery: An update could not be rolled back (the previous update was interrupted at phase migrated). Unfinished: the project metadata backup is missing. Inputs are kept under the installation\'s private/ folder and its staging/previous directories; see private/install.json.';
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'notes', 'ownerId' => 'owner']);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willThrowException(new \RuntimeException($recovery));
        $native->method('install')->willThrowException(new \RuntimeException('Restore the app database before installing another update'));
        $controller = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class));

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
}
