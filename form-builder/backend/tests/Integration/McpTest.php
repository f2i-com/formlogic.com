<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\McpController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * MCP token + tool enforcement against a real DB: app-scoped tokens are confined to their app, the
 * default builder token can't read responses, create_app is hidden when app-scoped, batch is capped,
 * and expired/revoked tokens fail. Skipped without a test DB (same setup as the other Integration tests).
 */
class McpTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static McpTokenService $tokens;
    private static AppService $apps;
    private static McpController $ctrl;

    private string $userId = '';
    private string $appA = '';
    private string $appB = '';
    private string $formA = '';
    private string $formB = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-mcp-test-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, $forms);
        self::$tokens = new McpTokenService($conn);
        self::$ctrl = new McpController(self::$tokens, $forms, self::$apps, $responses);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->appA = $this->makeApp();
        $this->appB = $this->makeApp();
        $this->formA = $this->makeForm();
        $this->formB = $this->makeForm();
        $this->attach($this->appA, $this->formA);
        $this->attach($this->appB, $this->formB);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM mcp_sessions WHERE user_id = ?')->execute([$this->userId]);
        // Clean children for EVERY app the user owns (incl. apps a creator token made during a test).
        $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $owned->execute([$this->userId]);
        foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── helpers ──

    private function makeApp(): string
    {
        $id = 'app-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Test App', ?, 'published')")
            ->execute([$id, $this->userId, 'mcp-' . bin2hex(random_bytes(5))]);
        return $id;
    }

    private function makeForm(): string
    {
        $id = 'frm-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'Test Form', 'published')")
            ->execute([$id, $this->userId]);
        return $id;
    }

    private function attach(string $appId, string $formId): void
    {
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible) VALUES (?, ?, ?, 'Form', 0, 1)")
            ->execute(['af-' . bin2hex(random_bytes(12)), $appId, $formId]);
    }

    private function rpc(string $token, array $payload): array
    {
        $stream = (new StreamFactory())->createStream(json_encode($payload));
        $req = (new ServerRequestFactory())->createServerRequest('POST', '/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody($stream);
        $resp = self::$ctrl->handle($req, (new ResponseFactory())->createResponse());
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** Returns ['isError'=>bool, 'data'=>mixed, 'text'=>string]. */
    private function tool(string $token, string $name, array $args = []): array
    {
        $r = $this->rpc($token, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => ['name' => $name, 'arguments' => $args]]);
        $txt = $r['result']['content'][0]['text'] ?? '';
        return ['isError' => $r['result']['isError'] ?? false, 'data' => json_decode($txt, true), 'text' => $txt];
    }

    private function toolNames(string $token): array
    {
        $r = $this->rpc($token, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']);
        return array_map(static fn ($t) => $t['name'], $r['result']['tools'] ?? []);
    }

    // ── token service ──

    public function testDefaultScopesExcludeResponses(): void
    {
        $t = self::$tokens->create($this->userId);
        $v = self::$tokens->validate($t['token']);
        $this->assertNotNull($v);
        $this->assertContains('forms:write', $v['scopes']);
        $this->assertNotContains('responses:read', $v['scopes']);
        $this->assertNotContains('responses:write', $v['scopes']);
    }

    public function testRevokedAndExpiredTokensFail(): void
    {
        $t = self::$tokens->create($this->userId);
        $this->assertTrue(self::$tokens->revoke($t['id'], $this->userId));
        $this->assertNull(self::$tokens->validate($t['token']), 'revoked token must not validate');

        $t2 = self::$tokens->create($this->userId);
        self::$pdo->prepare('UPDATE mcp_sessions SET expires_at = ? WHERE id = ?')->execute([date('Y-m-d H:i:s', time() - 3600), $t2['id']]);
        $this->assertNull(self::$tokens->validate($t2['token']), 'expired token must not validate');
    }

    public function testUnauthenticatedRequestIs401(): void
    {
        $r = $this->rpc('flm_not_a_real_token', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']);
        $this->assertSame(-32001, $r['error']['code'] ?? null);
    }

    // ── app-scope enforcement ──

    public function testAppScopedListAppsReturnsOnlyScopedApp(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'list_apps');
        $this->assertFalse($res['isError']);
        $this->assertCount(1, $res['data']);
        $this->assertSame($this->appA, $res['data'][0]['id']);
    }

    public function testAppScopedCannotTouchOtherApp(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'update_app', ['appId' => $this->appB, 'name' => 'Hijack']);
        $this->assertTrue($res['isError']);
        $this->assertStringContainsString('scoped', $res['text']);
    }

    public function testAppScopedCannotAccessFormOutsideApp(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'get_form', ['formId' => $this->formB]);
        $this->assertTrue($res['isError'], 'form in another app must be rejected');
    }

    public function testAppScopedCannotCreateApp(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertNotContains('create_app', $this->toolNames($tok), 'create_app hidden when app-scoped');
        $res = $this->tool($tok, 'create_app', ['name' => 'Sneaky']);
        $this->assertTrue($res['isError']);
    }

    public function testAppScopedCreateFormAutoAttaches(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_form', ['title' => 'Auto', 'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]]]);
        $this->assertFalse($res['isError'], $res['text']);
        $newId = $res['data']['id'] ?? '';
        $this->assertNotSame('', $newId);
        $this->assertTrue(self::$apps->formBelongsToApp($this->appA, $newId), 'created form should auto-attach to the scoped app');
    }

    // ── capability scopes ──

    public function testDefaultTokenCannotReadResponses(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertNotContains('list_responses', $this->toolNames($tok));
        $res = $this->tool($tok, 'list_responses', ['formId' => $this->formA]);
        $this->assertTrue($res['isError']);
        $this->assertStringContainsString('responses:read', $res['text']);
    }

    public function testResponsesReadScopeUnlocksListResponses(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA, 3600, 900, ['forms:read', 'responses:read'])['token'];
        $this->assertContains('list_responses', $this->toolNames($tok));
        $res = $this->tool($tok, 'list_responses', ['formId' => $this->formA]);
        $this->assertFalse($res['isError'], $res['text']);
    }

    // ── batch cap ──

    public function testBatchOverLimitRejected(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $batch = array_fill(0, 21, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping']);
        $r = $this->rpc($tok, $batch);
        $this->assertSame(-32600, $r['error']['code'] ?? null);
    }

    public function testUpdateAppSlugUniquenessAndValid(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $bSlug = self::$pdo->query('SELECT slug FROM apps WHERE id = ' . self::$pdo->quote($this->appB))->fetchColumn();
        $dup = $this->tool($tok, 'update_app', ['appId' => $this->appA, 'slug' => $bSlug]);
        $this->assertTrue($dup['isError'], 'a duplicate slug must be rejected');
        $fresh = $this->tool($tok, 'update_app', ['appId' => $this->appA, 'slug' => 'mcp-fresh-' . bin2hex(random_bytes(3))]);
        $this->assertFalse($fresh['isError'], $fresh['text']);
        $this->assertSame('Test App', $fresh['data']['name'] ?? null);
    }

    public function testUpdateAppHideNavPersists(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'update_app', ['appId' => $this->appA, 'hideNav' => true]);
        $this->assertFalse($res['isError'], $res['text']);
        $this->assertTrue(($res['data']['settings']['hideNav'] ?? null) === true, 'hideNav should persist in settings');
    }

    // ── creator tokens ("Hand to an AI": create a new app, confined to it) ──

    public function testCreatorTokenCreatesAndIsConfined(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 900, null, true)['token'];
        // Creator tokens CAN create apps and start with none.
        $this->assertContains('create_app', $this->toolNames($tok));
        $this->assertCount(0, $this->tool($tok, 'list_apps')['data'], 'nothing created yet');

        $made = $this->tool($tok, 'create_app', ['name' => 'AI Built']);
        $this->assertFalse($made['isError'], $made['text']);
        $newAppId = $made['data']['id'] ?? '';
        $this->assertNotSame('', $newAppId);

        // Can manage the app it created…
        $this->assertFalse($this->tool($tok, 'update_app', ['appId' => $newAppId, 'hideNav' => true])['isError']);
        // …but NOT a pre-existing app.
        $bad = $this->tool($tok, 'update_app', ['appId' => $this->appB, 'name' => 'hijack']);
        $this->assertTrue($bad['isError']);
        $this->assertStringContainsString('created', $bad['text']);

        // list_apps shows only the created app.
        $list = $this->tool($tok, 'list_apps')['data'];
        $this->assertCount(1, $list);
        $this->assertSame($newAppId, $list[0]['id']);
    }

    public function testSelfDescribingGuide(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        // initialize carries model-facing instructions
        $init = $this->rpc($tok, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
        $this->assertStringContainsString('FormLogic', $init['result']['instructions'] ?? '');
        // get_started is always listed + callable (no scope), and returns the how-to
        $this->assertContains('get_started', $this->toolNames($tok));
        $guide = $this->tool($tok, 'get_started');
        $this->assertFalse($guide['isError']);
        $this->assertStringContainsString('create_app_form', $guide['text']);
    }

    public function testIdleTimedOutTokenFails(): void
    {
        $t = self::$tokens->create($this->userId);
        self::$pdo->prepare('UPDATE mcp_sessions SET last_used_at = ? WHERE id = ?')
            ->execute([date('Y-m-d H:i:s', time() - 100000), $t['id']]);
        $this->assertNull(self::$tokens->validate($t['token']), 'idle-timed-out token must not validate');
    }

    public function testCreateAppFormCreatesAndAttaches(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_app_form', ['title' => 'Attached', 'fields' => []]);
        $this->assertFalse($res['isError'], $res['text']);
        $newId = $res['data']['form']['id'] ?? '';
        $this->assertNotSame('', $newId);
        $this->assertTrue(self::$apps->formBelongsToApp($this->appA, $newId), 'create_app_form must attach to the scoped app');
    }

    public function testCreateFormRejectsInvalidInput(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'X', 'status' => 'bogus'])['isError'], 'invalid status rejected');
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'X', 'fields' => ['not-an-object']])['isError'], 'malformed field rejected');
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'X', 'customScreen' => ['danger' => 1]])['isError'], 'unknown customScreen key rejected');
    }

    // ── adversarial ──

    public function testHugePayloadsRejected(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'Big', 'logicScript' => str_repeat('x', 102401)])['isError'], 'oversized logicScript rejected');
        $fields = [];
        for ($i = 0; $i < 250; $i++) {
            $fields[] = ['id' => "f{$i}", 'type' => 'short_text', 'label' => 'L', 'required' => false];
        }
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'Big', 'fields' => $fields])['isError'], '>200 fields rejected');
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'Big', 'customScreen' => ['enabled' => true, 'html' => str_repeat('y', 600000)]])['isError'], 'oversized customScreen rejected');
    }

    public function testAppScopeBypassAttemptsRejected(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        // Every app-mutating tool must reject a different app.
        $this->assertTrue($this->tool($tok, 'create_app_form', ['appId' => $this->appB, 'title' => 'Sneak'])['isError']);
        $this->assertTrue($this->tool($tok, 'add_form_to_app', ['appId' => $this->appB, 'formId' => $this->formB])['isError']);
        $this->assertTrue($this->tool($tok, 'set_app_home', ['appId' => $this->appB, 'customScreen' => ['enabled' => true, 'html' => '<b>x</b>']])['isError']);
        $this->assertTrue($this->tool($tok, 'get_form', ['formId' => $this->formB])['isError']);
    }

    public function testExpiredTokenBatchIsRejectedWholesale(): void
    {
        $t = self::$tokens->create($this->userId, $this->appA);
        self::$pdo->prepare('UPDATE mcp_sessions SET expires_at = ? WHERE id = ?')->execute([date('Y-m-d H:i:s', time() - 3600), $t['id']]);
        $r = $this->rpc($t['token'], [
            ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'],
            ['jsonrpc' => '2.0', 'id' => 2, 'method' => 'tools/list'],
        ]);
        $this->assertSame(-32001, $r['error']['code'] ?? null, 'expired token fails auth before the batch runs');
    }

    public function testResponsesReadOutsideScopeRejected(): void
    {
        // Has responses:read, but app-scoped to appA — must not read a form in appB.
        $tok = self::$tokens->create($this->userId, $this->appA, 3600, 900, ['forms:read', 'responses:read'])['token'];
        $this->assertTrue($this->tool($tok, 'list_responses', ['formId' => $this->formB])['isError']);
    }

    public function testExpiredAndRevokedSessionsArePurged(): void
    {
        // Create all three first (create() auto-purges, but nothing is dead yet), then kill two.
        $active = self::$tokens->create($this->userId)['id'];
        $expired = self::$tokens->create($this->userId)['id'];
        $revoked = self::$tokens->create($this->userId)['id'];
        self::$pdo->prepare('UPDATE mcp_sessions SET expires_at = ? WHERE id = ?')->execute([date('Y-m-d H:i:s', time() - 3600), $expired]);
        self::$tokens->revoke($revoked, $this->userId);

        $removed = self::$tokens->purgeExpired();
        $this->assertGreaterThanOrEqual(2, $removed);

        $exists = function (string $id): bool {
            $s = self::$pdo->prepare('SELECT 1 FROM mcp_sessions WHERE id = ?');
            $s->execute([$id]);
            return (bool) $s->fetchColumn();
        };
        $this->assertTrue($exists($active), 'active session must survive the purge');
        $this->assertFalse($exists($expired), 'expired session must be purged');
        $this->assertFalse($exists($revoked), 'revoked session must be purged');
    }

    public function testCreatorTokenConfinedToFormsItCreates(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 900, null, true)['token'];
        $made = $this->tool($tok, 'create_form', ['title' => 'Tasks', 'fields' => [['id' => 'x', 'type' => 'short_text', 'label' => 'X', 'required' => false]]]);
        $this->assertFalse($made['isError'], $made['text']);
        $fid = $made['data']['id'] ?? '';
        // Can read the form it created…
        $this->assertFalse($this->tool($tok, 'get_form', ['formId' => $fid])['isError']);
        // …but NOT an existing form it didn't create.
        $this->assertTrue($this->tool($tok, 'get_form', ['formId' => $this->formB])['isError']);
    }
}
