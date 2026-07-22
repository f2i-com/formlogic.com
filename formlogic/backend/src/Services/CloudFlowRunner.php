<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Bounded server-side flow runner (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7, Phase 5) —
 * the 'cloud' execution location. Interprets the same WorkflowGraph JSON as the browser
 * (ui/src/client-runtime/flows) and desktop Rust (flows/runner.rs) runners, deliberately
 * restricted to a v1 node subset that is safe to execute server-side:
 *
 *   - input / output / template      — pure graph plumbing + {{interpolation}};
 *   - formlogic_list_responses       — reads via ResponseService (structured filters incl.
 *   - formlogic_submit_response        phone_eq/gte/lte pushdown — already server-side);
 *   - formlogic_update_response
 *   - llm_chat                        — hosted Site AI (AIService::chat), metering
 *                                       ai_messages per call (double-metering beside the
 *                                       cloud_flow_runs credit is deliberate, plan §5.7);
 *   - http_request                    — egress-allow-listed to the site's own base URL;
 *   - connector_request               — ONLY by enqueueing through DesktopCommandService
 *                                       (typed 'no_linked_desktop' when none is linked).
 *
 * NOT cloud-executable in v1 (validateCloudEligible() names them at save time and again at
 * run time before any credit is touched): JS logic blocks (logic_block) and JS condition
 * nodes (condition) — there is no PHP-side JS sandbox — and every other node type
 * (storage_get/set, aokie_speak, browser_action, image_gen, stt/tts, desktop_services).
 * Loop/join: the graph executor's converging-branch semantics (several activated
 * predecessors → the upstream map) provide the join behavior; neither existing runner has
 * a loop node type, so cycles stay an invalid_flow error here too.
 *
 * Credit lifecycle (plan §5.7): preflight → check allowance → decrement → run. A STARTED
 * run consumes the credit even on failure; preflight failures never consume. Bound: 60 s
 * wall clock (checked at every node boundary), 50-node execution budget (the same
 * FLOW_NODE_BUDGET the Rust runner enforces). flow_run_logs rows are written with
 * execution_location='cloud' in the same shape as desktop runs.
 */
class CloudFlowRunner
{
    public const MAX_WALL_CLOCK_SECONDS = 60;
    /** Mirrors FLOW_NODE_BUDGET in the desktop Rust runner. */
    public const MAX_NODES = 50;
    public const LIST_RESPONSES_DEFAULT_LIMIT = 200;
    public const LIST_RESPONSES_MAX_LIMIT = 500;
    public const MAX_HTTP_RESPONSE_BYTES = 262144;   // 256 KiB
    public const HTTP_TIMEOUT_SECONDS = 20;

    /** Node types the v1 cloud subset implements (see the class docblock). */
    public const SUPPORTED_TYPES = [
        'input',
        'output',
        'template',
        'formlogic_list_responses',
        'formlogic_submit_response',
        'formlogic_update_response',
        'llm_chat',
        'http_request',
        'connector_request',
    ];

    private const MAX_DEEP_RESOLVE_DEPTH = 8;

    private PDO $mysql;
    /** Same-connection FlowService — only for ensureFlowVersion (run revision pinning). */
    private FlowService $flowService;
    /** @var null|callable(string, string, array, ?string): array{status: int, body: string} */
    private $httpTransport;

    public function __construct(
        MySQLConnection $mysql,
        private ResponseService $responses,
        private AIService $ai,
        private PlanService $plans,
        private DesktopCommandService $commands,
        private string $siteBaseUrl = '',
        ?callable $httpTransport = null,
        private int $maxWallClockSeconds = self::MAX_WALL_CLOCK_SECONDS,
    ) {
        $this->mysql = $mysql->getConnection();
        $this->flowService = new FlowService($mysql);
        $this->siteBaseUrl = rtrim($siteBaseUrl, '/');
        $this->httpTransport = $httpTransport;
    }

    /**
     * Save-time AND run-time preflight (plan §5.7): the typed offending-node list for a
     * flow graph — every node whose type the cloud subset cannot execute. An empty list
     * means the graph is cloud-eligible.
     *
     * @return array<int, array{nodeId: string, type: string, reason: string}>
     */
    public static function validateCloudEligible(mixed $flowJson): array
    {
        if (!is_array($flowJson) || !isset($flowJson['nodes']) || !is_array($flowJson['nodes'])) {
            return [['nodeId' => '(graph)', 'type' => '(graph)', 'reason' => 'the flow graph is malformed']];
        }
        $offenders = [];
        foreach ($flowJson['nodes'] as $i => $node) {
            $id = is_array($node) && is_string($node['id'] ?? null) && $node['id'] !== ''
                ? (string) $node['id']
                : '(node ' . $i . ')';
            $type = is_array($node) && is_string($node['type'] ?? null) ? (string) $node['type'] : '';
            if (in_array($type, self::SUPPORTED_TYPES, true)) {
                continue;
            }
            $reason = match ($type) {
                'logic_block' => 'JS logic blocks cannot run in FormLogic Cloud (v1)',
                'condition' => 'JS condition nodes cannot run in FormLogic Cloud (v1)',
                'service_action' => 'service actions run on FormLogic Desktop (the ServiceActionHost lives there)',
                default => "node type '{$type}' is not supported by the cloud runner (v1)",
            };
            $offenders[] = ['nodeId' => $id, 'type' => $type !== '' ? $type : '(unknown)', 'reason' => $reason];
        }
        return $offenders;
    }

