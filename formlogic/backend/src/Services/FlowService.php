<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * FormLogic Flows (docs/FORMLOGIC_FLOWS.md): app-scoped flow definitions (F2I WorkflowGraph JSON),
 * event bindings, the reserve-first run log, and the desktop-connection registry.
 *
 * All sanitization lives here as STATIC helpers so the pack import path (PackService) enforces the
 * exact same caps as the owner CRUD API — a pack can never smuggle what the API would reject.
 * Server-side caps mirror docs/contracts/flow-binding.schema.json:
 *   flow_json ≤ 256 KiB, each binding JSON column ≤ 16 KiB, ≤ 50 flows / ≤ 100 bindings per app.
 */
class FlowService
{
    public const MAX_FLOW_JSON_BYTES = 262144;      // 256 KiB
    public const MAX_BINDING_JSON_BYTES = 16384;    // 16 KiB per JSON column
    public const MAX_INPUT_SNAPSHOT_BYTES = 65536;  // 64 KiB per run inputSnapshot
    public const MAX_FLOWS_PER_APP = 50;
    public const MAX_BINDINGS_PER_APP = 100;

    public const SLUG_PATTERN = '/^[a-z][a-z0-9-]{1,127}$/';
    public const EVENT_PATTERN = '/^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)*$/';

    public const MODES = ['sync', 'async', 'background', 'manual'];
    public const OUTPUT_ACTION_TYPES = [
        'formlogic.submitResponse',
        'formlogic.updateResponse',
        'formlogic.toast',
        'connector.request',
        'call.speak',
        'formlogic.store',
    ];
    public const RUN_ACTIVE_STATUSES = ['queued', 'running'];
    public const RUN_TERMINAL_STATUSES = ['done', 'error', 'timeout', 'cancelled'];
    public const RUN_ERROR_CODES = ['node_failed', 'timeout', 'cancelled', 'capability_denied', 'invalid_flow', 'runner_unavailable'];
    /** Per-flow execution location (plan §5.7): auto = today's behavior, desktop = E2E relay lane, cloud = CloudFlowRunner. */
    public const EXECUTION_LOCATIONS = ['auto', 'desktop', 'cloud'];
    /** reclaimStuckRuns() default staleness threshold — see that method's docblock for the reasoning. */
    public const STUCK_RUN_DEFAULT_MAX_AGE_SECONDS = 600;

    /** Runtimes that may claim a queued run (queued→running exactly once). */
    public const RUNTIMES = ['browser', 'desktop'];
    /** Max ctx.flows.run() intents enqueued per form submission. */
    public const MAX_SCRIPT_FLOW_RUNS = 3;
    /** Max form.submitted bindings enqueued per form submission. */
    public const MAX_SUBMIT_BINDINGS_PER_SUBMISSION = 5;

    private const TIMEOUT_MIN_MS = 250;
    private const TIMEOUT_MAX_MS = 300000;
    private const TIMEOUT_DEFAULT_MS = 30000;

    private PDO $mysql;
    private ?FormEncryptionService $formEncryption = null;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * E2EE §9.2 gate: flow bindings hand answer snapshots to runners — binding a
     * private (end-to-end encrypted) form is refused at creation, matching the
     * enable preflight that guarantees none pre-exist.
     *
     * @throws PrivateFormEncryptedException
     */
    private function assertBindableForm(?string $formId): void
    {
        if ($formId === null || $formId === '') {
            return;
        }
        $this->formEncryption ??= new FormEncryptionService($this->mysql);
        // Enable-race gate: mid-enable the refusal is encryption_enabling (409).
        $this->formEncryption->assertNotEnabling($formId);
        if ($this->formEncryption->isPrivate($formId)) {
            throw new PrivateFormEncryptedException('Flow bindings are not available on private (end-to-end encrypted) forms (private_form_encrypted).');
        }
    }

    // ── Static sanitization (shared with PackService::validatePack) ─────────────────────────

    /** Validate a flow slug (^[a-z][a-z0-9-]{1,127}$). @throws \InvalidArgumentException */
    public static function sanitizeSlug(mixed $slug): string
    {
        if (!is_string($slug) || !preg_match(self::SLUG_PATTERN, $slug)) {
            throw new \InvalidArgumentException('Flow slug must be 2–128 chars: lowercase letters, digits and hyphens, starting with a letter');
        }
        return $slug;
    }

    /** Validate a flow execution location ('auto'|'desktop'|'cloud'). @throws \InvalidArgumentException */
    public static function sanitizeExecutionLocation(mixed $location): string
    {
        if (!is_string($location) || !in_array($location, self::EXECUTION_LOCATIONS, true)) {
            throw new \InvalidArgumentException('executionLocation must be one of: ' . implode(', ', self::EXECUTION_LOCATIONS));
        }
        return $location;
    }

    /**
     * Parse the optional `expectedVersion` optimistic-concurrency guard from an update
     * payload (extensible-flows plan §14.2). Absent/null → no guard (today's behavior).
     * @throws \InvalidArgumentException
     */
    private static function sanitizeExpectedVersion(array $data): ?int
    {
        if (!array_key_exists('expectedVersion', $data) || $data['expectedVersion'] === null) {
            return null;
        }
        $v = $data['expectedVersion'];
        if (!is_int($v) && !(is_string($v) && ctype_digit($v))) {
            throw new \InvalidArgumentException('expectedVersion must be a positive integer');
        }
        $v = (int) $v;
        if ($v < 1) {
            throw new \InvalidArgumentException('expectedVersion must be a positive integer');
        }
        return $v;
    }

    /**
     * Validate a WorkflowGraph-compatible flow graph: { nodes: [{id,type,...}], edges: [{source,target,...}] }.
     * Node ids must be unique; every edge must reference existing nodes; encoded size ≤ 256 KiB.
     * Returns the normalized graph. @throws \InvalidArgumentException
     */
    public static function sanitizeFlowJson(mixed $flowJson): array
    {
        if (!is_array($flowJson) || !isset($flowJson['nodes'], $flowJson['edges'])
            || !is_array($flowJson['nodes']) || !is_array($flowJson['edges'])
            || !array_is_list($flowJson['nodes']) || !array_is_list($flowJson['edges'])) {
            throw new \InvalidArgumentException('flowJson must be an object of shape { nodes: [], edges: [] }');
        }

        $encoded = json_encode($flowJson);
        if ($encoded === false || strlen($encoded) > self::MAX_FLOW_JSON_BYTES) {
            throw new \InvalidArgumentException('flowJson exceeds the 256KB limit');
        }

        $nodeIds = [];
        foreach ($flowJson['nodes'] as $i => $node) {
            $id = is_array($node) ? ($node['id'] ?? null) : null;
            if (!is_string($id) || $id === '' || strlen($id) > 128) {
                throw new \InvalidArgumentException("Flow node at index {$i} is missing a valid id");
            }
            if (!is_string($node['type'] ?? null) || $node['type'] === '') {
                throw new \InvalidArgumentException("Flow node '{$id}' is missing a type");
            }
            if (isset($nodeIds[$id])) {
                throw new \InvalidArgumentException("Duplicate flow node id: '{$id}'");
            }
            $nodeIds[$id] = true;
        }
        $edgeIds = [];
        foreach ($flowJson['edges'] as $i => $edge) {
            $source = is_array($edge) ? ($edge['source'] ?? null) : null;
            $target = is_array($edge) ? ($edge['target'] ?? null) : null;
            if (!is_string($source) || !is_string($target)) {
                throw new \InvalidArgumentException("Flow edge at index {$i} must have string source and target");
            }
            if (!isset($nodeIds[$source]) || !isset($nodeIds[$target])) {
                throw new \InvalidArgumentException("Flow edge at index {$i} references a missing node ('{$source}' → '{$target}')");
            }
            // Graph v2 (additive, extensible-flows plan §6.2): an edge MAY carry a stable id —
            // non-empty string, ≤128 chars, unique. Mirrors validateWorkflowGraph (browser) and
            // parse_graph (desktop runner); edges without ids stay legal (legacy v1).
            if (is_array($edge) && array_key_exists('id', $edge)) {
                $edgeId = $edge['id'];
                if (!is_string($edgeId) || $edgeId === '' || strlen($edgeId) > 128) {
                    throw new \InvalidArgumentException("Flow edge at index {$i} has an invalid id");
                }
                if (isset($edgeIds[$edgeId])) {
                    throw new \InvalidArgumentException("Duplicate flow edge id: '{$edgeId}'");
                }
                $edgeIds[$edgeId] = true;
            }
        }

        $out = ['nodes' => array_values($flowJson['nodes']), 'edges' => array_values($flowJson['edges'])];
        // Carry graphVersion through (previously stripped): reserved graph-v2 marker; only
        // 1 and 2 are meaningful today and anything else is rejected rather than laundered.
        if (array_key_exists('graphVersion', $flowJson)) {
            $gv = $flowJson['graphVersion'];
            if (!is_int($gv) || $gv < 1 || $gv > 2) {
                throw new \InvalidArgumentException('graphVersion must be 1 or 2');
            }
            $out['graphVersion'] = $gv;
        }
        return $out;
    }

    /**
     * Validate + normalize one binding config per flow-binding.schema.json semantics:
     * event pattern, flow slug, mode enum, condition/inputMap/outputActions/retryPolicy/fallbackPolicy
     * shapes, outputAction type whitelist, timeout bounds 250..300000, each JSON column ≤ 16 KiB.
     * Returns the normalized fields (unknown outputAction keys are stripped). @throws \InvalidArgumentException
     */
    public static function sanitizeBinding(array $input): array
    {
        $event = $input['event'] ?? null;
        if (!is_string($event) || $event === '' || strlen($event) > 150 || !preg_match(self::EVENT_PATTERN, $event)) {
            throw new \InvalidArgumentException('Binding event must match ^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)*$ (max 150 chars)');
        }

        $flow = self::sanitizeSlug($input['flow'] ?? null);

        $mode = $input['mode'] ?? null;
        if (!is_string($mode) || !in_array($mode, self::MODES, true)) {
            throw new \InvalidArgumentException('Binding mode must be one of: ' . implode(', ', self::MODES));
        }

        $condition = null;
        if (isset($input['condition']) && $input['condition'] !== null) {
            $c = $input['condition'];
            if (!is_array($c) || ($c['type'] ?? null) !== 'expression'
                || !is_string($c['expr'] ?? null) || strlen($c['expr']) > 1000) {
                throw new \InvalidArgumentException('Binding condition must be { type: "expression", expr: string ≤ 1000 chars }');
            }
            $condition = ['type' => 'expression', 'expr' => $c['expr']];
        }

        $inputMap = null;
        if (isset($input['inputMap']) && $input['inputMap'] !== null) {
            $m = $input['inputMap'];
            if (!is_array($m) || array_is_list($m) && $m !== []) {
                throw new \InvalidArgumentException('Binding inputMap must be an object of input name → selector');
            }
            if (count($m) > 32) {
                throw new \InvalidArgumentException('Binding inputMap cannot have more than 32 entries');
            }
            $inputMap = $m === [] ? null : $m;
        }

        $outputActions = null;
        if (isset($input['outputActions']) && $input['outputActions'] !== null) {
            $outputActions = self::sanitizeOutputActions($input['outputActions']);
        }

        $timeoutMs = self::TIMEOUT_DEFAULT_MS;
        if (isset($input['timeoutMs']) && $input['timeoutMs'] !== null) {
            $t = $input['timeoutMs'];
            if (!is_int($t) && !(is_numeric($t) && (string) (int) $t === (string) $t)) {
                throw new \InvalidArgumentException('Binding timeoutMs must be an integer');
            }
            $t = (int) $t;
            if ($t < self::TIMEOUT_MIN_MS || $t > self::TIMEOUT_MAX_MS) {
                throw new \InvalidArgumentException('Binding timeoutMs must be between 250 and 300000');
            }
            $timeoutMs = $t;
        }

        $retryPolicy = null;
        if (isset($input['retryPolicy']) && $input['retryPolicy'] !== null) {
            $r = $input['retryPolicy'];
            if (!is_array($r)) {
                throw new \InvalidArgumentException('Binding retryPolicy must be an object');
            }
            $retryPolicy = [];
            if (isset($r['maxAttempts'])) {
                $ma = $r['maxAttempts'];
                if (!is_int($ma) || $ma < 1 || $ma > 5) {
                    throw new \InvalidArgumentException('retryPolicy.maxAttempts must be an integer between 1 and 5');
                }
                $retryPolicy['maxAttempts'] = $ma;
            }
            if (isset($r['backoff'])) {
                if (!in_array($r['backoff'], ['none', 'fixed', 'exponential'], true)) {
                    throw new \InvalidArgumentException('retryPolicy.backoff must be none, fixed or exponential');
                }
                $retryPolicy['backoff'] = $r['backoff'];
            }
            if ($retryPolicy === []) {
                $retryPolicy = null;
            }
        }

        $fallbackPolicy = null;
        if (isset($input['fallbackPolicy']) && $input['fallbackPolicy'] !== null) {
            $f = $input['fallbackPolicy'];
            if (!is_array($f)) {
                throw new \InvalidArgumentException('Binding fallbackPolicy must be an object');
            }
            $fallbackPolicy = [];
            if (isset($f['onError'])) {
                if (!in_array($f['onError'], ['log_and_continue', 'surface_error'], true)) {
                    throw new \InvalidArgumentException('fallbackPolicy.onError must be log_and_continue or surface_error');
                }
                $fallbackPolicy['onError'] = $f['onError'];
            }
            if (isset($f['fallbackReply'])) {
                if (!is_string($f['fallbackReply']) || strlen($f['fallbackReply']) > 500) {
                    throw new \InvalidArgumentException('fallbackPolicy.fallbackReply must be a string ≤ 500 chars');
                }
                $fallbackPolicy['fallbackReply'] = $f['fallbackReply'];
            }
            if ($fallbackPolicy === []) {
                $fallbackPolicy = null;
            }
        }

        // Per-column size caps (each stored JSON column ≤ 16 KiB).
        foreach (['condition' => $condition, 'inputMap' => $inputMap, 'outputActions' => $outputActions,
                  'retryPolicy' => $retryPolicy, 'fallbackPolicy' => $fallbackPolicy] as $name => $value) {
            if ($value !== null) {
                $json = json_encode($value);
                if ($json === false || strlen($json) > self::MAX_BINDING_JSON_BYTES) {
                    throw new \InvalidArgumentException("Binding {$name} exceeds the 16KB limit");
                }
            }
        }

        return [
            'event' => $event,
            'flow' => $flow,
            'mode' => $mode,
            'condition' => $condition,
            'inputMap' => $inputMap,
            'outputActions' => $outputActions,
            'timeoutMs' => $timeoutMs,
            'retryPolicy' => $retryPolicy,
            'fallbackPolicy' => $fallbackPolicy,
            'enabled' => array_key_exists('enabled', $input) ? (bool) $input['enabled'] : true,
        ];
    }

    /**
     * Validate an outputActions list (≤ 16, whitelisted types, per-field caps, unknown keys stripped).
     * @throws \InvalidArgumentException
     */
    public static function sanitizeOutputActions(mixed $actions): array
    {
        if (!is_array($actions) || !array_is_list($actions)) {
            throw new \InvalidArgumentException('outputActions must be an array');
        }
        if (count($actions) > 16) {
            throw new \InvalidArgumentException('outputActions cannot have more than 16 items');
        }
        $out = [];
        foreach ($actions as $i => $action) {
            if (!is_array($action)) {
                throw new \InvalidArgumentException("outputActions[{$i}] must be an object");
            }
            $type = $action['type'] ?? null;
            if (!is_string($type) || !in_array($type, self::OUTPUT_ACTION_TYPES, true)) {
                throw new \InvalidArgumentException("outputActions[{$i}] has an unknown type — allowed: " . implode(', ', self::OUTPUT_ACTION_TYPES));
            }
            $clean = ['type' => $type];
            // 'scope'/'key' (formlogic.store) mirror the FlowKvService caps: scope ≤ 64, key ≤ 190.
            foreach (['form' => 128, 'responseId' => 128, 'when' => 500, 'connectorId' => 64, 'command' => 96, 'message' => 500, 'scope' => 64, 'key' => 190] as $key => $cap) {
                if (isset($action[$key])) {
                    if (!is_string($action[$key]) || strlen($action[$key]) > $cap) {
                        throw new \InvalidArgumentException("outputActions[{$i}].{$key} must be a string ≤ {$cap} chars");
                    }
                    $clean[$key] = $action[$key];
                }
            }
            // Free-shaped fields (selector into $result or literal payloads) pass through as-is.
            if (array_key_exists('answers', $action)) {
                $clean['answers'] = $action['answers'];
            }
            if (array_key_exists('payload', $action)) {
                $clean['payload'] = $action['payload'];
            }
            if (array_key_exists('value', $action)) {
                $clean['value'] = $action['value']; // formlogic.store: selector into $result or a literal
            }
            $out[] = $clean;
        }
        return $out;
    }

    // ── Flow definitions (owner CRUD) ────────────────────────────────────────────────────────

