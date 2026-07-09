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

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
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
        foreach ($flowJson['edges'] as $i => $edge) {
            $source = is_array($edge) ? ($edge['source'] ?? null) : null;
            $target = is_array($edge) ? ($edge['target'] ?? null) : null;
            if (!is_string($source) || !is_string($target)) {
                throw new \InvalidArgumentException("Flow edge at index {$i} must have string source and target");
            }
            if (!isset($nodeIds[$source]) || !isset($nodeIds[$target])) {
                throw new \InvalidArgumentException("Flow edge at index {$i} references a missing node ('{$source}' → '{$target}')");
            }
        }

        return ['nodes' => array_values($flowJson['nodes']), 'edges' => array_values($flowJson['edges'])];
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

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM flow_definitions WHERE app_id = :a");
        $countStmt->execute(['a' => $appId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_FLOWS_PER_APP) {
            throw new \InvalidArgumentException('An app can have at most ' . self::MAX_FLOWS_PER_APP . ' flows');
        }

        $id = $this->uuidV4();
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_definitions
                    (id, owner_user_id, app_id, name, slug, description, engine, flow_json, input_schema, output_schema, node_capabilities, version, enabled)
                VALUES
                    (:id, :owner, :app, :name, :slug, :descr, 'f2i', :flow_json, :input_schema, :output_schema, :node_caps, 1, :enabled)
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
            ]);
        } catch (\PDOException $e) {
            if ($this->isDuplicateKey($e)) {
                throw new \InvalidArgumentException("A flow with slug '{$slug}' already exists in this app");
            }
            throw $e;
        }

        return $this->getFlow($appId, $id) ?? throw new \RuntimeException('Flow creation failed');
    }

    /** Partial update; bumps version when flowJson changes. @throws \InvalidArgumentException */
    public function updateFlow(string $appId, string $flowId, array $data): ?array
    {
        $existing = $this->getFlow($appId, $flowId);
        if (!$existing) {
            return null;
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
        if (array_key_exists('flowJson', $data)) {
            $sets[] = 'flow_json = :flow_json';
            $sets[] = 'version = version + 1';
            $params['flow_json'] = json_encode(self::sanitizeFlowJson($data['flowJson']));
        }
        if (array_key_exists('inputSchema', $data) || array_key_exists('outputSchema', $data) || array_key_exists('nodeCapabilities', $data)) {
            [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
            if (array_key_exists('inputSchema', $data)) {
                $sets[] = 'input_schema = :input_schema';
                $params['input_schema'] = $inputSchema !== null ? json_encode($inputSchema) : null;
            }
            if (array_key_exists('outputSchema', $data)) {
                $sets[] = 'output_schema = :output_schema';
                $params['output_schema'] = $outputSchema !== null ? json_encode($outputSchema) : null;
            }
            if (array_key_exists('nodeCapabilities', $data)) {
                $sets[] = 'node_capabilities = :node_caps';
                $params['node_caps'] = $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null;
            }
        }
        if (array_key_exists('enabled', $data)) {
            $sets[] = 'enabled = :enabled';
            $params['enabled'] = ((bool) $data['enabled']) ? 1 : 0;
        }

        if (empty($sets)) {
            return $existing;
        }

        try {
            $stmt = $this->mysql->prepare('UPDATE flow_definitions SET ' . implode(', ', $sets) . ' WHERE id = :id AND app_id = :a');
            $stmt->execute($params);
        } catch (\PDOException $e) {
            if ($this->isDuplicateKey($e)) {
                throw new \InvalidArgumentException('A flow with this slug already exists in this app');
            }
            throw $e;
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

        $formId = $this->sanitizeBindingFormId($appId, $data['formId'] ?? null);
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
                'slug' => $flow['slug'],
                'name' => $flow['name'],
                'engine' => $flow['engine'],
                'flowJson' => $flow['flowJson'],
                'inputSchema' => $flow['inputSchema'],
                'outputSchema' => $flow['outputSchema'],
                'nodeCapabilities' => $flow['nodeCapabilities'],
                'version' => $flow['version'],
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
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :event, :corr, :key, :status, :input, :started)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $appId,
                'form' => $formId,
                'resp' => $responseId,
                'binding' => $bindingId,
                'flow' => $flow['id'],
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
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row || ($row['app_id'] ?? null) !== $appId) {
                // The key belongs to ANOTHER app (or vanished): never leak a foreign run id.
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['run' => $this->formatRun($row), 'created' => false];
        }

        return ['run' => $this->getRun($appId, $id) ?? throw new \RuntimeException('Run reservation failed'), 'created' => true];
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
     *   \RuntimeException('already_finalized') — the run is already terminal (controller → 409).
     */
    public function completeRun(string $appId, string $runId, array $data): ?array
    {
        $clean = $this->sanitizeCompletion($data);

        $stmt = $this->mysql->prepare("
            UPDATE flow_run_logs
            SET status = :s, result_json = :result, error_json = :error, output_actions_json = :actions, finished_at = NOW()
            WHERE id = :id AND app_id = :a AND status IN ('running', 'queued')
        ");
        $stmt->execute([
            's' => $clean['status'],
            'result' => $clean['resultJson'],
            'error' => $clean['errorJson'],
            'actions' => $clean['actionsJson'],
            'id' => $runId,
            'a' => $appId,
        ]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->getRun($appId, $runId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('already_finalized');
        }

        return $this->getRun($appId, $runId);
    }

    /**
     * Owner-scoped complete (workspace runs + any run of a flow the caller owns — the surface
     * FormLogic Desktop uses over API keys). Same payload/transitions as completeRun.
     */
    public function completeOwnerRun(string $ownerUserId, string $runId, array $data): ?array
    {
        $clean = $this->sanitizeCompletion($data);

        $stmt = $this->mysql->prepare("
            UPDATE flow_run_logs r
            JOIN flow_definitions f ON f.id = r.flow_definition_id
            SET r.status = :s, r.result_json = :result, r.error_json = :error,
                r.output_actions_json = :actions, r.finished_at = NOW()
            WHERE r.id = :id AND f.owner_user_id = :o AND r.status IN ('running', 'queued')
        ");
        $stmt->execute([
            's' => $clean['status'],
            'result' => $clean['resultJson'],
            'error' => $clean['errorJson'],
            'actions' => $clean['actionsJson'],
            'id' => $runId,
            'o' => $ownerUserId,
        ]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->getOwnerRun($ownerUserId, $runId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('already_finalized');
        }

        return $this->getOwnerRun($ownerUserId, $runId);
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
        $stmt = $this->mysql->prepare("
            INSERT INTO flow_run_logs
                (id, app_id, flow_definition_id, trigger_event, correlation_id, idempotency_key, status, started_at)
            VALUES
                (:id, :app, :flow, 'test', :corr, :key, 'running', NOW())
        ");
        $stmt->execute([
            'id' => $id,
            'app' => $appId,
            'flow' => $flow['id'],
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

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM flow_definitions WHERE owner_user_id = :o AND app_id IS NULL");
        $countStmt->execute(['o' => $ownerUserId]);
        if ((int) $countStmt->fetchColumn() >= self::MAX_FLOWS_PER_APP) {
            throw new \InvalidArgumentException('A workspace can have at most ' . self::MAX_FLOWS_PER_APP . ' flows');
        }

        $this->assertWorkspaceSlugFree($ownerUserId, $slug);

        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO flow_definitions
                (id, owner_user_id, app_id, name, slug, description, engine, flow_json, input_schema, output_schema, node_capabilities, version, enabled)
            VALUES
                (:id, :owner, NULL, :name, :slug, :descr, 'f2i', :flow_json, :input_schema, :output_schema, :node_caps, 1, :enabled)
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
        if (array_key_exists('flowJson', $data)) {
            $sets[] = 'flow_json = :flow_json';
            $sets[] = 'version = version + 1';
            $params['flow_json'] = json_encode(self::sanitizeFlowJson($data['flowJson']));
        }
        if (array_key_exists('inputSchema', $data) || array_key_exists('outputSchema', $data) || array_key_exists('nodeCapabilities', $data)) {
            [$inputSchema, $outputSchema, $nodeCapabilities] = $this->sanitizeFlowMeta($data);
            if (array_key_exists('inputSchema', $data)) {
                $sets[] = 'input_schema = :input_schema';
                $params['input_schema'] = $inputSchema !== null ? json_encode($inputSchema) : null;
            }
            if (array_key_exists('outputSchema', $data)) {
                $sets[] = 'output_schema = :output_schema';
                $params['output_schema'] = $outputSchema !== null ? json_encode($outputSchema) : null;
            }
            if (array_key_exists('nodeCapabilities', $data)) {
                $sets[] = 'node_capabilities = :node_caps';
                $params['node_caps'] = $nodeCapabilities !== null ? json_encode($nodeCapabilities) : null;
            }
        }
        if (array_key_exists('enabled', $data)) {
            $sets[] = 'enabled = :enabled';
            $params['enabled'] = ((bool) $data['enabled']) ? 1 : 0;
        }

        if (empty($sets)) {
            return $existing;
        }

        $stmt = $this->mysql->prepare('UPDATE flow_definitions SET ' . implode(', ', $sets) . ' WHERE id = :id AND owner_user_id = :o AND app_id IS NULL');
        $stmt->execute($params);

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
            $stmt = $this->mysql->prepare("
                UPDATE flow_run_logs
                SET status = 'error', error_json = :error, finished_at = NOW()
                WHERE status = 'running' AND started_at IS NOT NULL AND started_at < {$cutoffExpr}
                LIMIT {$batch}
            ");
            $stmt->execute(['error' => $errorJson]);
            $affected = $stmt->rowCount();
            $total += $affected;
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
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :event, :corr, :key, :status, :input, :started)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $flow['appId'],
                'form' => $formId,
                'resp' => $responseId,
                'binding' => $bindingId,
                'flow' => $flow['id'],
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
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['k' => $idempotencyKey]);
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
            SELECT af.form_id AS id, f.title AS name, af.display_name AS displayName
            FROM app_forms af
            JOIN forms f ON f.id = af.form_id
            WHERE af.app_id = :a
            ORDER BY af.sort_order ASC
        ");
        foreach ($stmt->fetchAll() as $row) {
            $formsStmt->execute(['a' => $row['id']]);
            $forms = array_map(static fn (array $f) => [
                'id' => $f['id'],
                'name' => $f['name'],
                'displayName' => $f['displayName'],
            ], $formsStmt->fetchAll());
            $out[] = [
                'app' => ['id' => $row['id'], 'slug' => $row['slug'], 'name' => $row['name']],
                'customLogic' => $this->decodeJson($row['custom_logic']),
                'forms' => $forms,
            ];
        }
        return $out;
    }

    // ── Owner run history (across every flow the user owns) ────────────────────────────────

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
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_run_logs
                    (id, app_id, form_id, response_id, binding_id, flow_definition_id, trigger_event,
                     correlation_id, idempotency_key, status, input_snapshot_json, started_at)
                VALUES
                    (:id, :app, :form, :resp, :binding, :flow, :event, :corr, :key, 'queued', :input, NULL)
            ");
            $stmt->execute([
                'id' => $id,
                'app' => $flow['appId'],
                'form' => $opts['formId'] ?? null,
                'resp' => $opts['responseId'] ?? null,
                'binding' => $opts['bindingId'] ?? null,
                'flow' => $flow['id'],
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
            $find = $this->mysql->prepare("
                SELECT r.*, f.slug AS flow_slug, f.owner_user_id AS flow_owner
                FROM flow_run_logs r
                LEFT JOIN flow_definitions f ON f.id = r.flow_definition_id
                WHERE r.idempotency_key = :k LIMIT 1
            ");
            $find->execute(['k' => substr($opts['idempotencyKey'], 0, 255)]);
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
    public function upsertDesktopConnection(string $userId, array $data): array
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

        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare("
            INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, capabilities_json, trusted_origins_json, last_seen_at)
            VALUES
                (:id, :owner, :name, :instance, :caps, :origins, NOW())
            ON DUPLICATE KEY UPDATE
                device_name = VALUES(device_name),
                capabilities_json = VALUES(capabilities_json),
                trusted_origins_json = VALUES(trusted_origins_json),
                last_seen_at = NOW()
        ");
        $stmt->execute([
            'id' => $id,
            'owner' => $userId,
            'name' => $deviceName,
            'instance' => $instanceId,
            'caps' => $capabilities !== null ? json_encode($capabilities) : null,
            'origins' => $trustedOrigins !== null ? json_encode($trustedOrigins) : null,
        ]);

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
            'flow' => $row['flow_slug'] ?? null,
            'triggerEvent' => $row['trigger_event'],
            'correlationId' => $row['correlation_id'],
            'idempotencyKey' => $row['idempotency_key'],
            'status' => $row['status'],
            'runtime' => $row['runtime'] ?? null,
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