    /**
     * Run one flow synchronously in the cloud. The caller (FlowRunController) has already
     * ownership-gated the flow. Returns a discriminated outcome:
     *   ['ok' => false, 'code' => 'cloud_unsupported_node', 'nodes' => [...]]  (preflight, no credit)
     *   ['ok' => true, 'runId', 'status' => 'done', 'result', 'nodesExecuted']
     *   ['ok' => true, 'runId', 'status' => 'error', 'error' => ['code','message','nodeId'?]]
     *
     * @param array $flow A formatted flow row (FlowService::formatFlow shape).
     * @throws \RuntimeException 'flow_credits_exceeded' when the allowance is spent
     * @throws \InvalidArgumentException on an oversized inputs snapshot
     */
    public function run(array $flow, string $userId, array $inputs): array
    {
        // Run-time preflight, BEFORE any credit is touched (plan §5.7 — the save-time check
        // alone is not enough: a flow saved as 'auto' can be flipped to 'cloud' later, and
        // its graph can gain an unsupported node after the location was chosen).
        $offenders = self::validateCloudEligible($flow['flowJson'] ?? null);
        if ($offenders !== []) {
            return ['ok' => false, 'code' => 'cloud_unsupported_node', 'nodes' => $offenders];
        }

        $snapshot = json_encode($inputs);
        if ($snapshot === false || strlen($snapshot) > FlowService::MAX_INPUT_SNAPSHOT_BYTES) {
            throw new \InvalidArgumentException('inputs exceed the 64KB limit');
        }

        // Credit lifecycle: check allowance → decrement → run. A STARTED run consumes the
        // credit even on failure — there is no refund path for a run that errors mid-graph.
        $this->plans->checkAndIncrement($userId, 'cloud_flow_runs', 1);

        $runId = $this->uuid();
        $flowVersionId = $this->flowService->ensureFlowVersion((string) $flow['id']);
        $this->mysql->prepare("
            INSERT INTO flow_run_logs
                (id, app_id, flow_definition_id, flow_version_id, trigger_event, correlation_id, idempotency_key,
                 status, runtime, execution_location, input_snapshot_json, started_at)
            VALUES
                (:id, :app, :flow, :flow_version, 'manual', :corr, :key, 'running', 'cloud', 'cloud', :input, NOW())
        ")->execute([
            'id' => $runId,
            'app' => $flow['appId'],
            'flow' => $flow['id'],
            'flow_version' => $flowVersionId,
            'corr' => 'cloud-run-' . $runId,
            'key' => 'cloud:' . $runId,
            'input' => $snapshot,
        ]);

        try {
            $outcome = $this->execute($flow, $userId, $inputs);
        } catch (CloudFlowNodeError $e) {
            $this->finalizeRun($runId, 'error', null, [
                'code' => $e->flowErrorCode,
                'message' => $e->getMessage(),
                'nodeId' => $e->nodeId,
            ]);
            return [
                'ok' => true,
                'runId' => $runId,
                'status' => 'error',
                'error' => ['code' => $e->flowErrorCode, 'message' => $e->getMessage(), 'nodeId' => $e->nodeId],
            ];
        } catch (\Throwable $e) {
            // Never leak internals into the owner-visible log; the detail goes to the server log.
            error_log('CloudFlowRunner: run ' . $runId . ' failed unexpectedly: ' . $e->getMessage());
            $this->finalizeRun($runId, 'error', null, ['code' => 'node_failed', 'message' => 'The flow run failed']);
            return [
                'ok' => true,
                'runId' => $runId,
                'status' => 'error',
                'error' => ['code' => 'node_failed', 'message' => 'The flow run failed'],
            ];
        }

