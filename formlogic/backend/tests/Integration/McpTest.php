<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\McpController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AuditService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\PlanService;
use FormLogic\Services\RateLimiter;
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
    private static AppReportService $reportValidator;
    private static DesktopCommandService $desktopCommands;
    private static FormService $forms;
    private static ResponseService $responses;

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
        self::$forms = $forms;
        self::$responses = $responses;
        self::$reportValidator = new AppReportService(self::$apps, $forms);
        self::$desktopCommands = new DesktopCommandService($conn);
        self::$ctrl = new McpController(self::$tokens, $forms, self::$apps, $responses, null, null, self::$reportValidator, self::$desktopCommands, null, null, null, new FlowService($conn));
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
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$this->userId]);
        // Clean children for EVERY app the user owns (incl. apps a creator token made during a test).
        $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $owned->execute([$this->userId]);
        foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$aid]);
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

    private function rpc(string $token, array $payload, ?McpController $ctrl = null): array
    {
        $stream = (new StreamFactory())->createStream(json_encode($payload));
        $req = (new ServerRequestFactory())->createServerRequest('POST', '/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody($stream);
        $resp = ($ctrl ?? self::$ctrl)->handle($req, (new ResponseFactory())->createResponse());
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** Returns ['isError'=>bool, 'data'=>mixed, 'text'=>string]. */
    private function tool(string $token, string $name, array $args = [], ?McpController $ctrl = null): array
    {
        $r = $this->rpc($token, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => ['name' => $name, 'arguments' => $args]], $ctrl);
        $txt = $r['result']['content'][0]['text'] ?? '';
        return ['isError' => $r['result']['isError'] ?? false, 'data' => json_decode($txt, true), 'text' => $txt];
    }

    /** A batch RPC: raw messages array (each { jsonrpc, id, method, params }), returned as the raw
     *  JSON-RPC response array (list of results, one per message with a non-null id). */
    private function batch(string $token, array $messages, ?McpController $ctrl = null): array
    {
        $stream = (new StreamFactory())->createStream(json_encode($messages));
        $req = (new ServerRequestFactory())->createServerRequest('POST', '/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody($stream);
        $resp = ($ctrl ?? self::$ctrl)->handle($req, (new ResponseFactory())->createResponse());
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** A connector_command tools/call batch message. */
    private function connectorCommandMessage(int $id, int $waitMs): array
    {
        return ['jsonrpc' => '2.0', 'id' => $id, 'method' => 'tools/call', 'params' => [
            'name' => 'connector_command',
            'arguments' => ['connectorId' => 'aokie', 'command' => 'call.hangup', 'waitMs' => $waitMs],
        ]];
    }

    /** A fresh McpController sharing the same real services/DB as self::$ctrl, but with its own
     *  RateLimiter / connector-batch ceiling / PlanService override — for tests that need to isolate
     *  those from the shared self::$ctrl used everywhere else. */
    private function makeCtrl(?RateLimiter $rateLimiter, ?int $connectorBatchCeilingMs = null, ?PlanService $planService = null): McpController
    {
        return new McpController(
            self::$tokens,
            self::$forms,
            self::$apps,
            self::$responses,
            null,
            null,
            self::$reportValidator,
            self::$desktopCommands,
            $rateLimiter,
            $connectorBatchCeilingMs,
            $planService
        );
    }

    private function toolNames(string $token): array
    {
        $r = $this->rpc($token, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']);
        return array_map(static fn ($t) => $t['name'], $r['result']['tools'] ?? []);
    }

    /** A fresh McpController sharing the same real services/DB as self::$ctrl, but wired to a REAL
     *  AuditService (self::$ctrl's is null) — for tests that assert an audit row was actually written. */
    private function makeAuditedCtrl(AuditService $audit, ?FormService $forms = null): McpController
    {
        return new McpController(
            self::$tokens,
            $forms ?? self::$forms,
            self::$apps,
            self::$responses,
            $audit,
            null,
            self::$reportValidator,
            self::$desktopCommands
        );
    }

    /** Latest audit_log row for this test's user + action, decoded, or null if none exists. */
    private function latestAuditRow(string $action): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM audit_log WHERE user_id = ? AND action = ? ORDER BY sequence_number DESC LIMIT 1');
        $stmt->execute([$this->userId, $action]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    /** Count of this test's user's audit_log rows across the given actions. */
    private function countAuditRows(array $actions): int
    {
        $placeholders = implode(',', array_fill(0, count($actions), '?'));
        $stmt = self::$pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE user_id = ? AND action IN ({$placeholders})");
        $stmt->execute(array_merge([$this->userId], $actions));
        return (int) $stmt->fetchColumn();
    }

    // ── connector_command: an AI drives the linked desktop's connectors through the relay ──

    public function testConnectorCommandIsScopeGatedAndEnqueuesForTheOwnersDesktop(): void
    {
        // Without connector:command the tool is neither listed nor callable.
        $plain = self::$tokens->create($this->userId)['token'];
        $this->assertNotContains('connector_command', $this->toolNames($plain));
        $denied = $this->tool($plain, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup']);
        $this->assertTrue($denied['isError']);
        $this->assertStringContainsString('scope', strtolower($denied['text']));

        // With the scope it's listed, and calling it queues a command for the owner's desktop. Nothing
        // claims it in-test, so waitMs=0 returns immediately: status=pending + an actionable note.
        $tok = self::$tokens->create($this->userId, null, 3600, 3600, ['connector:command'])['token'];
        $this->assertContains('connector_command', $this->toolNames($tok));
        $r = $this->tool($tok, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup', 'payload' => ['reason' => 'x'], 'waitMs' => 0]);
        $this->assertFalse($r['isError'], $r['text']);
        $this->assertSame('pending', $r['data']['status']);
        $this->assertNotEmpty($r['data']['commandId']);
        $this->assertArrayHasKey('note', $r['data']);
        // No desktop is polling in-test → reported offline, and the command says so.
        $this->assertFalse($r['data']['desktopOnline']);
        $this->assertStringContainsStringIgnoringCase('online', $r['data']['note']);

        // desktop_status is scope-gated too, and reports offline (nothing has polled the relay).
        $this->assertContains('desktop_status', $this->toolNames($tok));
        $this->assertNotContains('desktop_status', $this->toolNames($plain));
        $st = $this->tool($tok, 'desktop_status');
        $this->assertFalse($st['isError'], $st['text']);
        $this->assertFalse($st['data']['online']);
        $this->assertNull($st['data']['lastSeenSecondsAgo']);

        // The queued row is real, owner-scoped, and carries the connector + command.
        $stmt = self::$pdo->prepare('SELECT owner_user_id, connector_id, command, status FROM desktop_commands WHERE id = ?');
        $stmt->execute([$r['data']['commandId']]);
        $cmd = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame($this->userId, $cmd['owner_user_id']);
        $this->assertSame('aokie', $cmd['connector_id']);
        $this->assertSame('call.hangup', $cmd['command']);
        $this->assertSame('pending', $cmd['status']);
    }

    public function testConnectorCommandCannotRelayPrivateAokieRealtimeOrBootstrapCommands(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 3600, ['connector:command'])['token'];
        $commands = [
            'remote.bootstrap',
            'call.remoteStatus',
            'call.assistance.respond',
            'call.takeOver',
            'call.resumeBot',
            'call.endCaller',
            'call.declineWaiting',
        ];

        foreach ($commands as $command) {
            $r = $this->tool($tok, 'connector_command', [
                'connectorId' => 'aokie',
                'command' => $command,
                'waitMs' => 0,
            ]);
            $this->assertTrue($r['isError'], $command);
            $this->assertStringContainsStringIgnoringCase('private', $r['text'], $command);
        }

        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id = ?');
        $stmt->execute([$this->userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn());
    }

    // ── connector_command batch DoS fix: one shared wall-clock deadline across a whole batch ──

    /**
     * A single connector_command call — whether it's the only message in a JSON-RPC batch, or not a
     * batch at all — must behave EXACTLY as it did before the batch-deadline plumbing: it blocks for
     * its own full requested wait (no clamping), since the shared-deadline math only ever engages from
     * the 2nd connector_command call in a request onward. No desktop ever claims it in-test, so the
     * poll loop runs for its whole window (proving it actually waited, not just returned instantly).
     */
    public function testSoleConnectorCommandCallGetsItsFullRequestedWaitUnclamped(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 3600, ['connector:command'])['token'];

        // (a) As the ONLY message in a batch (array_is_list branch, count === 1).
        $start = microtime(true);
        $out = $this->batch($tok, [$this->connectorCommandMessage(1, 900)]);
        $elapsed = microtime(true) - $start;
        $data = json_decode($out[0]['result']['content'][0]['text'] ?? '', true);
        $this->assertSame('pending', $data['status'] ?? null, (string) json_encode($out));
        $this->assertGreaterThanOrEqual(0.7, $elapsed, 'a solo batched call must wait close to its full requested 900ms, not be clamped down');
        $this->assertLessThan(2.5, $elapsed, 'sanity: should not run far longer than its own requested wait');

        // (b) As a plain (non-batch) single JSON-RPC object — the everyday real-world shape.
        $start = microtime(true);
        $r = $this->tool($tok, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup', 'waitMs' => 700]);
        $elapsed = microtime(true) - $start;
        $this->assertFalse($r['isError'], $r['text']);
        $this->assertSame('pending', $r['data']['status']);
        $this->assertGreaterThanOrEqual(0.55, $elapsed, 'a non-batch call must wait close to its full requested 700ms, not be clamped down');
        $this->assertLessThan(2.5, $elapsed);
    }

    /**
     * Multiple connector_command calls in the SAME batch share ONE wall-clock ceiling: the first call
     * gets its own full wait, but later calls are clamped to whatever remains of that shared ceiling —
     * so the batch's TOTAL blocking time stays capped at roughly one call's ceiling, never the sum of
     * every call's independently-requested wait (which is what let 20 calls tie up a worker for ~500s).
     * Uses a short, test-only ceiling override (production always uses the real 25000ms) so this proves
     * the real wired-up polling mechanism without an actual ~25s sleep.
     */
    public function testBatchedConnectorCommandCallsShareOneCappedDeadlineNotTheSum(): void
    {
        $ctrl = $this->makeCtrl(null, 1200); // 1200ms shared ceiling instead of the real 25000ms
        $tok = self::$tokens->create($this->userId, null, 3600, 3600, ['connector:command'])['token'];

        // 4 calls each requesting 1000ms — uncapped, they'd sum to ~4s+. Capped, the whole batch must
        // land close to the 1200ms shared ceiling.
        $messages = [
            $this->connectorCommandMessage(1, 1000),
            $this->connectorCommandMessage(2, 1000),
            $this->connectorCommandMessage(3, 1000),
            $this->connectorCommandMessage(4, 1000),
        ];
        $start = microtime(true);
        $out = $this->batch($tok, $messages, $ctrl);
        $elapsed = microtime(true) - $start;

        $this->assertCount(4, $out);
        foreach ($out as $r) {
            $data = json_decode($r['result']['content'][0]['text'] ?? '', true);
            $this->assertSame('pending', $data['status'] ?? null, (string) json_encode($r));
        }
        // The real bug: 4 x 1000ms independently would take ~4s+ (and 20 calls at 25s each ~500s).
        // Capped to one shared ~1200ms ceiling, the whole batch must land well under half of the
        // uncapped sum, and comfortably close to the ceiling rather than to 4x it.
        $this->assertLessThan(2.0, $elapsed, 'a batch of 4 connector_command calls must be capped near the shared ceiling, not their 4x sum');
        $this->assertGreaterThanOrEqual(0.9, $elapsed, 'the first call in the batch must still block for close to its own real wait');
    }

    /**
     * connector_command is gated by the SAME per-user 30-per-60s budget the web enqueue path
     * (POST /api/app/{slug}/connector-commands) already enforces via RateLimitMiddleware — applied
     * here directly since this MCP tool calls DesktopCommandService without going through that
     * middleware. Exceeding it rejects with a tool error (not an uncaught exception); other tools
     * (e.g. desktop_status) are completely unaffected.
     */
    public function testConnectorCommandRateLimitMirrorsTheWebBudgetAndDoesNotAffectOtherTools(): void
    {
        $rateLimiter = new RateLimiter(self::$mysql->getConnection());
        $ctrl = $this->makeCtrl($rateLimiter);
        $tok = self::$tokens->create($this->userId, null, 3600, 3600, ['connector:command'])['token'];

        // The limiter uses a 60s wall-clock-aligned fixed window; if this test's 31 sequential calls
        // straddled a window boundary, the counter would reset mid-test and the 31st call would land in
        // a fresh (under-budget) window instead of tripping the limit. Start just after a fresh window
        // begins so the whole sequence has ample margin.
        $secondsLeft = $rateLimiter->secondsUntilReset(60);
        if ($secondsLeft < 10) {
            usleep(($secondsLeft + 1) * 1000000);
        }

        // waitMs=0 so every call returns immediately (no polling) — this test is about the rate
        // limiter's counting, not the wait/deadline logic covered above.
        for ($i = 1; $i <= 30; $i++) {
            $r = $this->tool($tok, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup', 'waitMs' => 0], $ctrl);
            $this->assertFalse($r['isError'], "call #{$i} should be within the 30/60s budget: {$r['text']}");
        }
        // The 31st call in the same 60s window exceeds the budget and is rejected as a tool error.
        $r31 = $this->tool($tok, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup', 'waitMs' => 0], $ctrl);
        $this->assertTrue($r31['isError']);
        $this->assertStringContainsStringIgnoringCase('too many', $r31['text']);

        // A completely different tool call (same session, same rate-limited controller) is unaffected —
        // the budget is scoped to connector_command only.
        $st = $this->tool($tok, 'desktop_status', [], $ctrl);
        $this->assertFalse($st['isError'], $st['text']);
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
        // The customScreen cap is 2MB (raised for data:-URI image assets) — 2.2MB must still refuse.
        $this->assertTrue($this->tool($tok, 'create_form', ['title' => 'Big', 'customScreen' => ['enabled' => true, 'html' => str_repeat('y', 2200000)]])['isError'], 'oversized customScreen rejected');
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

    // ── reports (charts + PDF documents) ──

    public function testReportToolsListedForAppScopedToken(): void
    {
        $names = $this->toolNames(self::$tokens->create($this->userId, $this->appA)['token']);
        $this->assertContains('create_report', $names);
        $this->assertContains('create_document', $names);
    }

    public function testCreateReportAddsChartAndPersists(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_report', [
            'appId' => $this->appA, 'name' => 'By status',
            'spec' => ['formId' => $this->formA, 'viz' => 'bar', 'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count']],
        ]);
        $this->assertFalse($res['isError'], $res['text']);
        $this->assertNotSame('', $res['data']['id'] ?? '');
        $reports = self::$apps->getApp($this->appA)['reports'] ?? [];
        $this->assertCount(1, $reports);
        $this->assertSame('By status', $reports[0]['name']);
        $this->assertSame('builder', $reports[0]['type']);
    }

    public function testCreateReportValidatesSpec(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertTrue($this->tool($tok, 'create_report', ['appId' => $this->appA, 'name' => 'X', 'spec' => ['viz' => 'bar']])['isError'], 'missing formId rejected');
        $this->assertTrue($this->tool($tok, 'create_report', ['appId' => $this->appA, 'name' => 'X', 'spec' => ['formId' => $this->formA, 'viz' => 'bogus']])['isError'], 'bad viz rejected');
    }

    public function testCreateReportAppScopeEnforced(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_report', ['appId' => $this->appB, 'name' => 'Sneak', 'spec' => ['formId' => $this->formB, 'viz' => 'kpi', 'measure' => ['fn' => 'count']]]);
        $this->assertTrue($res['isError'], 'creating a report on another app must be rejected');
    }

    public function testCreateReportRejectsFormOutsideApp(): void
    {
        // Account-wide creator token; create a fresh app, then try to base a report on a form NOT in it.
        $tok = self::$tokens->create($this->userId, null, 3600, 900, null, true)['token'];
        $newAppId = $this->tool($tok, 'create_app', ['name' => 'Reporty'])['data']['id'] ?? '';
        $this->assertNotSame('', $newAppId);
        $res = $this->tool($tok, 'create_report', ['appId' => $newAppId, 'name' => 'Foreign', 'spec' => ['formId' => $this->formA, 'viz' => 'kpi', 'measure' => ['fn' => 'count']]]);
        $this->assertTrue($res['isError'], 'a report whose base form is not in the app must be rejected');
        $this->assertStringContainsString('not part of this app', $res['text']);
    }

    public function testCreateDocumentReferencesExistingReports(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $chart = $this->tool($tok, 'create_report', ['appId' => $this->appA, 'name' => 'Chart', 'spec' => ['formId' => $this->formA, 'viz' => 'kpi', 'measure' => ['fn' => 'count']]]);
        $rid = $chart['data']['id'] ?? '';
        $this->assertNotSame('', $rid);
        // A document referencing an unknown report id is rejected.
        $bad = $this->tool($tok, 'create_document', ['appId' => $this->appA, 'name' => 'Doc', 'blocks' => [['kind' => 'report', 'reportId' => 'does-not-exist']]]);
        $this->assertTrue($bad['isError'], 'unknown reportId rejected');
        // Valid text + report blocks persist in order, referencing the chart.
        $doc = $this->tool($tok, 'create_document', ['appId' => $this->appA, 'name' => 'Doc', 'blocks' => [
            ['kind' => 'text', 'title' => 'Intro', 'body' => 'Hello'],
            ['kind' => 'report', 'reportId' => $rid, 'caption' => 'A KPI'],
        ]]);
        $this->assertFalse($doc['isError'], $doc['text']);
        $reports = self::$apps->getApp($this->appA)['reports'] ?? [];
        $document = array_values(array_filter($reports, static fn ($r) => ($r['type'] ?? '') === 'document'))[0] ?? null;
        $this->assertNotNull($document, 'document should be persisted');
        $this->assertCount(2, $document['blocks']);
        $this->assertSame($rid, $document['blocks'][1]['reportId']);
    }

    public function testCreateDocumentRequiresBlocks(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $this->assertTrue($this->tool($tok, 'create_document', ['appId' => $this->appA, 'name' => 'Empty', 'blocks' => []])['isError'], 'a document with no blocks is rejected');
    }

    // ── Tier-1 batch: form-count quota, exception leakage, per-user request rate limit, scope bug ──

    /**
     * create_form / create_app_form now enforce the SAME account form-count quota FormController's
     * checkFormQuota gates on the web create path — a mock PlanService reporting "over quota" rejects
     * both tools with a plan-limit message; the DEFAULT (no PlanService injected, self::$ctrl) behavior
     * — today's unconfigured/self-hosted default — must be completely unchanged (still succeeds).
     */
    public function testCreateFormAndCreateAppFormRejectedWhenPlanServiceReportsOverQuota(): void
    {
        $planService = $this->createMock(PlanService::class);
        $planService->method('canCreateForms')->willReturn(false);
        $planService->method('formLimit')->willReturn(5);
        $ctrl = $this->makeCtrl(null, null, $planService);
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];

        $res = $this->tool($tok, 'create_form', ['title' => 'Over quota'], $ctrl);
        $this->assertTrue($res['isError'], $res['text']);
        $this->assertStringContainsString('5 forms', $res['text']);

        $res2 = $this->tool($tok, 'create_app_form', ['title' => 'Over quota 2'], $ctrl);
        $this->assertTrue($res2['isError'], $res2['text']);
        $this->assertStringContainsString('5 forms', $res2['text']);
    }

    public function testCreateFormNotRejectedWhenPlanServiceIsNull(): void
    {
        // self::$ctrl carries no PlanService — today's default (self-hosted, no CLOUD_PLAN_ENFORCED)
        // — this must keep working exactly as before.
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_form', ['title' => 'No enforcement configured']);
        $this->assertFalse($res['isError'], $res['text']);
    }

    public function testCreateFormNotRejectedWhenPlanServiceReportsUnderQuota(): void
    {
        $planService = $this->createMock(PlanService::class);
        $planService->method('canCreateForms')->willReturn(true);
        $ctrl = $this->makeCtrl(null, null, $planService);
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];
        $res = $this->tool($tok, 'create_form', ['title' => 'Under quota'], $ctrl);
        $this->assertFalse($res['isError'], $res['text']);
    }

    /**
     * An unexpected non-\Exception \Throwable (a \TypeError from a called service) must return the
     * generic "unexpected error" message and never leak its original text — while a plain \Exception
     * (the file's established "safe to show the caller" convention, e.g. a validation failure) still
     * returns its own specific message exactly as before.
     */
    public function testUnexpectedThrowableIsGenericButPlainExceptionStillLeaksItsOwnSafeMessage(): void
    {
        $formService = $this->createMock(FormService::class);
        $formService->method('getAllForms')->willThrowException(new \TypeError('raw internal detail that must never reach the client'));
        $ctrl = new McpController(
            self::$tokens,
            $formService,
            self::$apps,
            self::$responses,
            null,
            null,
            self::$reportValidator,
            self::$desktopCommands
        );
        $tok = self::$tokens->create($this->userId)['token']; // account-wide token -> list_forms calls getAllForms()

        $res = $this->tool($tok, 'list_forms', [], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertSame('Error: an unexpected error occurred. Please try again.', $res['text']);
        $this->assertStringNotContainsString('raw internal detail', $res['text']);

        // A normal \Exception (validateFormInput rejects a malformed field before FormService is ever
        // touched) is unaffected: it still returns its own specific, safe message.
        $bad = $this->tool($tok, 'create_form', ['title' => 'X', 'fields' => ['not-an-object']], $ctrl);
        $this->assertTrue($bad['isError']);
        $this->assertStringContainsString('malformed', $bad['text']);
    }

    /**
     * /api/mcp's route-level rate limiter is IP-keyed (no session middleware runs first). Inside
     * McpController::handle(), a SEPARATE per-account 120-per-60s check now rejects once an
     * authenticated user's own budget is exhausted (a JSON-RPC error, before any dispatch work),
     * while normal usage well under the budget is completely unaffected.
     */
    public function testPerUserMcpRequestRateLimitRejectsOverBudgetAndAllowsNormalUsage(): void
    {
        $rateLimiter = new RateLimiter(self::$mysql->getConnection());
        $ctrl = $this->makeCtrl($rateLimiter);
        $tok = self::$tokens->create($this->userId)['token'];

        // Avoid straddling the limiter's 60s fixed window mid-test.
        $secondsLeft = $rateLimiter->secondsUntilReset(60);
        if ($secondsLeft < 15) {
            usleep(($secondsLeft + 1) * 1000000);
        }

        // Comfortably under budget: normal usage is unaffected.
        for ($i = 1; $i <= 5; $i++) {
            $r = $this->rpc($tok, ['jsonrpc' => '2.0', 'id' => $i, 'method' => 'ping'], $ctrl);
            $this->assertArrayNotHasKey('error', $r, "call #{$i} should succeed well within the 120/60s budget");
        }
        // Spend the rest of the budget up to the 120-request ceiling.
        for ($i = 6; $i <= 120; $i++) {
            $r = $this->rpc($tok, ['jsonrpc' => '2.0', 'id' => $i, 'method' => 'ping'], $ctrl);
            $this->assertArrayNotHasKey('error', $r, "call #{$i} should still be within the 120/60s budget");
        }
        // The 121st request in the same window exceeds the budget and is rejected before dispatch.
        $r121 = $this->rpc($tok, ['jsonrpc' => '2.0', 'id' => 121, 'method' => 'ping'], $ctrl);
        $this->assertSame(-32000, $r121['error']['code'] ?? null, (string) json_encode($r121));
        $this->assertStringContainsStringIgnoringCase('too many', $r121['error']['message'] ?? '');
    }

    /**
     * create_app_form's actual case in callTool() requires apps:write (on top of the forms:write it's
     * listed under) — so it must be HIDDEN from tools/list for a session that only has forms:write
     * (it would otherwise be advertised and then fail every real call with a confusing scope error),
     * and shown once the session has both scopes.
     */
    public function testCreateAppFormHiddenWithoutAppsWriteAndShownWithBothScopes(): void
    {
        $formsOnly = self::$tokens->create($this->userId, null, 3600, 900, ['forms:write'])['token'];
        $this->assertNotContains('create_app_form', $this->toolNames($formsOnly), 'create_app_form needs apps:write too — must be hidden without it');

        $both = self::$tokens->create($this->userId, null, 3600, 900, ['forms:write', 'apps:write'])['token'];
        $this->assertContains('create_app_form', $this->toolNames($both));
    }

    // ── denial/error auditing: scope/ownership denials and unexpected errors leave a queryable trail ──

    /**
     * A scope violation (requireScope) now throws McpDeniedException, which callTool()'s new catch
     * clause turns into an 'mcp.denied' audit row carrying the tool name + reason code 'scope' — while
     * the client-facing response text is byte-identical to the pre-fix plain-\Exception behavior.
     */
    public function testScopeViolationIsAuditedAsMcpDeniedWithReasonAndTool(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        $ctrl = $this->makeAuditedCtrl($audit);
        $tok = self::$tokens->create($this->userId)['token']; // no connector:command scope

        $res = $this->tool($tok, 'connector_command', ['connectorId' => 'aokie', 'command' => 'call.hangup'], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertSame(
            'Error: This MCP token lacks the required scope: connector:command',
            $res['text'],
            'client-facing response text must be byte-identical to before this fix'
        );

        $row = $this->latestAuditRow('mcp.denied');
        $this->assertNotNull($row, 'a scope violation must produce an mcp.denied audit row');
        $details = json_decode($row['details'] ?? '{}', true);
        $this->assertSame('scope', $details['reason'] ?? null);
        $this->assertSame('connector_command', $details['tool'] ?? null);
    }

    /**
     * An app-scope violation (assertAppScope: a token scoped to one app touching another) produces
     * 'mcp.denied' with reason 'app_scope', response text unchanged.
     */
    public function testAppScopeViolationIsAuditedAsMcpDeniedWithAppScopeReason(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        $ctrl = $this->makeAuditedCtrl($audit);
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];

        $res = $this->tool($tok, 'update_app', ['appId' => $this->appB, 'name' => 'Hijack'], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertSame(
            'Error: This MCP token is scoped to a single app and cannot touch other apps',
            $res['text'],
            'client-facing response text must be byte-identical to before this fix'
        );

        $row = $this->latestAuditRow('mcp.denied');
        $this->assertNotNull($row, 'an app-scope violation must produce an mcp.denied audit row');
        $details = json_decode($row['details'] ?? '{}', true);
        $this->assertSame('app_scope', $details['reason'] ?? null);
        $this->assertSame('update_app', $details['tool'] ?? null);
    }

    /**
     * A form-not-found/not-owned denial (ownForm) produces 'mcp.denied' with reason 'not_found' — the
     * intentionally vague "not found or access denied" message is preserved verbatim.
     */
    public function testFormOwnershipViolationIsAuditedAsMcpDeniedWithNotFoundReason(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        $ctrl = $this->makeAuditedCtrl($audit);
        // Account-wide token (not app-scoped) so assertFormInScope passes through to ownForm(), which
        // then rejects a formId belonging to a different user.
        $tok = self::$tokens->create($this->userId, null, 3600, 900, ['forms:read'])['token'];

        $res = $this->tool($tok, 'get_form', ['formId' => 'does-not-exist'], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertSame('Error: Form not found or access denied', $res['text']);

        $row = $this->latestAuditRow('mcp.denied');
        $this->assertNotNull($row, 'a form ownership/not-found denial must produce an mcp.denied audit row');
        $details = json_decode($row['details'] ?? '{}', true);
        $this->assertSame('not_found', $details['reason'] ?? null);
        $this->assertSame('get_form', $details['tool'] ?? null);
    }

    /**
     * An unexpected non-\Exception \Throwable (mirroring testUnexpectedThrowableIsGenericButPlainExceptionStillLeaksItsOwnSafeMessage)
     * produces an 'mcp.tool_error' audit row with the message truncated to 200 chars — while the
     * client-facing response stays the same generic, non-leaking text as before this fix.
     */
    public function testUnexpectedThrowableIsAuditedAsMcpToolErrorWithTruncatedMessage(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        $longMessage = 'raw internal detail that must never reach the client ' . str_repeat('x', 300);
        $formService = $this->createMock(FormService::class);
        $formService->method('getAllForms')->willThrowException(new \TypeError($longMessage));
        $ctrl = $this->makeAuditedCtrl($audit, $formService);
        $tok = self::$tokens->create($this->userId)['token']; // account-wide token -> list_forms calls getAllForms()

        $res = $this->tool($tok, 'list_forms', [], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertSame(
            'Error: an unexpected error occurred. Please try again.',
            $res['text'],
            'client-facing response must stay generic and byte-identical to before this fix'
        );
        $this->assertStringNotContainsString('raw internal detail', $res['text']);

        $row = $this->latestAuditRow('mcp.tool_error');
        $this->assertNotNull($row, 'an unexpected \Throwable must produce an mcp.tool_error audit row');
        $details = json_decode($row['details'] ?? '{}', true);
        $this->assertSame('list_forms', $details['tool'] ?? null);
        $this->assertSame(substr($longMessage, 0, 200), $details['message'] ?? null);
        $this->assertLessThanOrEqual(200, strlen($details['message'] ?? ''), 'the audited message must be truncated to 200 chars');
    }

    /**
     * A multibyte character straddling the old byte-200 cut point must not corrupt the audited details.
     * Byte-based substr() can split a multibyte UTF-8 codepoint, producing an invalid-UTF-8 string that
     * makes AuditService's json_encode() return false — silently discarding the WHOLE details blob
     * (including the 'tool' key), not just the message. Truncation must be mb-safe.
     */
    public function testUnexpectedThrowableWithMultibyteMessageProducesValidAuditDetails(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        // 199 ASCII bytes followed by multibyte UTF-8 characters straddling the byte-200 boundary.
        $longMessage = str_repeat('a', 199) . '日本語のエラーメッセージ' . str_repeat('b', 50);
        $formService = $this->createMock(FormService::class);
        $formService->method('getAllForms')->willThrowException(new \TypeError($longMessage));
        $ctrl = $this->makeAuditedCtrl($audit, $formService);
        $tok = self::$tokens->create($this->userId)['token']; // account-wide token -> list_forms calls getAllForms()

        $res = $this->tool($tok, 'list_forms', [], $ctrl);
        $this->assertTrue($res['isError']);

        $row = $this->latestAuditRow('mcp.tool_error');
        $this->assertNotNull($row, 'an unexpected \Throwable with a multibyte message must still produce an mcp.tool_error audit row');
        $this->assertNotSame(
            '',
            (string) ($row['details'] ?? ''),
            'details must not be silently dropped by a json_encode() failure on invalid UTF-8'
        );
        $details = json_decode($row['details'] ?? '{}', true);
        $this->assertSame('list_forms', $details['tool'] ?? null, 'tool attribution must survive truncation of a multibyte message');
        $this->assertSame(mb_substr($longMessage, 0, 200), $details['message'] ?? null);
    }

    /**
     * Ordinary input-validation \Exceptions (the file's established "safe to show the caller" convention
     * — e.g. a malformed field) are deliberately NOT audited by design: only genuine denials (scope/
     * ownership) and genuinely unexpected errors are. No new mcp.denied/mcp.tool_error row is added, and
     * the response text is unaffected.
     */
    public function testOrdinaryValidationExceptionDoesNotAddDenialOrErrorAuditRows(): void
    {
        $audit = new AuditService(self::$mysql, null, 'test-audit-hmac-key');
        $ctrl = $this->makeAuditedCtrl($audit);
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];

        $before = $this->countAuditRows(['mcp.denied', 'mcp.tool_error']);
        $res = $this->tool($tok, 'create_form', ['title' => 'X', 'fields' => ['not-an-object']], $ctrl);
        $this->assertTrue($res['isError']);
        $this->assertStringContainsString('malformed', $res['text']);
        $after = $this->countAuditRows(['mcp.denied', 'mcp.tool_error']);
        $this->assertSame($before, $after, 'an ordinary validation \Exception must not add a new mcp.denied/mcp.tool_error audit row');
    }

    // ── Flows over MCP ──

    /** The full flow lifecycle: create → list → get → bind to a form event → update → delete. */
    public function testFlowToolsBuildBindAndTearDown(): void
    {
        $tok = self::$tokens->create($this->userId)['token'];

        $created = $this->tool($tok, 'create_flow', [
            'appId' => $this->appA,
            'name' => 'Acknowledge lead',
            'slug' => 'ack-lead',
            'flowJson' => [
                'nodes' => [
                    ['id' => 'in', 'type' => 'input', 'data' => ['inputs' => [['name' => 'name']]]],
                    ['id' => 'out', 'type' => 'output', 'data' => ['value' => ['ok' => true]]],
                ],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
            'nodeCapabilities' => ['formlogic.responses.read'],
        ]);
        $this->assertFalse($created['isError'], $created['text']);
        $this->assertSame('ack-lead', $created['data']['slug'] ?? null);
        $flowId = (string) $created['data']['id'];

        $list = $this->tool($tok, 'list_flows', ['appId' => $this->appA]);
        $this->assertFalse($list['isError'], $list['text']);
        $this->assertSame(['ack-lead'], array_column($list['data'], 'slug'));

        $got = $this->tool($tok, 'get_flow', ['appId' => $this->appA, 'flowId' => $flowId]);
        $this->assertFalse($got['isError'], $got['text']);
        $this->assertSame('in', $got['data']['flowJson']['nodes'][0]['id'] ?? null);
        $this->assertSame(['formlogic.responses.read'], $got['data']['nodeCapabilities']);

        // Bind it to the app's form (form.submitted trigger). Mode defaults to async.
        $binding = $this->tool($tok, 'create_flow_binding', [
            'appId' => $this->appA,
            'flow' => 'ack-lead',
            'event' => 'form.submitted',
            'formId' => $this->formA,
            'inputMap' => ['name' => '$event.data.answers.name'],
        ]);
        $this->assertFalse($binding['isError'], $binding['text']);
        $this->assertSame('async', $binding['data']['mode'] ?? null);
        $this->assertSame($this->formA, $binding['data']['formId'] ?? null);
        $bindingId = (string) $binding['data']['id'];

        $bindings = $this->tool($tok, 'list_flow_bindings', ['appId' => $this->appA]);
        $this->assertFalse($bindings['isError'], $bindings['text']);
        $this->assertSame([$bindingId], array_column($bindings['data'], 'id'));

        // A binding to a form OUTSIDE the app is rejected by the service with a clear message.
        $foreign = $this->tool($tok, 'create_flow_binding', [
            'appId' => $this->appA, 'flow' => 'ack-lead', 'event' => 'form.submitted', 'formId' => $this->formB,
        ]);
        $this->assertTrue($foreign['isError']);
        $this->assertStringContainsString('does not belong to this app', $foreign['text']);

        $upd = $this->tool($tok, 'update_flow', ['appId' => $this->appA, 'flowId' => $flowId, 'enabled' => false]);
        $this->assertFalse($upd['isError'], $upd['text']);
        $this->assertFalse($upd['data']['enabled']);

        $updB = $this->tool($tok, 'update_flow_binding', ['appId' => $this->appA, 'bindingId' => $bindingId, 'enabled' => false]);
        $this->assertFalse($updB['isError'], $updB['text']);
        $this->assertFalse($updB['data']['enabled']);

        $delB = $this->tool($tok, 'delete_flow_binding', ['appId' => $this->appA, 'bindingId' => $bindingId]);
        $this->assertFalse($delB['isError'], $delB['text']);
        $del = $this->tool($tok, 'delete_flow', ['appId' => $this->appA, 'flowId' => $flowId]);
        $this->assertFalse($del['isError'], $del['text']);
        $this->assertSame([], $this->tool($tok, 'list_flows', ['appId' => $this->appA])['data']);
    }

    /** App-scoped tokens: flow tools default to the scoped app and cannot touch another app's flows. */
    public function testFlowToolsHonorAppScope(): void
    {
        $tok = self::$tokens->create($this->userId, $this->appA)['token'];

        // No appId → defaults to the scoped app.
        $created = $this->tool($tok, 'create_flow', ['name' => 'Scoped flow']);
        $this->assertFalse($created['isError'], $created['text']);
        $this->assertSame($this->appA, $created['data']['appId'] ?? null);

        // An explicit foreign appId is denied (and audited as an app_scope denial).
        $foreign = $this->tool($tok, 'create_flow', ['appId' => $this->appB, 'name' => 'Nope']);
        $this->assertTrue($foreign['isError']);
        $this->assertStringContainsString('scoped to a single app', $foreign['text']);

        $this->assertTrue($this->tool($tok, 'list_flows', ['appId' => $this->appB])['isError']);
    }

    /** Without apps:write the flow write tools are hidden from tools/list AND refuse when called. */
    public function testFlowWriteToolsRequireAppsWrite(): void
    {
        $tok = self::$tokens->create($this->userId, null, 3600, 900, ['apps:read', 'forms:read'])['token'];

        $names = $this->toolNames($tok);
        $this->assertContains('list_flows', $names);
        $this->assertNotContains('create_flow', $names);
        $this->assertNotContains('create_flow_binding', $names);

        $res = $this->tool($tok, 'create_flow', ['appId' => $this->appA, 'name' => 'X']);
        $this->assertTrue($res['isError']);
        $this->assertStringContainsString('lacks the required scope', $res['text']);
    }

    // ── Record writes over MCP (responses:write) ──

    /** Default builder tokens have no record-write tools; responses:write unlocks the full
     *  add → update (partial patch) → delete lifecycle through the validated pipeline. */
    public function testResponseWriteToolsGatedAndValidated(): void
    {
        // Default scopes: the write tools are hidden and refuse.
        $builder = self::$tokens->create($this->userId)['token'];
        $this->assertNotContains('add_response', $this->toolNames($builder));
        $denied = $this->tool($builder, 'add_response', ['formId' => $this->formA, 'answers' => []]);
        $this->assertTrue($denied['isError']);
        $this->assertStringContainsString('lacks the required scope', $denied['text']);

        // A responses:write token: build a real form (real fields), then write records through it.
        $scopes = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write', 'responses:read', 'responses:write'];
        $tok = self::$tokens->create($this->userId, null, 3600, 900, $scopes)['token'];
        $this->assertContains('add_response', $this->toolNames($tok));

        $form = $this->tool($tok, 'create_form', ['title' => 'Leads', 'fields' => [
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true],
            ['id' => 'note', 'type' => 'long_text', 'label' => 'Note', 'required' => false],
        ]]);
        $this->assertFalse($form['isError'], $form['text']);
        $formId = (string) $form['data']['id'];

        // Validation runs: a missing required field is rejected with the field error surfaced.
        $invalid = $this->tool($tok, 'add_response', ['formId' => $formId, 'answers' => ['note' => 'no name']]);
        $this->assertTrue($invalid['isError']);
        $this->assertStringContainsString('Validation failed', $invalid['text']);
        $this->assertStringContainsString('required', $invalid['text']);

        $created = $this->tool($tok, 'add_response', ['formId' => $formId, 'answers' => ['name' => 'Ada', 'note' => 'first contact']]);
        $this->assertFalse($created['isError'], $created['text']);
        $responseId = (string) $created['data']['id'];
        $this->assertNotSame('', $responseId);

        // update_response is a PARTIAL patch: omitting the required 'name' must not reject.
        $patched = $this->tool($tok, 'update_response', ['formId' => $formId, 'responseId' => $responseId, 'answers' => ['note' => 'followed up']]);
        $this->assertFalse($patched['isError'], $patched['text']);
        $this->assertSame('followed up', $patched['data']['answers']['note'] ?? null);
        $this->assertSame('Ada', $patched['data']['answers']['name'] ?? null);

        $deleted = $this->tool($tok, 'delete_response', ['formId' => $formId, 'responseId' => $responseId]);
        $this->assertFalse($deleted['isError'], $deleted['text']);
        $gone = $this->tool($tok, 'delete_response', ['formId' => $formId, 'responseId' => $responseId]);
        $this->assertTrue($gone['isError']);
    }

    /** tools/list front-loads the core build path (some MCP clients only eager-load the first
     *  schemas): get_started first, then create_app → create_app_form → set_app_home → update_app →
     *  create_flow → create_flow_binding before any list_* tool. */
    public function testBuildToolsAreFrontLoaded(): void
    {
        $tok = self::$tokens->create($this->userId)['token'];
        $names = $this->toolNames($tok);
        $this->assertSame('get_started', $names[0]);
        $expectedOrder = ['create_app', 'create_app_form', 'set_app_home', 'update_app', 'create_flow', 'create_flow_binding'];
        $positions = array_map(static fn ($n) => array_search($n, $names, true), $expectedOrder);
        $this->assertNotContains(false, $positions, 'every core build tool must be listed');
        $sorted = $positions;
        sort($sorted);
        $this->assertSame($sorted, $positions, 'core build tools must keep their build-path order');
        $firstList = array_search('list_forms', $names, true);
        $this->assertGreaterThan(max($positions), $firstList, 'build tools must precede the list_* tools');
    }
}
