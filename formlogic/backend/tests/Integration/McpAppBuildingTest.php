<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\McpController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppReportService;
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
 * End-to-end "an external AI builds a whole app over MCP" story + the app-building guarantees
 * behind it: create_app (incl. the validated appKind audience tag), create_app_form ×2 with a
 * linked_record relation between them, update_form, create_report, set_app_home with a WIDGET
 * DASHBOARD (sanitized through AppReportService exactly like the normal app save path), form
 * SECTION dashboards (sanitized on both the create and update paths), publish/unpublish via
 * update_app{status}, list_apps/list_forms visibility, and app-scope confinement.
 *
 * Skipped without a test DB (same setup as the other Integration suites).
 */
class McpAppBuildingTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static McpTokenService $tokens;
    private static AppService $apps;
    private static FormService $forms;
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-mcp-build-test-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        $responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$tokens = new McpTokenService($conn);
        self::$ctrl = new McpController(self::$tokens, self::$forms, self::$apps, $responses, null, null, new AppReportService(self::$apps, self::$forms));
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

    // ── helpers (same harness as McpTest) ──

    private function makeApp(): string
    {
        $id = 'app-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Test App', ?, 'published')")
            ->execute([$id, $this->userId, 'mcpb-' . bin2hex(random_bytes(5))]);
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

    /** A report widget for dashboard payloads. */
    private function reportWidget(string $formId, array $layout = ['x' => 0, 'y' => 0, 'w' => 6, 'h' => 3], array $spec = []): array
    {
        return [
            'kind' => 'report',
            'title' => 'Chart',
            'layout' => $layout,
            'spec' => array_merge(['formId' => $formId, 'viz' => 'kpi', 'measure' => ['fn' => 'count']], $spec),
        ];
    }

    // ── the full build story (what "hand an app to an AI" must support) ──

    public function testFullAppBuildStory(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 900, null, true)['token'];

        // 1. create_app with the optional audience tag + description (both persist).
        $made = $this->tool($tok, 'create_app', ['name' => 'Dispatch HQ', 'description' => 'Job dispatch for field staff', 'appKind' => 'staff']);
        $this->assertFalse($made['isError'], $made['text']);
        $appId = $made['data']['id'] ?? '';
        $this->assertNotSame('', $appId);
        $this->assertSame('Job dispatch for field staff', $made['data']['description'] ?? null);
        $this->assertSame('staff', $made['data']['settings']['appKind'] ?? null, 'create_app must accept + persist a valid appKind');

        // 2. Two forms via create_app_form — the second linked_record-related to the first.
        $customer = $this->tool($tok, 'create_app_form', ['appId' => $appId, 'title' => 'Customer', 'fields' => [
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true],
            ['id' => 'tier', 'type' => 'dropdown', 'label' => 'Tier', 'required' => false, 'properties' => ['options' => [
                ['id' => 'std', 'label' => 'Standard', 'value' => 'std'], ['id' => 'vip', 'label' => 'VIP', 'value' => 'vip'],
            ]]],
        ]]);
        $this->assertFalse($customer['isError'], $customer['text']);
        $customerId = $customer['data']['form']['id'] ?? '';
        $this->assertNotSame('', $customerId);
        $this->assertTrue(self::$apps->formBelongsToApp($appId, $customerId), 'create_app_form must attach the form');

        $job = $this->tool($tok, 'create_app_form', ['appId' => $appId, 'title' => 'Job', 'fields' => [
            ['id' => 'title', 'type' => 'short_text', 'label' => 'Title', 'required' => true],
            ['id' => 'status', 'type' => 'dropdown', 'label' => 'Status', 'required' => false, 'properties' => ['options' => [
                ['id' => 'open', 'label' => 'Open', 'value' => 'open'], ['id' => 'done', 'label' => 'Done', 'value' => 'done'],
            ]]],
            ['id' => 'customer', 'type' => 'linked_record', 'label' => 'Customer', 'required' => false, 'properties' => ['targetFormId' => $customerId]],
        ]]);
        $this->assertFalse($job['isError'], $job['text']);
        $jobId = $job['data']['form']['id'] ?? '';
        $this->assertNotSame('', $jobId);
        $this->assertTrue(self::$apps->formBelongsToApp($appId, $jobId));

        // 3. get_form: fields round-trip, incl. the linked_record relation.
        $fetched = $this->tool($tok, 'get_form', ['formId' => $jobId]);
        $this->assertFalse($fetched['isError'], $fetched['text']);
        $fields = [];
        foreach (($fetched['data']['fields'] ?? []) as $f) {
            $fields[$f['id']] = $f;
        }
        $this->assertCount(3, $fields);
        $this->assertSame('linked_record', $fields['customer']['type'] ?? null);
        $this->assertSame($customerId, $fields['customer']['properties']['targetFormId'] ?? null, 'linked_record target must persist');

        // 4. update_form: rename + give the JOB form a SECTION widget dashboard. Its specs may
        //    reference the form itself AND its linked_record target (formFieldMap semantics).
        $upd = $this->tool($tok, 'update_form', ['formId' => $jobId, 'title' => 'Job Ticket', 'customScreen' => [
            'kind' => 'dashboard',
            'dashboard' => ['cols' => 12, 'widgets' => [
                $this->reportWidget($jobId, ['x' => 0, 'y' => 0, 'w' => 6, 'h' => 3], ['viz' => 'bar', 'groupBy' => ['field' => 'status']]),
                $this->reportWidget($customerId, ['x' => 6, 'y' => 0, 'w' => 6, 'h' => 2]), // linked target: allowed
            ]],
        ]]);
        $this->assertFalse($upd['isError'], $upd['text']);
        $this->assertSame('Job Ticket', $upd['data']['title'] ?? null);
        $sectionWidgets = $upd['data']['customScreen']['dashboard']['widgets'] ?? [];
        $this->assertCount(2, $sectionWidgets, 'own-form + linked-target widgets must both survive sanitize');
        $this->assertSame('status', $sectionWidgets[0]['spec']['groupBy']['field'] ?? null);

        // 5. create_report persists in the app's Reports section.
        $rep = $this->tool($tok, 'create_report', ['appId' => $appId, 'name' => 'Jobs by status', 'spec' => [
            'formId' => $jobId, 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
        ]]);
        $this->assertFalse($rep['isError'], $rep['text']);
        $this->assertNotSame('', $rep['data']['id'] ?? '');
        $this->assertCount(1, self::$apps->getApp($appId)['reports'] ?? []);

        // 6. set_app_home accepts a WIDGET DASHBOARD (the primary home-screen kind) and persists it.
        $home = $this->tool($tok, 'set_app_home', ['appId' => $appId, 'customScreen' => [
            'kind' => 'dashboard',
            'dashboard' => ['cols' => 12, 'widgets' => [
                $this->reportWidget($jobId, ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2]),
                ['kind' => 'actions', 'layout' => ['x' => 0, 'y' => 2, 'w' => 12, 'h' => 1], 'title' => 'Quick actions'],
                ['kind' => 'list', 'layout' => ['x' => 0, 'y' => 3, 'w' => 6, 'h' => 3], 'title' => 'Customers',
                    'list' => ['formId' => $customerId, 'limit' => 5, 'titleField' => 'name', 'subtitleField' => 'tier']],
                ['kind' => 'text', 'layout' => ['x' => 6, 'y' => 3, 'w' => 6, 'h' => 2], 'text' => ['body' => 'Welcome to Dispatch HQ']],
            ]],
        ]]);
        $this->assertFalse($home['isError'], $home['text']);
        $saved = self::$apps->getApp($appId)['customScreen'] ?? [];
        $this->assertSame('dashboard', $saved['kind'] ?? null);
        $widgets = $saved['dashboard']['widgets'] ?? [];
        $this->assertCount(4, $widgets, 'all four widget kinds must persist');
        $this->assertSame($jobId, $widgets[0]['spec']['formId'] ?? null);
        $this->assertSame('name', $widgets[2]['list']['titleField'] ?? null);

        // 7. Visibility: the creator token sees its app and BOTH forms (and nothing else).
        $apps = $this->tool($tok, 'list_apps')['data'];
        $this->assertCount(1, $apps);
        $this->assertSame($appId, $apps[0]['id']);
        $formIds = array_column($this->tool($tok, 'list_forms')['data'], 'id');
        sort($formIds);
        $expected = [$customerId, $jobId];
        sort($expected);
        $this->assertSame($expected, $formIds);

        // 8. Publish, then unpublish, via update_app{status}.
        $pub = $this->tool($tok, 'update_app', ['appId' => $appId, 'status' => 'published']);
        $this->assertFalse($pub['isError'], $pub['text']);
        $this->assertSame('published', $pub['data']['status'] ?? null);
        $unpub = $this->tool($tok, 'update_app', ['appId' => $appId, 'status' => 'draft']);
        $this->assertFalse($unpub['isError'], $unpub['text']);
        $this->assertSame('draft', $unpub['data']['status'] ?? null);
    }

    // ── create_app appKind validation ──

    public function testCreateAppRejectsInvalidAppKind(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 900, null, true)['token'];
        $res = $this->tool($tok, 'create_app', ['name' => 'X', 'appKind' => 'overlord']);
        $this->assertTrue($res['isError'], 'an invalid appKind must be a clear error, not a silent drop');
        $this->assertStringContainsString('appKind', $res['text']);
        $this->assertStringContainsString('staff', $res['text'], 'the error should list the valid kinds');
    }

    // ── set_app_home dashboard sanitize (the same save boundary as AppController::update) ──

    public function testSetAppHomeDashboardSanitizedAgainstApp(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'set_app_home', ['appId' => $this->appA, 'customScreen' => [
            'kind' => 'dashboard',
            'dashboard' => ['cols' => 12, 'widgets' => [
                $this->reportWidget($this->formA, ['x' => 0, 'y' => 0, 'w' => 99, 'h' => 3]), // w clamped to cols
                $this->reportWidget($this->formB), // formB is NOT in appA → widget dropped
                ['kind' => 'bogus', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2]], // unknown kind → dropped
            ]],
        ]]);
        $this->assertFalse($res['isError'], $res['text']);
        $saved = self::$apps->getApp($this->appA)['customScreen']['dashboard'] ?? [];
        $widgets = $saved['widgets'] ?? [];
        $this->assertCount(1, $widgets, 'foreign-form and unknown-kind widgets must be dropped on save');
        $this->assertSame($this->formA, $widgets[0]['spec']['formId'] ?? null);
        $this->assertSame(12, $widgets[0]['layout']['w'] ?? null, 'layout must be clamped by the sanitizer');
    }

    public function testSetAppHomeRejectsUnknownScreenKeys(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'set_app_home', ['appId' => $this->appA, 'customScreen' => [
            'kind' => 'dashboard', 'dashboard' => ['widgets' => []], 'widgets' => [], // 'widgets' belongs INSIDE dashboard
        ]]);
        $this->assertTrue($res['isError'], 'a mis-shaped customScreen should be a clear error for the AI');
        $this->assertStringContainsString('widgets', $res['text']);
    }

    // ── form SECTION dashboards are sanitized on BOTH the create and update paths ──

    public function testSectionDashboardSanitizedOnCreateAndUpdate(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];

        // Create path: a text widget survives; a report widget on a foreign form is dropped.
        $made = $this->tool($tok, 'create_app_form', ['title' => 'Log', 'fields' => [
            ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false],
        ], 'customScreen' => [
            'kind' => 'dashboard',
            'dashboard' => ['widgets' => [
                ['kind' => 'text', 'layout' => ['x' => 0, 'y' => 0, 'w' => 12, 'h' => 1], 'text' => ['body' => 'Shift log']],
                $this->reportWidget($this->formB), // not this form / not a linked target → dropped
            ]],
        ]]);
        $this->assertFalse($made['isError'], $made['text']);
        $newId = $made['data']['form']['id'] ?? '';
        $this->assertNotSame('', $newId);
        $widgets = $made['data']['form']['customScreen']['dashboard']['widgets'] ?? [];
        $this->assertCount(1, $widgets, 'create_app_form must sanitize a section dashboard before it persists');
        $this->assertSame('text', $widgets[0]['kind'] ?? null);

        // Update path: an own-form widget survives; the foreign one is dropped.
        $upd = $this->tool($tok, 'update_form', ['formId' => $newId, 'customScreen' => [
            'kind' => 'dashboard',
            'dashboard' => ['widgets' => [
                $this->reportWidget($newId),
                $this->reportWidget($this->formB),
            ]],
        ]]);
        $this->assertFalse($upd['isError'], $upd['text']);
        $widgets = $upd['data']['customScreen']['dashboard']['widgets'] ?? [];
        $this->assertCount(1, $widgets, 'update_form must sanitize a section dashboard');
        $this->assertSame($newId, $widgets[0]['spec']['formId'] ?? null);
    }

    // ── confinement: an app-scoped token can NEVER create apps ──

    public function testAppScopedTokenCreateAppHiddenAndRefused(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertNotContains('create_app', $this->toolNames($tok), 'create_app must be hidden from tools/list');
        $res = $this->tool($tok, 'create_app', ['name' => 'Sneaky']);
        $this->assertTrue($res['isError'], 'create_app must be refused for an app-scoped token');
    }

    // ── the embedded guide keeps up with the shipped surface ──

    public function testGuideDocumentsDashboardsAndAppKind(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $init = $this->rpc($tok, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize']);
        $this->assertStringContainsString('dashboard', $init['result']['instructions'] ?? '', 'initialize.instructions must teach widget dashboards');

        $guide = $this->tool($tok, 'get_started');
        $this->assertFalse($guide['isError']);
        $this->assertStringContainsString('"kind":"dashboard"', str_replace(' ', '', $guide['text']), 'the guide must show a dashboard customScreen');
        $this->assertStringContainsString('appKind', $guide['text'], 'the guide must mention the appKind tag');
        $this->assertStringContainsString('widgets', $guide['text']);
    }
}