        $this->finalizeRun($runId, 'done', $outcome['result'], null);
        return [
            'ok' => true,
            'runId' => $runId,
            'status' => 'done',
            'result' => $outcome['result'],
            'nodesExecuted' => $outcome['nodesExecuted'],
        ];
    }

    // ── Graph execution (mirrors execute_flow in the desktop Rust runner) ─────────────────

    /**
     * @return array{result: mixed, nodesExecuted: int}
     * @throws CloudFlowNodeError
     */
    private function execute(array $flow, string $userId, array $inputs): array
    {
        [$nodes, $edges] = $this->parseGraph($flow['flowJson'] ?? null);
        if ($nodes === []) {
            return ['result' => [], 'nodesExecuted' => 0];
        }
        if (count($nodes) > self::MAX_NODES) {
            throw new CloudFlowNodeError('invalid_flow', 'Flow exceeds the ' . self::MAX_NODES . '-node budget');
        }
        $order = $this->topologicalOrder($nodes, $edges); // throws on a cycle

        $deadline = microtime(true) + max(0, $this->maxWallClockSeconds);

        // target => [[source, edge index], ...]. Activation is keyed by EDGE IDENTITY
        // (index), never "source→target", in lock-step with the browser and desktop
        // runners: parallel edges between the same two nodes must not share one key.
        // (No routing effect while condition isn't cloud-executable — every edge always
        // activates — but the keying must not drift between runtimes.)
        $incoming = [];
        foreach ($edges as $i => $e) {
            $incoming[$e['target']][] = [$e['source'], $i];
        }

        $outputs = [];
        $executed = [];
        $active = [];
        $activatedEdges = [];
        foreach ($nodes as $node) {
            if (empty($incoming[$node['id']])) {
                $active[$node['id']] = true;
            }
        }

        $appContext = $this->appContext($flow['appId'] ?? null);
        $nodesExecuted = 0;
        $sawOutput = false;
        $outputResult = null;
        $lastOutput = null;

        foreach ($order as $idx) {
            $node = $nodes[$idx];
            if (!isset($active[$node['id']])) {
                continue;
            }
            if (microtime(true) >= $deadline) {
                throw new CloudFlowNodeError('timeout', 'Flow run exceeded ' . max(0, $this->maxWallClockSeconds) . 's');
            }
            if ($nodesExecuted >= self::MAX_NODES) {
                throw new CloudFlowNodeError('invalid_flow', 'Flow exceeded the ' . self::MAX_NODES . '-node execution budget');
            }

            // Upstream: the single activated predecessor's output, or a map when
            // several branches converge (the executor's join semantics).
            $activeIn = [];
            foreach ($incoming[$node['id']] ?? [] as [$src, $edgeIndex]) {
                if (isset($executed[$src], $activatedEdges[$edgeIndex])) {
                    $activeIn[] = $src;
                }
            }
            $upstream = null;
            if (count($activeIn) === 1) {
                $upstream = $outputs[$activeIn[0]] ?? null;
            } elseif (count($activeIn) > 1) {
                $upstream = [];
                foreach ($activeIn as $src) {
                    $upstream[$src] = $outputs[$src] ?? null;
                }
            }

            $scope = [
                'inputs' => $inputs,
                'event' => null,
                'app' => $appContext,
                'nodes' => $outputs,
                'upstream' => $upstream,
                'result' => null,
            ];

            $output = $this->executeNode($node, $scope, $flow, $userId);

            $nodesExecuted++;
            $executed[$node['id']] = true;
            if ($node['type'] === 'output') {
                $sawOutput = true;
                $outputResult = $output;
            }
            $lastOutput = $output;
            $outputs[$node['id']] = $output;

            foreach ($edges as $i => $e) {
                if ($e['source'] !== $node['id']) {
                    continue;
                }
                // Non-condition nodes activate every outgoing edge; condition nodes are
                // not cloud-executable (preflight), so the Rust runner's handle routing
                // has no live case here.
                $activatedEdges[$i] = true;
                $active[$e['target']] = true;
            }
        }

        return ['result' => $sawOutput ? $outputResult : $lastOutput, 'nodesExecuted' => $nodesExecuted];
    }

    /** @return array{0: array<int, array{id: string, type: string, data: mixed}>, 1: array<int, array{source: string, target: string, sourceHandle: ?string}>} */
    private function parseGraph(mixed $flowJson): array
    {
        if (!is_array($flowJson) || !isset($flowJson['nodes'], $flowJson['edges'])
            || !is_array($flowJson['nodes']) || !is_array($flowJson['edges'])) {
            throw new CloudFlowNodeError('invalid_flow', 'flowJson must be an object of shape { nodes: [], edges: [] }');
        }
        $nodes = [];
        $ids = [];
        foreach ($flowJson['nodes'] as $i => $n) {
            $id = is_array($n) ? ($n['id'] ?? null) : null;
            if (!is_string($id) || $id === '') {
                throw new CloudFlowNodeError('invalid_flow', "Flow node at index {$i} is missing a valid id");
            }
            $type = is_array($n) ? ($n['type'] ?? null) : null;
            if (!is_string($type) || $type === '') {
                throw new CloudFlowNodeError('invalid_flow', "Flow node '{$id}' is missing a type");
            }
            if (isset($ids[$id])) {
                throw new CloudFlowNodeError('invalid_flow', "Duplicate flow node id: '{$id}'");
            }
            $ids[$id] = true;
            $nodes[] = ['id' => $id, 'type' => $type, 'data' => is_array($n) ? ($n['data'] ?? null) : null];
        }
        $edges = [];
        foreach ($flowJson['edges'] as $i => $e) {
            $source = is_array($e) ? ($e['source'] ?? null) : null;
            $target = is_array($e) ? ($e['target'] ?? null) : null;
            if (!is_string($source) || !is_string($target)) {
                throw new CloudFlowNodeError('invalid_flow', "Flow edge at index {$i} must have string source and target");
            }
            if (!isset($ids[$source], $ids[$target])) {
                throw new CloudFlowNodeError('invalid_flow', "Flow edge at index {$i} references a missing node ('{$source}' → '{$target}')");
            }
            $handle = is_array($e) && is_string($e['sourceHandle'] ?? null) ? $e['sourceHandle'] : null;
            $edges[] = ['source' => $source, 'target' => $target, 'sourceHandle' => $handle];
        }
        return [array_values($nodes), $edges];
    }

    /** Kahn toposort; throws invalid_flow on a cycle. @return int[] node indexes */
    private function topologicalOrder(array $nodes, array $edges): array
    {
        $index = [];
        foreach ($nodes as $i => $n) {
            $index[$n['id']] = $i;
        }
        $indegree = array_fill(0, count($nodes), 0);
        foreach ($edges as $e) {
            $indegree[$index[$e['target']]]++;
        }
        $queue = [];
        foreach ($nodes as $i => $n) {
            if ($indegree[$i] === 0) {
                $queue[] = $i;
            }
        }
        $order = [];
        $head = 0;
        while ($head < count($queue)) {
            $id = $queue[$head++];
            $order[] = $id;
            foreach ($edges as $e) {
                if ($e['source'] !== $nodes[$id]['id']) {
                    continue;
                }
                $t = $index[$e['target']];
                if (--$indegree[$t] === 0) {
                    $queue[] = $t;
                }
            }
        }
        if (count($order) !== count($nodes)) {
            throw new CloudFlowNodeError('invalid_flow', 'Flow graph contains a cycle');
        }
        return $order;
    }

    // ── Node executors ──

    /** @throws CloudFlowNodeError */
    private function executeNode(array $node, array $scope, array $flow, string $userId): mixed
    {
        $data = is_array($node['data']) ? $node['data'] : [];
        switch ($node['type']) {
            case 'input':
                return $scope['inputs'];

            case 'output':
                return array_key_exists('value', $data)
                    ? $this->resolveDeep($data['value'], $scope)
                    : $scope['upstream'];

            case 'template':
                $template = $this->requireString($node, $data, ['template', 'text']);
                return $this->interpolateTemplate($template, $this->scopeToContext($scope));

            case 'formlogic_list_responses':
                return $this->runListResponses($node, $data, $scope);

            case 'formlogic_submit_response':
                return $this->runSubmitResponse($node, $data, $scope);

            case 'formlogic_update_response':
                return $this->runUpdateResponse($node, $data, $scope);

            case 'llm_chat':
                return $this->runLlmChat($node, $data, $scope, $userId);

            case 'http_request':
                return $this->runHttpRequest($node, $data, $scope);

            case 'connector_request':
                return $this->runConnectorRequest($node, $data, $scope, $flow, $userId);

            default:
                // Defense in depth: validateCloudEligible runs before any credit is touched,
                // so this is unreachable in a legitimate run.
                throw new CloudFlowNodeError(
                    'invalid_flow',
                    "cloud_unsupported_node — node type '{$node['type']}' (node '{$node['id']}') is not cloud-executable",
                    $node['id'],
                );
        }
    }

    private ?FormEncryptionService $formEncryption = null;

    /**
     * E2EE §9.2 gate (docs/E2EE_PRIVATE_FORMS_PLAN.md): cloud record nodes never
     * touch a private form — reads would hand ciphertext to flows/LLMs, writes
     * would smuggle plaintext past the envelope pipeline. Uses the closed
     * 'node_failed' error-code set (the cross-runner contract is frozen); the
     * stable private_form_encrypted marker rides in the message.
     *
     * @throws CloudFlowNodeError
     */
    private function assertNotPrivateForm(array $node, string $formId): void
    {
        $this->formEncryption ??= new FormEncryptionService($this->mysql);
        if ($this->formEncryption->isPrivate($formId)) {
            throw new CloudFlowNodeError(
                'node_failed',
                "Node '{$node['id']}': this form is end-to-end encrypted — cloud flow nodes cannot read or write its responses (private_form_encrypted)",
                is_string($node['id'] ?? null) ? $node['id'] : null,
            );
        }
    }

    /** FROZEN CONTRACT (docs §4): fetch up to `limit` rows, normalize, apply ANDed filters, return {responses, count, first, found}. */
    private function runListResponses(array $node, array $data, array $scope): array
    {
        $formId = $this->resolveFormRef($node, $data, $scope);
        $this->assertNotPrivateForm($node, $formId);
        $limit = $this->clampListLimit($data['limit'] ?? null);
        $filters = $this->parseResponseFilters($data['filters'] ?? null);

        // Server-side pushdown (same rule as both runners): eq/phone_eq/gte/lte filters with
        // a STRING resolved value narrow the SQL fetch; every filter still applies below.
        $options = ['limit' => $limit];
        foreach ($filters as $f) {
            if (!preg_match('/^[A-Za-z0-9_]{1,64}$/', $f['field'])) {
                continue;
            }
            $resolved = $this->resolveSelector($f['value'], $scope);
            if (!is_string($resolved)) {
                continue;
            }
            match ($f['op']) {
                'eq' => $options['answersEq'][$f['field']] = $resolved,
                'phone_eq' => $options['answersPhoneEq'][$f['field']] = $resolved,
                'gte' => $options['answersGte'][$f['field']] = $resolved,
                'lte' => $options['answersLte'][$f['field']] = $resolved,
                default => null,
            };
        }

        $raw = $this->responses->getFormResponses($formId, $options);
        $rows = [];
        foreach ($raw as $item) {
            $row = $this->normalizeResponseRow($item);
            if ($row !== null) {
                $rows[] = $row;
            }
        }
        $matched = $filters === [] ? $rows : array_values(array_filter($rows, function (array $row) use ($filters, $scope): bool {
            foreach ($filters as $f) {
                $fieldValue = $row['answers'][$f['field']] ?? null;
                $resolved = $this->resolveSelector($f['value'], $scope);
                if (!$this->matchesFilterOp($fieldValue, $f['op'], $resolved)) {
                    return false;
                }
            }
            return true;
        }));

        return [
            'responses' => $matched,
            'count' => count($matched),
            'first' => $matched[0] ?? null,
            'found' => $matched !== [],
        ];
    }

    private function runSubmitResponse(array $node, array $data, array $scope): array
    {
        $formId = $this->resolveFormRef($node, $data, $scope);
        $this->assertNotPrivateForm($node, $formId);
        $answers = $this->resolveDeep($data['answers'] ?? null, $scope);
        $this->requireObject($node, $answers);
        try {
            $created = $this->responses->createResponse($formId, ['answers' => $answers]);
        } catch (\RuntimeException $e) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}': {$e->getMessage()}", $node['id']);
        }
        if (!is_array($created)) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}': the submission was rejected by the form's script", $node['id']);
        }
        return $this->normalizeResponseRow($created) ?? $created;
    }

    private function runUpdateResponse(array $node, array $data, array $scope): array
    {
        $formId = $this->resolveFormRef($node, $data, $scope);
        $this->assertNotPrivateForm($node, $formId);
        $responseId = $this->resolveSelector($data['responseId'] ?? null, $scope);
        if (!is_string($responseId) || $responseId === '') {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}' responseId did not resolve", $node['id']);
        }
        $answers = $this->resolveDeep($data['answers'] ?? null, $scope);
        $this->requireObject($node, $answers);
        $updated = $this->responses->updateResponse($formId, $responseId, ['answers' => $answers]);
        if ($updated === null) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}': response not found", $node['id']);
        }
        return $this->normalizeResponseRow($updated) ?? $updated;
    }

    /**
     * Hosted Site AI (plan §5.7): the node's Default resolution ON CLOUD is always the
     * hosted chat — a node pinning an explicit desktop provider/endpoint cannot run here
     * (typed failure, never a silent source hop). Each call meters ai_messages (the
     * deliberate double-metering beside the run's cloud_flow_runs credit).
     */
    private function runLlmChat(array $node, array $data, array $scope, string $userId): array
    {
        $tctx = $this->scopeToContext($scope);
        $provider = isset($data['provider']) && is_string($data['provider'])
            ? trim($this->interpolateTemplate($data['provider'], $tctx))
            : '';
        $endpoint = isset($data['endpoint']) && is_string($data['endpoint']) ? trim($data['endpoint']) : '';
        if (($provider !== '' && $provider !== 'default') || $endpoint !== '') {
            throw new CloudFlowNodeError(
                'node_failed',
                "Node '{$node['id']}' llm_chat pins an explicit desktop provider/endpoint, which a cloud run cannot reach — set the node to Default (from Settings) to run it in the cloud",
                $node['id'],
            );
        }

        $messages = [];
        if (isset($data['system']) && is_string($data['system']) && $data['system'] !== '') {
            $messages[] = ['role' => 'system', 'content' => $this->interpolateTemplate($data['system'], $tctx)];
        }
        if (isset($data['messages']) && is_array($data['messages'])) {
            foreach ($data['messages'] as $m) {
                if (is_array($m) && is_string($m['role'] ?? null) && is_string($m['content'] ?? null)) {
                    $messages[] = ['role' => $m['role'], 'content' => $this->interpolateTemplate($m['content'], $tctx)];
                }
            }
        }
        if (isset($data['prompt']) && is_string($data['prompt']) && $data['prompt'] !== '') {
            $messages[] = ['role' => 'user', 'content' => $this->interpolateTemplate($data['prompt'], $tctx)];
        }
        if ($messages === []) {
            throw new CloudFlowNodeError('invalid_flow', "Node '{$node['id']}' llm_chat has no prompt/messages", $node['id']);
        }

        // Allowance gate (one hosted message = one ai_messages unit) BEFORE the call — the
        // same started-consumes honesty as the run credit; over-allowance is a typed node
        // failure, not a run abort with a generic message.
        try {
            $this->plans->checkAndIncrement($userId, 'ai_messages', 1);
        } catch (\RuntimeException $e) {
            throw new CloudFlowNodeError('node_failed', 'ai_allowance_exceeded — this month\'s hosted AI allowance is used up', $node['id']);
        }

        try {
            $result = $this->ai->chat($messages, false);
        } catch (\Throwable $e) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}' llm_chat failed: {$e->getMessage()}", $node['id']);
        }
        $usage = is_array($result['usage'] ?? null) ? $result['usage'] : [];
        $in = (int) ($usage['promptTokens'] ?? 0);
        $out = (int) ($usage['completionTokens'] ?? 0);
        if ($in > 0 || $out > 0) {
            // Token usage arrives only after the upstream answers; meter it post-hoc (never gated).
            $this->plans->recordUsage($userId, 'ai_messages', 0, $in, $out);
        }
        return ['content' => (string) ($result['content'] ?? ''), 'usage' => $usage];
    }

    /**
     * Egress-allow-listed HTTP (plan §5.7): the ONLY reachable base is the site's own URL
     * (mirroring is_allowed_flow_url in the desktop runner — FormLogic base or nothing).
     * Redirects are NOT followed: a 30x to an arbitrary host would bypass the allow-list,
     * and the cloud's egress is shared infrastructure, not the user's own machine.
     */
    private function runHttpRequest(array $node, array $data, array $scope): array
    {
        $rawUrl = $this->requireString($node, $data, ['url']);
        $url = $this->interpolateTemplate($rawUrl, $this->scopeToContext($scope));
        if (!$this->isAllowedFlowUrl($url)) {
            throw new CloudFlowNodeError(
                'capability_denied',
                "Node '{$node['id']}' http_request URL is not allow-listed (the FormLogic site base URL only)",
                $node['id'],
            );
        }
        $method = isset($data['method']) && is_string($data['method']) && $data['method'] !== ''
            ? strtoupper($data['method'])
            : 'GET';
        if (!preg_match('/^[A-Z]{2,16}$/', $method)) {
            throw new CloudFlowNodeError('invalid_flow', "Node '{$node['id']}' bad method", $node['id']);
        }
        $headers = [];
        if (isset($data['headers']) && is_array($data['headers'])) {
            foreach ($data['headers'] as $k => $v) {
                if (is_string($k) && is_string($v)) {
                    $headers[] = $k . ': ' . $v;
                }
            }
        }
        $body = null;
        if (array_key_exists('body', $data) && $method !== 'GET' && $method !== 'HEAD') {
            $body = json_encode($this->resolveDeep($data['body'], $scope));
        }

        $transport = $this->httpTransport ?? $this->defaultHttpTransport(...);
        try {
            $res = $transport($method, $url, $headers, $body);
        } catch (\Throwable $e) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}': http_request failed: {$e->getMessage()}", $node['id']);
        }
        $status = (int) ($res['status'] ?? 0);
        $text = (string) ($res['body'] ?? '');
        $decoded = $text === '' ? null : json_decode($text, true);
        return [
            'status' => $status,
            'ok' => $status >= 200 && $status < 300,
            'body' => $text === '' ? null : (json_last_error() === JSON_ERROR_NONE ? $decoded : $text),
        ];
    }

    /**
     * A connector command the cloud flow needs is ENQUEUED for the linked desktop through
     * DesktopCommandService (plan §5.7) — the run does NOT wait for a result: the node
     * returns the relay receipt {accepted, queued, commandId}. Typed 'no_linked_desktop'
     * when the owner has no linked desktop at all. The declare-then-grant capability gate
     * (connector.<id>.<command> or connector.<id>.* in nodeCapabilities) matches both runners.
     */
    private function runConnectorRequest(array $node, array $data, array $scope, array $flow, string $userId): array
    {
        $connectorId = $this->requireString($node, $data, ['connectorId', 'connector']);
        $command = $this->requireString($node, $data, ['command']);
        $payload = array_key_exists('payload', $data) ? $this->resolveDeep($data['payload'], $scope) : null;

        $exact = "connector.{$connectorId}.{$command}";
        $wildcard = "connector.{$connectorId}.*";
        $capabilities = is_array($flow['nodeCapabilities'] ?? null) ? $flow['nodeCapabilities'] : [];
        if (!in_array($exact, $capabilities, true) && !in_array($wildcard, $capabilities, true)) {
            throw new CloudFlowNodeError(
                'capability_denied',
                "Node '{$node['id']}' requires the '{$exact}' capability — add `{$exact}` or `{$wildcard}` to the flow's nodeCapabilities",
                $node['id'],
            );
        }
        try {
            DesktopCommandService::assertPublicRelayCommand($connectorId, $command);
        } catch (\InvalidArgumentException $e) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}': {$e->getMessage()}", $node['id']);
        }

        $ownerUserId = (string) ($flow['ownerUserId'] ?? $userId);
        if (!$this->commands->hasLinkedDesktop($ownerUserId)) {
            throw new CloudFlowNodeError(
                'node_failed',
                "no_linked_desktop — Node '{$node['id']}' needs a linked FormLogic Desktop to run connector {$connectorId}.{$command}",
                $node['id'],
            );
        }
        $resolved = $this->commands->resolveTargetInstance($ownerUserId, $connectorId);
        if (($resolved['error'] ?? null) === 'ambiguous_desktop') {
            throw new CloudFlowNodeError(
                'node_failed',
                "ambiguous_desktop — more than one FormLogic Desktop is online; the owner must pin which machine runs '{$connectorId}' commands",
                $node['id'],
            );
        }

        $enqueued = $this->commands->enqueue($ownerUserId, $userId, $flow['appId'] ?? null, [
            'connectorId' => $connectorId,
            'command' => $command,
            'payload' => $payload,
            'targetInstanceId' => $resolved['target'],
        ]);
        $cmd = $enqueued['command'];
        return [
            'accepted' => true,
            'queued' => true,
            'commandId' => $cmd['commandId'],
            'status' => $cmd['status'],
        ];
    }

    // ── Selector + template engine (mirrors ui/src/client-runtime/flows/selectors.ts) ─────

    private function isSelector(mixed $value): bool
    {
        if (!is_string($value) || $value === '' || $value[0] !== '$') {
            return false;
        }
        $root = explode('.', $value, 2)[0];
        return in_array($root, ['$event', '$app', '$result', '$input', '$inputs', '$nodes', '$upstream'], true);
    }

    private function resolveSelector(mixed $value, array $scope): mixed
    {
        if (!$this->isSelector($value)) {
            return $value;
        }
        $parts = explode('.', $value);
        $root = array_shift($parts);
        $base = match ($root) {
            '$event' => $scope['event'] ?? null,
            '$app' => $scope['app'] ?? null,
            '$result' => $scope['result'] ?? null,
            '$input', '$inputs' => $scope['inputs'] ?? null,
            '$nodes' => $scope['nodes'] ?? null,
            '$upstream' => $scope['upstream'] ?? null,
            default => null,
        };
        return $parts === [] ? $base : $this->resolvePath($base, $parts);
    }

    /** Walk path segments into $root; a missing/non-object hop yields null. */
    private function resolvePath(mixed $root, array $path): mixed
    {
        $current = $root;
        foreach ($path as $segment) {
            if ($current === null) {
                return null;
            }
            if (is_array($current) && array_is_list($current)) {
                if (!ctype_digit($segment) || (int) $segment >= count($current)) {
                    return null;
                }
                $current = $current[(int) $segment];
                continue;
            }
            if (!is_array($current) || !array_key_exists($segment, $current)) {
                return null;
            }
            $current = $current[$segment];
        }
        return $current;
    }

    /** Recursively resolve selector strings inside a plain object/array (depth-capped). */
    private function resolveDeep(mixed $value, array $scope, int $depth = 0): mixed
    {
        if ($depth > self::MAX_DEEP_RESOLVE_DEPTH) {
            return $value;
        }
        if ($this->isSelector($value)) {
            return $this->resolveSelector($value, $scope);
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $out[$k] = $this->resolveDeep($v, $scope, $depth + 1);
            }
            return $out;
        }
        return $value;
    }

    /** Interpolate a {{path}} template (a leading '$' is tolerated); missing → ''. */
    private function interpolateTemplate(string $template, array $context): string
    {
        return (string) preg_replace_callback('/\{\{\s*([^{}]+?)\s*\}\}/', function (array $m) use ($context): string {
            $path = trim($m[1]);
            if (str_starts_with($path, '$')) {
                $path = substr($path, 1);
            }
            $value = $this->resolvePath($context, explode('.', $path));
            if ($value === null) {
                return '';
            }
            if (is_array($value)) {
                return (string) json_encode($value, JSON_UNESCAPED_SLASHES);
            }
            if (is_bool($value)) {
                return $value ? 'true' : 'false';
            }
            return (string) $value;
        }, $template);
    }

    /** The template/interpolation context for a scope (same roots, without '$'). */
    private function scopeToContext(array $scope): array
    {
        return [
            'event' => $scope['event'] ?? null,
            'app' => $scope['app'] ?? null,
            'result' => $scope['result'] ?? null,
            'input' => $scope['inputs'] ?? null,
            'inputs' => $scope['inputs'] ?? null,
            'nodes' => $scope['nodes'] ?? null,
            'upstream' => $scope['upstream'] ?? null,
        ];
    }

    // ── Filter semantics (mirrors matchesFilterOp in both runners) ──

    private function parseResponseFilters(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $out = [];
        foreach ($raw as $item) {
            if (!is_array($item)) {
                continue;
            }
            $field = is_string($item['field'] ?? null) ? trim($item['field']) : '';
            if ($field === '') {
                continue;
            }
            $op = is_string($item['op'] ?? null) ? $item['op'] : 'eq';
            if (!in_array($op, ['eq', 'neq', 'contains', 'gt', 'lt', 'gte', 'lte', 'in', 'phone_eq'], true)) {
                $op = 'eq';
            }
            $out[] = ['field' => $field, 'op' => $op, 'value' => $item['value'] ?? null];
        }
        return $out;
    }

    private function matchesFilterOp(mixed $fieldValue, string $op, mixed $filterValue): bool
    {
        return match ($op) {
            'eq' => $this->looseEquals($fieldValue, $filterValue),
            'neq' => !$this->looseEquals($fieldValue, $filterValue),
            'contains' => str_contains(
                strtolower($this->jsStringNullish($fieldValue)),
                strtolower($this->jsStringNullish($filterValue)),
            ),
            'gt' => $this->numericCompare($fieldValue, $filterValue) > 0,
            'lt' => $this->numericCompare($fieldValue, $filterValue) < 0,
            'gte' => $this->numericCompare($fieldValue, $filterValue) >= 0,
            'lte' => $this->numericCompare($fieldValue, $filterValue) <= 0,
            'in' => $this->inList($fieldValue, $filterValue),
            'phone_eq' => ResponseService::phoneDigitsMatch(
                $this->jsStringNullish($fieldValue),
                $this->jsStringNullish($filterValue),
            ),
            default => $this->looseEquals($fieldValue, $filterValue),
        };
    }

    /** JS String(v) for scalars; arrays comma-join; objects → "[object Object]". */
    private function jsString(mixed $v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_int($v) || is_float($v)) {
            return $this->jsNumberString($v);
        }
        if (is_string($v)) {
            return $v;
        }
        if (is_array($v) && array_is_list($v)) {
            return implode(',', array_map(fn ($x) => $x === null ? '' : $this->jsString($x), $v));
        }
        return '[object Object]';
    }

    /** JS Number→String: 42.0 prints "42", 0.1 prints "0.1" (PHP (string) agrees except for floats like 1.0). */
    private function jsNumberString(int|float $v): string
    {
        if (is_float($v) && floor($v) === $v && abs($v) < 1e15) {
            return (string) (int) $v;
        }
        return (string) $v;
    }

    /** JS String(v ?? '') — null coerces to the empty string. */
    private function jsStringNullish(mixed $v): string
    {
        return $v === null ? '' : $this->jsString($v);
    }

    /** JS Number(v); null when NaN. */
    private function jsNumber(mixed $v): ?float
    {
        if (is_int($v) || is_float($v)) {
            return (float) $v;
        }
        if (is_bool($v)) {
            return $v ? 1.0 : 0.0;
        }
        if ($v === null) {
            return 0.0;
        }
        if (is_string($v)) {
            $t = trim($v);
            if ($t === '') {
                return 0.0;
            }
            return is_numeric($t) ? (float) $t : null;
        }
        return null;
    }

    /** Loose equality: identity, else String()-compare (never across null). */
    private function looseEquals(mixed $a, mixed $b): bool
    {
        if ($a === $b) {
            return true;
        }
        if ($a === null || $b === null) {
            return false;
        }
        return $this->jsString($a) === $this->jsString($b);
    }

    /** Numeric compare with a string fallback when either side is non-numeric. */
    private function numericCompare(mixed $a, mixed $b): float
    {
        $na = $this->jsNumber($a);
        $nb = $this->jsNumber($b);
        if ($na !== null && $nb !== null) {
            return $na - $nb;
        }
        return strcmp($this->jsStringNullish($a), $this->jsStringNullish($b));
    }

    /** `one of` membership: the filter value is an array or a comma list; loose-equals membership. */
    private function inList(mixed $fieldValue, mixed $filterValue): bool
    {
        $list = is_array($filterValue) && array_is_list($filterValue)
            ? $filterValue
            : array_values(array_filter(array_map('trim', explode(',', $this->jsStringNullish($filterValue))), fn ($s) => $s !== ''));
        foreach ($list as $item) {
            if ($this->looseEquals($fieldValue, $item)) {
                return true;
            }
        }
        return false;
    }

    // ── Small shared helpers ──

    private function requireString(array $node, array $data, array $keys): string
    {
        foreach ($keys as $k) {
            if (isset($data[$k]) && is_string($data[$k]) && trim($data[$k]) !== '') {
                return $data[$k];
            }
        }
        throw new CloudFlowNodeError('invalid_flow', "Node '{$node['id']}' ({$node['type']}) is missing '{$keys[0]}'", $node['id']);
    }

    private function requireObject(array $node, mixed $v): void
    {
        if (!is_array($v) || array_is_list($v)) {
            throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}' answers did not resolve to an object", $node['id']);
        }
    }

    private function resolveFormRef(array $node, array $data, array $scope): string
    {
        $raw = $this->requireString($node, $data, ['form', 'formId']);
        $resolved = $this->resolveSelector($raw, $scope);
        if (is_string($resolved) && $resolved !== '') {
            return $resolved;
        }
        throw new CloudFlowNodeError('node_failed', "Node '{$node['id']}' form reference did not resolve to a form id", $node['id']);
    }

    private function clampListLimit(mixed $raw): int
    {
        $n = is_numeric($raw) ? (int) floor((float) $raw) : self::LIST_RESPONSES_DEFAULT_LIMIT;
        return max(1, min(self::LIST_RESPONSES_MAX_LIMIT, $n));
    }

    /** Normalize a raw response record to the frozen {id, answers, submittedAt?, status?} row. */
    private function normalizeResponseRow(mixed $raw): ?array
    {
        if (!is_array($raw) || array_is_list($raw)) {
            return null;
        }
        $id = $raw['id'] ?? '';
        $row = [
            'id' => is_string($id) || is_int($id) ? (string) $id : '',
            'answers' => isset($raw['answers']) && is_array($raw['answers']) ? $raw['answers'] : [],
        ];
        foreach (['submittedAt', 'submitted_at', 'createdAt', 'created_at'] as $k) {
            if (isset($raw[$k]) && is_string($raw[$k]) && $raw[$k] !== '') {
                $row['submittedAt'] = $raw[$k];
                break;
            }
        }
        if (isset($raw['status']) && is_string($raw['status']) && $raw['status'] !== '') {
            $row['status'] = $raw['status'];
        }
        return $row;
    }

    /** FormLogic base allow-list (mirrors is_allowed_flow_url): the site base URL ONLY. */
    private function isAllowedFlowUrl(string $url): bool
    {
        return $this->siteBaseUrl !== ''
            && ($url === $this->siteBaseUrl || str_starts_with($url, $this->siteBaseUrl . '/'));
    }

    /**
     * The production HTTP transport (cURL). Redirects are never followed (see runHttpRequest);
     * the response body is capped at MAX_HTTP_RESPONSE_BYTES.
     *
     * @param string[] $headers
     * @return array{status: int, body: string}
     */
    private function defaultHttpTransport(string $method, string $url, array $headers, ?string $body): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('could not initialize the HTTP client');
        }
        $headers[] = 'Content-Type: application/json';
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => self::HTTP_TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_REDIR_PROTOCOLS => 0,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        if ($body !== null) {
            $opts[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($ch, $opts);
        $result = curl_exec($ch);
        if ($result === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException($err !== '' ? $err : 'request failed');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'body' => substr((string) $result, 0, self::MAX_HTTP_RESPONSE_BYTES)];
    }

    /** The {id, slug, name} app context for $app selectors, or null for workspace flows. */
    private function appContext(?string $appId): ?array
    {
        if ($appId === null || $appId === '') {
            return null;
        }
        $stmt = $this->mysql->prepare("SELECT id, slug, name FROM apps WHERE id = :id LIMIT 1");
        $stmt->execute(['id' => $appId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    private function finalizeRun(string $runId, string $status, mixed $result, ?array $error): void
    {
        $this->mysql->prepare("
            UPDATE flow_run_logs
            SET status = :s, result_json = :result, error_json = :error, finished_at = NOW()
            WHERE id = :id
        ")->execute([
            's' => $status,
            'result' => $status === 'done' ? json_encode($result) : null,
            'error' => $error !== null ? json_encode($error) : null,
            'id' => $runId,
        ]);
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