    /** @return array[] */
    public function listFlows(string $appId): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE app_id = :a ORDER BY created_at ASC, id ASC");
        $stmt->execute(['a' => $appId]);
        return array_map([$this, 'formatFlow'], $stmt->fetchAll());
    }

    public function getFlow(string $appId, string $flowId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE id = :id AND app_id = :a");
        $stmt->execute(['id' => $flowId, 'a' => $appId]);
        $row = $stmt->fetch();
        return $row ? $this->formatFlow($row) : null;
    }

    public function findEnabledFlowBySlug(string $appId, string $slug): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE app_id = :a AND slug = :s AND enabled = 1");
        $stmt->execute(['a' => $appId, 's' => $slug]);
        $row = $stmt->fetch();
        return $row ? $this->formatFlow($row) : null;
    }

    /** @throws \InvalidArgumentException on validation failure */
    public function createFlow(string $appId, string $ownerUserId, array $data): array
    {
        $name = trim((string) ($data['name'] ?? ''));
        if ($name === '' || strlen($name) > 255) {
            throw new \InvalidArgumentException('Flow name is required (max 255 chars)');
        }
        $slug = self::sanitizeSlug($data['slug'] ?? $this->slugify($name));
        $flowJson = self::sanitizeFlowJson($data['flowJson'] ?? ['nodes' => [], 'edges' => []]);
        [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
        $executionLocation = array_key_exists('executionLocation', $data)
            ? self::sanitizeExecutionLocation($data['executionLocation'])
            : 'auto';

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM flow_definitions WHERE app_id = :a");
        $countStmt->execute(['a' => $appId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_FLOWS_PER_APP) {
            throw new \InvalidArgumentException('An app can have at most ' . self::MAX_FLOWS_PER_APP . ' flows');
        }

        // Caller-supplied id = preserve-ids restore (recycle bin / backup import).
        $id = (isset($data['id']) && is_string($data['id']) && $data['id'] !== '') ? $data['id'] : $this->uuidV4();
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_definitions
                    (id, owner_user_id, app_id, name, slug, description, engine, flow_json, input_schema, output_schema, node_capabilities, version, enabled, execution_location)
                VALUES
                    (:id, :owner, :app, :name, :slug, :descr, 'f2i', :flow_json, :input_schema, :output_schema, :node_caps, 1, :enabled, :exec_loc)
            ");
            $stmt->execute([
                'id' => $id,
                'owner' => $ownerUserId,
                'app' => $appId,
                'name' => $name,
                'slug' => $slug,
                'descr' => isset($data['description']) && is_string($data['description']) ? substr($data['description'], 0, 2000) : null,
                'flow_json' => json_encode($flowJson),
                'input_schema' => $inputSchema !== null ? json_encode($inputSchema) : null,
                'output_schema' => $outputSchema !== null ? json_encode($outputSchema) : null,
                'node_caps' => $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null,
                'enabled' => (array_key_exists('enabled', $data) ? (bool) $data['enabled'] : true) ? 1 : 0,
                'exec_loc' => $executionLocation,
            ]);
        } catch (\PDOException $e) {
            if ($this->isDuplicateKey($e)) {
                throw new \InvalidArgumentException("A flow with slug '{$slug}' already exists in this app");
            }
            throw $e;
        }

        return $this->getFlow($appId, $id) ?? throw new \RuntimeException('Flow creation failed');
    }

    /**
     * Partial update; bumps version when any executable-contract field changes (flowJson,
     * schemas, capabilities, executionLocation). An optional `expectedVersion` becomes an
     * atomic optimistic-concurrency guard: stale saves throw FlowRevisionConflictException
     * (HTTP 409) instead of clobbering a concurrent edit.
     * @throws \InvalidArgumentException @throws FlowRevisionConflictException
     */
    public function updateFlow(string $appId, string $flowId, array $data): ?array
    {
        $existing = $this->getFlow($appId, $flowId);
        if (!$existing) {
            return null;
        }
        $expectedVersion = self::sanitizeExpectedVersion($data);
        if ($expectedVersion !== null && $expectedVersion !== (int) $existing['version']) {
            throw new FlowRevisionConflictException((int) $existing['version']);
        }

        $sets = [];
        $params = ['id' => $flowId, 'a' => $appId];

        if (array_key_exists('name', $data)) {
            $name = trim((string) $data['name']);
            if ($name === '' || strlen($name) > 255) {
                throw new \InvalidArgumentException('Flow name is required (max 255 chars)');
            }
            $sets[] = 'name = :name';
            $params['name'] = $name;
        }
        if (array_key_exists('slug', $data)) {
            $sets[] = 'slug = :slug';
            $params['slug'] = self::sanitizeSlug($data['slug']);
        }
        if (array_key_exists('description', $data)) {
            $sets[] = 'description = :descr';
            $params['descr'] = is_string($data['description']) ? substr($data['description'], 0, 2000) : null;
        }
        $contractChanged = false;
        if (array_key_exists('flowJson', $data)) {
            $sets[] = 'flow_json = :flow_json';
            $contractChanged = true;
            $params['flow_json'] = json_encode(self::sanitizeFlowJson($data['flowJson']));
        }
        if (array_key_exists('inputSchema', $data) || array_key_exists('outputSchema', $data) || array_key_exists('nodeCapabilities', $data)) {
            [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
            if (array_key_exists('inputSchema', $data)) {
                $sets[] = 'input_schema = :input_schema';
                $contractChanged = true;
                $params['input_schema'] = $inputSchema !== null ? json_encode($inputSchema) : null;
            }
            if (array_key_exists('outputSchema', $data)) {
                $sets[] = 'output_schema = :output_schema';
                $contractChanged = true;
                $params['output_schema'] = $outputSchema !== null ? json_encode($outputSchema) : null;
            }
            if (array_key_exists('nodeCapabilities', $data)) {
                $sets[] = 'node_capabilities = :node_caps';
                $contractChanged = true;
                $params['node_caps'] = $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null;
            }
        }
        if (array_key_exists('enabled', $data)) {
            $sets[] = 'enabled = :enabled';
            $params['enabled'] = ((bool) $data['enabled']) ? 1 : 0;
        }
        if (array_key_exists('executionLocation', $data)) {
            $sets[] = 'execution_location = :exec_loc';
            $contractChanged = true;
            $params['exec_loc'] = self::sanitizeExecutionLocation($data['executionLocation']);
        }

        if (empty($sets)) {
            return $existing;
        }
        // Any executable-contract change bumps the version, so immutable revision rows
        // (flow_definition_versions, minted lazily at run-reserve) never collide on
        // UNIQUE(flow_definition_id, version) with different content.
        if ($contractChanged) {
            $sets[] = 'version = version + 1';
        }

        // The expectedVersion guard rides the UPDATE itself (atomic): a concurrent bump
        // between the read above and this statement makes the WHERE miss.
        $guardSql = '';
        if ($expectedVersion !== null) {
            $guardSql = ' AND version = :guard';
            $params['guard'] = $expectedVersion;
        }
        try {
            $stmt = $this->mysql->prepare('UPDATE flow_definitions SET ' . implode(', ', $sets) . ' WHERE id = :id AND app_id = :a' . $guardSql);
            $stmt->execute($params);
        } catch (\PDOException $e) {
            if ($this->isDuplicateKey($e)) {
                throw new \InvalidArgumentException('A flow with this slug already exists in this app');
            }
            throw $e;
        }
        if ($expectedVersion !== null && $stmt->rowCount() === 0) {
            // Zero affected rows = the guard missed OR a same-values no-op; only a moved
            // version is a real conflict.
            $current = $this->getFlow($appId, $flowId);
            if (!$current) {
                return null;
            }
            if ((int) $current['version'] !== $expectedVersion) {
                throw new FlowRevisionConflictException((int) $current['version']);
            }
            return $current;
        }

        return $this->getFlow($appId, $flowId);
    }

    public function deleteFlow(string $appId, string $flowId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM flow_definitions WHERE id = :id AND app_id = :a");
        $stmt->execute(['id' => $flowId, 'a' => $appId]);
        return $stmt->rowCount() > 0;
    }

    // ── Bindings (owner CRUD) ────────────────────────────────────────────────────────────────

    /** @return array[] */
    public function listBindings(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.app_id = :a
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
        ");
        $stmt->execute(['a' => $appId]);
        return array_map([$this, 'formatBinding'], $stmt->fetchAll());
    }

    public function getBinding(string $appId, string $bindingId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.id = :id AND b.app_id = :a
        ");
        $stmt->execute(['id' => $bindingId, 'a' => $appId]);
        $row = $stmt->fetch();
        return $row ? $this->formatBinding($row) : null;
    }

    /** @throws \InvalidArgumentException on validation failure */
    public function createBinding(string $appId, array $data): array
    {
        $clean = self::sanitizeBinding($data);

        // Resolve the flow slug within this app (bindings can target disabled flows; enable later).
        $flowStmt = $this->mysql->prepare("SELECT id FROM flow_definitions WHERE app_id = :a AND slug = :s");
        $flowStmt->execute(['a' => $appId, 's' => $clean['flow']]);
        $flowDefinitionId = $flowStmt->fetchColumn();
        if (!$flowDefinitionId) {
            throw new \InvalidArgumentException("Unknown flow '{$clean['flow']}' in this app");
        }

        // E2EE §9.2 first: a private form id is refused with the typed error even
        // before membership validation (which would 404-style reject it anyway —
        // a private form can never be app-attached, so it never belongs).
        if (is_string($data['formId'] ?? null)) {
            $this->assertBindableForm($data['formId']);
        }
        $formId = $this->sanitizeBindingFormId($appId, $data['formId'] ?? null);
        $this->assertBindableForm($formId);
        $connectorId = $this->sanitizeConnectorId($data['connectorId'] ?? null);

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM app_flow_bindings WHERE app_id = :a");
        $countStmt->execute(['a' => $appId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_BINDINGS_PER_APP) {
            throw new \InvalidArgumentException('An app can have at most ' . self::MAX_BINDINGS_PER_APP . ' flow bindings');
        }

        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_flow_bindings
                (id, app_id, form_id, connector_id, flow_definition_id, event_name, mode, condition_json,
                 input_map_json, output_actions_json, timeout_ms, retry_policy_json, fallback_policy_json, enabled, sort_order)
            VALUES
                (:id, :app, :form, :connector, :flow, :event, :mode, :cond, :input_map, :actions, :timeout, :retry, :fallback, :enabled, :sort)
        ");
        $stmt->execute([
            'id' => $id,
            'app' => $appId,
            'form' => $formId,
            'connector' => $connectorId,
            'flow' => $flowDefinitionId,
            'event' => $clean['event'],
            'mode' => $clean['mode'],
            'cond' => $clean['condition'] !== null ? json_encode($clean['condition']) : null,
            'input_map' => $clean['inputMap'] !== null ? json_encode($clean['inputMap']) : null,
            'actions' => $clean['outputActions'] !== null ? json_encode($clean['outputActions']) : null,
            'timeout' => $clean['timeoutMs'],
            'retry' => $clean['retryPolicy'] !== null ? json_encode($clean['retryPolicy']) : null,
            'fallback' => $clean['fallbackPolicy'] !== null ? json_encode($clean['fallbackPolicy']) : null,
            'enabled' => $clean['enabled'] ? 1 : 0,
            'sort' => (int) ($data['sortOrder'] ?? 0),
        ]);

        return $this->getBinding($appId, $id) ?? throw new \RuntimeException('Binding creation failed');
    }

    /** Full replace of the binding config (same required fields as create). @throws \InvalidArgumentException */
    public function updateBinding(string $appId, string $bindingId, array $data): ?array
    {
        $existing = $this->getBinding($appId, $bindingId);
        if (!$existing) {
            return null;
        }

        // Merge over the existing config so partial updates keep unspecified fields.
        $merged = array_merge([
            'event' => $existing['event'],
            'flow' => $existing['flow'],
            'mode' => $existing['mode'],
            'condition' => $existing['condition'],
            'inputMap' => $existing['inputMap'],
            'outputActions' => $existing['outputActions'],
            'timeoutMs' => $existing['timeoutMs'],
            'retryPolicy' => $existing['retryPolicy'],
            'fallbackPolicy' => $existing['fallbackPolicy'],
            'enabled' => $existing['enabled'],
        ], $data);
        $clean = self::sanitizeBinding($merged);

        $flowStmt = $this->mysql->prepare("SELECT id FROM flow_definitions WHERE app_id = :a AND slug = :s");
        $flowStmt->execute(['a' => $appId, 's' => $clean['flow']]);
        $flowDefinitionId = $flowStmt->fetchColumn();
        if (!$flowDefinitionId) {
            throw new \InvalidArgumentException("Unknown flow '{$clean['flow']}' in this app");
        }

        $formId = array_key_exists('formId', $data)
            ? $this->sanitizeBindingFormId($appId, $data['formId'])
            : $existing['formId'];
        $connectorId = array_key_exists('connectorId', $data)
            ? $this->sanitizeConnectorId($data['connectorId'])
            : $existing['connectorId'];

        $stmt = $this->mysql->prepare("
            UPDATE app_flow_bindings SET
                form_id = :form, connector_id = :connector, flow_definition_id = :flow, event_name = :event,
                mode = :mode, condition_json = :cond, input_map_json = :input_map, output_actions_json = :actions,
                timeout_ms = :timeout, retry_policy_json = :retry, fallback_policy_json = :fallback,
                enabled = :enabled, sort_order = :sort
            WHERE id = :id AND app_id = :app
        ");
        $stmt->execute([
            'id' => $bindingId,
            'app' => $appId,
            'form' => $formId,
            'connector' => $connectorId,
            'flow' => $flowDefinitionId,
            'event' => $clean['event'],
            'mode' => $clean['mode'],
            'cond' => $clean['condition'] !== null ? json_encode($clean['condition']) : null,
            'input_map' => $clean['inputMap'] !== null ? json_encode($clean['inputMap']) : null,
            'actions' => $clean['outputActions'] !== null ? json_encode($clean['outputActions']) : null,
            'timeout' => $clean['timeoutMs'],
            'retry' => $clean['retryPolicy'] !== null ? json_encode($clean['retryPolicy']) : null,
            'fallback' => $clean['fallbackPolicy'] !== null ? json_encode($clean['fallbackPolicy']) : null,
            'enabled' => $clean['enabled'] ? 1 : 0,
            'sort' => array_key_exists('sortOrder', $data) ? (int) $data['sortOrder'] : (int) $existing['sortOrder'],
        ]);

        return $this->getBinding($appId, $bindingId);
    }

    public function deleteBinding(string $appId, string $bindingId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_flow_bindings WHERE id = :id AND app_id = :a");
        $stmt->execute(['id' => $bindingId, 'a' => $appId]);
        return $stmt->rowCount() > 0;
    }

    // ── Runtime: definitions + reserve-first run log ────────────────────────────────────────

    /**
     * Enabled flow definitions + enabled bindings for the app runtime, WITHOUT owner-only fields
     * (no ownerUserId / internal ids beyond what the runner needs).
     * @return array{flows: array[], bindings: array[]}
     */
    public function getRuntimeFlows(string $appId): array
    {
        $flows = [];
        foreach ($this->listFlows($appId) as $flow) {
            if (!$flow['enabled']) {
                continue;
            }
            $flows[] = [
                // Stable flow id — the DURABLE reference flow_call nodes store (extensible-flows
                // plan §8.1: slugs are presentation/routing aliases and can change).
                'id' => $flow['id'],
                'slug' => $flow['slug'],
                'name' => $flow['name'],
                'engine' => $flow['engine'],
                'flowJson' => $flow['flowJson'],
                'inputSchema' => $flow['inputSchema'],
                'outputSchema' => $flow['outputSchema'],
                'nodeCapabilities' => $flow['nodeCapabilities'],
                'version' => $flow['version'],
                'executionLocation' => $flow['executionLocation'],
            ];
        }

        $bindings = [];
        foreach ($this->listBindings($appId) as $binding) {
            if (!$binding['enabled']) {
                continue;
            }
            $bindings[] = [
                'id' => $binding['id'],
                'flow' => $binding['flow'],
                'formId' => $binding['formId'],
                'connectorId' => $binding['connectorId'],
                'event' => $binding['event'],
                'mode' => $binding['mode'],
                'condition' => $binding['condition'],
                'inputMap' => $binding['inputMap'],
                'outputActions' => $binding['outputActions'],
                'timeoutMs' => $binding['timeoutMs'],
                'retryPolicy' => $binding['retryPolicy'],
                'fallbackPolicy' => $binding['fallbackPolicy'],
                'sortOrder' => $binding['sortOrder'],
            ];
        }

        return ['flows' => $flows, 'bindings' => $bindings];
    }

    /**
     * Reserve a run BEFORE execution, using the UNIQUE idempotency_key as the atomic gate (same
     * reserve-first pattern as app submissions): the first caller wins and creates the 'running'
     * row; a duplicate event replay gets the existing run back with created=false.
     *
     * @return array{run: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / unknown flow / key reuse across apps
     */
    public function reserveRun(string $appId, string $userId, array $data): array
    {
        $flowSlug = self::sanitizeSlug($data['flowSlug'] ?? null);
        $flow = $this->findEnabledFlowBySlug($appId, $flowSlug);
        if (!$flow) {
            throw new \InvalidArgumentException("Unknown or disabled flow '{$flowSlug}'");
        }

        $bindingId = null;
        if (isset($data['bindingId']) && $data['bindingId'] !== null && $data['bindingId'] !== '') {
            $binding = is_string($data['bindingId']) ? $this->getBinding($appId, $data['bindingId']) : null;
            if (!$binding) {
                throw new \InvalidArgumentException('Unknown flow binding');
            }
            $bindingId = $binding['id'];
        }

        $triggerEvent = $data['triggerEvent'] ?? null;
        if (!is_string($triggerEvent) || $triggerEvent === '' || strlen($triggerEvent) > 150 || !preg_match(self::EVENT_PATTERN, $triggerEvent)) {
            throw new \InvalidArgumentException('triggerEvent must match ^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)*$ (max 150 chars)');
        }

        $correlationId = $data['correlationId'] ?? null;
        if (!is_string($correlationId) || $correlationId === '' || strlen($correlationId) > 150) {
            throw new \InvalidArgumentException('correlationId is required (max 150 chars)');
        }

        $idempotencyKey = $data['idempotencyKey'] ?? null;
        if (!is_string($idempotencyKey) || $idempotencyKey === '' || strlen($idempotencyKey) > 255) {
            throw new \InvalidArgumentException('idempotencyKey is required (max 255 chars)');
        }

        $inputSnapshot = null;
        if (isset($data['inputSnapshot']) && $data['inputSnapshot'] !== null) {
            if (!is_array($data['inputSnapshot'])) {
                throw new \InvalidArgumentException('inputSnapshot must be an object');
            }
            $json = json_encode($data['inputSnapshot']);
            if ($json === false || strlen($json) > self::MAX_INPUT_SNAPSHOT_BYTES) {
                throw new \InvalidArgumentException('inputSnapshot exceeds the 64KB limit');
            }
            $inputSnapshot = $json;
        }

        $formId = null;
        if (isset($data['formId']) && is_string($data['formId']) && $data['formId'] !== '') {
            $formId = $this->sanitizeBindingFormId($appId, $data['formId']);
        }
        $responseId = (isset($data['responseId']) && is_string($data['responseId']) && $data['responseId'] !== '')
            ? substr($data['responseId'], 0, 36) : null;

        // queued:true reserves WITHOUT starting execution (server-initiated queue entry a runtime
        // claims later via the claim endpoint); default reserves as 'running' (caller executes now).
        $queued = ($data['queued'] ?? false) === true;

        $id = $this->uuidV4();
        $flowVersionId = $this->ensureFlowVersion($flow['id']);
        [$parentRunId, $rootRunId, $depth, $callNodeId] = $this->resolveRunLineage($data, $appId, null);
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, flow_version_id,
                     parent_run_id, root_run_id, call_node_id, depth, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :flow_version,
                     :parent_run, :root_run, :call_node, :depth, :event, :corr, :key, :status, :input, :started)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $appId,
                'form' => $formId,
                'resp' => $responseId,
                'binding' => $bindingId,
                'flow' => $flow['id'],
                'flow_version' => $flowVersionId,
                'parent_run' => $parentRunId,
                'root_run' => $rootRunId,
                'call_node' => $callNodeId,
                'depth' => $depth,
                'event' => $triggerEvent,
                'corr' => $correlationId,
                'key' => $idempotencyKey,
                'status' => $queued ? 'queued' : 'running',
                'input' => $inputSnapshot,
                'started' => $queued ? null : date('Y-m-d H:i:s'),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Already reserved (or complete): return the existing run — idempotent replay.
            // Lookup uses the SAME scope as the unique index (audit FL-08): keys are only
            // unique per flow definition now.
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.flow_definition_id = :f AND r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['f' => $flow['id'], 'k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row || ($row['app_id'] ?? null) !== $appId) {
                // The key belongs to ANOTHER app (or vanished): never leak a foreign run id.
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['run' => $this->formatRun($row), 'created' => false];
        }

        return ['run' => $this->getRun($appId, $id) ?? throw new \RuntimeException('Run reservation failed'), 'created' => true];
    }

    /**
     * Lazily materialise the immutable revision row for a flow's CURRENT executable
     * contract and return its id (extensible-flows plan §14.2): draft edits keep using the
     * mutable flow_definitions row; every RUN pins the exact revision it executed, so
     * revisions exist precisely for contract states that ran. Idempotent per
     * (flow_definition_id, version) via the UNIQUE key.
     *
     * definition_json is composed from the RAW stored column strings — never re-encoded
     * through PHP arrays (json_encode turns {} into [], so a re-encode would not be
     * byte-stable against the stored graph) — and the column is MEDIUMTEXT (not JSON) so
     * the digest stays byte-exact against what was hashed.
     *
     * Returns null when the flow row vanished mid-flight — run reservation must not fail
     * because of revision bookkeeping.
     */
    public function ensureFlowVersion(string $flowDefinitionId): ?string
    {
        $stmt = $this->mysql->prepare("
            SELECT engine, version, flow_json, input_schema, output_schema, node_capabilities, execution_location
            FROM flow_definitions WHERE id = :id
        ");
        $stmt->execute(['id' => $flowDefinitionId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        $version = (int) $row['version'];

        $find = $this->mysql->prepare(
            'SELECT id FROM flow_definition_versions WHERE flow_definition_id = :f AND version = :v'
        );
        $find->execute(['f' => $flowDefinitionId, 'v' => $version]);
        $existingId = $find->fetchColumn();
        if (is_string($existingId) && $existingId !== '') {
            return $existingId;
        }

        $definitionJson = '{"engine":' . json_encode((string) $row['engine'])
            . ',"version":' . $version
            . ',"flowJson":' . ((string) $row['flow_json'])
            . ',"inputSchema":' . (isset($row['input_schema']) ? (string) $row['input_schema'] : 'null')
            . ',"outputSchema":' . (isset($row['output_schema']) ? (string) $row['output_schema'] : 'null')
            . ',"nodeCapabilities":' . (isset($row['node_capabilities']) ? (string) $row['node_capabilities'] : 'null')
            . ',"executionLocation":' . json_encode((string) $row['execution_location'])
            . '}';
        $graphVersion = 1;
        $decodedGraph = json_decode((string) $row['flow_json'], true);
        if (is_array($decodedGraph) && is_int($decodedGraph['graphVersion'] ?? null)) {
            $graphVersion = (int) $decodedGraph['graphVersion'];
        }

        $id = $this->uuidV4();
        try {
            $ins = $this->mysql->prepare("
                INSERT INTO flow_definition_versions
                    (id, flow_definition_id, version, graph_version, definition_json, definition_digest)
                VALUES (:id, :f, :v, :gv, :def, :digest)
            ");
            $ins->execute([
                'id' => $id,
                'f' => $flowDefinitionId,
                'v' => $version,
                'gv' => $graphVersion,
                'def' => $definitionJson,
                'digest' => hash('sha256', $definitionJson),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Concurrent reserve minted it first — the winner's row is THE revision.
            $find->execute(['f' => $flowDefinitionId, 'v' => $version]);
            $winner = $find->fetchColumn();
            return is_string($winner) && $winner !== '' ? $winner : null;
        }
        return $id;
    }

    /** Server-side ceiling on run-lineage depth (extensible-flows plan §8.8/§15.8; the
     * browser invoker enforces the tighter awaited-depth-8 limit before reserving). */
    public const RUN_LINEAGE_MAX_DEPTH = 16;

    // ── Canonical terminal outcome events (extensible-flows plan §9) ─────────────────────

    /** Terminal run status → canonical outcome event name. */
    public const OUTCOME_EVENTS = [
        'done' => 'flow.succeeded',
        'error' => 'flow.failed',
        'timeout' => 'flow.timed_out',
        'cancelled' => 'flow.cancelled',
    ];
    /** Success results larger than this are omitted from the event payload (redaction/size, §9). */
    private const OUTCOME_RESULT_MAX_BYTES = 16384;
    /** Dispatch attempts before a pending event is parked as 'failed' (sweep stops retrying). */
    private const OUTCOME_MAX_ATTEMPTS = 5;

    /**
     * Emit + dispatch the canonical outcome event for an ALREADY-terminal run (plan §9).
     * Convenience wrapper for finalisation paths that can't couple the insert into their
     * own transaction (cloud runner, stuck-run reclaim). Exactly-once rides the UNIQUE
     * run_id (a duplicate emission is a silent no-op); rows are only written when the
     * app/owner actually has outcome subscribers. NEVER throws — outcome bookkeeping must
     * not break run finalisation.
     */
    public function emitRunOutcome(string $runId): void
    {
        try {
            $event = $this->insertOutcomeEventForRun($runId);
            if ($event !== null) {
                $this->dispatchOutcomeEvent($event);
            }
        } catch (\Throwable $e) {
            error_log("FlowService: outcome emission failed for run {$runId}: " . $e->getMessage());
        }
    }

    /**
     * Insert the outcome-event row for a terminal run and return it (with the source run
     * attached) — or null when the run isn't terminal, has no subscribers, or was already
     * emitted. Safe to call INSIDE the terminal transaction (plan §14.5: outbox insert
     * couples to the owning transaction; dispatch happens after commit).
     *
     * FAIL-CLOSED outbox (audit FL-03): only a positively identified duplicate-key
     * conflict is an idempotent no-op. Every OTHER insertion failure THROWS so the
     * terminal transition it is coupled to rolls back and the completion can retry —
     * a transient DB failure must never silently lose flow.succeeded/flow.failed
     * events while presenting the completion as atomic. Paths that finalise OUTSIDE
     * a coupled transaction (cloud runner, stuck-run reclaim) go through
     * emitRunOutcome(), which catches and defers to the reconciliation sweep.
     */
    private function insertOutcomeEventForRun(string $runId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.id = :id LIMIT 1
        ");
        $stmt->execute(['id' => $runId]);
        $run = $stmt->fetch();
        if (!$run || !isset(self::OUTCOME_EVENTS[(string) $run['status']])) {
            return null;
        }
        $eventName = self::OUTCOME_EVENTS[(string) $run['status']];
        $ownerUserId = (string) $run['flow_owner'];
        $appId = isset($run['app_id']) && is_string($run['app_id']) && $run['app_id'] !== '' ? $run['app_id'] : null;
        if ($this->outcomeSubscribers($appId, $ownerUserId) === []) {
            return null; // no consumers → no row (the terminal run row stays the truth)
        }

        $error = null;
        if (isset($run['error_json']) && is_string($run['error_json'])) {
            $decoded = json_decode($run['error_json'], true);
            if (is_array($decoded)) {
                // Redacted error projection: stable code + message (+ node attribution).
                $error = array_intersect_key($decoded, ['code' => 1, 'message' => 1, 'nodeId' => 1]);
            }
        }
        $result = null;
        $resultOmitted = false;
        if ($eventName === 'flow.succeeded' && isset($run['result_json']) && is_string($run['result_json'])) {
            if (strlen($run['result_json']) <= self::OUTCOME_RESULT_MAX_BYTES) {
                $result = json_decode($run['result_json'], true);
            } else {
                $resultOmitted = true;
            }
        }
        $payload = [
            'runId' => $run['id'],
            'rootRunId' => (isset($run['root_run_id']) && is_string($run['root_run_id']) && $run['root_run_id'] !== '')
                ? $run['root_run_id'] : $run['id'],
            'flowId' => $run['flow_definition_id'],
            'flowSlug' => $run['flow_slug'],
            'flowVersionId' => $run['flow_version_id'] ?? null,
            'status' => substr($eventName, strlen('flow.')),
            'error' => $error,
            'result' => $result,
            'correlationId' => $run['correlation_id'],
            'depth' => (int) ($run['depth'] ?? 0),
            'finishedAt' => $run['finished_at'],
        ];
        if ($resultOmitted) {
            $payload['resultOmitted'] = true;
        }

        $eventId = $this->uuidV4();
        try {
            $ins = $this->mysql->prepare("
                INSERT INTO flow_outcome_events
                    (id, run_id, app_id, owner_user_id, flow_definition_id, event_name, payload_json)
                VALUES (:id, :run, :app, :owner, :flow, :event, :payload)
            ");
            $ins->execute([
                'id' => $eventId,
                'run' => $run['id'],
                'app' => $appId,
                'owner' => $ownerUserId,
                'flow' => $run['flow_definition_id'],
                'event' => $eventName,
                'payload' => json_encode($payload),
            ]);
        } catch (\PDOException $e) {
            if ($this->isDuplicateKey($e)) {
                return null; // already emitted for this run — exactly-once holds
            }
            throw $e;
        }
        return [
            'id' => $eventId,
            'run_id' => $run['id'],
            'app_id' => $appId,
            'owner_user_id' => $ownerUserId,
            'flow_definition_id' => $run['flow_definition_id'],
            'event_name' => $eventName,
            'payload' => $payload,
            'source_run' => $run,
        ];
    }

    /**
     * Reconciliation (audit FL-03): find terminal runs that finished recently but have NO
     * outcome-event row (an emission that failed after its transaction committed — e.g. the
     * cloud runner / reclaim paths, whose emitRunOutcome() never throws) and re-emit them.
     * emitRunOutcome() no-ops runs without subscribers, so this stays cheap. Bounded window
     * + batch so the sweep never scans deep history. @return int events emitted
     */
    public function reconcileMissingOutcomeEvents(int $windowSeconds = 21600, int $limit = 500): int
    {
        $windowSeconds = max(60, $windowSeconds);
        $limit = max(1, min(2000, $limit));
        $stmt = $this->mysql->prepare("
            SELECT r.id FROM flow_run_logs r
            LEFT JOIN flow_outcome_events e ON e.run_id = r.id
            WHERE e.run_id IS NULL
              AND r.status IN ('done', 'error', 'timeout', 'cancelled')
              AND r.finished_at IS NOT NULL
              AND r.finished_at > (NOW() - INTERVAL {$windowSeconds} SECOND)
            ORDER BY r.finished_at ASC
            LIMIT {$limit}
        ");
        $stmt->execute();
        $emitted = 0;
        foreach ($stmt->fetchAll() as $row) {
            $before = $this->countOutcomeEventForRun((string) $row['id']);
            $this->emitRunOutcome((string) $row['id']);
            if (!$before && $this->countOutcomeEventForRun((string) $row['id'])) {
                $emitted++;
            }
        }
        return $emitted;
    }

    private function countOutcomeEventForRun(string $runId): bool
    {
        $stmt = $this->mysql->prepare('SELECT 1 FROM flow_outcome_events WHERE run_id = :r LIMIT 1');
        $stmt->execute(['r' => $runId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Enabled, non-manual outcome bindings visible to this app/owner: the app's own
     * bindings plus the owner's workspace bindings. The flow itself must be enabled.
     * @return array[]
     */
    private function outcomeSubscribers(?string $appId, string $ownerUserId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT b.id, b.event_name, b.flow_definition_id, b.condition_json,
                   f.app_id AS flow_app_id, f.owner_user_id AS flow_owner
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.enabled = 1 AND b.mode != 'manual' AND f.enabled = 1
              AND b.event_name IN ('flow.succeeded', 'flow.failed', 'flow.timed_out', 'flow.cancelled')
              AND ((:app1 IS NOT NULL AND b.app_id = :app2) OR (b.app_id IS NULL AND f.owner_user_id = :o))
        ");
        $stmt->execute(['app1' => $appId, 'app2' => $appId, 'o' => $ownerUserId]);
        return $stmt->fetchAll();
    }

    /**
     * Dispatch one outcome event: enqueue an INDEPENDENT durable handler run per matching
     * binding (plan §9 — handlers ride the normal queued-run claim path). §9.2 loop guards:
     *   - never dispatch to the binding that produced the source run (direct self-loop);
     *   - never re-trigger the same (root, binding, event) pair within one root;
     *   - handler runs carry parentRunId = source run, so the lineage depth ceiling (16)
     *     terminates any indirect chain;
     *   - per-event/binding idempotency key makes replays no-ops.
     */
    private function dispatchOutcomeEvent(array $event): void
    {
        $run = $event['source_run'];
        $rootRunId = (isset($run['root_run_id']) && is_string($run['root_run_id']) && $run['root_run_id'] !== '')
            ? $run['root_run_id'] : (string) $run['id'];
        $subscribers = array_filter(
            $this->outcomeSubscribers($event['app_id'], (string) $event['owner_user_id']),
            fn (array $b) => $b['event_name'] === $event['event_name']
        );

        $failed = false;
        foreach ($subscribers as $binding) {
            try {
                if (($run['binding_id'] ?? null) === $binding['id']) {
                    continue; // the handler's own output — never re-trigger itself directly
                }
                $seen = $this->mysql->prepare("
                    SELECT 1 FROM flow_run_logs
                    WHERE root_run_id = :root AND binding_id = :b AND trigger_event = :e AND id != :self
                    LIMIT 1
                ");
                $seen->execute([
                    'root' => $rootRunId,
                    'b' => $binding['id'],
                    'e' => $event['event_name'],
                    'self' => $run['id'],
                ]);
                if ($seen->fetchColumn()) {
                    continue; // same source/handler pair already fired within this root (§9.2)
                }
                $this->enqueueRun(
                    [
                        'id' => $binding['flow_definition_id'],
                        'appId' => $binding['flow_app_id'],
                        'ownerUserId' => $binding['flow_owner'],
                    ],
                    [
                        'triggerEvent' => $event['event_name'],
                        'correlationId' => (string) ($event['payload']['correlationId'] ?? ('outcome-' . $run['id'])),
                        'idempotencyKey' => 'flowoutcome:' . $run['id'] . ':' . $binding['id'],
                        'inputSnapshot' => ['event' => ['name' => $event['event_name'], 'data' => $event['payload']]],
                        'bindingId' => $binding['id'],
                        'parentRunId' => (string) $run['id'],
                    ]
                );
            } catch (\InvalidArgumentException $e) {
                // Depth ceiling / validation refusals circuit-break THIS binding only.
                error_log("FlowService: outcome handler skipped (binding {$binding['id']}): " . $e->getMessage());
            } catch (\Throwable $e) {
                $failed = true;
                error_log("FlowService: outcome dispatch failed (binding {$binding['id']}): " . $e->getMessage());
            }
        }

        $mark = $this->mysql->prepare("
            UPDATE flow_outcome_events
            SET dispatch_status = :s, attempts = attempts + 1, dispatched_at = NOW()
            WHERE id = :id
        ");
        $mark->execute(['s' => $failed ? 'pending' : 'done', 'id' => $event['id']]);
        if ($failed) {
            $this->mysql->prepare("
                UPDATE flow_outcome_events SET dispatch_status = 'failed'
                WHERE id = :id AND attempts >= :max
            ")->execute(['id' => $event['id'], 'max' => self::OUTCOME_MAX_ATTEMPTS]);
        }
    }

    /**
     * At-least-once recovery sweep (bin/flow-outcome-dispatch.php): dispatch events whose
     * inline dispatch never completed. Returns how many events were processed.
     */
    public function dispatchPendingOutcomeEvents(int $limit = 50): int
    {
        $limit = max(1, min(500, $limit));
        $stmt = $this->mysql->query("
            SELECT * FROM flow_outcome_events
            WHERE dispatch_status = 'pending'
            ORDER BY created_at ASC, id ASC
            LIMIT {$limit}
        ");
        $processed = 0;
        foreach ($stmt->fetchAll() as $row) {
            $runStmt = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
                FROM flow_run_logs r JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.id = :id LIMIT 1
            ");
            $runStmt->execute(['id' => $row['run_id']]);
            $run = $runStmt->fetch();
            if (!$run) {
                $this->mysql->prepare("UPDATE flow_outcome_events SET dispatch_status = 'failed' WHERE id = :id")
                    ->execute(['id' => $row['id']]);
                continue;
            }
            $this->dispatchOutcomeEvent([
                'id' => $row['id'],
                'run_id' => $row['run_id'],
                'app_id' => $row['app_id'],
                'owner_user_id' => $row['owner_user_id'],
                'flow_definition_id' => $row['flow_definition_id'],
                'event_name' => $row['event_name'],
                'payload' => json_decode((string) $row['payload_json'], true) ?: [],
                'source_run' => $run,
            ]);
            $processed++;
        }
        return $processed;
    }

    /**
     * Resolve reserve-time run lineage (extensible-flows plan §8.7/§14.1). The caller may
     * name only its parent run + calling node; root and depth are DERIVED from the parent
     * row here — client-supplied lineage is never trusted. The parent must already be
     * visible to the caller (same app for app runs, same flow owner for owner runs);
     * anything else refuses with an OPAQUE error so foreign run ids can't be probed.
     *
     * @return array{0: ?string, 1: ?string, 2: int, 3: ?string} [parentRunId, rootRunId, depth, callNodeId]
     * @throws \InvalidArgumentException
     */
    private function resolveRunLineage(array $data, ?string $appId, ?string $ownerUserId): array
    {
        $callNodeId = isset($data['callNodeId']) && is_string($data['callNodeId']) && $data['callNodeId'] !== ''
            ? substr($data['callNodeId'], 0, 128)
            : null;
        $parentRunId = isset($data['parentRunId']) && is_string($data['parentRunId']) && $data['parentRunId'] !== ''
            ? substr($data['parentRunId'], 0, 36)
            : null;
        if ($parentRunId === null) {
            return [null, null, 0, $callNodeId];
        }

        $stmt = $this->mysql->prepare("
            SELECT r.id, r.app_id, r.root_run_id, r.depth, f.owner_user_id AS flow_owner
            FROM flow_run_logs r
            LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.id = :id LIMIT 1
        ");
        $stmt->execute(['id' => $parentRunId]);
        $parent = $stmt->fetch();
        $visible = $parent && (
            ($appId !== null && ($parent['app_id'] ?? null) === $appId)
            || ($ownerUserId !== null && ($parent['flow_owner'] ?? null) === $ownerUserId)
        );
        if (!$visible) {
            throw new \InvalidArgumentException('Unknown parent run');
        }

        $depth = (int) ($parent['depth'] ?? 0) + 1;
        if ($depth > self::RUN_LINEAGE_MAX_DEPTH) {
            throw new \InvalidArgumentException(
                'Run lineage depth limit exceeded (' . self::RUN_LINEAGE_MAX_DEPTH . ')'
            );
        }
        $rootRunId = is_string($parent['root_run_id'] ?? null) && $parent['root_run_id'] !== ''
            ? $parent['root_run_id']
            : $parentRunId;
        return [$parentRunId, $rootRunId, $depth, $callNodeId];
    }

    public function getRun(string $appId, string $runId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.id = :id AND r.app_id = :a
        ");
        $stmt->execute(['id' => $runId, 'a' => $appId]);
        $row = $stmt->fetch();
        return $row ? $this->formatRun($row) : null;
    }

    /**
     * Complete a run: transition 'running'/'queued' → a terminal status per flow-run-result.schema.json,
     * stamping finished_at. Returns the updated run, null when not found, or throws:
     *   \InvalidArgumentException — invalid payload,
     *   \RuntimeException('already_finalized') — the run is already terminal (controller → 409),
     *   \RuntimeException('claimed_elsewhere') — a DIFFERENT instance claimed this run (→ 409).
     *
     * Claimant binding (audit FL-AUTH-001, hardened per audit FL-01): a CLAIMED run
     * (claimed_by set at claim time) may ONLY be completed by a caller presenting the same
     * instanceId — omitting it no longer bypasses the lease. Queued, never-claimed work is
     * not completable either: a runtime claims (queued→running) before it may finalise, so
     * a bare run UUID can't be used to terminate work some other runtime owns.
     */
    public function completeRun(string $appId, string $runId, array $data): ?array
    {
        $clean = $this->sanitizeCompletion($data);
        $instanceId = $this->sanitizeCompletionInstanceId($data);

        // The guarded transition + the outcome-event outbox insert share one transaction
        // (plan §14.5/§15.7: the FINALIZER owns terminal state AND outbox insertion);
        // dispatch runs after commit. The guarded UPDATE stays the exactly-once gate.
        $wrapped = !$this->mysql->inTransaction();
        if ($wrapped) {
            $this->mysql->beginTransaction();
        }
        $outcomeEvent = null;
        try {
            $stmt = $this->mysql->prepare("
                UPDATE flow_run_logs
                SET status = :s, result_json = :result, error_json = :error, output_actions_json = :actions, finished_at = NOW()
                WHERE id = :id AND app_id = :a AND status = 'running'
                  AND (claimed_by IS NULL OR (:cb1 IS NOT NULL AND claimed_by = :cb2))
            ");
            $stmt->execute([
                's' => $clean['status'],
                'result' => $clean['resultJson'],
                'error' => $clean['errorJson'],
                'actions' => $clean['actionsJson'],
                'id' => $runId,
                'a' => $appId,
                'cb1' => $instanceId,
                'cb2' => $instanceId,
            ]);
            $transitioned = $stmt->rowCount() > 0;
            if ($transitioned) {
                $outcomeEvent = $this->insertOutcomeEventForRun($runId);
            }
            if ($wrapped) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($wrapped && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        if (!$transitioned) {
            $existing = $this->getRun($appId, $runId);
            if ($existing === null) {
                return null;
            }
            if (in_array($existing['status'], self::RUN_ACTIVE_STATUSES, true)) {
                throw new \RuntimeException('claimed_elsewhere');
            }
            throw new \RuntimeException('already_finalized');
        }
        if ($outcomeEvent !== null) {
            $this->dispatchOutcomeEvent($outcomeEvent);
        }

        return $this->getRun($appId, $runId);
    }

    /**
     * Owner-scoped complete (workspace runs + any run of a flow the caller owns — the surface
     * FormLogic Desktop uses over API keys). Same payload/transitions/claimant-binding rules
     * as completeRun.
     */
    public function completeOwnerRun(string $ownerUserId, string $runId, array $data): ?array
    {
        $clean = $this->sanitizeCompletion($data);
        $instanceId = $this->sanitizeCompletionInstanceId($data);

        // Same finalizer discipline as completeRun: transition + outbox insert in one
        // transaction, dispatch after commit.
        $wrapped = !$this->mysql->inTransaction();
        if ($wrapped) {
            $this->mysql->beginTransaction();
        }
        $outcomeEvent = null;
        try {
            $stmt = $this->mysql->prepare("
                UPDATE flow_run_logs r
                JOIN flow_definitions f ON f.id = r.flow_definition_id
                SET r.status = :s, r.result_json = :result, r.error_json = :error,
                    r.output_actions_json = :actions, r.finished_at = NOW()
                WHERE r.id = :id AND f.owner_user_id = :o AND r.status = 'running'
                  AND (r.claimed_by IS NULL OR (:cb1 IS NOT NULL AND r.claimed_by = :cb2))
            ");
            $stmt->execute([
                's' => $clean['status'],
                'result' => $clean['resultJson'],
                'error' => $clean['errorJson'],
                'actions' => $clean['actionsJson'],
                'id' => $runId,
                'o' => $ownerUserId,
                'cb1' => $instanceId,
                'cb2' => $instanceId,
            ]);
            $transitioned = $stmt->rowCount() > 0;
            if ($transitioned) {
                $outcomeEvent = $this->insertOutcomeEventForRun($runId);
            }
            if ($wrapped) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($wrapped && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        if (!$transitioned) {
            $existing = $this->getOwnerRun($ownerUserId, $runId);
            if ($existing === null) {
                return null;
            }
            if (in_array($existing['status'], self::RUN_ACTIVE_STATUSES, true)) {
                throw new \RuntimeException('claimed_elsewhere');
            }
            throw new \RuntimeException('already_finalized');
        }
        if ($outcomeEvent !== null) {
            $this->dispatchOutcomeEvent($outcomeEvent);
        }

        return $this->getOwnerRun($ownerUserId, $runId);
    }

    /**
     * Optional completion instanceId (claimant binding — see completeRun). @throws \InvalidArgumentException
     */
    private function sanitizeCompletionInstanceId(array $data): ?string
    {
        if (!isset($data['instanceId']) || $data['instanceId'] === null || $data['instanceId'] === '') {
            return null;
        }
        if (!is_string($data['instanceId']) || strlen($data['instanceId']) > 120) {
            throw new \InvalidArgumentException('instanceId must be a string ≤ 120 chars');
        }
        return $data['instanceId'];
    }

    /**
     * Validate a completion payload (status/result/error/outputActions per
     * flow-run-result.schema.json). @return array{status: string, resultJson: ?string, errorJson: ?string, actionsJson: ?string}
     * @throws \InvalidArgumentException
     */
    private function sanitizeCompletion(array $data): array
    {
        $status = $data['status'] ?? null;
        if (!is_string($status) || !in_array($status, self::RUN_TERMINAL_STATUSES, true)) {
            throw new \InvalidArgumentException('status must be one of: ' . implode(', ', self::RUN_TERMINAL_STATUSES));
        }

        $resultJson = null;
        if (array_key_exists('result', $data) && $data['result'] !== null) {
            $json = json_encode($data['result']);
            if ($json === false || strlen($json) > self::MAX_FLOW_JSON_BYTES) {
                throw new \InvalidArgumentException('result exceeds the 256KB limit');
            }
            $resultJson = $json;
        }

        $errorJson = null;
        if (array_key_exists('error', $data) && $data['error'] !== null) {
            $err = $data['error'];
            if (!is_array($err) || !is_string($err['code'] ?? null) || !in_array($err['code'], self::RUN_ERROR_CODES, true)
                || !is_string($err['message'] ?? null) || strlen($err['message']) > 1000) {
                throw new \InvalidArgumentException('error must be { code: <known code>, message: string ≤ 1000, nodeId?: string ≤ 128 }');
            }
            $clean = ['code' => $err['code'], 'message' => $err['message']];
            if (isset($err['nodeId'])) {
                if (!is_string($err['nodeId']) || strlen($err['nodeId']) > 128) {
                    throw new \InvalidArgumentException('error.nodeId must be a string ≤ 128 chars');
                }
                $clean['nodeId'] = $err['nodeId'];
            }
            $errorJson = json_encode($clean);
        }

        $actionsJson = null;
        if (array_key_exists('outputActions', $data) && $data['outputActions'] !== null) {
            $actionsJson = json_encode(self::sanitizeOutputActions($data['outputActions']));
        }

        return ['status' => $status, 'resultJson' => $resultJson, 'errorJson' => $errorJson, 'actionsJson' => $actionsJson];
    }

    /**
     * Paginated run history, newest first, optionally filtered by flow / binding / status.
     * @param array{flowId?: ?string, bindingId?: ?string, status?: ?string} $filters
     * @return array{runs: array[], page: int, limit: int, total: int}
     */
    public function listRuns(string $appId, array $filters = [], int $page = 1, int $limit = 50): array
    {
        $page = max(1, $page);
        $limit = max(1, min(200, $limit));

        $where = 'r.app_id = :a';
        $params = ['a' => $appId];
        if (!empty($filters['flowId'])) {
            $where .= ' AND r.flow_definition_id = :flow';
            $params['flow'] = $filters['flowId'];
        }
        if (!empty($filters['bindingId'])) {
            $where .= ' AND r.binding_id = :binding';
            $params['binding'] = $filters['bindingId'];
        }
        if (!empty($filters['status']) && in_array($filters['status'], array_merge(self::RUN_ACTIVE_STATUSES, self::RUN_TERMINAL_STATUSES), true)) {
            $where .= ' AND r.status = :status';
            $params['status'] = $filters['status'];
        }

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM flow_run_logs r WHERE {$where}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $offset = ($page - 1) * $limit;
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE {$where}
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT {$limit} OFFSET {$offset}
        ");
        $stmt->execute($params);

        return [
            'runs' => array_map([$this, 'formatRun'], $stmt->fetchAll()),
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
        ];
    }

    /**
     * Record a 'running' test run for a flow (trigger_event 'test'); execution happens client-side
     * in the builder, which PATCHes the result in like any other run.
     */
    public function createTestRun(string $appId, string $flowId): ?array
    {
        $flow = $this->getFlow($appId, $flowId);
        if (!$flow) {
            return null;
        }
        $id = $this->uuidV4();
        $flowVersionId = $this->ensureFlowVersion($flow['id']);
        $stmt = $this->mysql->prepare("
            INSERT INTO flow_run_logs
                (id, app_id, flow_definition_id, flow_version_id, trigger_event, correlation_id, idempotency_key, status, started_at)
            VALUES
                (:id, :app, :flow, :flow_version, 'test', :corr, :key, 'running', NOW())
        ");
        $stmt->execute([
            'id' => $id,
            'app' => $appId,
            'flow' => $flow['id'],
            'flow_version' => $flowVersionId,
            'corr' => 'test-' . $id,
            'key' => 'test:' . $id,
        ]);
        return $this->getRun($appId, $id);
    }

    // ── Workspace flows (owner-scoped, app_id NULL) ─────────────────────────────────────────
    //
    // MySQL UNIQUE(app_id, slug) ignores rows where app_id IS NULL, so workspace-slug
    // uniqueness per owner is enforced HERE (create + slug update) — every workspace write
    // must go through these methods.

    /** @return array[] */
    public function listWorkspaceFlows(string $ownerUserId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM flow_definitions
            WHERE owner_user_id = :o AND app_id IS NULL
            ORDER BY created_at ASC, id ASC
        ");
        $stmt->execute(['o' => $ownerUserId]);
        return array_map([$this, 'formatFlow'], $stmt->fetchAll());
    }

    public function getWorkspaceFlow(string $ownerUserId, string $flowId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE id = :id AND owner_user_id = :o AND app_id IS NULL");
        $stmt->execute(['id' => $flowId, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->formatFlow($row) : null;
    }

    public function findEnabledWorkspaceFlowBySlug(string $ownerUserId, string $slug): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM flow_definitions
            WHERE owner_user_id = :o AND app_id IS NULL AND slug = :s AND enabled = 1
        ");
        $stmt->execute(['o' => $ownerUserId, 's' => $slug]);
        $row = $stmt->fetch();
        return $row ? $this->formatFlow($row) : null;
    }

    /**
     * One flow by id, gated on the caller OWNING it (workspace + app flows alike) — the
     * ownership check for owner-scoped run surfaces (POST /api/flows/{id}/run and the
     * desktop flow relay, plan Phase 5). Returns null when the flow is missing or foreign.
     */
    public function getOwnedFlow(string $ownerUserId, string $flowId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE id = :id AND owner_user_id = :o LIMIT 1");
        $stmt->execute(['id' => $flowId, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->formatFlow($row) : null;
    }

    /** @throws \InvalidArgumentException on validation failure / duplicate slug */
    public function createWorkspaceFlow(string $ownerUserId, array $data): array
    {
        $name = trim((string) ($data['name'] ?? ''));
        if ($name === '' || strlen($name) > 255) {
            throw new \InvalidArgumentException('Flow name is required (max 255 chars)');
        }
        $slug = self::sanitizeSlug($data['slug'] ?? $this->slugify($name));
        $flowJson = self::sanitizeFlowJson($data['flowJson'] ?? ['nodes' => [], 'edges' => []]);
        [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
        $executionLocation = array_key_exists('executionLocation', $data)
            ? self::sanitizeExecutionLocation($data['executionLocation'])
            : 'auto';

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM flow_definitions WHERE owner_user_id = :o AND app_id IS NULL");
        $countStmt->execute(['o' => $ownerUserId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_FLOWS_PER_APP) {
            throw new \InvalidArgumentException('A workspace can have at most ' . self::MAX_FLOWS_PER_APP . ' flows');
        }

        $this->assertWorkspaceSlugFree($ownerUserId, $slug);

        // Caller-supplied id = preserve-ids restore (recycle bin / backup import).
        $id = (isset($data['id']) && is_string($data['id']) && $data['id'] !== '') ? $data['id'] : $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO flow_definitions
                (id, owner_user_id, app_id, name, slug, description, engine, flow_json, input_schema, output_schema, node_capabilities, version, enabled, execution_location)
            VALUES
                (:id, :owner, NULL, :name, :slug, :descr, 'f2i', :flow_json, :input_schema, :output_schema, :node_caps, 1, :enabled, :exec_loc)
        ");
        $stmt->execute([
            'id' => $id,
            'owner' => $ownerUserId,
            'name' => $name,
            'slug' => $slug,
            'descr' => isset($data['description']) && is_string($data['description']) ? substr($data['description'], 0, 2000) : null,
            'flow_json' => json_encode($flowJson),
            'input_schema' => $inputSchema !== null ? json_encode($inputSchema) : null,
            'output_schema' => $outputSchema !== null ? json_encode($outputSchema) : null,
            'node_caps' => $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null,
            'enabled' => (array_key_exists('enabled', $data) ? (bool) $data['enabled'] : true) ? 1 : 0,
            'exec_loc' => $executionLocation,
        ]);

        return $this->getWorkspaceFlow($ownerUserId, $id) ?? throw new \RuntimeException('Flow creation failed');
    }

    /** Partial update; bumps version when flowJson changes. @throws \InvalidArgumentException */
    public function updateWorkspaceFlow(string $ownerUserId, string $flowId, array $data): ?array
    {
        $existing = $this->getWorkspaceFlow($ownerUserId, $flowId);
        if (!$existing) {
            return null;
        }
        $expectedVersion = self::sanitizeExpectedVersion($data);
        if ($expectedVersion !== null && $expectedVersion !== (int) $existing['version']) {
            throw new FlowRevisionConflictException((int) $existing['version']);
        }

        $sets = [];
        $params = ['id' => $flowId, 'o' => $ownerUserId];

        if (array_key_exists('name', $data)) {
            $name = trim((string) $data['name']);
            if ($name === '' || strlen($name) > 255) {
                throw new \InvalidArgumentException('Flow name is required (max 255 chars)');
            }
            $sets[] = 'name = :name';
            $params['name'] = $name;
        }
        if (array_key_exists('slug', $data)) {
            $slug = self::sanitizeSlug($data['slug']);
            if ($slug !== $existing['slug']) {
                $this->assertWorkspaceSlugFree($ownerUserId, $slug);
            }
            $sets[] = 'slug = :slug';
            $params['slug'] = $slug;
        }
        if (array_key_exists('description', $data)) {
            $sets[] = 'description = :descr';
            $params['descr'] = is_string($data['description']) ? substr($data['description'], 0, 2000) : null;
        }
        $contractChanged = false;
        if (array_key_exists('flowJson', $data)) {
            $sets[] = 'flow_json = :flow_json';
            $contractChanged = true;
            $params['flow_json'] = json_encode(self::sanitizeFlowJson($data['flowJson']));
        }
        if (array_key_exists('inputSchema', $data) || array_key_exists('outputSchema', $data) || array_key_exists('nodeCapabilities', $data)) {
            [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
            if (array_key_exists('inputSchema', $data)) {
                $sets[] = 'input_schema = :input_schema';
                $contractChanged = true;
                $params['input_schema'] = $inputSchema !== null ? json_encode($inputSchema) : null;
            }
            if (array_key_exists('outputSchema', $data)) {
                $sets[] = 'output_schema = :output_schema';
                $contractChanged = true;
                $params['output_schema'] = $outputSchema !== null ? json_encode($outputSchema) : null;
            }
            if (array_key_exists('nodeCapabilities', $data)) {
                $sets[] = 'node_capabilities = :node_caps';
                $contractChanged = true;
                $params['node_caps'] = $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null;
            }
        }
        if (array_key_exists('enabled', $data)) {
            $sets[] = 'enabled = :enabled';
            $params['enabled'] = ((bool) $data['enabled']) ? 1 : 0;
        }
        if (array_key_exists('executionLocation', $data)) {
            $sets[] = 'execution_location = :exec_loc';
            $contractChanged = true;
            $params['exec_loc'] = self::sanitizeExecutionLocation($data['executionLocation']);
        }

        if (empty($sets)) {
            return $existing;
        }
        if ($contractChanged) {
            $sets[] = 'version = version + 1';
        }

        $guardSql = '';
        if ($expectedVersion !== null) {
            $guardSql = ' AND version = :guard';
            $params['guard'] = $expectedVersion;
        }
        $stmt = $this->mysql->prepare('UPDATE flow_definitions SET ' . implode(', ', $sets) . ' WHERE id = :id AND owner_user_id = :o AND app_id IS NULL' . $guardSql);
        $stmt->execute($params);
        if ($expectedVersion !== null && $stmt->rowCount() === 0) {
            $current = $this->getWorkspaceFlow($ownerUserId, $flowId);
            if (!$current) {
                return null;
            }
            if ((int) $current['version'] !== $expectedVersion) {
                throw new FlowRevisionConflictException((int) $current['version']);
            }
            return $current;
        }

        return $this->getWorkspaceFlow($ownerUserId, $flowId);
    }

    public function deleteWorkspaceFlow(string $ownerUserId, string $flowId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM flow_definitions WHERE id = :id AND owner_user_id = :o AND app_id IS NULL");
        $stmt->execute(['id' => $flowId, 'o' => $ownerUserId]);
        return $stmt->rowCount() > 0;
    }

    /** @throws \InvalidArgumentException when the workspace slug is taken */
    private function assertWorkspaceSlugFree(string $ownerUserId, string $slug): void
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM flow_definitions WHERE owner_user_id = :o AND app_id IS NULL AND slug = :s LIMIT 1");
        $stmt->execute(['o' => $ownerUserId, 's' => $slug]);
        if ($stmt->fetchColumn()) {
            throw new \InvalidArgumentException("A workspace flow with slug '{$slug}' already exists");
        }
    }

    // ── Owner-wide reads (the API-key surface FormLogic Desktop consumes) ──────────────────

    /**
     * Every flow the user owns — workspace + app-scoped — optionally filtered to one app or to
     * the workspace only (appId '' / workspaceOnly). @return array[]
     */
    public function listOwnerFlows(string $ownerUserId, ?string $appId = null, bool $workspaceOnly = false): array
    {
        $where = 'owner_user_id = :o';
        $params = ['o' => $ownerUserId];
        if ($workspaceOnly) {
            $where .= ' AND app_id IS NULL';
        } elseif ($appId !== null && $appId !== '') {
            $where .= ' AND app_id = :a';
            $params['a'] = $appId;
        }
        $stmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE {$where} ORDER BY created_at ASC, id ASC");
        $stmt->execute($params);
        return array_map([$this, 'formatFlow'], $stmt->fetchAll());
    }

    /**
     * Every ENABLED binding whose flow the user owns (workspace form bindings + app bindings),
     * optionally filtered by form. This is the sole backer of the API-key `/api/v1/flow-bindings`
     * route that FormLogic Desktop polls into its local dispatch snapshot (formlogic_client.rs
     * `list_bindings`) — the `enabled = 1` predicate is the server-side kill switch: disabling a
     * binding from the owner-facing Flows panel (which lists bindings via the separate app-scoped
     * `listBindings()`/`listFormBindings()`, unaffected by this filter) must stop Desktop from ever
     * seeing it again, not just the browser runtime (`getRuntimeFlows()` filters the same way).
     * @return array[]
     */
    public function listOwnerBindings(string $ownerUserId, ?string $formId = null): array
    {
        $where = 'f.owner_user_id = :o AND b.enabled = 1';
        $params = ['o' => $ownerUserId];
        if ($formId !== null && $formId !== '') {
            $where .= ' AND b.form_id = :form';
            $params['form'] = $formId;
        }
        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE {$where}
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
        ");
        $stmt->execute($params);
        return array_map([$this, 'formatBinding'], $stmt->fetchAll());
    }

    /**
     * Every binding that points at one owned flow. App flows read app-scoped bindings by the
     * selected flow's app + slug; workspace flows read only app_id NULL form bindings on forms
     * owned by the same user. Returns null when the flow is missing or foreign.
     * @return array[]|null
     */
    public function listBindingsForFlow(string $ownerUserId, string $flowId): ?array
    {
        $flowStmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE id = :id AND owner_user_id = :o LIMIT 1");
        $flowStmt->execute(['id' => $flowId, 'o' => $ownerUserId]);
        $flowRow = $flowStmt->fetch();
        if (!$flowRow) {
            return null;
        }
        $flow = $this->formatFlow($flowRow);

        if ($flow['appId'] !== null) {
            $stmt = $this->mysql->prepare("
                SELECT b.*, f.slug AS flow_slug
                FROM app_flow_bindings b
                JOIN flow_definitions f ON f.id = b.flow_definition_id
                WHERE b.app_id = :app AND f.app_id = :app2 AND f.slug = :slug
                ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
            ");
            $stmt->execute(['app' => $flow['appId'], 'app2' => $flow['appId'], 'slug' => $flow['slug']]);
            return array_map([$this, 'formatBinding'], $stmt->fetchAll());
        }

        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            JOIN forms frm ON frm.id = b.form_id
            WHERE b.app_id IS NULL
              AND f.app_id IS NULL
              AND f.owner_user_id = :owner
              AND frm.user_id = :owner2
              AND f.slug = :slug
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
        ");
        $stmt->execute(['owner' => $ownerUserId, 'owner2' => $ownerUserId, 'slug' => $flow['slug']]);
        return array_map([$this, 'formatBinding'], $stmt->fetchAll());
    }

    // ── Form bindings (workspace scope: app_id NULL + form_id set, non-app forms) ──────────

    /** forms.user_id — the ownership gate for /api/forms/{id}/flow-bindings. */
    public function getFormOwner(string $formId): ?string
    {
        $stmt = $this->mysql->prepare("SELECT user_id FROM forms WHERE id = :id");
        $stmt->execute(['id' => $formId]);
        $owner = $stmt->fetchColumn();
        return is_string($owner) ? $owner : null;
    }

    /** @return array[] */
    public function listFormBindings(string $ownerUserId, string $formId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.app_id IS NULL AND b.form_id = :form AND f.owner_user_id = :o
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
        ");
        $stmt->execute(['form' => $formId, 'o' => $ownerUserId]);
        return array_map([$this, 'formatBinding'], $stmt->fetchAll());
    }

    public function getFormBinding(string $ownerUserId, string $formId, string $bindingId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.id = :id AND b.app_id IS NULL AND b.form_id = :form AND f.owner_user_id = :o
        ");
        $stmt->execute(['id' => $bindingId, 'form' => $formId, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->formatBinding($row) : null;
    }

    /**
     * Bind a WORKSPACE flow (same owner, app_id NULL) to a standalone form's events
     * (e.g. 'form.submitted'). @throws \InvalidArgumentException
     */
    public function createFormBinding(string $ownerUserId, string $formId, array $data): array
    {
        $this->assertBindableForm($formId);
        $clean = self::sanitizeBinding($data);

        // The flow must be one of the owner's WORKSPACE flows (bindings can target disabled flows).
        $flowStmt = $this->mysql->prepare("SELECT id FROM flow_definitions WHERE owner_user_id = :o AND app_id IS NULL AND slug = :s");
        $flowStmt->execute(['o' => $ownerUserId, 's' => $clean['flow']]);
        $flowDefinitionId = $flowStmt->fetchColumn();
        if (!$flowDefinitionId) {
            throw new \InvalidArgumentException("Unknown workspace flow '{$clean['flow']}'");
        }

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM app_flow_bindings WHERE app_id IS NULL AND form_id = :form");
        $countStmt->execute(['form' => $formId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_BINDINGS_PER_APP) {
            throw new \InvalidArgumentException('A form can have at most ' . self::MAX_BINDINGS_PER_APP . ' flow bindings');
        }

        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_flow_bindings
                (id, app_id, form_id, connector_id, flow_definition_id, event_name, mode, condition_json,
                 input_map_json, output_actions_json, timeout_ms, retry_policy_json, fallback_policy_json, enabled, sort_order)
            VALUES
                (:id, NULL, :form, NULL, :flow, :event, :mode, :cond, :input_map, :actions, :timeout, :retry, :fallback, :enabled, :sort)
        ");
        $stmt->execute([
            'id' => $id,
            'form' => $formId,
            'flow' => $flowDefinitionId,
            'event' => $clean['event'],
            'mode' => $clean['mode'],
            'cond' => $clean['condition'] !== null ? json_encode($clean['condition']) : null,
            'input_map' => $clean['inputMap'] !== null ? json_encode($clean['inputMap']) : null,
            'actions' => $clean['outputActions'] !== null ? json_encode($clean['outputActions']) : null,
            'timeout' => $clean['timeoutMs'],
            'retry' => $clean['retryPolicy'] !== null ? json_encode($clean['retryPolicy']) : null,
            'fallback' => $clean['fallbackPolicy'] !== null ? json_encode($clean['fallbackPolicy']) : null,
            'enabled' => $clean['enabled'] ? 1 : 0,
            'sort' => (int) ($data['sortOrder'] ?? 0),
        ]);

        return $this->getFormBinding($ownerUserId, $formId, $id) ?? throw new \RuntimeException('Binding creation failed');
    }

    /** Partial update over the existing config (same merge semantics as updateBinding). */
    public function updateFormBinding(string $ownerUserId, string $formId, string $bindingId, array $data): ?array
    {
        $existing = $this->getFormBinding($ownerUserId, $formId, $bindingId);
        if (!$existing) {
            return null;
        }

        $merged = array_merge([
            'event' => $existing['event'],
            'flow' => $existing['flow'],
            'mode' => $existing['mode'],
            'condition' => $existing['condition'],
            'inputMap' => $existing['inputMap'],
            'outputActions' => $existing['outputActions'],
            'timeoutMs' => $existing['timeoutMs'],
            'retryPolicy' => $existing['retryPolicy'],
            'fallbackPolicy' => $existing['fallbackPolicy'],
            'enabled' => $existing['enabled'],
        ], $data);
        $clean = self::sanitizeBinding($merged);

        $flowStmt = $this->mysql->prepare("SELECT id FROM flow_definitions WHERE owner_user_id = :o AND app_id IS NULL AND slug = :s");
        $flowStmt->execute(['o' => $ownerUserId, 's' => $clean['flow']]);
        $flowDefinitionId = $flowStmt->fetchColumn();
        if (!$flowDefinitionId) {
            throw new \InvalidArgumentException("Unknown workspace flow '{$clean['flow']}'");
        }

        $stmt = $this->mysql->prepare("
            UPDATE app_flow_bindings SET
                flow_definition_id = :flow, event_name = :event, mode = :mode, condition_json = :cond,
                input_map_json = :input_map, output_actions_json = :actions, timeout_ms = :timeout,
                retry_policy_json = :retry, fallback_policy_json = :fallback, enabled = :enabled, sort_order = :sort
            WHERE id = :id AND app_id IS NULL AND form_id = :form
        ");
        $stmt->execute([
            'id' => $bindingId,
            'form' => $formId,
            'flow' => $flowDefinitionId,
            'event' => $clean['event'],
            'mode' => $clean['mode'],
            'cond' => $clean['condition'] !== null ? json_encode($clean['condition']) : null,
            'input_map' => $clean['inputMap'] !== null ? json_encode($clean['inputMap']) : null,
            'actions' => $clean['outputActions'] !== null ? json_encode($clean['outputActions']) : null,
            'timeout' => $clean['timeoutMs'],
            'retry' => $clean['retryPolicy'] !== null ? json_encode($clean['retryPolicy']) : null,
            'fallback' => $clean['fallbackPolicy'] !== null ? json_encode($clean['fallbackPolicy']) : null,
            'enabled' => $clean['enabled'] ? 1 : 0,
            'sort' => array_key_exists('sortOrder', $data) ? (int) $data['sortOrder'] : (int) $existing['sortOrder'],
        ]);

        return $this->getFormBinding($ownerUserId, $formId, $bindingId);
    }

    public function deleteFormBinding(string $ownerUserId, string $formId, string $bindingId): bool
    {
        // Scope through the flow's owner (a workspace binding carries no owner column itself).
        $stmt = $this->mysql->prepare("
            DELETE b FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.id = :id AND b.app_id IS NULL AND b.form_id = :form AND f.owner_user_id = :o
        ");
        $stmt->execute(['id' => $bindingId, 'form' => $formId, 'o' => $ownerUserId]);
        return $stmt->rowCount() > 0;
    }

    // ── Queued runs + claiming (queued → running exactly once) ─────────────────────────────

    /** Claimable queued runs for an app, oldest first. @return array[] */
    public function listQueuedRuns(string $appId, int $limit = 50): array
    {
        $limit = max(1, min(200, $limit));
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.app_id = :a AND r.status = 'queued'
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT {$limit}
        ");
        $stmt->execute(['a' => $appId]);
        return array_map([$this, 'formatRun'], $stmt->fetchAll());
    }

    /** Claimable queued runs across every flow the user owns, oldest first. @return array[] */
    public function listOwnerQueuedRuns(string $ownerUserId, int $limit = 50): array
    {
        $limit = max(1, min(200, $limit));
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE f.owner_user_id = :o AND r.status = 'queued'
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT {$limit}
        ");
        $stmt->execute(['o' => $ownerUserId]);
        return array_map([$this, 'formatRun'], $stmt->fetchAll());
    }

    /**
     * Claim a queued run for an app runtime: the atomic UPDATE ... WHERE status='queued' is the
     * exactly-once gate. Returns the (now running) run; null when the run doesn't exist;
     * throws \RuntimeException('already_claimed') when it exists but isn't queued (→ 409).
     * @throws \InvalidArgumentException on an invalid payload
     */
    public function claimRun(string $appId, string $runId, array $data): ?array
    {
        [$runtime, $claimedBy] = $this->sanitizeClaim($data);
        $stmt = $this->mysql->prepare("
            UPDATE flow_run_logs
            SET status = 'running', runtime = :rt, claimed_by = :cb, started_at = NOW()
            WHERE id = :id AND app_id = :a AND status = 'queued'
        ");
        $stmt->execute(['rt' => $runtime, 'cb' => $claimedBy, 'id' => $runId, 'a' => $appId]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->getRun($appId, $runId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('already_claimed');
        }
        return $this->getRun($appId, $runId);
    }

    /** Owner-scoped claim (workspace runs + any run of a flow the caller owns). */
    public function claimOwnerRun(string $ownerUserId, string $runId, array $data): ?array
    {
        [$runtime, $claimedBy] = $this->sanitizeClaim($data);
        $stmt = $this->mysql->prepare("
            UPDATE flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            SET r.status = 'running', r.runtime = :rt, r.claimed_by = :cb, r.started_at = NOW()
            WHERE r.id = :id AND f.owner_user_id = :o AND r.status = 'queued'
        ");
        $stmt->execute(['rt' => $runtime, 'cb' => $claimedBy, 'id' => $runId, 'o' => $ownerUserId]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->getOwnerRun($ownerUserId, $runId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('already_claimed');
        }
        return $this->getOwnerRun($ownerUserId, $runId);
    }

    /**
     * Reclaim flow_run_logs rows stuck at 'running' past $maxAgeSeconds (bin/flow-runs-reclaim.php,
     * run from cron — see that file's docblock for scheduling). Once claimRun()/claimOwnerRun()
     * (queued→running) or a direct reserveRun()/reserveOwnerRun() (queued:false, straight into
     * running) transitions a row to 'running', NOTHING else in this class ever revisits it: if the
     * claiming runtime (FormLogic Desktop or a browser tab) crashes, loses power, or loses
     * connectivity before calling completeRun()/completeOwnerRun(), the row — and anything gated on
     * its completion — is stuck at 'running' forever with no automatic retry path.
     *
     * No new column was needed to detect this: started_at is ALREADY stamped to NOW() at the exact
     * moment a row becomes 'running', both at direct-reserve time (reserveRun/reserveOwnerRun, see
     * the INSERT's `started` value) and at claim time (claimRun/claimOwnerRun's `SET ... started_at
     * = NOW()`). It already IS the "when did this run start executing" timestamp a staleness sweep
     * needs.
     *
     * Default threshold 600s (10 min): a flow binding's own timeoutMs caps at TIMEOUT_MAX_MS
     * (300000ms / 5 min) — a single per-RUN wall-clock budget the Rust desktop runner enforces as one
     * shrinking deadline shared across every node in the run (see flows/runner.rs: one `Instant`-based
     * deadline computed once, each node's execution wrapped in `tokio::time::timeout(remaining, …)`
     * against that same shrinking budget), NOT a per-node allowance that stacks. So the true
     * worst-case legitimate run duration is 300s; 600s gives a full 2x margin over that ceiling —
     * real flows normally finish in well under a minute. 600s is also the EXACT threshold this
     * codebase already uses elsewhere for "this reservation is abandoned, not just slow" (see
     * ResponseController/AppPublicController's `idempotency_key` takeover: `created_at < NOW() -
     * INTERVAL 600 SECOND`), so this sweep is consistent with an existing convention rather than
     * inventing a new one.
     *
     * Never touches a 'queued' row (started_at is NULL until claimed — a stuck queue is a capacity
     * problem visible via listQueuedRuns()/listOwnerQueuedRuns(), not a crash) or a 'running' row
     * younger than the threshold (still genuinely in flight). Batched (like
     * bin/desktop-commands-cleanup.php's DELETE loop) so a large stuck backlog — e.g. after an
     * infra outage that took out every claiming instance at once — never holds one long table lock.
     *
     * @return int rows reclaimed, or (when $dryRun) rows that WOULD be reclaimed
     */
    public function reclaimStuckRuns(int $maxAgeSeconds = self::STUCK_RUN_DEFAULT_MAX_AGE_SECONDS, bool $dryRun = false): int
    {
        $maxAgeSeconds = max(1, $maxAgeSeconds);
        $cutoffExpr = "(NOW() - INTERVAL {$maxAgeSeconds} SECOND)"; // sanitized int, safe to interpolate (mirrors listQueuedRuns' LIMIT)

        if ($dryRun) {
            $stmt = $this->mysql->query("
                SELECT COUNT(*) FROM flow_run_logs
                WHERE status = 'running' AND started_at IS NOT NULL AND started_at < {$cutoffExpr}
            ");
            return (int) $stmt->fetchColumn();
        }

        $errorJson = json_encode([
            'code' => 'runner_unavailable',
            'message' => 'Run exceeded its execution window and was never completed — the claiming instance likely crashed or lost connectivity.',
        ]);

        $batch = 5000;
        $total = 0;
        do {
            // Select-then-update so each reclaimed run can emit its outcome event (plan §9)
            // — the blind batch UPDATE never knew which ids it flipped.
            $pick = $this->mysql->query("
                SELECT id FROM flow_run_logs
                WHERE status = 'running' AND started_at IS NOT NULL AND started_at < {$cutoffExpr}
                LIMIT {$batch}
            ");
            $ids = array_map(static fn (array $row) => (string) $row['id'], $pick->fetchAll());
            if ($ids === []) {
                break;
            }
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $this->mysql->prepare("
                UPDATE flow_run_logs
                SET status = 'error', error_json = ?, finished_at = NOW()
                WHERE status = 'running' AND id IN ({$placeholders})
            ");
            $stmt->execute([$errorJson, ...$ids]);
            $affected = $stmt->rowCount();
            $total += $affected;
            foreach ($ids as $id) {
                $this->emitRunOutcome($id); // best-effort; never throws
            }
        } while ($affected === $batch);

        return $total;
    }

    /** @return array{0: string, 1: ?string} [runtime, claimedBy] @throws \InvalidArgumentException */
    private function sanitizeClaim(array $data): array
    {
        $runtime = $data['runtime'] ?? null;
        if (!is_string($runtime) || !in_array($runtime, self::RUNTIMES, true)) {
            throw new \InvalidArgumentException('runtime must be one of: ' . implode(', ', self::RUNTIMES));
        }
        $claimedBy = null;
        if (isset($data['instanceId']) && $data['instanceId'] !== null && $data['instanceId'] !== '') {
            if (!is_string($data['instanceId']) || strlen($data['instanceId']) > 120) {
                throw new \InvalidArgumentException('instanceId must be a string ≤ 120 chars');
            }
            $claimedBy = $data['instanceId'];
        }
        return [$runtime, $claimedBy];
    }

    /**
     * Owner-scoped reserve — the API-key surface FormLogic Desktop uses (POST /api/v1/flow-runs).
     * Resolves the flow within the caller's OWN flows: `appId` set → that app's slug scope
     * (the flow must belong to the caller), `appId` absent/'workspace' → workspace scope.
     * Same reserve-first UNIQUE idempotency-key gate as reserveRun, so a desktop reserve and a
     * browser reserve of the same event dedupe to exactly ONE run regardless of which runtime
     * got there first.
     *
     * @return array{run: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / unknown flow / foreign key reuse
     */
    public function reserveOwnerRun(string $ownerUserId, array $data): array
    {
        $flowSlug = self::sanitizeSlug($data['flowSlug'] ?? null);

        $appId = null;
        if (isset($data['appId']) && is_string($data['appId']) && $data['appId'] !== '' && $data['appId'] !== 'workspace') {
            $appId = $data['appId'];
        }

        if ($appId !== null) {
            $flow = $this->findEnabledFlowBySlug($appId, $flowSlug);
            if ($flow !== null && ($flow['ownerUserId'] ?? null) !== $ownerUserId) {
                $flow = null; // never reserve into a foreign owner's app flow
            }
        } else {
            $flow = $this->findEnabledWorkspaceFlowBySlug($ownerUserId, $flowSlug);
        }
        if (!$flow) {
            throw new \InvalidArgumentException("Unknown or disabled flow '{$flowSlug}'");
        }

        // A bindingId must reference a binding OF THIS FLOW (bindings carry no owner column;
        // the flow join is the ownership gate).
        $bindingId = null;
        if (isset($data['bindingId']) && $data['bindingId'] !== null && $data['bindingId'] !== '') {
            if (!is_string($data['bindingId'])) {
                throw new \InvalidArgumentException('Unknown flow binding');
            }
            $stmt = $this->mysql->prepare("SELECT id FROM app_flow_bindings WHERE id = :id AND flow_definition_id = :f");
            $stmt->execute(['id' => $data['bindingId'], 'f' => $flow['id']]);
            $bindingId = $stmt->fetchColumn() ?: null;
            if ($bindingId === null) {
                throw new \InvalidArgumentException('Unknown flow binding');
            }
        }

        $triggerEvent = $data['triggerEvent'] ?? null;
        if (!is_string($triggerEvent) || $triggerEvent === '' || strlen($triggerEvent) > 150 || !preg_match(self::EVENT_PATTERN, $triggerEvent)) {
            throw new \InvalidArgumentException('triggerEvent must match ^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)*$ (max 150 chars)');
        }
        $correlationId = $data['correlationId'] ?? null;
        if (!is_string($correlationId) || $correlationId === '' || strlen($correlationId) > 150) {
            throw new \InvalidArgumentException('correlationId is required (max 150 chars)');
        }
        $idempotencyKey = $data['idempotencyKey'] ?? null;
        if (!is_string($idempotencyKey) || $idempotencyKey === '' || strlen($idempotencyKey) > 255) {
            throw new \InvalidArgumentException('idempotencyKey is required (max 255 chars)');
        }

        $inputSnapshot = null;
        if (isset($data['inputSnapshot']) && $data['inputSnapshot'] !== null) {
            if (!is_array($data['inputSnapshot'])) {
                throw new \InvalidArgumentException('inputSnapshot must be an object');
            }
            $json = json_encode($data['inputSnapshot']);
            if ($json === false || strlen($json) > self::MAX_INPUT_SNAPSHOT_BYTES) {
                throw new \InvalidArgumentException('inputSnapshot exceeds the 64KB limit');
            }
            $inputSnapshot = $json;
        }

        // formId is informational on the run log; accept only a form the caller owns.
        $formId = null;
        if (isset($data['formId']) && is_string($data['formId']) && $data['formId'] !== '') {
            $formId = substr($data['formId'], 0, 36);
            if ($this->getFormOwner($formId) !== $ownerUserId) {
                $formId = null;
            }
        }
        $responseId = (isset($data['responseId']) && is_string($data['responseId']) && $data['responseId'] !== '')
            ? substr($data['responseId'], 0, 36) : null;

        $queued = ($data['queued'] ?? false) === true;

        $id = $this->uuidV4();
        $flowVersionId = $this->ensureFlowVersion($flow['id']);
        [$parentRunId, $rootRunId, $depth, $callNodeId] = $this->resolveRunLineage($data, null, $ownerUserId);
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, flow_version_id,
                     parent_run_id, root_run_id, call_node_id, depth, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :flow_version,
                     :parent_run, :root_run, :call_node, :depth, :event, :corr, :key, :status, :input, :started)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $flow['appId'],
                'form' => $formId,
                'resp' => $responseId,
                'binding' => $bindingId,
                'flow' => $flow['id'],
                'flow_version' => $flowVersionId,
                'parent_run' => $parentRunId,
                'root_run' => $rootRunId,
                'call_node' => $callNodeId,
                'depth' => $depth,
                'event' => $triggerEvent,
                'corr' => $correlationId,
                'key' => $idempotencyKey,
                'status' => $queued ? 'queued' : 'running',
                'input' => $inputSnapshot,
                'started' => $queued ? null : date('Y-m-d H:i:s'),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Already reserved (or complete): return the existing run — idempotent replay,
            // but only within the caller's own flows (never leak a foreign run id).
            // Same scope as the unique index (audit FL-08).
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.flow_definition_id = :f AND r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['f' => $flow['id'], 'k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row || ($row['flow_owner'] ?? null) !== $ownerUserId) {
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['run' => $this->formatRun($row), 'created' => false];
        }

        return ['run' => $this->getOwnerRun($ownerUserId, $id) ?? throw new \RuntimeException('Run reservation failed'), 'created' => true];
    }

    /**
     * The custom-logic bundles of the caller's OWN apps — the surface FormLogic Desktop uses to
     * apply onConnectorEvent scripts headless (GET /api/v1/app-logic). One app when `selector`
     * (app id or slug) is given; otherwise every owner app that HAS a custom_logic bundle.
     * Each entry: {app:{id,slug,name}, customLogic, forms:[{id,name,displayName}]} — the forms
     * list resolves the bundle's formKey references (form title / display name → form id).
     *
     * @return array[]
     */
    public function getOwnerAppLogic(string $ownerUserId, ?string $selector = null): array
    {
        if ($selector !== null && $selector !== '') {
            $stmt = $this->mysql->prepare("
                SELECT id, slug, name, custom_logic FROM apps
                WHERE owner_id = :o AND (id = :sel OR slug = :sel2)
                LIMIT 1
            ");
            $stmt->execute(['o' => $ownerUserId, 'sel' => $selector, 'sel2' => $selector]);
        } else {
            $stmt = $this->mysql->prepare("
                SELECT id, slug, name, custom_logic FROM apps
                WHERE owner_id = :o AND custom_logic IS NOT NULL AND custom_logic != ''
                ORDER BY created_at ASC
                LIMIT 50
            ");
            $stmt->execute(['o' => $ownerUserId]);
        }

        $out = [];
        $formsStmt = $this->mysql->prepare("
            SELECT af.form_id AS id, f.title AS name, af.display_name AS displayName, af.settings AS afSettings
            FROM app_forms af
            JOIN forms f ON f.id = af.form_id
            WHERE af.app_id = :a
            ORDER BY af.sort_order ASC
        ");
        foreach ($stmt->fetchAll() as $row) {
            $formsStmt->execute(['a' => $row['id']]);
            $forms = array_map(static function (array $f) {
                $afSettings = json_decode((string) ($f['afSettings'] ?? ''), true);
                return [
                    'id' => $f['id'],
                    'name' => $f['name'],
                    'displayName' => $f['displayName'],
                    // Stable machine alias (audit FL-007): stamped at pack import,
                    // untouched by renames — formKey resolution checks it FIRST so
                    // relabelling a form can't break app-logic record writes.
                    'packFormId' => is_array($afSettings) ? ($afSettings['packFormId'] ?? null) : null,
                ];
            }, $formsStmt->fetchAll());
            $out[] = [
                'app' => ['id' => $row['id'], 'slug' => $row['slug'], 'name' => $row['name']],
                'customLogic' => $this->decodeJson($row['custom_logic']),
                'forms' => $forms,
                // Connector ids this app holds grants for (audit INT-004): the
                // desktop routes a connector's events only to the ASSIGNED app,
                // or to the single candidate app when no assignment exists.
                'connectors' => $this->appConnectorIds($row['id']),
            ];
        }
        return $out;
    }

    // ── Owner run history (across every flow the user owns) ────────────────────────────────

    /**
     * Paginated DIRECT children of one run (extensible-flows plan §14.4) — runs whose
     * parent_run_id names it, oldest first (creation order = call order for awaited
     * children). Anchored on getOwnerRun's ownership check: an invisible parent returns
     * null exactly like a nonexistent one (no run-id oracle); children are additionally
     * owner-filtered through their own flow join.
     *
     * @return array{runs: array[], total: int, limit: int, offset: int}|null
     */
    public function listOwnerRunChildren(string $ownerUserId, string $runId, int $limit = 25, int $offset = 0): ?array
    {
        if ($this->getOwnerRun($ownerUserId, $runId) === null) {
            return null;
        }
        $limit = max(1, min(100, $limit));
        $offset = max(0, $offset);

        $count = $this->mysql->prepare("
            SELECT COUNT(*)
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.parent_run_id = :id AND f.owner_user_id = :o
        ");
        $count->execute(['id' => $runId, 'o' => $ownerUserId]);
        $total = (int) $count->fetchColumn();

        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.parent_run_id = :id AND f.owner_user_id = :o
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT {$limit} OFFSET {$offset}
        ");
        $stmt->execute(['id' => $runId, 'o' => $ownerUserId]);

        return [
            'runs' => array_map([$this, 'formatRun'], $stmt->fetchAll()),
            'total' => $total,
            'limit' => $limit,
            'offset' => $offset,
        ];
    }

    public function getOwnerRun(string $ownerUserId, string $runId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE r.id = :id AND f.owner_user_id = :o
        ");
        $stmt->execute(['id' => $runId, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->formatRun($row) : null;
    }

    /**
     * Paginated run history across the user's flows, newest first; optional flow / status /
     * app ('' or 'workspace' selects workspace-only runs) filters.
     * @param array{flowId?: ?string, status?: ?string, appId?: ?string} $filters
     * @return array{runs: array[], page: int, limit: int, total: int, offset: int}
     */
    public function listOwnerRuns(string $ownerUserId, array $filters = [], int $page = 1, int $limit = 50, ?int $offset = null): array
    {
        $page = max(1, $page);
        $limit = max(1, min(200, $limit));

        $where = 'f.owner_user_id = :o';
        $params = ['o' => $ownerUserId];
        if (!empty($filters['flowId'])) {
            $where .= ' AND r.flow_definition_id = :flow';
            $params['flow'] = $filters['flowId'];
        }
        if (!empty($filters['status']) && in_array($filters['status'], array_merge(self::RUN_ACTIVE_STATUSES, self::RUN_TERMINAL_STATUSES), true)) {
            $where .= ' AND r.status = :status';
            $params['status'] = $filters['status'];
        }
        if (isset($filters['appId']) && $filters['appId'] !== null && $filters['appId'] !== '') {
            if ($filters['appId'] === 'workspace') {
                $where .= ' AND r.app_id IS NULL';
            } else {
                $where .= ' AND r.app_id = :app';
                $params['app'] = $filters['appId'];
            }
        }

        $countStmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE {$where}
        ");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $offset = $offset !== null ? max(0, $offset) : (($page - 1) * $limit);
        $stmt = $this->mysql->prepare("
            SELECT r.*, f.slug AS flow_slug
            FROM flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            WHERE {$where}
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT {$limit} OFFSET {$offset}
        ");
        $stmt->execute($params);

        return [
            'runs' => array_map([$this, 'formatRun'], $stmt->fetchAll()),
            'page' => $page,
            'limit' => $limit,
            'offset' => $offset,
            'total' => $total,
        ];
    }

    // ── Server-side enqueue (form.submitted bindings + ctx.flows.run script intents) ───────

    /**
     * Insert a 'queued' run row for a (formatted) flow. The UNIQUE idempotency key makes this
     * safe to replay: a duplicate returns the existing run with created=false.
     *
     * @param array $flow A formatted flow row (formatFlow shape: id/appId/ownerUserId)
     * @param array{triggerEvent: string, correlationId: string, idempotencyKey: string,
     *              inputSnapshot?: ?array, formId?: ?string, responseId?: ?string, bindingId?: ?string} $opts
     * @return array{run: array, created: bool}
     * @throws \InvalidArgumentException when the idempotency key is held by a foreign owner's run
     */
    public function enqueueRun(array $flow, array $opts): array
    {
        $inputSnapshot = null;
        if (isset($opts['inputSnapshot']) && is_array($opts['inputSnapshot'])) {
            $json = json_encode($opts['inputSnapshot']);
            if ($json !== false && strlen($json) <= self::MAX_INPUT_SNAPSHOT_BYTES) {
                $inputSnapshot = $json;
            }
        }

        $id = $this->uuidV4();
        $flowVersionId = $this->ensureFlowVersion($flow['id']);
        // Lineage (plan §8.7): outcome-handler enqueues name their source run as parent so
        // event-driven chains inherit root/depth (and the depth ceiling terminates loops).
        [$parentRunId, $rootRunId, $depth, $callNodeId] = $this->resolveRunLineage(
            $opts,
            isset($flow['appId']) && is_string($flow['appId']) && $flow['appId'] !== '' ? $flow['appId'] : null,
            isset($flow['ownerUserId']) && is_string($flow['ownerUserId']) ? $flow['ownerUserId'] : null
        );
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, flow_version_id,
                     parent_run_id, root_run_id, call_node_id, depth, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :flow_version,
                     :parent_run, :root_run, :call_node, :depth, :event, :corr, :key, 'queued', :input, NULL)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $flow['appId'],
                'form' => $opts['formId'] ?? null,
                'resp' => $opts['responseId'] ?? null,
                'binding' => $opts['bindingId'] ?? null,
                'flow' => $flow['id'],
                'flow_version' => $flowVersionId,
                'parent_run' => $parentRunId,
                'root_run' => $rootRunId,
                'call_node' => $callNodeId,
                'depth' => $depth,
                'event' => $opts['triggerEvent'],
                'corr' => substr($opts['correlationId'], 0, 150),
                'key' => substr($opts['idempotencyKey'], 0, 255),
                'input' => $inputSnapshot,
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Replay: return the existing run — but only within the same owner's flows.
            // Same scope as the unique index (audit FL-08).
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.flow_definition_id = :f AND r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['f' => $flow['id'], 'k' => substr($opts['idempotencyKey'], 0, 255)]);
            $row = $find->fetch();
            if (!$row || ($row['flow_owner'] ?? null) !== ($flow['ownerUserId'] ?? null)) {
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['run' => $this->formatRun($row), 'created' => false];
        }

        return ['run' => $this->getOwnerRun($flow['ownerUserId'], $id) ?? throw new \RuntimeException('Run enqueue failed'), 'created' => true];
    }

    /**
     * After a successful submission: enqueue a queued run for every ENABLED 'form.submitted'
     * binding on this form — app bindings and workspace (app_id NULL) bindings alike — capped at
     * MAX_SUBMIT_BINDINGS_PER_SUBMISSION. inputMap selectors are resolved lazily by the executor;
     * the snapshot stores the raw event ({event:{name,data:{formId,responseId,answers}}}) and no
     * user expression runs server-side. Returns the number of runs enqueued.
     */
    public function enqueueSubmissionBindings(string $formId, string $responseId, array $answers): int
    {
        $stmt = $this->mysql->prepare("
            SELECT b.id AS binding_id, b.app_id AS binding_app_id, f.*
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.form_id = :form AND b.event_name = 'form.submitted' AND b.enabled = 1 AND f.enabled = 1
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
            LIMIT " . self::MAX_SUBMIT_BINDINGS_PER_SUBMISSION . "
        ");
        $stmt->execute(['form' => $formId]);
        $rows = $stmt->fetchAll();

        $event = ['name' => 'form.submitted', 'data' => ['formId' => $formId, 'responseId' => $responseId, 'answers' => $answers]];
        $snapshot = ['event' => $event];
        $json = json_encode($snapshot);
        if ($json === false || strlen($json) > self::MAX_INPUT_SNAPSHOT_BYTES) {
            // Answers too large for the snapshot cap: keep the event envelope, drop the payload.
            $snapshot = ['event' => ['name' => 'form.submitted', 'data' => ['formId' => $formId, 'responseId' => $responseId, 'answersTruncated' => true]]];
        }

        $enqueued = 0;
        foreach ($rows as $row) {
            $bindingId = $row['binding_id'];
            $flow = $this->formatFlow($row);
            // The joined row's binding app_id wins over the flow row ordering ambiguity: a
            // binding always enqueues into ITS scope (app or workspace).
            $flow['appId'] = $row['binding_app_id'];
            try {
                $result = $this->enqueueRun($flow, [
                    'triggerEvent' => 'form.submitted',
                    'correlationId' => 'resp-' . $responseId,
                    'idempotencyKey' => 'binding:' . $bindingId . ':' . $responseId,
                    'inputSnapshot' => $snapshot,
                    'formId' => $formId,
                    'responseId' => $responseId,
                    'bindingId' => $bindingId,
                ]);
                if ($result['created']) {
                    $enqueued++;
                }
            } catch (\Throwable $e) {
                // Best-effort per binding: one bad binding must not block the others.
                continue;
            }
        }
        return $enqueued;
    }

    /**
     * Enqueue queued runs for ctx.flows.run() intents recorded by a form's onSubmit script.
     * Each intent is {slug, input?}. The flow slug resolves within the form's app scope first
     * (first app containing the form that has an enabled flow with that slug), then the form
     * owner's workspace scope. Capped at MAX_SCRIPT_FLOW_RUNS; the idempotency key
     * 'script:<responseId>:<slug>' dedupes replays AND repeated run() calls for the same slug.
     * Returns the number of runs enqueued.
     */
    public function enqueueScriptFlowRuns(string $formId, string $responseId, array $intents): int
    {
        $owner = $this->getFormOwner($formId);
        if ($owner === null) {
            return 0;
        }

        $enqueued = 0;
        $seen = [];
        foreach (array_slice(array_values($intents), 0, self::MAX_SCRIPT_FLOW_RUNS) as $intent) {
            $slug = is_array($intent) ? ($intent['slug'] ?? null) : null;
            if (!is_string($slug) || !preg_match(self::SLUG_PATTERN, $slug) || isset($seen[$slug])) {
                continue;
            }
            $seen[$slug] = true;

            // App scope first: an enabled flow with this slug in any app containing the form.
            $stmt = $this->mysql->prepare("
                SELECT f.* FROM flow_definitions f
                JOIN app_forms af ON af.app_id = f.app_id
                WHERE af.form_id = :form AND f.slug = :s AND f.enabled = 1
                ORDER BY f.created_at ASC, f.id ASC
                LIMIT 1
            ");
            $stmt->execute(['form' => $formId, 's' => $slug]);
            $row = $stmt->fetch();
            $flow = $row ? $this->formatFlow($row) : null;
            if ($flow !== null && $flow['ownerUserId'] !== $owner) {
                $flow = null; // never enqueue into a foreign owner's app flow
            }
            $flow ??= $this->findEnabledWorkspaceFlowBySlug($owner, $slug);
            if (!$flow) {
                continue; // unknown slug — the intent is dropped
            }

            $input = (is_array($intent) && isset($intent['input']) && is_array($intent['input'])) ? $intent['input'] : null;
            try {
                $result = $this->enqueueRun($flow, [
                    'triggerEvent' => 'script.run',
                    'correlationId' => 'resp-' . $responseId,
                    'idempotencyKey' => 'script:' . $responseId . ':' . $slug,
                    'inputSnapshot' => $input,
                    'formId' => $formId,
                    'responseId' => $responseId,
                ]);
                if ($result['created']) {
                    $enqueued++;
                }
            } catch (\Throwable $e) {
                continue;
            }
        }
        return $enqueued;
    }

    // ── Desktop connections (paired FormLogic Desktop installs) ────────────────────────────

    /**
     * Upsert on (owner_user_id, desktop_instance_id): registering the same install again refreshes
     * device_name / capabilities / trusted origins and stamps last_seen_at.
     * @throws \InvalidArgumentException on invalid payload
     */
    public function upsertDesktopConnection(string $userId, array $data, ?string $apiKeyId = null): array
    {
        $instanceId = $data['desktopInstanceId'] ?? null;
        if (!is_string($instanceId) || $instanceId === '' || strlen($instanceId) > 128 || !preg_match('/^[A-Za-z0-9._-]+$/', $instanceId)) {
            throw new \InvalidArgumentException('desktopInstanceId is required (max 128 chars: letters, digits, ., _, -)');
        }
        $deviceName = trim((string) ($data['deviceName'] ?? ''));
        if ($deviceName === '') {
            $deviceName = 'FormLogic Desktop';
        }
        $deviceName = substr($deviceName, 0, 255);

        $capabilities = $this->sanitizeStringList($data['capabilities'] ?? null, 64, 128, 'capabilities');
        $trustedOrigins = $this->sanitizeStringList($data['trustedOrigins'] ?? null, 32, 255, 'trustedOrigins');

        // ROUTE-001: an api-key-authenticated heartbeat BINDS the row to that key —
        // the instance identity is then anchored to a credential the server minted,
        // not just a self-asserted string. The OAuth link creates a placeholder row
        // ('oauth-…' synthetic instance id) for the same key before the desktop's
        // first real heartbeat; absorb it here (one install = ONE row, ghost-free)
        // instead of accumulating a sibling that would trip ambiguity resolution.
        //
        // BIND-ONCE (audit FL-01): an instance already bound to a DIFFERENT active key
        // refuses the heartbeat — a sibling key under the same account must never
        // re-bind (impersonate) another install's identity. Unbound legacy rows bind
        // exactly once on their next keyed heartbeat.
        if ($apiKeyId !== null) {
            $existing = $this->mysql->prepare(
                "SELECT id, api_key_id FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i"
            );
            $existing->execute(['o' => $userId, 'i' => $instanceId]);
            $existingRow = $existing->fetch();
            if (
                $existingRow !== false
                && $existingRow['api_key_id'] !== null
                && (string) $existingRow['api_key_id'] !== $apiKeyId
            ) {
                throw new \InvalidArgumentException(
                    'This desktop instance is bound to a different API key — unlink it in Settings before re-pairing'
                );
            }
            if ($existingRow === false) {
                $absorb = $this->mysql->prepare("
                    UPDATE desktop_connections
                    SET desktop_instance_id = :i, device_name = :name,
                        capabilities_json = :caps, trusted_origins_json = :origins, last_seen_at = NOW()
                    WHERE owner_user_id = :o AND api_key_id = :k
                    LIMIT 1
                ");
                $absorb->execute([
                    'i' => $instanceId,
                    'name' => $deviceName,
                    'caps' => $capabilities !== null ? json_encode($capabilities) : null,
                    'origins' => $trustedOrigins !== null ? json_encode($trustedOrigins) : null,
                    'o' => $userId,
                    'k' => $apiKeyId,
                ]);
                if ($absorb->rowCount() > 0) {
                    $find = $this->mysql->prepare("SELECT * FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i");
                    $find->execute(['o' => $userId, 'i' => $instanceId]);
                    $row = $find->fetch();
                    return $row ? $this->formatDesktopConnection($row) : throw new \RuntimeException('Desktop connection upsert failed');
                }
            }
        }

        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, api_key_id, capabilities_json, trusted_origins_json, last_seen_at)
            VALUES
                (:id, :owner, :name, :instance, :apikey, :caps, :origins, NOW())
            ON DUPLICATE KEY UPDATE
                device_name = VALUES(device_name),
                api_key_id = COALESCE(VALUES(api_key_id), api_key_id),
                capabilities_json = VALUES(capabilities_json),
                trusted_origins_json = VALUES(trusted_origins_json),
                last_seen_at = NOW()
        ");
        $stmt->execute([
            'id' => $id,
            'owner' => $userId,
            'name' => $deviceName,
            'instance' => $instanceId,
            'apikey' => $apiKeyId,
            'caps' => $capabilities !== null ? json_encode($capabilities) : null,
            'origins' => $trustedOrigins !== null ? json_encode($trustedOrigins) : null,
        ]);

        if ($apiKeyId !== null) {
            // One key = one install = ONE row: sweep any stray sibling still holding
            // this key under a different instance id (e.g. an unabsorbed placeholder),
            // so it can never make target resolution ambiguous.
            $sweep = $this->mysql->prepare(
                "DELETE FROM desktop_connections
                 WHERE owner_user_id = :o AND api_key_id = :k AND desktop_instance_id != :i"
            );
            $sweep->execute(['o' => $userId, 'k' => $apiKeyId, 'i' => $instanceId]);
        }

        $find = $this->mysql->prepare("SELECT * FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i");
        $find->execute(['o' => $userId, 'i' => $instanceId]);
        $row = $find->fetch();
        return $row ? $this->formatDesktopConnection($row) : throw new \RuntimeException('Desktop connection upsert failed');
    }

    /**
     * Register a desktop connection minted by the OAuth device-link flow, tied to the scoped flk_
     * key the token exchange issued. A fresh row per link (unique synthetic instance id): re-linking
     * supersedes nothing implicitly — the caller revokes the previous key/connection. deviceLabel
     * names the device ("FormLogic Desktop on <device>"); apiKeyId is the minted key's id (revoked
     * when the connection is deleted).
     */
    public function createOAuthDesktopConnection(string $userId, ?string $deviceLabel, string $apiKeyId): array
    {
        $device = $deviceLabel !== null && trim($deviceLabel) !== '' ? trim($deviceLabel) : null;
        $deviceName = substr($device !== null ? "FormLogic Desktop on {$device}" : 'FormLogic Desktop', 0, 255);
        $instanceId = 'oauth-' . bin2hex(random_bytes(12));
        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, api_key_id, last_seen_at)
            VALUES
                (:id, :owner, :name, :instance, :apikey, NOW())
        ");
        $stmt->execute([
            'id' => $id,
            'owner' => $userId,
            'name' => $deviceName,
            'instance' => $instanceId,
            'apikey' => $apiKeyId,
        ]);
        $find = $this->mysql->prepare("SELECT * FROM desktop_connections WHERE id = :id");
        $find->execute(['id' => $id]);
        $row = $find->fetch();
        return $row ? $this->formatDesktopConnection($row) : throw new \RuntimeException('Desktop connection creation failed');
    }

    /**
     * Delegates to the ONE FL-01 identity contract — see
     * DesktopCommandService::resolveDesktopIdentity for the full rules.
     * @throws \RuntimeException 'instance_mismatch' on an impersonation attempt
     */
    public function resolveDesktopIdentity(string $ownerUserId, ?string $apiKeyId, ?string $claimedInstanceId): ?string
    {
        return DesktopCommandService::resolveDesktopIdentityWithPdo($this->mysql, $ownerUserId, $apiKeyId, $claimedInstanceId);
    }

    /** @return array[] */
    public function listDesktopConnections(string $userId): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_connections WHERE owner_user_id = :o ORDER BY last_seen_at DESC, created_at DESC");
        $stmt->execute(['o' => $userId]);
        return array_map([$this, 'formatDesktopConnection'], $stmt->fetchAll());
    }

    public function getDesktopConnection(string $id, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_connections WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $userId]);
        $row = $stmt->fetch();
        return $row ? $this->formatDesktopConnection($row) : null;
    }

    public function deleteDesktopConnection(string $id, string $userId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM desktop_connections WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Delete the connection minted for a given flk_ key (owner-scoped). Backs the desktop's own
     * /api/v1 self-unlink: the calling key identifies exactly one install, so it can remove only its
     * OWN row — never a sibling install's (least-privilege by construction). A hand-entered key with
     * no connection row matches nothing (returns false), so the caller leaves it alone. True if a row went.
     */
    public function deleteDesktopConnectionForKey(string $userId, string $apiKeyId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM desktop_connections WHERE owner_user_id = :o AND api_key_id = :k");
        $stmt->execute(['o' => $userId, 'k' => $apiKeyId]);
        return $stmt->rowCount() > 0;
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /** inputSchema / outputSchema (≤ 16 KiB each) + nodeCapabilities (≤ 64 strings ≤ 128 chars). */
    private function sanitizeFlowMeta(array $data): array
    {
        $schemas = ['inputSchema' => null, 'outputSchema' => null];
        foreach (array_keys($schemas) as $key) {
            if (isset($data[$key]) && $data[$key] !== null) {
                if (!is_array($data[$key])) {
                    throw new \InvalidArgumentException("{$key} must be an object");
                }
                $json = json_encode($data[$key]);
                if ($json === false || strlen($json) > self::MAX_BINDING_JSON_BYTES) {
                    throw new \InvalidArgumentException("{$key} exceeds the 16KB limit");
                }
                $schemas[$key] = $data[$key];
            }
        }
        $inputSchema = $schemas['inputSchema'];
        $outputSchema = $schemas['outputSchema'];

        $nodeCapabilities = $this->sanitizeStringList($data['nodeCapabilities'] ?? null, 64, 128, 'nodeCapabilities');

        return [$inputSchema, $outputSchema, $nodeCapabilities];
    }

    /** A list of ≤ $maxItems non-empty strings each ≤ $maxLen; null when absent/empty. */
    private function sanitizeStringList(mixed $value, int $maxItems, int $maxLen, string $name): ?array
    {
        if ($value === null) {
            return null;
        }
        if (!is_array($value) || !array_is_list($value)) {
            throw new \InvalidArgumentException("{$name} must be an array of strings");
        }
        if (count($value) > $maxItems) {
            throw new \InvalidArgumentException("{$name} cannot have more than {$maxItems} items");
        }
        $out = [];
        foreach ($value as $item) {
            if (!is_string($item) || $item === '' || strlen($item) > $maxLen) {
                throw new \InvalidArgumentException("{$name} items must be non-empty strings ≤ {$maxLen} chars");
            }
            $out[] = $item;
        }
        return $out === [] ? null : $out;
    }

    /** A binding form must belong to the app (or be null). @throws \InvalidArgumentException */
    private function sanitizeBindingFormId(string $appId, mixed $formId): ?string
    {
        if ($formId === null || $formId === '') {
            return null;
        }
        if (!is_string($formId)) {
            throw new \InvalidArgumentException('formId must be a string');
        }
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE app_id = :a AND form_id = :f");
        $stmt->execute(['a' => $appId, 'f' => $formId]);
        if (!$stmt->fetchColumn()) {
            throw new \InvalidArgumentException('formId does not belong to this app');
        }
        return $formId;
    }

    private function sanitizeConnectorId(mixed $connectorId): ?string
    {
        if ($connectorId === null || $connectorId === '') {
            return null;
        }
        if (!is_string($connectorId) || strlen($connectorId) > 64) {
            throw new \InvalidArgumentException('connectorId must be a string ≤ 64 chars');
        }
        return $connectorId;
    }

    private function isDuplicateKey(\PDOException $e): bool
    {
        return $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
    }

    private function formatFlow(array $row): array
    {
        return [
            'id' => $row['id'],
            'ownerUserId' => $row['owner_user_id'],
            'appId' => $row['app_id'],
            'name' => $row['name'],
            'slug' => $row['slug'],
            'description' => $row['description'],
            'engine' => $row['engine'],
            'flowJson' => $this->decodeJson($row['flow_json']) ?? ['nodes' => [], 'edges' => []],
            'inputSchema' => $this->decodeJson($row['input_schema']),
            'outputSchema' => $this->decodeJson($row['output_schema']),
            'nodeCapabilities' => $this->decodeJson($row['node_capabilities']),
            'version' => (int) $row['version'],
            'enabled' => (bool) $row['enabled'],
            'executionLocation' => is_string($row['execution_location'] ?? null) && $row['execution_location'] !== ''
                ? $row['execution_location']
                : 'auto',
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    private function formatBinding(array $row): array
    {
        return [
            'id' => $row['id'],
            'appId' => $row['app_id'],
            'formId' => $row['form_id'],
            'connectorId' => $row['connector_id'],
            'flowDefinitionId' => $row['flow_definition_id'],
            'flow' => $row['flow_slug'] ?? null,
            'event' => $row['event_name'],
            'mode' => $row['mode'],
            'condition' => $this->decodeJson($row['condition_json']),
            'inputMap' => $this->decodeJson($row['input_map_json']),
            'outputActions' => $this->decodeJson($row['output_actions_json']),
            'timeoutMs' => (int) $row['timeout_ms'],
            'retryPolicy' => $this->decodeJson($row['retry_policy_json']),
            'fallbackPolicy' => $this->decodeJson($row['fallback_policy_json']),
            'enabled' => (bool) $row['enabled'],
            'sortOrder' => (int) $row['sort_order'],
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    private function formatRun(array $row): array
    {
        return [
            'runId' => $row['id'],
            'appId' => $row['app_id'],
            'formId' => $row['form_id'],
            'responseId' => $row['response_id'],
            'bindingId' => $row['binding_id'],
            'flowDefinitionId' => $row['flow_definition_id'],
            'flowVersionId' => $row['flow_version_id'] ?? null,
            'parentRunId' => $row['parent_run_id'] ?? null,
            'rootRunId' => $row['root_run_id'] ?? null,
            'callNodeId' => $row['call_node_id'] ?? null,
            'depth' => (int) ($row['depth'] ?? 0),
            'flow' => $row['flow_slug'] ?? null,
            'triggerEvent' => $row['trigger_event'],
            'correlationId' => $row['correlation_id'],
            'idempotencyKey' => $row['idempotency_key'],
            'status' => $row['status'],
            'runtime' => $row['runtime'] ?? null,
            'executionLocation' => $row['execution_location'] ?? null,
            'claimedBy' => $row['claimed_by'] ?? null,
            'inputSnapshot' => $this->decodeJson($row['input_snapshot_json']),
            'result' => $this->decodeJson($row['result_json']),
            'outputActions' => $this->decodeJson($row['output_actions_json']),
            'error' => $this->decodeJson($row['error_json']),
            'startedAt' => $row['started_at'],
            'finishedAt' => $row['finished_at'],
            'createdAt' => $row['created_at'],
        ];
    }

    private function formatDesktopConnection(array $row): array
    {
        return [
            'id' => $row['id'],
            'deviceName' => $row['device_name'],
            'desktopInstanceId' => $row['desktop_instance_id'],
            'apiKeyId' => $row['api_key_id'] ?? null,
            'capabilities' => $this->decodeJson($row['capabilities_json']) ?? [],
            'trustedOrigins' => $this->decodeJson($row['trusted_origins_json']) ?? [],
            'lastSeenAt' => $row['last_seen_at'],
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    // ── Connector→app assignments (audit INT-004/C-13) ─────────────────────────

    /**
     * The owner's connector→app assignments plus, per connector, every CANDIDATE
     * app (any app holding a connector.<id>.* role grant). Runtimes route a
     * connector's events to the assigned app; with no assignment they may fall
     * back to a SINGLE candidate, and must reject ambiguous (2+) fan-out.
     */
    public function getConnectorAssignments(string $ownerUserId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT ca.connector_id, ca.app_id, a.name AS app_name, a.slug AS app_slug,
                   ca.desktop_connection_id, dc.device_name AS desktop_device_name,
                   dc.desktop_instance_id, dc.last_seen_at AS desktop_last_seen_at
            FROM connector_assignments ca
            JOIN apps a ON a.id = ca.app_id
            LEFT JOIN desktop_connections dc ON dc.id = ca.desktop_connection_id
            WHERE ca.owner_user_id = :o
            ORDER BY ca.connector_id ASC
        ");
        $stmt->execute(['o' => $ownerUserId]);
        $assignments = array_map(static fn (array $r) => [
            'connectorId' => $r['connector_id'],
            'appId' => $r['app_id'],
            'appName' => $r['app_name'],
            'appSlug' => $r['app_slug'],
            // ROUTE-001: the pinned desktop that runs this connector's commands (null =
            // implicit-single / ambiguous resolution at enqueue time).
            'desktopConnectionId' => $r['desktop_connection_id'],
            'desktopDeviceName' => $r['desktop_device_name'],
            'desktopInstanceId' => $r['desktop_instance_id'],
            'desktopLastSeenAt' => $r['desktop_last_seen_at'],
        ], $stmt->fetchAll());

        $stmt = $this->mysql->prepare("
            SELECT DISTINCT SUBSTRING_INDEX(SUBSTRING(arp.permission, 11), '.', 1) AS connector_id,
                   ar.app_id, a.name AS app_name
            FROM app_role_permissions arp
            JOIN app_roles ar ON ar.id = arp.role_id
            JOIN apps a ON a.id = ar.app_id
            WHERE a.owner_id = :o AND arp.permission LIKE 'connector.%'
            ORDER BY connector_id ASC, a.created_at ASC
        ");
        $stmt->execute(['o' => $ownerUserId]);
        $candidates = [];
        foreach ($stmt->fetchAll() as $r) {
            $candidates[$r['connector_id']][] = ['appId' => $r['app_id'], 'appName' => $r['app_name']];
        }
        // ROUTE-001: the owner's registered desktops ride along so assignment UIs can
        // offer the machine picker without a second request.
        $desktops = array_map(static fn (array $c) => [
            'id' => $c['id'],
            'deviceName' => $c['deviceName'],
            'desktopInstanceId' => $c['desktopInstanceId'],
            'lastSeenAt' => $c['lastSeenAt'],
        ], $this->listDesktopConnections($ownerUserId));
        return ['assignments' => $assignments, 'candidates' => $candidates, 'desktops' => $desktops];
    }

    /**
     * Assign a connector to ONE of the owner's apps (upsert), or clear the
     * assignment with appId null. Throws InvalidArgumentException on a bad
     * connector id or an app the owner does not own.
     *
     * ROUTE-001: $desktopConnectionId optionally pins WHICH desktop connection
     * runs this connector's relay commands. Passed as ['set' => ?string] so
     * "leave unchanged" (key absent) is distinct from "clear the pin" (null):
     * a plain app re-assignment must never silently drop the machine pin.
     */
    public function setConnectorAssignment(
        string $ownerUserId,
        string $connectorId,
        ?string $appId,
        array $desktopConnectionId = [],
    ): array {
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $connectorId)) {
            throw new \InvalidArgumentException('Invalid connector id');
        }
        if ($appId === null || $appId === '') {
            $stmt = $this->mysql->prepare(
                'DELETE FROM connector_assignments WHERE owner_user_id = :o AND connector_id = :c'
            );
            $stmt->execute(['o' => $ownerUserId, 'c' => $connectorId]);
            return $this->getConnectorAssignments($ownerUserId);
        }
        $stmt = $this->mysql->prepare('SELECT id FROM apps WHERE id = :a AND owner_id = :o');
        $stmt->execute(['a' => $appId, 'o' => $ownerUserId]);
        if (!$stmt->fetch()) {
            throw new \InvalidArgumentException('App not found or not owned by you');
        }

        $desktopProvided = array_key_exists('set', $desktopConnectionId);
        $desktopId = $desktopProvided ? $desktopConnectionId['set'] : null;
        if ($desktopProvided && $desktopId !== null && $desktopId !== '') {
            if (!is_string($desktopId)) {
                throw new \InvalidArgumentException('desktopConnectionId must be a string or null');
            }
            $stmt = $this->mysql->prepare('SELECT id FROM desktop_connections WHERE id = :d AND owner_user_id = :o');
            $stmt->execute(['d' => $desktopId, 'o' => $ownerUserId]);
            if (!$stmt->fetch()) {
                throw new \InvalidArgumentException('Desktop connection not found or not owned by you');
            }
        } elseif ($desktopProvided) {
            $desktopId = null; // explicit clear
        }

        $desktopSql = $desktopProvided ? ', desktop_connection_id = VALUES(desktop_connection_id)' : '';
        $sql = "
            INSERT INTO connector_assignments (id, owner_user_id, connector_id, app_id" . ($desktopProvided ? ', desktop_connection_id' : '') . ")
            VALUES (:id, :o, :c, :a" . ($desktopProvided ? ', :d' : '') . ")
            ON DUPLICATE KEY UPDATE app_id = VALUES(app_id){$desktopSql}
        ";
        $params = ['id' => $this->uuidV4(), 'o' => $ownerUserId, 'c' => $connectorId, 'a' => $appId];
        if ($desktopProvided) {
            $params['d'] = $desktopId;
        }
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return $this->getConnectorAssignments($ownerUserId);
    }

    /** Distinct connector ids an app holds `connector.<id>.*` role grants for. */
    private function appConnectorIds(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT DISTINCT SUBSTRING_INDEX(SUBSTRING(arp.permission, 11), '.', 1) AS connector_id
            FROM app_role_permissions arp
            JOIN app_roles ar ON ar.id = arp.role_id
            WHERE ar.app_id = :a AND arp.permission LIKE 'connector.%'
            ORDER BY connector_id ASC
        ");
        $stmt->execute(['a' => $appId]);
        return array_values(array_filter(array_map(
            static fn (array $r) => (string) $r['connector_id'],
            $stmt->fetchAll()
        )));
    }

    private function decodeJson(?string $json): ?array
    {
        if ($json === null || $json === '') {
            return null;
        }
        $decoded = json_decode($json, true);
        return is_array($decoded) ? $decoded : null;
    }

    private function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');
        if ($slug === '' || !preg_match('/^[a-z]/', $slug)) {
            $slug = 'flow-' . $slug;
        }
        $slug = substr(rtrim($slug, '-'), 0, 128);
        return strlen($slug) >= 2 ? $slug : $slug . '-1';
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
