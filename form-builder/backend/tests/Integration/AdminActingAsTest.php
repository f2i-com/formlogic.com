<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Controllers\AppController;
use FormLogic\Controllers\AppDomainController;
use FormLogic\Controllers\AppUserController;
use FormLogic\Controllers\FlowController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\WebhookController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Http\AdminActingAsRoutes;
use FormLogic\Middleware\AdminActAsMiddleware;
use FormLogic\Middleware\AdminGateMiddleware;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\ResponseInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RouteCollectorProxy;

/**
 * The admin acting-as mirror (/api/admin/users/{ownerId}/...) end to end
 * through a REAL Slim app with the production middleware chain: AuthMiddleware
 * → AdminGateMiddleware → AdminActAsMiddleware → AdminActingAsRoutes.
 *
 * Locks the three properties the mirror exists for:
 *  1. Owner parity — the swapped effective user makes owner controllers accept
 *     the admin's structural edits, and the owner sees them.
 *  2. Default-deny — every allowlisted route rejects non-admins and anonymous
 *     callers; the table itself may never grow a record-data pattern.
 *  3. The no-response-data boundary — a planted TOP-SECRET-ANSWER (in a
 *     response, a flow-run snapshot, and a webhook delivery payload) is never
 *     visible through ANY mirror route; flow runs come back metadata-only.
 */
class AdminActingAsTest extends TestCase
{
    private const JWT_SECRET = 'acting-as-test-secret-0123456789abcdef';
    private const SECRET = 'TOP-SECRET-ANSWER';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AuthService $auth;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static FlowService $flows;
    private static AuditService $audit;
    private static \Slim\App $slim;
    private static string $tmpRoot = '';

