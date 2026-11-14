<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\{NativeAppController, NativeAppVersionsController};
use FormLogic\Models\User;
use FormLogic\Services\{AppService, AppUserService, AuthService, ChatToolsContext, ChatToolsService, FlowService, FormService, NativeAppService, NativeAppVersions, PlanService, ResponseService, RuntimeEngineService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The owner's routes for an app's history of versions: who is admitted, what each answers, what
 * the file route will and will not show, and that every way a version is made (the app's page, an
 * upload, an AI over MCP or in the chat, a going back) is said in its record.
 *
 * The app is installed for real into a folder of its own (no backend, so nothing is started).
 */
final class NativeAppVersionsControllerTest extends TestCase
{
    private const APP = ['id' => 'notes-id', 'slug' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'draft', 'settings' => ['softnApp' => true]];
    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff\x80\x07";

    private ?string $storage = null;
    private NativeAppService $native;
    private NativeAppVersions $versions;
    /** What the engine's rules say of the next project asked about: null lets it through. */
    private ?string $torch = null;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-versions-http-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->versions = new NativeAppVersions($this->native);
        // Two versions: the first made by someone else (an earlier owner), the second by the owner.
        $this->native->install(self::APP['id'], self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, null, ['by' => 'earlier', 'how' => 'upload', 'summary' => 'First']);
        $this->native->install(self::APP['id'], self::project(['index.html' => '<h1>Two</h1>', 'about.html' => 'About'], ['assets/logo.png' => self::PNG]), 1, null, ['by' => 'owner', 'how' => 'page']);
    }

    protected function tearDown(): void
    {
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-versions-http-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    private static function project(array $files = [], array $media = []): array
    {
        return ['access' => 'application', 'home' => true,
            'files' => $files + ['manifest.json' => '{"id":"notes","name":"Notes","main":"index.html"}', 'index.html' => '<h1>Notes</h1>'],
            'assets' => array_map('base64_encode', $media)];
    }

    private function apps(): AppService
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(static fn (string $id): ?array => $id === self::APP['id'] ? self::APP : null);
        return $apps;
    }

    private function engines(): RuntimeEngineService
    {
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('torchRefusal')->willReturnCallback(fn (): ?string => $this->torch);
        $engines->method('effective')->willReturn(['id' => 'zipp-web', 'requested' => 'zipp-web', 'stored' => null, 'revision' => '0123456789abcdef']);
        return $engines;
    }

    private function controller(): NativeAppVersionsController
    {
        $auth = $this->createMock(AuthService::class);
        $auth->method('getUserById')->willReturnCallback(static fn (string $id): ?User => $id === 'earlier' ? new User('earlier', 'earlier@example.test', 'Earlier Owner') : null);
        return new NativeAppVersionsController($this->apps(), $this->versions, $this->engines(), $auth);
    }

    /** One call of the routes, as index.php hands it over. */
    private function call(string $method, string $action, ?string $user = 'owner', array $args = [], ?array $body = null, array $query = []): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/apps/notes-id/native/versions' . ($query ? '?' . http_build_query($query) : ''))->withQueryParams($query);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        if ($body !== null) $request = $request->withParsedBody($body);
        return $this->controller()->{$action}($request, new Response(), $args + ['id' => self::APP['id']]);
    }

    private static function body(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true);
    }

    private function installed(): array
    {
        return $this->native->get(self::APP['id']);
    }

    public function testTheOwnerIsGivenTheListNewestFirstWithTheCurrentVersionMarkedAndWhoMadeEach(): void
    {
        $response = $this->call('GET', 'index');
        $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $list = self::body($response);
        $this->assertSame(2, $list['current']);
        $this->assertSame([[2, true], [1, false]], array_map(static fn (array $row): array => [$row['version'], $row['current']], $list['versions']));
        $this->assertSame([true, null, 'page'], [$list['versions'][0]['byYou'], $list['versions'][0]['byName'], $list['versions'][0]['how']]);
        // Someone else's is named where the site knows a name, never by an id alone.
        $this->assertSame([false, 'Earlier Owner', 'upload', 'First'], [$list['versions'][1]['byYou'], $list['versions'][1]['byName'], $list['versions'][1]['how'], $list['versions'][1]['summary']]);

        $one = self::body($this->call('GET', 'show', 'owner', ['n' => '1']));
        $this->assertSame([1, 2, 'Earlier Owner'], [$one['version']['version'], $one['current'], $one['version']['byName']]);
        $this->assertSame([['path' => 'about.html', 'text' => true]], $one['differs']['added']);
        $this->assertSame([['path' => 'index.html', 'text' => true]], $one['differs']['changed']);
        $this->assertSame([], $one['databaseAhead']);
    }

    public function testAnotherPersonAndNoOneAtAllAreRefusedEveryRouteAndChangeNothing(): void
    {
        $before = [$this->installed(), $this->versions->list(self::APP['id'])];
        $calls = [
            ['GET', 'index', [], null, []], ['GET', 'show', ['n' => '1'], null, []], ['GET', 'file', ['n' => '1'], null, ['path' => 'index.html']],
            ['POST', 'restore', ['n' => '1'], ['expectedVersion' => 2], []], ['PUT', 'pin', ['n' => '1'], ['pinned' => true], []],
            ['DELETE', 'remove', ['n' => '1'], null, []],
        ];
        foreach (['someone-else', null] as $who) {
            foreach ($calls as [$method, $action, $args, $body, $query]) {
                $response = $this->call($method, $action, $who, $args, $body, $query);
                $this->assertSame(404, $response->getStatusCode(), $action . ' for ' . ($who ?? 'no one'));
                $this->assertSame(['error' => true, 'message' => 'App not found or access denied'], self::body($response));
                $this->assertStringNotContainsString('<h1>', (string) $response->getBody());
            }
        }
        // Nor for an app that is not there, whoever asks.
        $this->assertSame(404, $this->call('GET', 'index', 'owner', ['id' => 'no-such-app'])->getStatusCode());
        $this->assertSame($before, [$this->installed(), $this->versions->list(self::APP['id'])], 'nothing was installed, nothing was pinned and nothing was removed');
    }

    public function testAnEarlierVersionIsRemovedFromTheHistoryThroughTheRouteAndTheAppIsNotTouched(): void
    {
        $installed = $this->installed();
        // Never the current version, never one that is not there, and a pinned one only once it is unpinned: each said plainly.
        $current = $this->call('DELETE', 'remove', 'owner', ['n' => '2']);
        $this->assertSame([409, 'Version 2 is the app as it is now, so it cannot be removed from the history.'], [$current->getStatusCode(), self::body($current)['message']]);
        foreach (['7', '0', 'abc', '-1'] as $n) $this->assertSame(404, $this->call('DELETE', 'remove', 'owner', ['n' => $n])->getStatusCode(), $n);
        $this->call('PUT', 'pin', 'owner', ['n' => '1'], ['pinned' => true]);
        $pinned = $this->call('DELETE', 'remove', 'owner', ['n' => '1']);
        $this->assertSame([409, 'Version 1 is pinned. Unpin it first, then remove it.'], [$pinned->getStatusCode(), self::body($pinned)['message']]);
        $this->assertSame([2, 1], array_column(self::body($this->call('GET', 'index'))['versions'], 'version'));
        $this->call('PUT', 'pin', 'owner', ['n' => '1'], ['pinned' => false]);

        $response = $this->call('DELETE', 'remove', 'owner', ['n' => '1']);
        $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame(['version' => 1, 'removed' => true], self::body($response));
        $this->assertSame([2], array_column(self::body($this->call('GET', 'index'))['versions'], 'version'));
        $this->assertSame(404, $this->call('GET', 'show', 'owner', ['n' => '1'])->getStatusCode());
        $this->assertSame(404, $this->call('GET', 'file', 'owner', ['n' => '1'], null, ['path' => 'index.html'])->getStatusCode());
        $this->assertSame(404, $this->call('DELETE', 'remove', 'owner', ['n' => '1'])->getStatusCode(), 'it cannot be removed twice');
        $this->assertSame($installed, $this->installed(), 'the app as it is installed is not touched');
    }

    /**
     * The removal is admitted exactly as going back and pinning are: the same middleware in the
     * same order, the owner alone in the controller, and no way in for an administrator acting
     * as the owner (none of the history's routes is mirrored).
     */
    public function testTheRemovalRouteIsHeldToWhatTheOtherWritesOfTheHistoryAre(): void
    {
        $source = str_replace("\r\n", "\n", (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php'));
        $count = preg_match_all("~\\\$app->(get|post|put|delete)\\('/api/apps/\\{id\\}/native/versions([^']*)'.*?NativeAppVersionsController::class\\)->(\\w+)\\(.*?\\}\\)((?:->add\\([^;]*?\\))*);~s", $source, $routes, PREG_SET_ORDER);
        $this->assertSame(6, $count, 'the list, one version, a file, going back, a pin and a removal');
        $wired = [];
        foreach ($routes as [, $method, $path, $action, $chain]) $wired[$action] = [$method, $path, $chain];
        $write = '->add($cloudWriteGate)->add($hostingLimiter)->add($authRequired)';
        $this->assertSame(['delete', '/{n:[0-9]{1,9}}', $write], $wired['remove']);
        $this->assertSame(['put', '/{n:[0-9]{1,9}}', $write], $wired['pin']);
        $this->assertSame(['post', '/{n:[0-9]{1,9}}/restore', $write], $wired['restore']);
        foreach (['index', 'show', 'file'] as $read) $this->assertSame(['get', '->add($hostingReadLimiter)->add($authRequired)'], [$wired[$read][0], $wired[$read][2]], $read);
        foreach (\FormLogic\Http\AdminActingAsRoutes::ROUTES as $row) {
            $this->assertStringNotContainsString('/native', $row[1], 'an administrator acting as the owner reaches none of an app\'s installed project or its history');
            $this->assertNotSame(NativeAppVersionsController::class, $row[2]);
        }
    }

    /**
     * A failure no refusal names (the history's folder could not be read or written) is said as
     * what it is: the history could not be read, or changed, just now. Not the host's runtime
     * configuration, which is the install's to blame when going back fails; and never the
     * server's own message, which goes to its log.
     */
    public function testAnUnexpectedFailureOfTheHistoryIsSaidAsOneAndNotAsTheHosts(): void
    {
        $broken = $this->createMock(NativeAppService::class);
        $broken->method('withHistory')->willThrowException(new \RuntimeException('Short write to the app\'s history: 3 of 9 bytes'));
        $auth = $this->createMock(AuthService::class);
        $controller = new NativeAppVersionsController($this->apps(), new NativeAppVersions($broken), $this->engines(), $auth);
        $said = [];
        $log = ini_set('error_log', $this->storage . '/php-errors.log');
        try {
            foreach ([['GET', 'index', [], null, []], ['GET', 'show', ['n' => '1'], null, []], ['GET', 'file', ['n' => '1'], null, ['path' => 'index.html']],
                ['PUT', 'pin', ['n' => '1'], ['pinned' => true], []], ['DELETE', 'remove', ['n' => '1'], null, []], ['POST', 'restore', ['n' => '1'], ['expectedVersion' => 2], []]] as [$method, $action, $args, $body, $query]) {
                $request = (new ServerRequestFactory())->createServerRequest($method, '/api/apps/notes-id/native/versions')->withQueryParams($query)->withAttribute('userId', 'owner');
                if ($body !== null) $request = $request->withParsedBody($body);
                $response = $controller->{$action}($request, new Response(), $args + ['id' => self::APP['id']]);
                $this->assertSame(503, $response->getStatusCode(), $action);
                $this->assertStringNotContainsString('Short write', (string) $response->getBody(), $action);
                $said[$action] = [self::body($response)['code'] ?? null, self::body($response)['message']];
            }
        } finally {
            ini_set('error_log', $log === false ? '' : $log);
        }
        $read = ['history_unavailable', 'The app’s history could not be read just now. Try again shortly; if it keeps happening, the server’s log says why.'];
        $changed = ['history_unavailable', 'The app’s history could not be changed just now. Try again shortly; if it keeps happening, the server’s log says why.'];
        $this->assertSame(['index' => $read, 'show' => $read, 'file' => $read, 'pin' => $changed, 'remove' => $changed,
            'restore' => [null, 'The native app host is unavailable. Check its runtime configuration.']], $said);
        $this->assertStringContainsString('Short write to the app\'s history', (string) file_get_contents($this->storage . '/php-errors.log'), 'the reason is in the server\'s log');
    }

    public function testTheFileRouteShowsASourceFileAndRefusesAPathOutsideTheProjectAndABinary(): void
    {
        $response = $this->call('GET', 'file', 'owner', ['n' => '1'], null, ['path' => 'index.html']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(['current' => 2, 'version' => 1, 'path' => 'index.html', 'text' => '<h1>One</h1>'], self::body($response));
        $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame('<h1>Two</h1>', self::body($this->call('GET', 'file', 'owner', ['n' => '2'], null, ['path' => 'index.html']))['text'], 'the current version\'s too');

        // A media file is the project's, and is not text: refused as that, for a kept version and the current one.
        foreach (['1', '2'] as $n) {
            $binary = $this->call('GET', 'file', 'owner', ['n' => $n], null, ['path' => 'assets/logo.png']);
            $this->assertSame(422, $binary->getStatusCode(), 'version ' . $n);
            $this->assertStringNotContainsString('PNG', (string) $binary->getBody());
        }
        // Anything the project does not hold is not found, however it is spelt: the app's own private
        // files beside the project, a path that climbs, a file only a later version has, no path at all.
        $outside = ['private/config.json', '../private/config.json', '..\\private\\config.json', 'project.json', '/etc/passwd', 'index.html/../../project.json',
            'history/index.json', 'about.html', 'index.HTML', 'index.html ', '', "index.html\0", 'C:\\Windows\\win.ini', str_repeat('a/', 300) . 'index.html'];
        foreach ($outside as $path) {
            $response = $this->call('GET', 'file', 'owner', ['n' => '1'], null, ['path' => $path]);
            $this->assertSame(404, $response->getStatusCode(), var_export($path, true));
            $this->assertStringNotContainsString('keyHex', (string) $response->getBody());
        }
        foreach ([[], ['path' => ['index.html']]] as $query) $this->assertSame(404, $this->call('GET', 'file', 'owner', ['n' => '1'], null, $query)->getStatusCode());
        // And a version that is not kept has no files.
        foreach (['9', '0', '-1', 'abc', '1e1', '0000000001x'] as $n) $this->assertSame(404, $this->call('GET', 'file', 'owner', ['n' => $n], null, ['path' => 'index.html'])->getStatusCode(), $n);
    }

    public function testGoingBackThroughTheRouteIsANewVersionMadeByWhoeverAskedAndSaysSo(): void
    {
        foreach ([null, [], ['expectedVersion' => '2'], ['expectedVersion' => 0]] as $bad) {
            $this->assertSame(400, $this->call('POST', 'restore', 'owner', ['n' => '1'], $bad)->getStatusCode());
        }
        $stale = $this->call('POST', 'restore', 'owner', ['n' => '1'], ['expectedVersion' => 1]);
        $this->assertSame(409, $stale->getStatusCode());
        $this->assertStringContainsString('now at version 2', self::body($stale)['message']);
        $this->assertSame(404, $this->call('POST', 'restore', 'owner', ['n' => '7'], ['expectedVersion' => 2])->getStatusCode());
        $this->assertSame(2, $this->installed()['version']);

        // Held to the engine's rules, as a publish from the page is.
        $this->torch = 'This app uses torch, which its settings turn off.';
        $refused = $this->call('POST', 'restore', 'owner', ['n' => '1'], ['expectedVersion' => 2]);
        $this->assertSame([400, 'This app uses torch, which its settings turn off.'], [$refused->getStatusCode(), self::body($refused)['message']]);
        $this->assertSame(2, $this->installed()['version']);
        $this->torch = null;

        $response = $this->call('POST', 'restore', 'owner', ['n' => '1'], ['expectedVersion' => 2]);
        $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        $this->assertSame(['version' => 3, 'restored' => 1, 'databaseAhead' => []], self::body($response));
        $this->assertSame('<h1>One</h1>', $this->installed()['files']['index.html']);
        $this->assertArrayNotHasKey('about.html', $this->installed()['files']);
        $now = self::body($this->call('GET', 'index'))['versions'][0];
        $this->assertSame([3, true, true, 'rollback', 1, 'Back to version 1'], [$now['version'], $now['current'], $now['byYou'], $now['how'], $now['restored'], $now['summary']]);
    }

    public function testAVersionIsPinnedAndUnpinnedThroughTheRoute(): void
    {
        foreach ([null, [], ['pinned' => 'yes'], ['pinned' => 1]] as $bad) {
            $this->assertSame(400, $this->call('PUT', 'pin', 'owner', ['n' => '1'], $bad)->getStatusCode());
        }
        $this->assertSame(['version' => 1, 'pinned' => true], self::body($this->call('PUT', 'pin', 'owner', ['n' => '1'], ['pinned' => true])));
        $this->assertTrue(self::body($this->call('GET', 'index'))['versions'][1]['pinned']);
        $this->assertSame(['version' => 1, 'pinned' => false], self::body($this->call('PUT', 'pin', 'owner', ['n' => '1'], ['pinned' => false])));
        $this->assertFalse(self::body($this->call('GET', 'index'))['versions'][1]['pinned']);
        $this->assertSame(404, $this->call('PUT', 'pin', 'owner', ['n' => '8'], ['pinned' => true])->getStatusCode());
    }

    /** Every way a version is made says what it was: the app's page and an upload (PUT …/native), an AI over MCP and in the chat. */
    public function testEachWayAVersionIsMadeIsSaidInItsRecord(): void
    {
        $page = new NativeAppController($this->apps(), $this->createMock(AppUserService::class), $this->native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $this->engines());
        $put = function (array $body) use ($page): ResponseInterface {
            $request = (new ServerRequestFactory())->createServerRequest('PUT', '/api/apps/notes-id/native')->withAttribute('userId', 'owner')->withParsedBody($body);
            return $page->manage($request, new Response(), ['id' => self::APP['id']]);
        };
        $this->assertSame(200, $put(['project' => self::project(['index.html' => '<h1>Three</h1>']), 'expectedVersion' => 2])->getStatusCode());
        $this->assertSame(200, $put(['project' => self::project(['index.html' => '<h1>Four</h1>']), 'expectedVersion' => 3, 'how' => 'upload', 'summary' => 'From notes-v4.softn'])->getStatusCode());
        // What a page may say of itself is "upload" or nothing: it cannot call its version an AI's, or a going back.
        $this->assertSame(200, $put(['project' => self::project(['index.html' => '<h1>Five</h1>']), 'expectedVersion' => 4, 'how' => 'rollback', 'summary' => ['not', 'text']])->getStatusCode());

        $tools = new ChatToolsService($this->createMock(FormService::class), $this->apps(), $this->createMock(ResponseService::class), native: $this->native);
        $tools->call('update_native_app_files', ['appId' => self::APP['id'], 'expectedVersion' => 5, 'files' => ['index.html' => '<h1>Six</h1>'], 'summary' => 'A new heading'], new ChatToolsContext('owner', source: 'mcp'));
        $tools->callChatTool('update_native_app_files', ['appId' => self::APP['id'], 'expectedVersion' => 6, 'files' => ['index.html' => '<h1>Seven</h1>']], new ChatToolsContext('owner'));

        $rows = array_column(self::body($this->call('GET', 'index'))['versions'], null, 'version');
        $said = static fn (int $n): array => [$rows[$n]['how'], $rows[$n]['summary'], $rows[$n]['by']];
        $this->assertSame(['page', null, 'owner'], $said(3));
        $this->assertSame(['upload', 'From notes-v4.softn', 'owner'], $said(4));
        $this->assertSame(['page', null, 'owner'], $said(5));
        $this->assertSame(['mcp', 'A new heading', 'owner'], $said(6));
        $this->assertSame(['chat', null, 'owner'], $said(7));
        $this->assertTrue($rows[7]['current']);
    }
}
