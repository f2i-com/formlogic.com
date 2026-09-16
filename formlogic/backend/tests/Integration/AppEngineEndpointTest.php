<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\HostedAppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Models\User;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FormService;
use FormLogic\Services\HostedAppService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\RuntimeEngineService;
use FormLogic\Services\SandboxRunner;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * The owner's engine choice end to end: its own endpoint and its own column (never apps.settings,
 * which is replaced wholesale and replayed by packs, the MCP merge and the acting-as mirror), the
 * engine block the runtime and manage GETs carry, and the action-time 409 that tells a page loaded
 * before a revocation to remount.
 */
class AppEngineEndpointTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static FormService $forms;
    private static SQLiteConnection $sqlite;
    private static string $tmpRoot = '';

    private string $ownerId = '';
    private string $otherId = '';
    private string $appId = '';
    private string $slug = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/fl-app-engine-' . bin2hex(random_bytes(6));
        mkdir(self::$tmpRoot . '/sqlite', 0700, true);
        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$tmpRoot === '' || !is_dir(self::$tmpRoot)) {
            return;
        }
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator(self::$tmpRoot, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iterator as $file) {
            $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir(self::$tmpRoot);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        $this->otherId = 'u-' . bin2hex(random_bytes(12));
        $ins = self::$pdo->prepare('INSERT INTO users (id, email, password_hash, mfa_enabled) VALUES (?, ?, ?, 1)');
        $ins->execute([$this->ownerId, $this->ownerId . '@test.local', 'x']);
        $ins->execute([$this->otherId, $this->otherId . '@test.local', 'x']);
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        $this->slug = 'engine-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Engine app', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM system_meta WHERE meta_key = ?')->execute([RuntimeEngineService::POLICY_KEY]);
        self::$pdo->prepare('DELETE FROM audit_log WHERE resource_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->ownerId, $this->otherId] as $uid) {
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function engines(?array $advertised = null): RuntimeEngineService
    {
        $path = null;
        if ($advertised !== null) {
            $path = self::$tmpRoot . '/provenance-' . bin2hex(random_bytes(4)) . '.json';
            file_put_contents($path, json_encode($advertised));
        }
        return new RuntimeEngineService(self::$mysql, $path);
    }

    private function controller(?RuntimeEngineService $engines = null): HostedAppController
    {
        return new HostedAppController(
            self::$apps,
            self::$appUsers,
            new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'),
            $engines ?? $this->engines(),
            new AuditService(self::$mysql, null, 'app-engine-test-audit-key'),
            new NativeAppService(self::$tmpRoot . '/native')
        );
    }

    /**
     * A native project on disk for this app, as the read paths see one: `get()` reads project.json
     * and nothing else, so a file is the whole fixture. Installing one for real would start the
     * ZIPP runtime, which is not what is under test here.
     */
    private function installNativeProject(array $files): void
    {
        $root = self::$tmpRoot . '/native/' . hash('sha256', $this->appId);
        if (!is_dir($root)) mkdir($root, 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => false, 'version' => 1, 'updatedAt' => gmdate('c'), 'access' => 'application', 'assets' => [],
            'files' => $files + ['manifest.json' => '{"id":"engine-app","main":"ui/main.ui"}'],
        ], JSON_THROW_ON_ERROR));
    }

    private function request(string $method, string $path, ?array $body = null, ?string $userId = null, array $headers = []): ServerRequestInterface
    {
        $userId ??= $this->ownerId;
        $email = $userId === $this->ownerId ? $this->ownerId . '@test.local' : $this->otherId . '@test.local';
        $request = (new ServerRequestFactory())->createServerRequest($method, $path, ['REMOTE_ADDR' => '203.0.113.11'])
            ->withAttribute('userId', $userId)
            ->withAttribute('user', new User(id: $userId, email: $email));
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        return $body === null ? $request : $request->withParsedBody($body);
    }

    private function jsonBody(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    private function allowHostJs(): void
    {
        $this->engines()->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'host-js']]);
    }

    private function verifyOwner(): void
    {
        self::$pdo->prepare('UPDATE users SET code_trust_verified_at = NOW() WHERE id = ?')->execute([$this->ownerId]);
    }

    private function publish(): void
    {
        (new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'))->publish($this->appId, [
            'version' => 1,
            'client' => ['manifest.json' => '{"main":"ui/main.ui","name":"Engine app"}', 'ui/main.ui' => '<Text>Hello</Text>'],
            'actions' => ['noop' => ['access' => 'owner', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return 1; }']],
        ], 0);
    }

    private function storedEngine(): ?string
    {
        $stmt = self::$pdo->prepare('SELECT client_engine FROM apps WHERE id = ?');
        $stmt->execute([$this->appId]);
        $value = $stmt->fetchColumn();
        return is_string($value) ? $value : null;
    }

    // ── the owner's choice ───────────────────────────────────────────────────

    public function testOnlyTheOwnerCanSetTheEngine(): void
    {
        $response = $this->controller()->engine(
            $this->request('PUT', '/api/apps/' . $this->appId . '/engine', ['engine' => 'zipp-web-python'], $this->otherId),
            (new ResponseFactory())->createResponse(),
            ['id' => $this->appId]
        );
        $this->assertSame(404, $response->getStatusCode(), 'another account is told the app does not exist');
        $this->assertNull($this->storedEngine());
    }

    public function testTheSharedDemoCannotSetTheEngine(): void
    {
        $demoEmail = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        $request = $this->request('PUT', '/api/apps/' . $this->appId . '/engine', ['engine' => 'zipp-web-python'])
            ->withAttribute('user', new User(id: $this->ownerId, email: $demoEmail));
        $response = $this->controller()->engine($request, (new ResponseFactory())->createResponse(), ['id' => $this->appId]);
        $this->assertSame(403, $response->getStatusCode());
        $this->assertSame('demo_readonly', $this->jsonBody($response)['code']);
    }

    public function testAnEngineThisSiteDoesNotAllowIsRefusedWith422(): void
    {
        $response = $this->put(['engine' => 'zipp-web']);
        $this->assertSame(422, $response->getStatusCode());
        $this->assertSame('engine_not_available', $this->jsonBody($response)['code']);
        $this->assertNull($this->storedEngine(), 'nothing was stored');
    }

    public function testHostJsIsRefusedUntilTheOwnerIsVerified(): void
    {
        $this->allowHostJs();
        $refused = $this->put(['engine' => 'host-js']);
        $this->assertSame(422, $refused->getStatusCode());
        $this->assertStringContainsString('verified for code trust', $this->jsonBody($refused)['message']);

        // Verified: the choice is stored AND effective, because the installed hosted runtime
        // serves host-js. The answer still says which engine actually runs, and gives no reason
        // because there is nothing standing between the choice and the frame.
        $this->verifyOwner();
        $accepted = $this->put(['engine' => 'host-js']);
        $this->assertSame(200, $accepted->getStatusCode());
        $this->assertSame('host-js', $this->storedEngine());
        $engine = $this->jsonBody($accepted)['engine'];
        $this->assertSame('host-js', $engine['id']);
        $this->assertArrayNotHasKey('reason', $engine);
        $this->assertSame(['zipp-web-python', 'host-js'], $this->jsonBody($accepted)['policy']['allowed']);
    }

    public function testStoringAChoiceIsAudited(): void
    {
        $this->assertSame(200, $this->put(['engine' => 'zipp-web-python'])->getStatusCode());
        $this->assertSame(200, $this->put(['engine' => null])->getStatusCode(), 'null means the site default');
        $this->assertNull($this->storedEngine());

        $stmt = self::$pdo->prepare('SELECT action, details FROM audit_log WHERE resource_id = ? ORDER BY sequence_number ASC');
        $stmt->execute([$this->appId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(2, $rows);
        $this->assertSame('app.engine_change', $rows[0]['action']);
        $this->assertSame(['from' => null, 'to' => 'zipp-web-python', 'effective' => 'zipp-web-python', 'reason' => null], json_decode((string) $rows[0]['details'], true));
        $this->assertSame('zipp-web-python', json_decode((string) $rows[1]['details'], true)['from']);
        $this->assertNull(json_decode((string) $rows[1]['details'], true)['to']);
    }

    public function testABadBodyIsRefusedBeforeAnythingIsWritten(): void
    {
        foreach ([[], ['engine' => 5], ['engines' => 'zipp-web-python']] as $body) {
            $response = $this->put($body);
            $this->assertSame(400, $response->getStatusCode(), json_encode($body));
        }
        $this->assertNull($this->storedEngine());
    }

    public function testReplayingTheAppSettingsLeavesTheStoredEngineAlone(): void
    {
        $this->allowHostJs();
        $this->verifyOwner();
        $this->put(['engine' => 'host-js']);
        // The whole-settings write every owner PUT, pack import and MCP merge performs.
        self::$apps->updateApp($this->appId, ['name' => 'Renamed', 'settings' => ['appKind' => 'workspace', 'clientEngine' => 'zipp-web-python']]);
        $this->assertSame('host-js', $this->storedEngine(), 'the engine is not part of apps.settings');
    }

    private function put(array $body): ResponseInterface
    {
        return $this->controller()->engine(
            $this->request('PUT', '/api/apps/' . $this->appId . '/engine', $body),
            (new ResponseFactory())->createResponse(),
            ['id' => $this->appId]
        );
    }

    // ── what the responses carry ─────────────────────────────────────────────

    public function testTheManageGetCarriesTheChoiceTheOutcomeAndTheChoosableEngines(): void
    {
        $this->publish();
        $response = $this->controller()->manage(
            $this->request('GET', '/api/apps/' . $this->appId . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['id' => $this->appId]
        );
        $body = $this->jsonBody($response);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame('zipp-web-python', $body['engine']['id']);
        $this->assertNull($body['engine']['stored']);
        $this->assertSame(['zipp-web-python'], $body['enginePolicy']['allowed'], 'the site default allow-list, which host-js is not in');
        // The install serves more than the policy allows: the owner is offered the intersection.
        $this->assertSame(['zipp-web-python', 'host-js'], $body['enginePolicy']['installed']);
    }

    public function testTheRuntimeGetCarriesTheEngineAndItsRevisionAndStaysNoStore(): void
    {
        $this->publish();
        $response = $this->controller()->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        );
        $body = $this->jsonBody($response);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame(['id', 'revision'], array_keys($body['engine']));
        $this->assertSame('zipp-web-python', $body['engine']['id']);
        $this->assertSame($this->engines()->effective($this->appId)['revision'], $body['engine']['revision']);
    }

    public function testAnActionWithNoEngineHeaderIsAnsweredAsBefore(): void
    {
        $this->publish();
        $response = $this->controller()->runtime(
            $this->request('POST', '/api/app/' . $this->slug . '/actions/noop', []),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug, 'action' => 'noop']
        );
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(1, $this->jsonBody($response)['result']);
    }

    public function testAMatchingEngineHeaderIsAccepted(): void
    {
        $this->publish();
        $effective = $this->engines()->effective($this->appId);
        $response = $this->controller()->runtime(
            $this->request('POST', '/api/app/' . $this->slug . '/actions/noop', [], null, ['X-FormLogic-Client-Engine' => $effective['id'] . ';' . $effective['revision']]),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug, 'action' => 'noop']
        );
        $this->assertSame(200, $response->getStatusCode());
    }

    public function testAStaleEngineHeaderAnswers409EngineChanged(): void
    {
        $this->publish();
        $effective = $this->engines()->effective($this->appId);
        // What a page that loaded before a revocation would still be sending.
        foreach (['host-js;' . $effective['revision'], 'zipp-web-python;' . str_repeat('0', 16)] as $header) {
            $response = $this->controller()->runtime(
                $this->request('POST', '/api/app/' . $this->slug . '/actions/noop', [], null, ['X-FormLogic-Client-Engine' => $header]),
                (new ResponseFactory())->createResponse(),
                ['slug' => $this->slug, 'action' => 'noop']
            );
            $this->assertSame(409, $response->getStatusCode(), $header);
            $this->assertSame('engine_changed', $this->jsonBody($response)['code'], $header);
        }
    }

    public function testAPolicyChangeMovesTheRevisionSoAPageIsToldToRemount(): void
    {
        $this->publish();
        $before = $this->engines()->effective($this->appId);
        $this->allowHostJs();
        $after = $this->engines()->effective($this->appId);
        $this->assertNotSame($before['revision'], $after['revision']);
        $response = $this->controller()->runtime(
            $this->request('POST', '/api/app/' . $this->slug . '/actions/noop', [], null, ['X-FormLogic-Client-Engine' => $before['id'] . ';' . $before['revision']]),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug, 'action' => 'noop']
        );
        $this->assertSame(409, $response->getStatusCode());
        $this->assertSame('engine_changed', $this->jsonBody($response)['code']);
    }

    // ── an app whose logic is Python ─────────────────────────────────────────

    /** The one Python thing about a Python app: a client file whose NAME ends `.py`. */
    private function publishPython(): void
    {
        (new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'))->publish($this->appId, [
            'version' => 1,
            'client' => [
                'manifest.json' => '{"main":"ui/main.ui","name":"Engine app","files":{"logic":["logic/counter.py"]}}',
                'ui/main.ui' => '<Text>{count}</Text>',
                'logic/counter.py' => "count = 0\n",
            ],
            'actions' => ['noop' => ['access' => 'owner', 'mode' => 'read', 'source' => 'function onRequest(ctx) { return 1; }']],
        ], 0);
    }

    /** An install serving all three engines, so a fallback to zipp-web is genuinely available. */
    private function everyEngine(): RuntimeEngineService
    {
        return $this->engines(['hostedRuntime' => [
            'engines' => ['zipp-web-python', 'zipp-web', 'host-js'],
            'features' => ['python-logic/1'],
        ]]);
    }

    public function testAPythonAppRunsOnWebPythonEvenWhenItsOwnerChoseHostJavaScript(): void
    {
        $this->engines()->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'zipp-web', 'host-js']]);
        $this->verifyOwner();
        $this->publishPython();
        self::$pdo->prepare('UPDATE apps SET client_engine = ? WHERE id = ?')->execute(['host-js', $this->appId]);
        $controller = $this->controller($this->everyEngine());

        // The control first: with nothing but the owner's choice to go on, host-js is effective —
        // the policy allows it, the owner is verified and the install serves it.
        $this->assertSame('host-js', $this->everyEngine()->effective($this->appId)['id']);

        // And what a member is actually served, because the app's own file names say it is Python.
        $body = $this->jsonBody($controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        ));
        $this->assertSame('zipp-web-python', $body['engine']['id']);

        // The owner's settings screen is told the same thing, with the reason.
        $owner = $this->jsonBody($controller->manage(
            $this->request('GET', '/api/apps/' . $this->appId . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['id' => $this->appId]
        ))['engine'];
        $this->assertSame('zipp-web-python', $owner['id']);
        $this->assertSame('host-js', $owner['stored'], 'the choice is kept; it is the outcome that is clamped');
        $this->assertSame('python-required', $owner['reason']);

        // The same pair against the runtime this tree has actually installed, not a fixture: the
        // resolver's before and after for one app, one argument apart.
        $installed = $this->engines();
        $this->assertSame('host-js', $installed->effective($this->appId)['id']);
        $clamped = $installed->effective($this->appId, ['javascript', 'python']);
        $this->assertSame('zipp-web-python', $clamped['id']);
        $this->assertSame('python-required', $clamped['reason']);
    }

    public function testAPythonAppRunsOnWebPythonEvenWhereTheSiteDefaultIsTheJavaScriptOnlyBuild(): void
    {
        $this->engines()->writePolicy(['default' => 'zipp-web', 'allowed' => ['zipp-web-python', 'zipp-web']]);
        $controller = $this->controller($this->everyEngine());

        // The control: the same app, same site, one file name apart.
        $this->publish();
        $this->assertSame('zipp-web', $this->jsonBody($controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        ))['engine']['id'], 'a JavaScript app takes the site default');

        (new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'))->publish($this->appId, [
            'version' => 1,
            'client' => ['manifest.json' => '{"main":"ui/main.ui","name":"Engine app"}', 'ui/main.ui' => '<Text/>', 'logic/counter.py' => "count = 0\n"],
            'actions' => [],
        ], 1);
        $this->assertSame('zipp-web-python', $this->jsonBody($controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        ))['engine']['id'], 'zipp-web cannot run Python at all, whatever the site prefers');
        $this->assertSame('python-required', $this->everyEngine()->effective($this->appId, ['javascript', 'python'])['reason']);
    }

    public function testAnActionFromAClampedPythonFrameIsNotToldTheEngineChanged(): void
    {
        // The engine the GET answered with is the engine the action-time check must compute, or the
        // frame is sent round a remount loop it can never settle: it reloads, is given the same
        // clamped engine, sends it back, and is refused again.
        $this->engines()->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'zipp-web', 'host-js']]);
        $this->verifyOwner();
        $this->publishPython();
        self::$pdo->prepare('UPDATE apps SET client_engine = ? WHERE id = ?')->execute(['host-js', $this->appId]);
        $controller = $this->controller($this->everyEngine());
        $mounted = $this->jsonBody($controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        ))['engine'];
        $this->assertSame('zipp-web-python', $mounted['id']);
        $action = $controller->runtime(
            $this->request('POST', '/api/app/' . $this->slug . '/actions/noop', [], null, ['X-FormLogic-Client-Engine' => $mounted['id'] . ';' . $mounted['revision']]),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug, 'action' => 'noop']
        );
        $this->assertSame(200, $action->getStatusCode(), (string) ($this->jsonBody($action)['code'] ?? ''));
        $this->assertSame(1, $this->jsonBody($action)['result']);
    }

    /**
     * The audit row is the record an incident is reconstructed from. `effective: host-js` for an
     * app that can never run host JavaScript would read as evidence that host JavaScript was in
     * play — for the one decision an administrator verified an account in order to permit.
     */
    public function testTheAuditRowForAPythonAppRecordsTheEngineItWillActuallyRunOn(): void
    {
        $this->allowHostJs();
        $this->verifyOwner();
        $this->publishPython();
        $response = $this->put(['engine' => 'host-js']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('host-js', $this->storedEngine(), 'the choice is still stored: it is storable, just not effective');
        $this->assertSame('zipp-web-python', $this->jsonBody($response)['engine']['id']);
        $this->assertSame('python-required', $this->jsonBody($response)['engine']['reason']);

        $stmt = self::$pdo->prepare('SELECT details FROM audit_log WHERE resource_id = ? ORDER BY sequence_number DESC LIMIT 1');
        $stmt->execute([$this->appId]);
        $details = json_decode((string) $stmt->fetchColumn(), true);
        $this->assertSame('host-js', $details['to'], 'what the owner asked for');
        $this->assertSame('zipp-web-python', $details['effective'], 'and what it actually produced');
        $this->assertSame('python-required', $details['reason']);
    }

    public function testTheChoiceCoversTheNativeClientToo(): void
    {
        // One column covers an app's hosted deployment AND its native client. A Python native
        // project with no hosted deployment at all is the case a hosted-only derivation misses.
        $this->allowHostJs();
        $this->verifyOwner();
        $this->installNativeProject(['ui/main.ui' => '<Text/>', 'logic/counter.py' => "count = 0\n"]);
        $response = $this->put(['engine' => 'host-js']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('zipp-web-python', $this->jsonBody($response)['engine']['id']);

        $stmt = self::$pdo->prepare('SELECT details FROM audit_log WHERE resource_id = ? ORDER BY sequence_number DESC LIMIT 1');
        $stmt->execute([$this->appId]);
        $this->assertSame('zipp-web-python', json_decode((string) $stmt->fetchColumn(), true)['effective']);

        // The control: the same app one file name apart records the choice as effective.
        $this->installNativeProject(['ui/main.ui' => '<Text/>', 'logic/counter.logic' => 'let count = 0;']);
        $again = $this->put(['engine' => 'host-js']);
        $this->assertSame('host-js', $this->jsonBody($again)['engine']['id']);
        $stmt->execute([$this->appId]);
        $this->assertSame('host-js', json_decode((string) $stmt->fetchColumn(), true)['effective']);
    }

    public function testTheAdminsPerAppEngineIsTheOneTheRuntimeGetWouldAnswer(): void
    {
        // An admin reads this to decide whether an account still needs code-trust verification.
        $this->allowHostJs();
        $this->verifyOwner();
        $this->publishPython();
        self::$pdo->prepare('UPDATE apps SET client_engine = ? WHERE id = ?')->execute(['host-js', $this->appId]);
        $admin = new \FormLogic\Services\AdminService(
            self::$mysql,
            new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'),
            new NativeAppService(self::$tmpRoot . '/native')
        );
        $apps = $admin->getUserOverview($this->ownerId)['apps'];
        $row = null;
        foreach ($apps as $app) {
            if ($app['id'] === $this->appId) $row = $app;
        }
        $this->assertNotNull($row);
        $this->assertSame('zipp-web-python', $row['engine']['id']);
        $this->assertSame('python-required', $row['engine']['reason']);
        $this->assertSame('host-js', $row['engine']['stored'], 'the stored choice is still shown');
    }

    public function testAnInstallThatDoesNotAdvertiseThePythonContractServesNoPythonAppAtAll(): void
    {
        // The state of any tree whose runtime was installed by a FormLogic from before the `.py`
        // rule: it would inline the author's Python as JavaScript. Fail closed.
        $stale = $this->engines(['hostedRuntime' => ['engines' => ['zipp-web-python', 'host-js']]]);
        $controller = $this->controller($stale);

        $this->publish();
        $this->assertSame(200, $controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        )->getStatusCode(), 'a JavaScript app is unaffected');

        (new HostedAppService(new SandboxRunner(), self::$tmpRoot . '/hosted'))->publish($this->appId, [
            'version' => 1,
            'client' => ['manifest.json' => '{"main":"ui/main.ui","name":"Engine app"}', 'ui/main.ui' => '<Text/>', 'logic/counter.py' => "count = 0\n"],
            'actions' => [],
        ], 1);
        $refused = $controller->runtime(
            $this->request('GET', '/api/app/' . $this->slug . '/hosting'),
            (new ResponseFactory())->createResponse(),
            ['slug' => $this->slug]
        );
        $this->assertSame(503, $refused->getStatusCode());
        $this->assertArrayNotHasKey('deployment', $this->jsonBody($refused));
    }
}
