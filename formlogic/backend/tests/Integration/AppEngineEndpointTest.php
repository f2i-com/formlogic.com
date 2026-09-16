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
            new AuditService(self::$mysql, null, 'app-engine-test-audit-key')
        );
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

        // Verified: the choice is STORED even though this install serves ZIPP only, and the
        // answer says which engine actually runs and why.
        $this->verifyOwner();
        $accepted = $this->put(['engine' => 'host-js']);
        $this->assertSame(200, $accepted->getStatusCode());
        $this->assertSame('host-js', $this->storedEngine());
        $engine = $this->jsonBody($accepted)['engine'];
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('not-installed', $engine['reason']);
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
        $this->assertSame(['zipp-web-python'], $body['enginePolicy']['allowed']);
        $this->assertSame(['zipp-web-python'], $body['enginePolicy']['installed']);
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
}
