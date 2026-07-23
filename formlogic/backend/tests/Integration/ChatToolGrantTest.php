<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ChatToolsController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\ChatToolGrantService;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Chat tool grants + catalog + execute (plan Phase 6 §5.4/§6): grant mint (shape, 10-min
 * TTL, demo 403, instance resolution: pin/implicit → ambiguous_desktop → desktop_offline,
 * explicit-instance ownership), the execute surface (happy path running AS the granting
 * user, typed grant_invalid / grant_expired / grant_instance_mismatch / unknown_tool, the
 * non-destructive update_form guard, flk_ scope rules, audit rows), and the catalog
 * (EXACTLY the ten v1 tools, top-level {"tools":…}, session OR flk_ auth).
 * Skipped without a test database.
 */
class ChatToolGrantTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static ChatToolGrantService $grants;
    private static ChatToolsService $tools;
    private static DesktopCommandService $commands;
    private static ApiKeyService $apiKeys;
    private static FormService $forms;
    private static ChatToolsController $ctrl;

    private string $userId = '';
    private string $otherId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-chattools-test-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, self::$forms);
        $responses = new ResponseService($conn, $sqlite);
        self::$grants = new ChatToolGrantService($conn);
        self::$tools = new ChatToolsService(self::$forms, $apps, $responses);
        self::$commands = new DesktopCommandService($conn);
        self::$apiKeys = new ApiKeyService($conn);
        self::$ctrl = new ChatToolsController(
            self::$grants,
            self::$tools,
            self::$commands,
            self::$apiKeys,
            new AuditService($conn)
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = $this->addUser();
        $this->otherId = $this->addUser();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->userId, $this->otherId] as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE FROM chat_tool_grants WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function addUser(): string
    {
        $uid = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$uid, $uid . '@test.local']);
        return $uid;
    }

    private function addConnection(string $ownerId, string $instanceId, bool $fresh = true): void
    {
        self::$pdo->prepare(
            "INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at)
             VALUES (?, ?, 'TestBox', ?, " . ($fresh ? 'NOW()' : 'NULL') . ')'
        )->execute(['dc-' . bin2hex(random_bytes(8)), $ownerId, $instanceId]);
    }

    /** POST /api/ai/chat-tool-grant as $userId (optionally as the shared demo user). */
    private function mint(?string $userId, array $body = [], bool $demo = false): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat-tool-grant')
            ->withParsedBody($body);
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        if ($demo) {
            $req = $req->withAttribute('user', (object) ['email' => $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local']);
        }
        $resp = self::$ctrl->mintGrant($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** POST /api/ai/chat-tools/execute with simulated ApiKeyMiddleware attributes. */
    private function execute(?string $keyOwnerId, array $scopes, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/ai/chat-tools/execute')
            ->withParsedBody($body);
        if ($keyOwnerId !== null) {
            $req = $req->withAttribute('userId', $keyOwnerId)->withAttribute('apiKeyScopes', $scopes);
        }
        $resp = self::$ctrl->execute($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function grantRow(string $userId): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM chat_tool_grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    // ── grant mint ──

    public function testMintShapeTtlAndBinding(): void
    {
        $this->addConnection($this->userId, 'inst-mint-1');
        $out = $this->mint($this->userId);
        $this->assertSame(200, $out['status']);
        $grant = $out['body']['data'] ?? [];
        $this->assertStringStartsWith('ctg_', $grant['grantToken'] ?? '');
        $expires = strtotime((string) ($grant['expiresAt'] ?? ''));
        $this->assertNotFalse($expires, 'expiresAt must be ISO-8601');
        $this->assertGreaterThan(time() + 540, $expires, 'TTL is ~10 minutes');
        $this->assertLessThan(time() + 660, $expires);

        // Only the sha256 hash is stored, bound to the resolved instance + the fixed scope.
        $row = $this->grantRow($this->userId);
        $this->assertNotNull($row);
        $this->assertSame(hash('sha256', $grant['grantToken']), $row['token_hash']);
        $this->assertSame('inst-mint-1', $row['desktop_instance_id']);
        $this->assertSame('ai:chat-tools', $row['scope']);
        $this->assertStringNotContainsString($grant['grantToken'], json_encode($row) ?: '');
    }

    public function testMintDemoIs403(): void
    {
        $this->addConnection($this->userId, 'inst-demo');
        $out = $this->mint($this->userId, [], true);
        $this->assertSame(403, $out['status']);
        $this->assertSame('demo_readonly', $out['body']['code']);
    }

    public function testMintTargetResolutionFailuresAreTyped(): void
    {
        // No linked/fresh desktop → desktop_offline.
        $out = $this->mint($this->userId);
        $this->assertSame(503, $out['status']);
        $this->assertSame('desktop_offline', $out['body']['code']);

        // Two fresh desktops, no assignment pin → ambiguous_desktop with the machine list.
        $this->addConnection($this->userId, 'inst-a');
        $this->addConnection($this->userId, 'inst-b');
        $out = $this->mint($this->userId);
        $this->assertSame(409, $out['status']);
        $this->assertSame('ambiguous_desktop', $out['body']['code']);
        $this->assertCount(2, $out['body']['details']['desktops'] ?? []);

        // An explicit instanceId resolves the ambiguity…
        $out = $this->mint($this->userId, ['instanceId' => 'inst-b']);
        $this->assertSame(200, $out['status']);
        $this->assertSame('inst-b', $this->grantRow($this->userId)['desktop_instance_id']);

        // …but only for an instance registered to THIS workspace.
        $out = $this->mint($this->userId, ['instanceId' => 'inst-foreign']);
        $this->assertSame(404, $out['status']);
        $this->assertSame('unknown_desktop_instance', $out['body']['code']);

        // Unauthenticated → 401.
        $this->assertSame(401, $this->mint(null)['status']);
    }

    // ── execute ──

    public function testExecuteRunsAsTheGrantingUserAndAudits(): void
    {
        $this->addConnection($this->userId, 'inst-exec');
        $token = $this->mint($this->userId)['body']['data']['grantToken'];

        $out = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $token,
            'tool' => 'create_form',
            'input' => ['title' => 'Chat-created form'],
        ]);
        $this->assertSame(200, $out['status']);
        $formId = $out['body']['data']['id'] ?? '';
        $this->assertNotSame('', $formId);
        // The form belongs to the GRANTING user (not to any key/other identity).
        $form = self::$forms->getForm($formId);
        $this->assertSame($this->userId, $form['userId'] ?? null);

        // Every execution is audit-logged; the write handler adds its own chat.create_form row.
        $stmt = self::$pdo->prepare('SELECT action FROM audit_log WHERE user_id = ? ORDER BY sequence_number DESC LIMIT 5');
        $stmt->execute([$this->userId]);
        $actions = array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'action');
        $this->assertContains('chat.tool_execute', $actions);
        $this->assertContains('chat.create_form', $actions);

        // The grandfathered connector:relay scope also executes (plan §7).
        $token2 = $this->mint($this->userId)['body']['data']['grantToken'];
        $out2 = $this->execute($this->userId, ['connector:relay'], [
            'grantToken' => $token2,
            'tool' => 'list_forms',
            'input' => [],
        ]);
        $this->assertSame(200, $out2['status']);
        $ids = array_column($out2['body']['data'] ?? [], 'id');
        $this->assertContains($formId, $ids);
    }

    public function testExecuteTypedFailures(): void
    {
        $this->addConnection($this->userId, 'inst-typed');
        $token = $this->mint($this->userId)['body']['data']['grantToken'];

        // Unknown/malformed token → grant_invalid.
        $bad = $this->execute($this->userId, ['ai:relay'], ['grantToken' => 'ctg_' . str_repeat('0', 48), 'tool' => 'list_forms', 'input' => []]);
        $this->assertSame(401, $bad['status']);
        $this->assertSame('grant_invalid', $bad['body']['code']);
        $malformed = $this->execute($this->userId, ['ai:relay'], ['grantToken' => 'not-a-grant', 'tool' => 'list_forms', 'input' => []]);
        $this->assertSame('grant_invalid', $malformed['body']['code']);

        // Expired (still present) → grant_expired, honestly distinct from invalid.
        self::$pdo->prepare('UPDATE chat_tool_grants SET expires_at = (NOW() - INTERVAL 60 SECOND) WHERE token_hash = ?')
            ->execute([hash('sha256', $token)]);
        $expired = $this->execute($this->userId, ['ai:relay'], ['grantToken' => $token, 'tool' => 'list_forms', 'input' => []]);
        $this->assertSame(401, $expired['status']);
        $this->assertSame('grant_expired', $expired['body']['code']);

        // A grant bound to ANOTHER workspace's desktop → grant_instance_mismatch for this key.
        $fresh = $this->mint($this->userId)['body']['data']['grantToken'];
        $mismatch = $this->execute($this->otherId, ['ai:relay'], ['grantToken' => $fresh, 'tool' => 'list_forms', 'input' => []]);
        $this->assertSame(403, $mismatch['status']);
        $this->assertSame('grant_instance_mismatch', $mismatch['body']['code']);

        // A tool outside the v1 subset → unknown_tool (delete_response exists over MCP only).
        $fresh2 = $this->mint($this->userId)['body']['data']['grantToken'];
        $unknown = $this->execute($this->userId, ['ai:relay'], ['grantToken' => $fresh2, 'tool' => 'delete_response', 'input' => []]);
        $this->assertSame(400, $unknown['status']);
        $this->assertSame('unknown_tool', $unknown['body']['code']);

        // update_form is non-destructive from chat: archiving refuses with a typed denial.
        $form = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $this->mint($this->userId)['body']['data']['grantToken'],
            'tool' => 'create_form', 'input' => ['title' => 'To archive'],
        ]);
        $archive = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $this->mint($this->userId)['body']['data']['grantToken'],
            'tool' => 'update_form',
            'input' => ['formId' => $form['body']['data']['id'], 'status' => 'archived'],
        ]);
        $this->assertSame(403, $archive['status']);
        $this->assertSame('tool_denied', $archive['body']['code']);
        $this->assertStringContainsStringIgnoringCase('archiv', (string) $archive['body']['message']);

        // flk_ scope rules: neither relay scope → insufficient_scope; no auth at all → 401.
        $scoped = $this->execute($this->userId, ['flows:write'], ['grantToken' => $fresh2, 'tool' => 'list_forms', 'input' => []]);
        $this->assertSame(403, $scoped['status']);
        $this->assertSame('insufficient_scope', $scoped['body']['code']);
        $this->assertSame(401, $this->execute(null, [], ['grantToken' => $fresh2, 'tool' => 'list_forms', 'input' => []])['status']);
    }

    public function testScreenToolsRunFromChatAndUpdateAppNeverArchives(): void
    {
        $this->addConnection($this->userId, 'inst-screens');
        $mint = fn () => $this->mint($this->userId)['body']['data']['grantToken'];

        // set_form_screen replaces the form's customScreen (screen-authoring centralisation).
        $form = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'create_form', 'input' => ['title' => 'Screened form'],
        ]);
        $formId = (string) ($form['body']['data']['id'] ?? '');
        $this->assertNotSame('', $formId);
        $out = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'set_form_screen',
            'input' => ['formId' => $formId, 'customScreen' => [
                'enabled' => true, 'entry' => 'index.tsx',
                'files' => [['path' => 'index.tsx', 'content' => 'export {}']],
            ]],
        ]);
        $this->assertSame(200, $out['status']);
        $stored = self::$forms->getForm($formId);
        $this->assertTrue((bool) ($stored['customScreen']['enabled'] ?? false));
        $this->assertSame('index.tsx', $stored['customScreen']['files'][0]['path'] ?? null);

        // The MCP customScreen key whitelist holds on the chat surface too.
        $badKeys = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'set_form_screen',
            'input' => ['formId' => $formId, 'customScreen' => ['enabled' => true, 'evil' => 1]],
        ]);
        $this->assertSame(400, $badKeys['status']);
        $this->assertSame('tool_failed', $badKeys['body']['code']);

        // set_app_home + update_app publish work from chat; archiving an app is refused typed.
        $app = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'create_app', 'input' => ['name' => 'Screened app'],
        ]);
        $appId = (string) ($app['body']['data']['id'] ?? '');
        $this->assertNotSame('', $appId);
        $home = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'set_app_home',
            'input' => ['appId' => $appId, 'customScreen' => [
                'enabled' => true, 'entry' => 'index.tsx',
                'files' => [['path' => 'index.tsx', 'content' => 'export {}']],
            ]],
        ]);
        $this->assertSame(200, $home['status']);
        $publish = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'update_app',
            'input' => ['appId' => $appId, 'status' => 'published'],
        ]);
        $this->assertSame(200, $publish['status']);
        $archive = $this->execute($this->userId, ['ai:relay'], [
            'grantToken' => $mint(), 'tool' => 'update_app',
            'input' => ['appId' => $appId, 'status' => 'archived'],
        ]);
        $this->assertSame(403, $archive['status']);
        $this->assertSame('tool_denied', $archive['body']['code']);
        $this->assertStringContainsStringIgnoringCase('archiv', (string) $archive['body']['message']);
    }

    // ── catalog ──

    public function testCatalogIsExactlyTheTenChatToolsTopLevel(): void
    {
        // Session-authed.
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/ai/chat-tools/catalog')
            ->withAttribute('userId', $this->userId);
        $resp = self::$ctrl->catalog($req, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $resp->getStatusCode());
        $body = self::decode($resp);
        $this->assertArrayNotHasKey('data', $body, 'catalog is TOP-LEVEL {"tools":…} (the pinned wire shape)');
        $names = array_column($body['tools'] ?? [], 'name');
        // Pin extended 2026-07-23 (extensible-flows §25 step 8): + blueprint_propose_elements,
        // then + list_blueprints/get_blueprint (chat READ access to diagrams), then
        // + set_form_screen/set_app_home/update_app (screen-authoring centralisation —
        // chat is the AI surface for custom screens; update_app publishes, never archives).
        $this->assertSame([
            'list_apps', 'list_forms', 'get_form', 'create_app', 'create_app_form',
            'create_form', 'update_form', 'add_form_to_app', 'create_flow', 'list_responses',
            'blueprint_propose_elements', 'list_blueprints', 'get_blueprint',
            'set_form_screen', 'set_app_home', 'update_app',
        ], $names);
        foreach ($body['tools'] as $tool) {
            $this->assertNotSame('', $tool['description'] ?? '');
            $this->assertSame('object', $tool['inputSchema']['type'] ?? null);
            $this->assertArrayNotHasKey('scope', $tool);
        }

        // flk_ with ai:relay works; a key without either relay scope is refused; no auth → 401.
        $key = self::$apiKeys->createKey($this->userId, 'chat-catalog', ['ai:relay']);
        $flkReq = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/ai/chat-tools/catalog')
            ->withHeader('Authorization', 'Bearer ' . $key['key']);
        $this->assertSame(200, self::$ctrl->catalog($flkReq, (new ResponseFactory())->createResponse())->getStatusCode());

        $wrong = self::$apiKeys->createKey($this->userId, 'chat-catalog-wrong', ['flows:write']);
        $wrongReq = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/ai/chat-tools/catalog')
            ->withHeader('Authorization', 'Bearer ' . $wrong['key']);
        $this->assertSame(403, self::$ctrl->catalog($wrongReq, (new ResponseFactory())->createResponse())->getStatusCode());

        $anonReq = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/ai/chat-tools/catalog');
        $this->assertSame(401, self::$ctrl->catalog($anonReq, (new ResponseFactory())->createResponse())->getStatusCode());
    }
}