    private string $ownerId = '';
    private string $adminId = '';
    private string $plainId = '';
    private string $formId = '';
    private string $appId = '';
    private string $appFlowId = '';
    private string $wsFlowId = '';
    private string $runId = '';
    private string $webhookId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-actingas-test-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);

        $sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$flows = new FlowService($conn);
        self::$audit = new AuditService($conn, null, 'acting-as-test-hmac-key');
        self::$auth = new AuthService($conn, [
            'secret' => self::JWT_SECRET,
            'expiry' => 3600,
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
        ]);

        // The production wiring in miniature: the same controllers, the same
        // middleware chain (LIFO: auth → gate → act-as), the same routes table.
        $controllers = [
            FormController::class => new FormController(
                self::$forms, null, new FormVersionService($conn, self::$forms), self::$audit
            ),
            AppController::class => new AppController(self::$apps, null, self::$audit),
            AppUserController::class => new AppUserController(self::$appUsers, self::$apps, self::$audit),
            FlowController::class => new FlowController(self::$flows, self::$apps, self::$appUsers),
            WebhookController::class => new WebhookController(new WebhookService($conn), self::$forms),
            AppDomainController::class => new AppDomainController(new AppDomainService($conn), self::$apps),
        ];
        $container = new class ($controllers) implements ContainerInterface {
            public function __construct(private array $services)
            {
            }
            public function get(string $id): mixed
            {
                return $this->services[$id];
            }
            public function has(string $id): bool
            {
                return isset($this->services[$id]);
            }
        };

        self::$slim = AppFactory::create();
        self::$slim->group('/api/admin/users/{ownerId}', function (RouteCollectorProxy $group) use ($container) {
            AdminActingAsRoutes::register($group, $container);
        })
            ->add(new AdminActAsMiddleware(self::$auth, self::$audit))
            ->add(new AdminGateMiddleware(self::$auth))
            ->add(new AuthMiddleware(self::$auth));
        self::$slim->addRoutingMiddleware();
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = $this->makeUser(false);
        $this->adminId = $this->makeUser(true);
        $this->plainId = $this->makeUser(false);

        // The owner's world: a form holding a secret response, an app with the
        // form attached, an app flow, a workspace flow, a flow run whose
        // snapshot/result/error all carry the secret, and a webhook whose
        // delivery payload carries it too.
        $form = self::$forms->createForm([
            'title' => 'Owner Contact Form', 'userId' => $this->ownerId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $this->formId = (string) $form['id'];
        self::$responses->createResponse($this->formId, ['answers' => ['name' => self::SECRET]], null);

        $app = self::$apps->createApp(['name' => 'Owner Helpdesk'], $this->ownerId);
        $this->appId = (string) $app['id'];
        self::$apps->addFormToApp($this->appId, $this->formId, 'Contacts');

        $this->appFlowId = (string) self::$flows->createFlow($this->appId, $this->ownerId, ['name' => 'Fixture Flow'])['id'];
        $this->wsFlowId = (string) self::$flows->createWorkspaceFlow($this->ownerId, ['name' => 'Fixture Workspace Flow'])['id'];

        $this->runId = 'run-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("
            INSERT INTO flow_run_logs
                (id, app_id, form_id, flow_definition_id, trigger_event, correlation_id,
                 idempotency_key, status, input_snapshot_json, result_json, error_json, created_at)
            VALUES (?, ?, ?, ?, 'form.submitted', ?, ?, 'running', ?, ?, ?, NOW())
        ")->execute([
            $this->runId, $this->appId, $this->formId, $this->appFlowId,
            'corr-' . $this->runId, 'idem-' . $this->runId,
            json_encode(['answers' => ['name' => self::SECRET]]),
            json_encode(['echo' => self::SECRET]),
            json_encode(['message' => 'failed with ' . self::SECRET]),
        ]);

        $this->webhookId = 'wh-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("
            INSERT INTO webhooks (id, form_id, user_id, url, secret, events, is_active)
            VALUES (?, ?, ?, 'https://example.com/hook', 'whsec', '[\"response.created\"]', 1)
        ")->execute([$this->webhookId, $this->formId, $this->ownerId]);
        self::$pdo->prepare("
            INSERT INTO webhook_deliveries (id, webhook_id, event, payload, response_status, response_body, duration_ms, success, status)
            VALUES (?, ?, 'response.created', ?, 200, ?, 12, 1, 'success')
        ")->execute([
            'whd-' . bin2hex(random_bytes(12)), $this->webhookId,
            json_encode(['answers' => ['name' => self::SECRET]]), self::SECRET,
        ]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->ownerId, $this->adminId, $this->plainId] as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM webhooks WHERE user_id = ?')->execute([$uid]); // deliveries cascade
            $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $owned->execute([$uid]);
            foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
                self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            }
            self::$pdo->prepare('DELETE FROM flow_run_logs WHERE flow_definition_id IN (SELECT id FROM flow_definitions WHERE owner_user_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM form_versions WHERE form_id IN (SELECT id FROM forms WHERE user_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private function makeUser(bool $isAdmin): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'T', ?)")
            ->execute([$id, $id . '@test.local', $isAdmin ? 1 : 0]);
        return $id;
    }

    private function tokenFor(string $userId): string
    {
        $stmt = self::$pdo->prepare('SELECT email FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $iat = time();
        return JWT::encode([
            'iss' => 'formlogic', 'aud' => 'formlogic-api', 'sub' => $userId,
            'email' => (string) $stmt->fetchColumn(),
            'iat' => $iat, 'nbf' => $iat, 'exp' => $iat + 3600, 'tv' => 0,
        ], self::JWT_SECRET, 'HS256');
    }

    private function send(string $method, string $path, ?array $body = null, ?string $token = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $request = $request->withParsedBody($body);
        }
        if ($token !== null) {
            $request = $request->withHeader('Authorization', 'Bearer ' . $token);
        }
        return self::$slim->handle($request);
    }

    private function json(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    private function body(ResponseInterface $response): string
    {
        $response->getBody()->rewind();
        return (string) $response->getBody();
    }

    /** Fill an allowlist pattern's placeholders with this test's fixture ids. */
    private function actingPath(string $pattern, ?string $ownerId = null): string
    {
        $inAppUserScope = str_contains($pattern, '{appId}');
        return '/api/admin/users/' . ($ownerId ?? $this->ownerId) . strtr($pattern, [
            '{appId}' => $this->appId,
            '{formId}' => $this->formId,
            '{flowId}' => str_starts_with($pattern, '/apps') ? $this->appFlowId : $this->wsFlowId,
            '{webhookId}' => $this->webhookId,
            '{runId}' => $this->runId,
            '{version}' => '1',
            '{bindingId}' => 'missing-binding',
            '{domainId}' => 'missing-domain',
            '{roleId}' => 'missing-role',
            '{memberId}' => 'missing-member',
            '{id}' => str_starts_with($pattern, '/forms')
                ? $this->formId
                : ($inAppUserScope ? 'missing-id' : $this->appId),
        ]);
    }

    // ── 1. the swap ──────────────────────────────────────────────────────────

    public function testActingAsSwapsEffectiveUserToTheOwner(): void
    {
        $admin = $this->tokenFor($this->adminId);

        $forms = $this->json($this->send('GET', "/api/admin/users/{$this->ownerId}/forms", null, $admin));
        $this->assertStringContainsString('Owner Contact Form', json_encode($forms), 'admin must see the OWNER\'s form list');

        $apps = $this->json($this->send('GET', "/api/admin/users/{$this->ownerId}/apps", null, $admin));
        $this->assertStringContainsString('Owner Helpdesk', json_encode($apps));

        // The admin's own (empty) world is NOT what the mirror serves.
        $this->assertStringNotContainsString($this->adminId, json_encode($forms));
    }

    public function testActingAsUnknownOwnerIs404(): void
    {
        $res = $this->send('GET', '/api/admin/users/no-such-user/forms', null, $this->tokenFor($this->adminId));
        $this->assertSame(404, $res->getStatusCode());
    }

    public function testOwnershipMismatchIs404(): void
    {
        // plainId's form is NOT reachable through ownerId's mirror — the URL
        // ownerId doubles as the consistency check via the owner-path 404.
        $foreign = self::$forms->createForm(['title' => 'Not Yours', 'userId' => $this->plainId, 'fields' => []]);
        $res = $this->send(
            'GET',
            "/api/admin/users/{$this->ownerId}/forms/{$foreign['id']}",
            null,
            $this->tokenFor($this->adminId)
        );
        $this->assertSame(404, $res->getStatusCode());
    }

    // ── 2. default-deny ──────────────────────────────────────────────────────

    public function testEveryMirrorRouteRejectsNonAdminsAndAnonymous(): void
    {
        $plain = $this->tokenFor($this->plainId);
        foreach (AdminActingAsRoutes::ROUTES as $row) {
            [$method, $pattern] = $row;
            $path = $this->actingPath($pattern);

            $anon = $this->send($method, $path);
            $this->assertSame(401, $anon->getStatusCode(), "anonymous {$method} {$pattern} must be 401");

            $denied = $this->send($method, $path, [], $plain);
            $this->assertSame(403, $denied->getStatusCode(), "non-admin {$method} {$pattern} must be 403");
        }
    }

    public function testMirrorAllowlistNeverContainsDataPatterns(): void
    {
        // The table is the boundary: a record-data-shaped route may never be
        // added. (Deliberately broad — 'reports' also catches run/run-batch.)
        $forbidden = '/responses|export|files|lookup|analytics|reports|script|claim|queued|flow-kv|api-key|mcp|oauth/i';
        foreach (AdminActingAsRoutes::ROUTES as $row) {
            $this->assertDoesNotMatchRegularExpression(
                $forbidden,
                $row[1],
                "allowlist entry {$row[1]} matches a record-data pattern — this must never happen"
            );
        }
    }

    // ── 3. the no-response-data boundary ─────────────────────────────────────

    public function testNoGetRouteRevealsThePlantedSecret(): void
    {
        // Sanity: the secret IS there on the owner surfaces this test mirrors.
        $ownerSees = json_encode(self::$responses->getFormResponses($this->formId));
        $this->assertStringContainsString(self::SECRET, $ownerSees, 'fixture must actually contain the secret');
        $rawRun = self::$pdo->query("SELECT input_snapshot_json FROM flow_run_logs WHERE id = '{$this->runId}'")->fetchColumn();
        $this->assertStringContainsString(self::SECRET, (string) $rawRun);

        $admin = $this->tokenFor($this->adminId);
        $mustSucceed = ['/forms', '/apps', '/forms/{id}', '/apps/{id}', '/apps/{id}/forms',
            '/apps/{id}/flows', '/flows', '/flow-runs', '/apps/{id}/flow-runs',
            '/forms/{id}/webhooks', '/forms/{id}/webhooks/{webhookId}/deliveries'];

        foreach (AdminActingAsRoutes::ROUTES as $row) {
            [$method, $pattern] = $row;
            if ($method !== 'GET') {
                continue;
            }
            $res = $this->send('GET', $this->actingPath($pattern), null, $admin);
            $this->assertLessThan(500, $res->getStatusCode(), "GET {$pattern} must not error");
            if (in_array($pattern, $mustSucceed, true)) {
                $this->assertSame(200, $res->getStatusCode(), "GET {$pattern} should serve real fixture data");
            }
            $this->assertStringNotContainsString(
                self::SECRET,
                $this->body($res),
                "GET {$pattern} leaked record data to an administrator"
            );
        }
    }

    public function testFlowRunPayloadsAreRedactedToMetadata(): void
    {
        $admin = $this->tokenFor($this->adminId);

        $list = $this->json($this->send('GET', "/api/admin/users/{$this->ownerId}/flow-runs", null, $admin));
        $mine = array_values(array_filter($list['runs'] ?? [], fn ($r) => ($r['runId'] ?? '') === $this->runId));
        $this->assertCount(1, $mine, 'the planted run must be listed');
        $run = $mine[0];
        $this->assertSame('running', $run['status']);
        $this->assertTrue($run['hasError']);
        $this->assertTrue($run['redacted']);
        foreach (['inputSnapshot', 'result', 'outputActions', 'error'] as $field) {
            $this->assertArrayNotHasKey($field, $run, "redacted runs must not carry {$field}");
        }

        // Completing a run through the mirror echoes the run — REDACTED, so
        // PATCHing a real user run can never read its snapshot back.
        $done = $this->send('PATCH', "/api/admin/users/{$this->ownerId}/flow-runs/{$this->runId}", [
            'status' => 'done',
            'result' => ['note' => 'admin test run'],
        ], $admin);
        $this->assertSame(200, $done->getStatusCode(), $this->body($done));
        $echo = $this->json($done)['run'] ?? [];
        $this->assertTrue($echo['redacted'] ?? false);
        $this->assertArrayNotHasKey('inputSnapshot', $echo);
        $this->assertStringNotContainsString(self::SECRET, $this->body($done));
    }

    // ── 4. owner parity + audit ──────────────────────────────────────────────

    public function testOnBehalfWriteRoundTripIsAuditedWithTrueActor(): void
    {
        $admin = $this->tokenFor($this->adminId);
        $res = $this->send('PUT', "/api/admin/users/{$this->ownerId}/forms/{$this->formId}", [
            'title' => 'Renamed By Platform Admin',
        ], $admin);
        $this->assertSame(200, $res->getStatusCode(), $this->body($res));

        // The owner really sees the change.
        $form = self::$forms->getForm($this->formId);
        $this->assertSame('Renamed By Platform Admin', $form['title'] ?? null);

        // Wrapper audit: admin.on_behalf attributed to the ADMIN, body KEYS only.
        $stmt = self::$pdo->prepare("SELECT details FROM audit_log WHERE action = 'admin.on_behalf' AND user_id = ? AND resource_id = ?");
        $stmt->execute([$this->adminId, $this->ownerId]);
        $wrappers = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $this->assertNotEmpty($wrappers, 'every on-behalf mutation must journal admin.on_behalf');
        $details = json_decode((string) end($wrappers), true);
        $this->assertContains('title', $details['bodyKeys'] ?? []);
        $this->assertStringNotContainsString('Renamed By Platform Admin', (string) end($wrappers), 'audit must carry body keys, never values');

        // Native event: attributed to the admin with onBehalfOf = the owner.
        $stmt = self::$pdo->prepare("SELECT details FROM audit_log WHERE user_id = ? AND action LIKE 'form.%' AND resource_id = ?");
        $stmt->execute([$this->adminId, $this->formId]);
        $native = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $this->assertNotEmpty($native, 'the native form.* event must name the admin as actor');
        $this->assertStringContainsString($this->ownerId, (string) end($native), 'native event must record onBehalfOf');
    }

    public function testActingAsDemoOwnerIsReadOnly(): void
    {
        $demoEmail = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        $stmt = self::$pdo->prepare('SELECT id FROM users WHERE email = ?');
        $stmt->execute([$demoEmail]);
        $demoId = $stmt->fetchColumn();
        $created = false;
        if ($demoId === false) {
            $demoId = 'u-' . bin2hex(random_bytes(12));
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Demo')")
                ->execute([$demoId, $demoEmail]);
            $created = true;
        }
        try {
            $admin = $this->tokenFor($this->adminId);

            // Reads pass (structure oversight is fine)…
            $read = $this->send('GET', "/api/admin/users/{$demoId}/forms", null, $admin);
            $this->assertSame(200, $read->getStatusCode());

            // …mutations are refused: the shared demo account is provisioning-managed.
            $write = $this->send('PUT', "/api/admin/users/{$demoId}/forms/whatever", ['title' => 'x'], $admin);
            $this->assertSame(403, $write->getStatusCode());
            $this->assertSame('demo_readonly', $this->json($write)['code'] ?? null);
        } finally {
            if ($created) {
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([(string) $demoId]);
            }
        }
    }
}
