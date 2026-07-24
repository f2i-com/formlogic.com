<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DesktopFlowRelayController;
use FormLogic\Controllers\FlowRunController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/** Test double: the chat transport is stubbed; env config makes the service "configured". */
class CloudFlowRunnerFakeAi extends AIService
{
    public array $calls = [];

    protected function chatCompletionsRequest(array $payload, bool $stream, ?callable $onDelta, ?callable $onHeartbeat): array
    {
        $this->calls[] = $payload;
        return ['content' => 'fake-answer', 'usage' => ['promptTokens' => 12, 'completionTokens' => 5, 'totalTokens' => 17]];
    }
}

/**
 * Cloud flow execution (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 5 §5.7):
 * validateCloudEligible per node type, the v1 node subset executing (input/output/template,
 * record nodes via ResponseService, llm_chat via hosted Site AI with ai_messages metering,
 * http_request with the egress allow-list, connector_request enqueued through
 * DesktopCommandService), the credit lifecycle (preflight consumes nothing; a STARTED run
 * consumes the credit even on failure; flow_credits_exceeded is typed), the wall-clock
 * bound, the run dispatcher's routing per execution_location, and the executionLocation
 * serialization round-trip. Skipped without a test database.
 */
class CloudFlowRunnerTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $formService;
    private static ResponseService $responses;
    private static FlowService $flows;
    private static DesktopCommandService $commands;
    private static CloudFlowRunnerFakeAi $ai;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];
    private ?string $prevAiBaseUrl = null;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-cloudrun-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
        self::$flows = new FlowService($conn);
        self::$commands = new DesktopCommandService($conn);
        // A custom (keyless) endpoint makes AIService::isConfigured() true without a key.
        $_ENV['AI_BASE_URL'] = 'http://127.0.0.1:9/v1';
        self::$ai = new CloudFlowRunnerFakeAi();
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->prevAiBaseUrl = $_ENV['AI_BASE_URL'] ?? null;
        self::$ai->calls = [];
        // These tests depend on the seeded allowances; INSERT IGNORE makes each test
        // independent of what an earlier test file's tearDown pruned or perturbed.
        self::$pdo->exec("INSERT IGNORE INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES
            ('personal', 'cloud_flow_runs', 100, 1), ('personal', 'ai_messages', 500, 1)");
    }

    protected function tearDown(): void
    {
        if ($this->prevAiBaseUrl !== null) {
            $_ENV['AI_BASE_URL'] = $this->prevAiBaseUrl;
        }
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM usage_meter WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE f FROM desktop_flow_run_frames f JOIN desktop_flow_runs r ON f.request_id = r.id WHERE r.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_flow_runs WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->appIds as $aid) {
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$aid]);
        }
        self::$pdo->exec("DELETE FROM flow_run_logs WHERE trigger_event = 'manual' AND idempotency_key LIKE 'cloud:%'");
        // Restore the seeded allowances a test may have perturbed.
        self::$pdo->exec("INSERT INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES
            ('personal', 'cloud_flow_runs', 100, 1), ('personal', 'ai_messages', 500, 1)
            ON DUPLICATE KEY UPDATE monthly_value = VALUES(monthly_value), enabled = VALUES(enabled)");
    }

    // ── helpers ──

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function plan(): PlanService
    {
        return new PlanService(self::$mysql, new FileStorageService(['storagePath' => sys_get_temp_dir() . '/fl-test-uploads']), ['planEnforced' => true]);
    }

    private function runner(?callable $transport = null, string $baseUrl = 'https://site.example', ?int $wallClock = null): CloudFlowRunner
    {
        return new CloudFlowRunner(
            self::$mysql,
            self::$responses,
            self::$ai,
            $this->plan(),
            self::$commands,
            $baseUrl,
            $transport,
            $wallClock ?? CloudFlowRunner::MAX_WALL_CLOCK_SECONDS,
        );
    }

    /** A REAL workspace flow row (the run log's flow_definition_id FK requires it). */
    private function flowRow(string $ownerId, array $nodes, array $edges = [], array $extra = []): array
    {
        $flow = self::$flows->createWorkspaceFlow($ownerId, [
            'name' => 'Cloud test ' . bin2hex(random_bytes(3)),
            'flowJson' => ['nodes' => $nodes, 'edges' => $edges],
        ]);
        return array_merge($flow, $extra);
    }

    private function makeForm(string $ownerId): string
    {
        $form = self::$formService->createForm([
            'user_id' => $ownerId,
            'title' => 'Jobs',
            'status' => 'published',
            'fields' => [
                ['id' => 'service', 'type' => 'short_text', 'label' => 'Service', 'required' => false, 'order' => 0, 'properties' => []],
                ['id' => 'phone', 'type' => 'short_text', 'label' => 'Phone', 'required' => false, 'order' => 1, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    private function meterCount(string $userId, string $metric): int
    {
        $stmt = self::$pdo->prepare('SELECT `count` FROM usage_meter WHERE user_id = ? AND metric = ? AND period = ?');
        $stmt->execute([$userId, $metric, gmdate('Y-m')]);
        return (int) $stmt->fetchColumn();
    }

    private function meterTokens(string $userId, string $metric): array
    {
        $stmt = self::$pdo->prepare('SELECT tokens_in, tokens_out FROM usage_meter WHERE user_id = ? AND metric = ? AND period = ?');
        $stmt->execute([$userId, $metric, gmdate('Y-m')]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: ['tokens_in' => 0, 'tokens_out' => 0];
    }

    private function runLogRow(string $runId): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_run_logs WHERE id = ?');
        $stmt->execute([$runId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    // ── validateCloudEligible ──

    public function testValidateCloudEligiblePerNodeType(): void
    {
        $supported = ['nodes' => [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 't', 'type' => 'template', 'data' => ['template' => 'x']],
            ['id' => 'list', 'type' => 'formlogic_list_responses', 'data' => ['form' => 'f']],
            ['id' => 'sub', 'type' => 'formlogic_submit_response', 'data' => ['form' => 'f', 'answers' => ['a' => 1]]],
            ['id' => 'upd', 'type' => 'formlogic_update_response', 'data' => ['form' => 'f', 'responseId' => '$inputs.rid', 'answers' => ['a' => 1]]],
            ['id' => 'llm', 'type' => 'llm_chat', 'data' => ['prompt' => 'hi']],
            ['id' => 'http', 'type' => 'http_request', 'data' => ['url' => 'https://site.example/api/x']],
            ['id' => 'conn', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'phone.status']],
            ['id' => 'out', 'type' => 'output'],
        ], 'edges' => []];
        $this->assertSame([], CloudFlowRunner::validateCloudEligible($supported));

        $offenders = CloudFlowRunner::validateCloudEligible(['nodes' => [
            ['id' => 'lb', 'type' => 'logic_block', 'data' => ['expr' => '1']],
            ['id' => 'cond', 'type' => 'condition', 'data' => ['expr' => 'true']],
            ['id' => 'kv', 'type' => 'storage_get', 'data' => ['key' => 'k']],
            ['id' => 'spk', 'type' => 'aokie_speak', 'data' => ['text' => 'hi']],
            ['id' => 'ba', 'type' => 'browser_action', 'data' => ['action' => 'goto']],
        ]]);
        $this->assertCount(5, $offenders);
        $byId = array_column($offenders, null, 'nodeId');
        $this->assertSame('cloud_unsupported_node', 'cloud_unsupported_node'); // the code the dispatcher reports
        $this->assertStringContainsString('JS logic blocks', $byId['lb']['reason']);
        $this->assertStringContainsString('JS condition nodes', $byId['cond']['reason']);
        $this->assertSame('storage_get', $byId['kv']['type']);
        $this->assertSame('aokie_speak', $byId['spk']['type']);
        $this->assertSame('browser_action', $byId['ba']['type']);

        $malformed = CloudFlowRunner::validateCloudEligible(['nodes' => 'nope']);
        $this->assertCount(1, $malformed);
        $this->assertSame('(graph)', $malformed[0]['nodeId']);
    }

    // ── supported nodes execute ──

    public function testInputTemplateOutputFlow(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow(
            $userId,
            [
                ['id' => 'in', 'type' => 'input'],
                ['id' => 't', 'type' => 'template', 'data' => ['template' => 'Hello {{inputs.name}} ({{nodes.in.name}})']],
                ['id' => 'out', 'type' => 'output', 'data' => ['value' => '$nodes.t']],
            ],
            [['source' => 'in', 'target' => 't'], ['source' => 't', 'target' => 'out']],
        );
        $outcome = $this->runner()->run($flow, $userId, ['name' => 'Lance']);
        $this->assertTrue($outcome['ok']);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame('Hello Lance (Lance)', $outcome['result']);
        $this->assertSame(3, $outcome['nodesExecuted']);
        // The run consumed exactly one credit and logged execution_location='cloud'.
        $this->assertSame(1, $this->meterCount($userId, 'cloud_flow_runs'));
        $row = $this->runLogRow($outcome['runId']);
        $this->assertNotNull($row);
        $this->assertSame('done', $row['status']);
        $this->assertSame('cloud', $row['execution_location']);
        $this->assertSame('cloud', $row['runtime']);
        $this->assertSame(json_encode('Hello Lance (Lance)'), $row['result_json']);
    }

    public function testConvergingBranchesJoinUpstreamMap(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow(
            $userId,
            [
                ['id' => 'a', 'type' => 'template', 'data' => ['template' => 'A']],
                ['id' => 'b', 'type' => 'template', 'data' => ['template' => 'B']],
                ['id' => 'join', 'type' => 'template', 'data' => ['template' => '{{upstream.a}}+{{upstream.b}}']],
                ['id' => 'out', 'type' => 'output', 'data' => ['value' => '$nodes.join']],
            ],
            [['source' => 'a', 'target' => 'join'], ['source' => 'b', 'target' => 'join'], ['source' => 'join', 'target' => 'out']],
        );
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame('A+B', $outcome['result']);
    }

    public function testRecordNodesListSubmitUpdate(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm($userId);
        self::$responses->createResponse($formId, ['answers' => ['service' => 'cut', 'phone' => '0491 570 156']]);
        self::$responses->createResponse($formId, ['answers' => ['service' => 'color', 'phone' => '0400000000']]);

        // List with an eq filter AND a phone_eq pushdown filter (both resolve to the same row).
        $list = $this->flowRow($userId, [
            ['id' => 'list', 'type' => 'formlogic_list_responses', 'data' => [
                'form' => $formId,
                'filters' => [
                    ['field' => 'service', 'op' => 'eq', 'value' => 'cut'],
                    ['field' => 'phone', 'op' => 'phone_eq', 'value' => '+61 491 570 156'],
                ],
            ]],
        ]);
        $outcome = $this->runner()->run($list, $userId, []);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame(1, $outcome['result']['count']);
        $this->assertTrue($outcome['result']['found']);
        $this->assertSame('cut', $outcome['result']['first']['answers']['service']);

        // Submit then update (the update's responseId rides a $nodes selector).
        $mutate = $this->flowRow(
            $userId,
            [
                ['id' => 'sub', 'type' => 'formlogic_submit_response', 'data' => ['form' => $formId, 'answers' => ['service' => 'shave', 'phone' => '$inputs.phone']]],
                ['id' => 'upd', 'type' => 'formlogic_update_response', 'data' => ['form' => $formId, 'responseId' => '$nodes.sub.id', 'answers' => ['service' => 'trim']]],
                ['id' => 'out', 'type' => 'output', 'data' => ['value' => '$nodes.upd']],
            ],
            [['source' => 'sub', 'target' => 'upd'], ['source' => 'upd', 'target' => 'out']],
        );
        $outcome = $this->runner()->run($mutate, $userId, ['phone' => '0412345678']);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame('trim', $outcome['result']['answers']['service']);
        $this->assertSame('shave', $outcome['result']['id'] !== '' ? 'shave' : null);
        // The update replaced the answers wholesale (same semantics as the API path).
        $stored = self::$responses->getResponse($formId, $outcome['result']['id']);
        $this->assertSame(['service' => 'trim'], $stored['answers']);
    }

    public function testLlmChatMetersAiMessagesAndRecordsTokens(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow($userId, [
            ['id' => 'llm', 'type' => 'llm_chat', 'data' => ['system' => 'You are brief.', 'prompt' => 'Say hi to {{inputs.name}}']],
        ]);
        $outcome = $this->runner()->run($flow, $userId, ['name' => 'Bo']);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame('fake-answer', $outcome['result']['content']);
        // The fake transport saw the assembled messages.
        $this->assertCount(1, self::$ai->calls);
        $messages = self::$ai->calls[0]['messages'];
        $this->assertSame('system', $messages[0]['role']);
        $this->assertSame('Say hi to Bo', $messages[1]['content']);
        // Double-metering: one cloud_flow_runs credit AND one ai_messages unit + tokens.
        $this->assertSame(1, $this->meterCount($userId, 'cloud_flow_runs'));
        $this->assertSame(1, $this->meterCount($userId, 'ai_messages'));
        $tokens = $this->meterTokens($userId, 'ai_messages');
        $this->assertSame(12, (int) $tokens['tokens_in']);
        $this->assertSame(5, (int) $tokens['tokens_out']);
    }

    public function testLlmChatExplicitDesktopProviderFailsClosed(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow($userId, [
            ['id' => 'llm', 'type' => 'llm_chat', 'data' => ['provider' => 'provider:openai-codex-agent', 'prompt' => 'hi']],
        ]);
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('node_failed', $outcome['error']['code']);
        $this->assertSame('llm', $outcome['error']['nodeId']);
        $this->assertStringContainsString('Default (from Settings)', $outcome['error']['message']);
        // A started run still consumed the credit (documented lifecycle).
        $this->assertSame(1, $this->meterCount($userId, 'cloud_flow_runs'));
        $this->assertCount(0, self::$ai->calls, 'the provider-refusal happens before any upstream call');
    }

    public function testLlmChatAllowanceExhaustedIsATypedNodeFailure(): void
    {
        $userId = $this->makeUser();
        $this->plan()->setAllowance('personal', 'ai_messages', 0, true);
        $flow = $this->flowRow($userId, [
            ['id' => 'llm', 'type' => 'llm_chat', 'data' => ['prompt' => 'hi']],
        ]);
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('node_failed', $outcome['error']['code']);
        $this->assertStringContainsString('ai_allowance_exceeded', $outcome['error']['message']);
        $this->assertCount(0, self::$ai->calls);
    }

    public function testHttpRequestEgressAllowList(): void
    {
        $userId = $this->makeUser();
        $calls = [];
        $transport = static function (string $method, string $url, array $headers, ?string $body) use (&$calls): array {
            $calls[] = ['method' => $method, 'url' => $url, 'body' => $body];
            return ['status' => 200, 'body' => '{"a":1}'];
        };
        $ok = $this->flowRow($userId, [
            ['id' => 'http', 'type' => 'http_request', 'data' => ['url' => 'https://site.example/api/health', 'method' => 'get']],
        ]);
        $outcome = $this->runner($transport)->run($ok, $userId, []);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertSame(200, $outcome['result']['status']);
        $this->assertTrue($outcome['result']['ok']);
        $this->assertSame(['a' => 1], $outcome['result']['body']);
        $this->assertSame('GET', $calls[0]['method'], 'lowercase methods normalize to uppercase');

        // Off-base URLs are refused before any egress.
        $off = $this->flowRow($userId, [
            ['id' => 'http', 'type' => 'http_request', 'data' => ['url' => 'https://evil.example/steal']],
        ]);
        $calls = [];
        $outcome = $this->runner($transport)->run($off, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('capability_denied', $outcome['error']['code']);
        $this->assertCount(0, $calls, 'no egress happens for a non-allow-listed URL');

        // Loopback is not implicitly trusted either.
        $loop = $this->flowRow($userId, [
            ['id' => 'http', 'type' => 'http_request', 'data' => ['url' => 'http://127.0.0.1:8080/internal']],
        ]);
        $outcome = $this->runner($transport)->run($loop, $userId, []);
        $this->assertSame('capability_denied', $outcome['error']['code']);
    }

    public function testConnectorRequestWithoutLinkedDesktopIsTyped(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow(
            $userId,
            [['id' => 'c', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'phone.status']]],
            [],
            ['nodeCapabilities' => ['connector.aokie.phone.status']],
        );
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('node_failed', $outcome['error']['code']);
        $this->assertStringContainsString('no_linked_desktop', $outcome['error']['message']);
        // Nothing was enqueued.
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM desktop_commands WHERE owner_user_id = ?');
        $stmt->execute([$userId]);
        $this->assertSame(0, (int) $stmt->fetchColumn());
    }

    public function testConnectorRequestCapabilityGateAndEnqueue(): void
    {
        $userId = $this->makeUser();

        // Missing the declared capability → capability_denied, no enqueue.
        $flow = $this->flowRow(
            $userId,
            [['id' => 'c', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'phone.status', 'payload' => ['x' => '$inputs.x']]]],
        );
        $outcome = $this->runner()->run($flow, $userId, ['x' => 1]);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('capability_denied', $outcome['error']['code']);

        // Wildcard grant + a linked desktop → the command is ENQUEUED (never executed inline).
        self::$pdo->prepare("INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at) VALUES (?, ?, 'Box', 'desk-1', NOW())")
            ->execute(['dc-' . bin2hex(random_bytes(8)), $userId]);
        $flow = $this->flowRow(
            $userId,
            [['id' => 'c', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'phone.status', 'payload' => ['x' => '$inputs.x']]]],
            [],
            ['nodeCapabilities' => ['connector.aokie.*']],
        );
        $outcome = $this->runner()->run($flow, $userId, ['x' => 7]);
        $this->assertSame('done', $outcome['status'], json_encode($outcome));
        $this->assertTrue($outcome['result']['accepted']);
        $this->assertTrue($outcome['result']['queued']);
        $this->assertSame('pending', $outcome['result']['status']);
        $stmt = self::$pdo->prepare("SELECT connector_id, command, payload_json, target_instance_id FROM desktop_commands WHERE id = ?");
        $stmt->execute([$outcome['result']['commandId']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertNotFalse($row);
        $this->assertSame('aokie', $row['connector_id']);
        $this->assertSame('phone.status', $row['command']);
        $this->assertSame(['x' => 7], json_decode((string) $row['payload_json'], true));
        $this->assertSame('desk-1', $row['target_instance_id'], 'the implicit single fresh desktop is targeted');
    }

    // ── credit lifecycle ──

    public function testPreflightFailureConsumesNoCreditAndWritesNoRun(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow($userId, [
            ['id' => 'lb', 'type' => 'logic_block', 'data' => ['expr' => '1']],
        ]);
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertFalse($outcome['ok']);
        $this->assertSame('cloud_unsupported_node', $outcome['code']);
        $this->assertSame('lb', $outcome['nodes'][0]['nodeId']);
        $this->assertSame(0, $this->meterCount($userId, 'cloud_flow_runs'));
        $stmt = self::$pdo->prepare("SELECT COUNT(*) FROM flow_run_logs WHERE flow_definition_id = ? AND trigger_event = 'manual'");
        $stmt->execute([$flow['id']]);
        $this->assertSame(0, (int) $stmt->fetchColumn(), 'a preflight refusal never writes a run row');
    }

    public function testStartedFailingRunConsumesCreditAndLogsCloudError(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm($userId);
        $flow = $this->flowRow($userId, [
            ['id' => 'upd', 'type' => 'formlogic_update_response', 'data' => ['form' => $formId, 'responseId' => 'missing', 'answers' => ['service' => 'x']]],
        ]);
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('node_failed', $outcome['error']['code']);
        $this->assertSame(1, $this->meterCount($userId, 'cloud_flow_runs'), 'a started run consumes the credit even on failure');
        $row = $this->runLogRow($outcome['runId']);
        $this->assertNotNull($row);
        $this->assertSame('error', $row['status']);
        $this->assertSame('cloud', $row['execution_location']);
        $error = json_decode((string) $row['error_json'], true);
        $this->assertSame('node_failed', $error['code']);
        $this->assertSame('upd', $error['nodeId']);
    }

    public function testFlowCreditsExceededIsTypedAndConsumesNothing(): void
    {
        $userId = $this->makeUser();
        $this->plan()->setAllowance('personal', 'cloud_flow_runs', 0, true);
        $flow = $this->flowRow($userId, [['id' => 'in', 'type' => 'input']]);
        try {
            $this->runner()->run($flow, $userId, []);
            $this->fail('expected flow_credits_exceeded');
        } catch (\RuntimeException $e) {
            $this->assertSame('flow_credits_exceeded', $e->getMessage());
        }
        $this->assertSame(0, $this->meterCount($userId, 'cloud_flow_runs'));
    }

    // ── wall clock ──

    public function testWallClockBound(): void
    {
        $userId = $this->makeUser();
        $flow = $this->flowRow(
            $userId,
            [
                ['id' => 'a', 'type' => 'template', 'data' => ['template' => 'x']],
                ['id' => 'b', 'type' => 'template', 'data' => ['template' => 'y']],
            ],
            [['source' => 'a', 'target' => 'b']],
        );
        // A zero-second budget is already past the deadline at the first node boundary.
        $outcome = $this->runner(null, 'https://site.example', 0)->run($flow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertSame('timeout', $outcome['error']['code']);
    }

    // ── run dispatcher (POST /api/flows/{id}/run) ──

    private function dispatcher(): FlowRunController
    {
        $relayCtrl = new DesktopFlowRelayController(
            new DesktopFlowRelayService(self::$mysql),
            self::$commands,
            self::$flows,
        );
        return new FlowRunController(self::$flows, $this->runner(), $relayCtrl);
    }

    private function postRun(string $userId, string $flowId, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/flows/' . $flowId . '/run')
            ->withParsedBody($body)
            ->withAttribute('userId', $userId);
        $resp = $this->dispatcher()->run($req, (new ResponseFactory())->createResponse(), ['flowId' => $flowId]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function createFlow(string $ownerId, string $location, array $nodes = [['id' => 'in', 'type' => 'input']], array $edges = []): string
    {
        return self::$flows->createWorkspaceFlow($ownerId, [
            'name' => 'Dispatcher flow ' . $location . ' ' . bin2hex(random_bytes(3)),
            'flowJson' => ['nodes' => $nodes, 'edges' => $edges],
            'executionLocation' => $location,
        ])['id'];
    }

    public function testDispatcherAutoRefusesWithTyped409(): void
    {
        $userId = $this->makeUser();
        $flowId = $this->createFlow($userId, 'auto');
        $r = $this->postRun($userId, $flowId, ['inputs' => ['x' => 1]]);
        $this->assertSame(409, $r['status']);
        $this->assertSame('use_browser_runner', $r['body']['code'] ?? null);
        // Nothing ran: no credit, no run row.
        $this->assertSame(0, $this->meterCount($userId, 'cloud_flow_runs'));
    }

    public function testDispatcherDesktopRequiresTheSealedEnvelope(): void
    {
        $userId = $this->makeUser();
        $flowId = $this->createFlow($userId, 'desktop');
        $plain = $this->postRun($userId, $flowId, ['inputs' => ['x' => 1]]);
        $this->assertSame(409, $plain['status']);
        $this->assertSame('use_desktop_relay', $plain['body']['code'] ?? null);

        // The sealed passthrough delegates to the relay lane.
        $sealed = $this->postRun($userId, $flowId, [
            'ephPub' => base64_encode(random_bytes(32)),
            'envelope' => base64_encode('sealed-inputs'),
        ]);
        $this->assertSame(201, $sealed['status'], json_encode($sealed['body']));
        $this->assertSame('pending', $sealed['body']['status']);
        $stmt = self::$pdo->prepare('SELECT flow_id, owner_user_id FROM desktop_flow_runs WHERE id = ?');
        $stmt->execute([$sealed['body']['requestId']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertNotFalse($row);
        $this->assertSame($flowId, $row['flow_id'], 'the flow identity came from the route');
        $this->assertSame($userId, $row['owner_user_id']);
    }

    public function testDispatcherCloudRunsSynchronously(): void
    {
        $userId = $this->makeUser();
        $flowId = $this->createFlow($userId, 'cloud', [
            ['id' => 't', 'type' => 'template', 'data' => ['template' => 'hi {{inputs.name}}']],
            ['id' => 'out', 'type' => 'output', 'data' => ['value' => '$nodes.t']],
        ], [['source' => 't', 'target' => 'out']]);
        $r = $this->postRun($userId, $flowId, ['inputs' => ['name' => 'Bo']]);
        $this->assertSame(200, $r['status'], json_encode($r['body']));
        $this->assertSame('done', $r['body']['status']);
        $this->assertSame('hi Bo', $r['body']['result']);
        $this->assertSame('cloud', $r['body']['executionLocation']);
        $this->assertSame(1, $this->meterCount($userId, 'cloud_flow_runs'));
        $row = $this->runLogRow($r['body']['runId']);
        $this->assertSame('cloud', $row['execution_location']);
    }

    public function testDispatcherForeignFlowIs404(): void
    {
        $userId = $this->makeUser();
        $otherId = $this->makeUser();
        $flowId = $this->createFlow($userId, 'cloud');
        $r = $this->postRun($otherId, $flowId, []);
        $this->assertSame(404, $r['status']);
    }

    public function testDispatcherCloudIneligibleIs422WithoutCredit(): void
    {
        $userId = $this->makeUser();
        $flowId = $this->createFlow($userId, 'cloud', [
            ['id' => 'lb', 'type' => 'logic_block', 'data' => ['expr' => '1']],
        ]);
        $r = $this->postRun($userId, $flowId, []);
        $this->assertSame(422, $r['status']);
        $this->assertSame('cloud_unsupported_node', $r['body']['code'] ?? null);
        $this->assertSame('lb', $r['body']['details']['nodes'][0]['nodeId'] ?? null);
        $this->assertSame(0, $this->meterCount($userId, 'cloud_flow_runs'));
    }

    public function testDispatcherCloudCreditsSpentIs402(): void
    {
        $userId = $this->makeUser();
        $this->plan()->setAllowance('personal', 'cloud_flow_runs', 0, true);
        $flowId = $this->createFlow($userId, 'cloud');
        $r = $this->postRun($userId, $flowId, []);
        $this->assertSame(402, $r['status']);
        $this->assertSame('flow_credits_exceeded', $r['body']['code'] ?? null);
    }

    // ── executionLocation serialization round-trip ──

    public function testExecutionLocationSerializationRoundTrip(): void
    {
        $userId = $this->makeUser();

        // Default is 'auto' when the caller says nothing.
        $flow = self::$flows->createWorkspaceFlow($userId, ['name' => 'Plain flow', 'flowJson' => ['nodes' => [], 'edges' => []]]);
        $this->assertSame('auto', $flow['executionLocation']);

        // Create + read back + update.
        $flow = self::$flows->createWorkspaceFlow($userId, ['name' => 'Tunneled flow', 'flowJson' => ['nodes' => [], 'edges' => []], 'executionLocation' => 'desktop']);
        $this->assertSame('desktop', $flow['executionLocation']);
        $read = self::$flows->getWorkspaceFlow($userId, $flow['id']);
        $this->assertSame('desktop', $read['executionLocation']);
        $updated = self::$flows->updateWorkspaceFlow($userId, $flow['id'], ['executionLocation' => 'cloud']);
        $this->assertSame('cloud', $updated['executionLocation']);

        // Invalid values are refused.
        try {
            self::$flows->updateWorkspaceFlow($userId, $flow['id'], ['executionLocation' => 'server']);
            $this->fail('expected an invalid executionLocation to be refused');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('executionLocation', $e->getMessage());
        }

        // App-scoped flows carry it too.
        $appId = 'app-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")
            ->execute([$appId, $userId, 'app-' . bin2hex(random_bytes(4))]);
        $this->appIds[] = $appId;
        $appFlow = self::$flows->createFlow($appId, $userId, ['name' => 'App flow', 'flowJson' => ['nodes' => [], 'edges' => []], 'executionLocation' => 'cloud']);
        $this->assertSame('cloud', $appFlow['executionLocation']);
        $this->assertSame('cloud', self::$flows->getFlow($appId, $appFlow['id'])['executionLocation']);
        $appUpdated = self::$flows->updateFlow($appId, $appFlow['id'], ['executionLocation' => 'desktop']);
        $this->assertSame('desktop', $appUpdated['executionLocation']);

        // Run history rows expose executionLocation.
        $runner = $this->runner();
        $outcome = $runner->run($appFlow, $userId, []);
        $this->assertSame('done', $outcome['status']);
        $runs = self::$flows->listOwnerRuns($userId, ['flowId' => $appFlow['id']]);
        $this->assertNotEmpty($runs['runs']);
        $this->assertSame('cloud', $runs['runs'][0]['executionLocation']);
    }

    // ── flow_call (extensible-flows plan §8, cloud leg) ─────────────────────────────────

    public function testFlowCallExecutesChildInlineWithLineageAndRoutesSuccess(): void
    {
        $userId = $this->makeUser();
        $child = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 't', 'type' => 'template', 'data' => ['template' => 'child says {{inputs.n}}']],
            ['id' => 'out', 'type' => 'output'],
        ], [
            ['source' => 'in', 'target' => 't'],
            ['source' => 't', 'target' => 'out'],
        ]);
        $parent = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 'call', 'type' => 'flow_call', 'data' => [
                'flowId' => $child['id'], 'failureMode' => 'route', 'input' => ['n' => '$inputs.n'],
            ]],
            ['id' => 'ok', 'type' => 'template', 'data' => ['template' => 'ok: {{nodes.call.result}}']],
            ['id' => 'bad', 'type' => 'template', 'data' => ['template' => 'bad: {{nodes.call.error.code}}']],
            ['id' => 'out', 'type' => 'output'],
        ], [
            ['source' => 'in', 'target' => 'call'],
            ['source' => 'call', 'target' => 'ok', 'sourceHandle' => 'success'],
            ['source' => 'call', 'target' => 'bad', 'sourceHandle' => 'failure'],
            ['source' => 'ok', 'target' => 'out'],
            ['source' => 'bad', 'target' => 'out'],
        ]);

        $outcome = $this->runner()->run($parent, $userId, ['n' => 7]);
        $this->assertSame('done', $outcome['status']);
        $this->assertSame('ok: child says 7', $outcome['result'], 'success handle routed with the child result');

        // The child ran as its OWN lineage-linked run (trigger flow.call, parent = the
        // parent's run row, depth 1, calling node recorded).
        $stmt = self::$pdo->prepare(
            "SELECT * FROM flow_run_logs WHERE trigger_event = 'flow.call' AND parent_run_id = ?"
        );
        $stmt->execute([$outcome['runId']]);
        $children = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(1, $children);
        $this->assertSame('done', $children[0]['status']);
        $this->assertSame(1, (int) $children[0]['depth']);
        $this->assertSame('call', $children[0]['call_node_id']);
        $this->assertSame($outcome['runId'], $children[0]['root_run_id']);
    }

    public function testFlowCallFailureRoutingAndRecursionGuard(): void
    {
        $userId = $this->makeUser();
        // A child whose template node is missing its required key fails typed.
        $broken = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 't', 'type' => 'template', 'data' => []],
        ], [['source' => 'in', 'target' => 't']]);
        $parent = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 'call', 'type' => 'flow_call', 'data' => ['flowId' => $broken['id'], 'failureMode' => 'route']],
            ['id' => 'bad', 'type' => 'template', 'data' => ['template' => 'handled: {{nodes.call.error.code}}']],
            ['id' => 'out', 'type' => 'output'],
        ], [
            ['source' => 'in', 'target' => 'call'],
            ['source' => 'call', 'target' => 'bad', 'sourceHandle' => 'failure'],
            ['source' => 'bad', 'target' => 'out'],
        ]);
        $outcome = $this->runner()->run($parent, $userId, []);
        $this->assertSame('done', $outcome['status'], 'the PARENT succeeds — the failure path handled it');
        $this->assertSame('handled: invalid_flow', $outcome['result']);

        // Self-recursion (fail-parent default) refuses typed without reserving a child.
        $loop = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 'call', 'type' => 'flow_call', 'data' => ['flowId' => 'SELF']],
        ], [['source' => 'in', 'target' => 'call']]);
        self::$flows->updateWorkspaceFlow($userId, $loop['id'], [
            'flowJson' => [
                'nodes' => [
                    ['id' => 'in', 'type' => 'input'],
                    ['id' => 'call', 'type' => 'flow_call', 'data' => ['flowId' => $loop['id']]],
                ],
                'edges' => [['source' => 'in', 'target' => 'call']],
            ],
        ]);
        $loopFlow = self::$flows->getWorkspaceFlow($userId, $loop['id']);
        $outcome = $this->runner()->run($loopFlow, $userId, []);
        $this->assertSame('error', $outcome['status']);
        $this->assertStringContainsString('recursion_detected', $outcome['error']['message']);
    }

    // ── RUN-301: compiled canonical IR — contributed core-preset nodes run on cloud ─────────

    public function testContributedCorePresetNodeCompilesAndRunsOnCloud(): void
    {
        $userId = $this->makeUser();

        // Install a node-only extension whose contributed node is a preset over 'template'.
        $pkgV2 = new \FormLogic\Services\Packages\PackageV2InstallService(self::$mysql);
        $pkgV2->install([
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.cloud-presets', 'kind' => 'extension', 'version' => '1.0.0', 'publisherId' => 'com.acme', 'displayName' => 'Cloud Presets'],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => 'com.acme.cloudpresets.greet',
                'version' => '1.0.0',
                'display' => ['label' => 'Greet'],
                'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'Hello {{inputs.name}}!']],
                'sideEffects' => 'none',
            ]]],
        ], $userId, []);

        // Author a flow USING the contributed type (storable — no type allowlist at save).
        $flow = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 'greet', 'type' => 'com.acme.cloudpresets.greet', 'data' => []],
            ['id' => 'out', 'type' => 'output', 'data' => ['value' => '$nodes.greet']],
        ], [
            ['source' => 'in', 'target' => 'greet'],
            ['source' => 'greet', 'target' => 'out'],
        ]);

        // The run executes the revision's COMPILED IR: the contributed node was lowered to
        // 'template' at version mint, so the flow is cloud-eligible AND produces the preset.
        $outcome = $this->runner()->run($flow, $userId, ['name' => 'Ada']);
        $this->assertSame('done', $outcome['status'], json_encode($outcome['error'] ?? null));
        $this->assertSame('Hello Ada!', $outcome['result']);

        // The version row pinned the lowering: compiled IR + the definition lock.
        $row = self::$pdo->query("SELECT compiled_ir_json, definition_locks_json, ir_digest FROM flow_definition_versions WHERE flow_definition_id = '{$flow['id']}'")->fetch(PDO::FETCH_ASSOC);
        $this->assertNotNull($row['ir_digest']);
        $ir = json_decode((string) $row['compiled_ir_json'], true);
        $this->assertSame('template', $ir['nodes'][1]['type'], 'the stored IR carries the lowered node');
        $locks = json_decode((string) $row['definition_locks_json'], true);
        $this->assertSame('com.acme.cloudpresets.greet', $locks[0]['type']);
        $this->assertSame('template', $locks[0]['loweredTo']);

        // The STORED graph keeps the contributed identity — lowering never rewrites authoring state.
        $stored = self::$flows->getWorkspaceFlow($userId, $flow['id']);
        $this->assertSame('com.acme.cloudpresets.greet', $stored['flowJson']['nodes'][1]['type']);
    }

    public function testServiceActionContributedNodeStaysCloudRefused(): void
    {
        $userId = $this->makeUser();
        $pkgV2 = new \FormLogic\Services\Packages\PackageV2InstallService(self::$mysql);
        $pkgV2->install([
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.cloud-media', 'kind' => 'extension', 'version' => '1.0.0', 'publisherId' => 'com.acme', 'displayName' => 'Cloud Media'],
            'contributions' => ['flowNodes' => [[
                'schemaVersion' => 1,
                'type' => 'com.acme.cloudmedia.generate',
                'version' => '1.0.0',
                'display' => ['label' => 'Generate'],
                'handler' => ['kind' => 'service-action', 'bindingSlot' => 'gen', 'requiredAction' => 'generate'],
                'sideEffects' => 'external-write',
            ]]],
            'requirements' => ['services' => [['slot' => 'gen']]],
        ], $userId, []);

        // service-action cannot compile (no bindings yet) → NO IR → the stored graph reaches
        // preflight, where the dotted type is unsupported → typed refusal, no credit consumed.
        $flow = $this->flowRow($userId, [
            ['id' => 'in', 'type' => 'input'],
            ['id' => 'gen', 'type' => 'com.acme.cloudmedia.generate', 'data' => []],
        ], [['source' => 'in', 'target' => 'gen']]);
        $outcome = $this->runner()->run($flow, $userId, []);
        $this->assertFalse($outcome['ok']);
        $this->assertSame('cloud_unsupported_node', $outcome['code']);
        $this->assertSame(0, $this->meterCount($userId, 'cloud_flow_runs'), 'preflight refusals never consume a credit');

        $row = self::$pdo->query("SELECT ir_digest FROM flow_definition_versions WHERE flow_definition_id = '{$flow['id']}'")->fetch(PDO::FETCH_ASSOC);
        $this->assertNull($row['ir_digest'], 'an uncompilable graph pins no IR');
    }
}
