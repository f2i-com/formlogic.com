<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Blueprints (extensible-flows plan §11/§14, Phase 6 groundwork): the persistent
 * high-level Diagram plus the seed of the Build Mutation Gateway (§14.3) every later
 * editing surface — canvas, Copilot, launcher — must route through.
 *
 * Model discipline:
 *   - SEPARATE semantic vs layout revisions (§11.2): semantic operations carry a
 *     `baseSemanticRevision` precondition (stale → revision_conflict); layout operations
 *     never do — a node drag can never conflict with a simultaneous semantic edit.
 *   - Elements hold BOTH diagram nodes and relationship edges (element_type 'edge',
 *     endpoints validated in properties.sourceId/targetId). Deletes are TOMBSTONES.
 *   - Every commit is one atomic change set: ID-addressed operations recorded with
 *     their inverses (undo groundwork); operation_id is UNIQUE per blueprint so replays
 *     are refused rather than double-applied.
 *   - Edges/elements start CONCEPT-ONLY (§11.5) — materialisation into real bindings
 *     and resources is a later slice; this service never mutates other aggregates.
 */
class BlueprintService
{
    public const MAX_BLUEPRINTS_PER_OWNER = 100;
    public const MAX_ELEMENTS_PER_BLUEPRINT = 500;
    public const MAX_OPERATIONS_PER_BATCH = 100;
    public const ELEMENT_ID_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/';

    public const ELEMENT_TYPES = [
        'app', 'form', 'screen', 'event', 'flow', 'intelligence',
        'service', 'actor', 'decision', 'group', 'note', 'edge',
        // §11A.1b drawing layer: freehand strokes, pasted/attached images, outlined
        // shapes (rect/circle/triangle) and freestanding text labels.
        'ink', 'image', 'shape', 'text',
    ];
    public const EDGE_TYPES = [
        'contains', 'triggers', 'sends-data', 'success', 'failure',
        'invokes', 'uses', 'relation', 'exposes',
    ];

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /** @return array[] newest-updated first */
    public function listBlueprints(string $ownerUserId): array
    {
        $stmt = $this->mysql->prepare(
            'SELECT * FROM blueprints WHERE owner_user_id = :o ORDER BY updated_at DESC, id LIMIT 200'
        );
        $stmt->execute(['o' => $ownerUserId]);
        return array_map([$this, 'formatBlueprintRow'], $stmt->fetchAll());
    }

    public function createBlueprint(string $ownerUserId, array $input): array
    {
        $name = trim((string) ($input['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 120) {
            throw new \InvalidArgumentException('Blueprint name must be 1-120 characters');
        }
        $appId = isset($input['appId']) && is_string($input['appId']) && $input['appId'] !== ''
            ? substr($input['appId'], 0, 36)
            : null;
        $count = $this->mysql->prepare('SELECT COUNT(*) FROM blueprints WHERE owner_user_id = :o');
        $count->execute(['o' => $ownerUserId]);
        if ((int) $count->fetchColumn() >= self::MAX_BLUEPRINTS_PER_OWNER) {
            throw new \InvalidArgumentException('Blueprint limit reached (' . self::MAX_BLUEPRINTS_PER_OWNER . ')');
        }
        $id = $this->uuid();
        $stmt = $this->mysql->prepare('
            INSERT INTO blueprints (id, owner_user_id, app_id, name, status, created_by, updated_by)
            VALUES (:id, :o, :app, :name, :status, :actor, :actor2)
        ');
        $stmt->execute([
            'id' => $id,
            'o' => $ownerUserId,
            'app' => $appId,
            'name' => $name,
            'status' => 'draft',
            'actor' => $ownerUserId,
            'actor2' => $ownerUserId,
        ]);
        return $this->getBlueprint($ownerUserId, $id) ?? throw new \RuntimeException('Blueprint create failed');
    }

    /** Full snapshot: identity + revisions + live elements + layouts. Null when foreign/missing. */
    public function getBlueprint(string $ownerUserId, string $blueprintId): ?array
    {
        $row = $this->ownedRow($ownerUserId, $blueprintId);
        if ($row === null) {
            return null;
        }
        $elements = $this->mysql->prepare('
            SELECT * FROM blueprint_elements
            WHERE blueprint_id = :b AND deleted_at IS NULL
            ORDER BY created_at, id
        ');
        $elements->execute(['b' => $blueprintId]);
        $layouts = $this->mysql->prepare('SELECT element_id, layout_json FROM blueprint_layouts WHERE blueprint_id = :b');
        $layouts->execute(['b' => $blueprintId]);
        $layoutMap = [];
        foreach ($layouts->fetchAll() as $layout) {
            $layoutMap[(string) $layout['element_id']] = json_decode((string) $layout['layout_json'], true);
        }
        $out = $this->formatBlueprintRow($row);
        $out['elements'] = array_map(
            fn (array $element) => [
                'id' => (string) $element['id'],
                'elementType' => (string) $element['element_type'],
                'resourceRef' => $element['resource_ref_json'] !== null
                    ? json_decode((string) $element['resource_ref_json'], true)
                    : null,
                'properties' => $element['properties_json'] !== null
                    ? json_decode((string) $element['properties_json'], true)
                    : new \stdClass(),
                'layout' => $layoutMap[(string) $element['id']] ?? null,
            ],
            $elements->fetchAll()
        );
        return $out;
    }

    /** Rename (identity metadata — not a diagram mutation, so no operation batch). */
    public function renameBlueprint(string $ownerUserId, string $blueprintId, string $name): ?array
    {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 120) {
            throw new \InvalidArgumentException('Blueprint name must be 1-120 characters');
        }
        if ($this->ownedRow($ownerUserId, $blueprintId) === null) {
            return null;
        }
        $this->mysql->prepare('UPDATE blueprints SET name = :name, updated_by = :actor WHERE id = :id')
            ->execute(['name' => $name, 'actor' => $ownerUserId, 'id' => $blueprintId]);
        return $this->getBlueprint($ownerUserId, $blueprintId);
    }

    public function deleteBlueprint(string $ownerUserId, string $blueprintId): bool
    {
        if ($this->ownedRow($ownerUserId, $blueprintId) === null) {
            return false;
        }
        $this->mysql->prepare('DELETE FROM blueprint_operations WHERE blueprint_id = :b')->execute(['b' => $blueprintId]);
        $this->mysql->prepare('DELETE FROM blueprint_layouts WHERE blueprint_id = :b')->execute(['b' => $blueprintId]);
        $this->mysql->prepare('DELETE FROM blueprint_elements WHERE blueprint_id = :b')->execute(['b' => $blueprintId]);
        $this->mysql->prepare('DELETE FROM blueprints WHERE id = :b')->execute(['b' => $blueprintId]);
        return true;
    }

    /**
     * Validate + atomically commit one operation batch (§14.3). Returns the new revisions
     * plus the change-set id. Throws BlueprintRevisionConflictException on a stale
     * baseSemanticRevision and \InvalidArgumentException on any structural refusal —
     * validation runs BEFORE any write, so a refused batch mutates nothing.
     *
     * Supported v1 operations (ID-addressed; never raw JSON Patch):
     *   blueprint.element.create  {targetId, elementType, resourceRef?, properties?, layout?}
     *   blueprint.element.update  {targetId, properties? , resourceRef?}   (semantic)
     *   blueprint.element.delete  {targetId}                                (tombstone)
     *   blueprint.layout.set      {targetId, layout}                        (layout-only)
     *   blueprint.viewport.set    {viewport}                                (layout-only)
     */
    /**
     * §14 dry-run: validate a batch EXACTLY as commit would — same preconditions, same
     * structural checks against the working element set — without writing anything.
     * Returns the revisions the commit WOULD produce; Copilot proposals preview through
     * this before a user-confirmed commit. Throws exactly like commitOperations.
     */
    public function validateOperations(string $ownerUserId, string $blueprintId, array $batch): array
    {
        [$row, , $semanticOps, $layoutOps] = $this->planBatch($ownerUserId, $blueprintId, $batch);
        return [
            'valid' => true,
            'semanticRevision' => $semanticOps > 0 ? ((int) $row['semantic_revision']) + 1 : (int) $row['semantic_revision'],
            'layoutRevision' => $layoutOps > 0 ? ((int) $row['layout_revision']) + 1 : (int) $row['layout_revision'],
        ];
    }

    public function commitOperations(string $ownerUserId, string $blueprintId, array $batch): array
    {
        [$row, $planned, $semanticOps, $layoutOps] = $this->planBatch($ownerUserId, $blueprintId, $batch);
        $changeSetId = 'cs_' . bin2hex(random_bytes(10));
        $currentSemantic = (int) $row['semantic_revision'];
        $newSemantic = $semanticOps > 0 ? $currentSemantic + 1 : $currentSemantic;
        $newLayout = $layoutOps > 0 ? ((int) $row['layout_revision']) + 1 : (int) $row['layout_revision'];

        $ownTxn = !$this->mysql->inTransaction();
        if ($ownTxn) {
            $this->mysql->beginTransaction();
        }
        try {
            foreach ($planned as $plan) {
                // Inverses capture PRE-apply state (an update's undo must restore the old
                // properties), so compute them before the write.
                $inverse = $this->inverseFor($blueprintId, $plan);
                $this->applyOperation($blueprintId, $plan, $newSemantic);
                $this->recordOperation($blueprintId, $changeSetId, $ownerUserId, $plan, $inverse, $newSemantic, $newLayout, (string) ($batch['origin'] ?? 'manual'));
            }
            $this->mysql->prepare('
                UPDATE blueprints SET semantic_revision = :s, layout_revision = :l, updated_by = :actor
                WHERE id = :b
            ')->execute(['s' => $newSemantic, 'l' => $newLayout, 'actor' => $ownerUserId, 'b' => $blueprintId]);
            if ($ownTxn) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($ownTxn && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            // A duplicate operation_id = an already-applied replay; refuse loudly (idempotency).
            if ($e instanceof \PDOException && str_contains($e->getMessage(), 'uniq_bpop_op')) {
                throw new \InvalidArgumentException('Duplicate operationId — this operation was already committed');
            }
            throw $e;
        }

        return [
            'changeSetId' => $changeSetId,
            'semanticRevision' => $newSemantic,
            'layoutRevision' => $newLayout,
        ];
    }

    // ─── internals ─────────────────────────────────────────────────────────────

    /**
     * The shared validate-everything-before-any-write path commit and dry-run both use:
     * ownership, batch shape, operation classification, the semantic-revision
     * precondition, and structural validation against the working element set.
     *
     * @return array{0: array, 1: array[], 2: int, 3: int} [$blueprintRow, $plannedOps, $semanticOps, $layoutOps]
     */
    private function planBatch(string $ownerUserId, string $blueprintId, array $batch): array
    {
        $row = $this->ownedRow($ownerUserId, $blueprintId);
        if ($row === null) {
            throw new \InvalidArgumentException('Unknown blueprint');
        }
        $operations = $batch['operations'] ?? null;
        if (!is_array($operations) || $operations === [] || count($operations) > self::MAX_OPERATIONS_PER_BATCH) {
            throw new \InvalidArgumentException('operations must be 1-' . self::MAX_OPERATIONS_PER_BATCH . ' entries');
        }

        $semanticOps = 0;
        $layoutOps = 0;
        foreach ($operations as $op) {
            $type = is_array($op) ? (string) ($op['type'] ?? '') : '';
            if (in_array($type, ['blueprint.element.create', 'blueprint.element.update', 'blueprint.element.delete'], true)) {
                $semanticOps++;
                if ($type === 'blueprint.element.create' && is_array($op['layout'] ?? null)) {
                    $layoutOps++; // an inline placement is a layout change too
                }
            } elseif (in_array($type, ['blueprint.layout.set', 'blueprint.viewport.set'], true)) {
                $layoutOps++;
            } else {
                throw new \InvalidArgumentException("Unsupported operation type '{$type}'");
            }
        }

        if ($semanticOps > 0) {
            $base = $batch['baseSemanticRevision'] ?? null;
            if (!is_int($base) && !(is_numeric($base) && (string) (int) $base === (string) $base)) {
                throw new \InvalidArgumentException('Semantic operations require baseSemanticRevision');
            }
            if ((int) $base !== (int) $row['semantic_revision']) {
                throw new BlueprintRevisionConflictException((int) $row['semantic_revision']);
            }
        }

        // Working element set for structural validation (ids -> element_type), tombstones excluded.
        $existing = $this->mysql->prepare(
            'SELECT id, element_type FROM blueprint_elements WHERE blueprint_id = :b AND deleted_at IS NULL'
        );
        $existing->execute(['b' => $blueprintId]);
        $live = [];
        foreach ($existing->fetchAll() as $element) {
            $live[(string) $element['id']] = (string) $element['element_type'];
        }

        $planned = [];
        $seq = 0;
        foreach ($operations as $op) {
            $planned[] = $this->validateOperation($blueprintId, $op, $live, $seq++);
        }
        if (count($live) > self::MAX_ELEMENTS_PER_BLUEPRINT) {
            throw new \InvalidArgumentException('Element limit reached (' . self::MAX_ELEMENTS_PER_BLUEPRINT . ')');
        }

        return [$row, $planned, $semanticOps, $layoutOps];
    }

    /**
     * Structural validation of one operation against the WORKING element set ($live is
     * mutated so later ops in the batch see earlier ones). Returns the apply plan.
     */
    private function validateOperation(string $blueprintId, mixed $op, array &$live, int $seq): array
    {
        if (!is_array($op)) {
            throw new \InvalidArgumentException('Each operation must be an object');
        }
        $type = (string) ($op['type'] ?? '');
        $operationId = (string) ($op['operationId'] ?? '');
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/', $operationId)) {
            throw new \InvalidArgumentException('Each operation needs an operationId (1-64 safe chars)');
        }

        if ($type === 'blueprint.viewport.set') {
            $viewport = $op['viewport'] ?? null;
            if (!is_array($viewport)) {
                throw new \InvalidArgumentException('viewport.set requires a viewport object');
            }
            return ['type' => $type, 'operationId' => $operationId, 'seq' => $seq, 'viewport' => $viewport];
        }

        $targetId = (string) ($op['targetId'] ?? '');
        if (!preg_match(self::ELEMENT_ID_PATTERN, $targetId)) {
            throw new \InvalidArgumentException("Operation '{$type}' needs a valid targetId");
        }

        switch ($type) {
            case 'blueprint.element.create':
                if (isset($live[$targetId])) {
                    throw new \InvalidArgumentException("Element '{$targetId}' already exists");
                }
                $elementType = (string) ($op['elementType'] ?? '');
                if (!in_array($elementType, self::ELEMENT_TYPES, true)) {
                    throw new \InvalidArgumentException("Unknown elementType '{$elementType}'");
                }
                $properties = is_array($op['properties'] ?? null) ? $op['properties'] : [];
                if ($elementType === 'edge') {
                    $this->assertEdgeProperties($properties, $live);
                }
                $resourceRef = is_array($op['resourceRef'] ?? null) ? $op['resourceRef'] : null;
                $this->assertJsonSize($properties, 'properties', $this->propertiesCap($elementType));
                $live[$targetId] = $elementType;
                return [
                    'type' => $type,
                    'operationId' => $operationId,
                    'seq' => $seq,
                    'targetId' => $targetId,
                    'elementType' => $elementType,
                    'properties' => $properties,
                    'resourceRef' => $resourceRef,
                    'layout' => is_array($op['layout'] ?? null) ? $op['layout'] : null,
                ];

            case 'blueprint.element.update':
                if (!isset($live[$targetId])) {
                    throw new \InvalidArgumentException("Element '{$targetId}' does not exist");
                }
                $properties = is_array($op['properties'] ?? null) ? $op['properties'] : null;
                $resourceRef = array_key_exists('resourceRef', $op) && (is_array($op['resourceRef']) || $op['resourceRef'] === null)
                    ? $op['resourceRef']
                    : false; // false = untouched
                if ($properties === null && $resourceRef === false) {
                    throw new \InvalidArgumentException('element.update needs properties and/or resourceRef');
                }
                if ($properties !== null) {
                    if ($live[$targetId] === 'edge') {
                        $this->assertEdgeProperties($properties, $live);
                    }
                    $this->assertJsonSize($properties, 'properties', $this->propertiesCap($live[$targetId]));
                }
                return [
                    'type' => $type,
                    'operationId' => $operationId,
                    'seq' => $seq,
                    'targetId' => $targetId,
                    'properties' => $properties,
                    'resourceRef' => $resourceRef,
                ];

            case 'blueprint.element.delete':
                if (!isset($live[$targetId])) {
                    throw new \InvalidArgumentException("Element '{$targetId}' does not exist");
                }
                // Deleting a node an edge still references leaves a dangling edge — refuse
                // so diagrams stay structurally sound (delete the edge first).
                foreach ($live as $id => $elementType) {
                    if ($elementType !== 'edge' || $id === $targetId) {
                        continue;
                    }
                    $edge = $this->fetchElementProperties($blueprintId, (string) $id);
                    if (($edge['sourceId'] ?? null) === $targetId || ($edge['targetId'] ?? null) === $targetId) {
                        throw new \InvalidArgumentException("Element '{$targetId}' is still referenced by edge '{$id}'");
                    }
                }
                unset($live[$targetId]);
                return ['type' => $type, 'operationId' => $operationId, 'seq' => $seq, 'targetId' => $targetId];

            case 'blueprint.layout.set':
                if (!isset($live[$targetId])) {
                    throw new \InvalidArgumentException("Element '{$targetId}' does not exist");
                }
                $layout = $op['layout'] ?? null;
                if (!is_array($layout)) {
                    throw new \InvalidArgumentException('layout.set requires a layout object');
                }
                $this->assertJsonSize($layout, 'layout');
                return ['type' => $type, 'operationId' => $operationId, 'seq' => $seq, 'targetId' => $targetId, 'layout' => $layout];
        }
        throw new \InvalidArgumentException("Unsupported operation type '{$type}'");
    }

    private function applyOperation(string $blueprintId, array $plan, int $semanticRevision): void
    {
        switch ($plan['type']) {
            case 'blueprint.element.create':
                $this->mysql->prepare('
                    INSERT INTO blueprint_elements
                        (id, blueprint_id, element_type, resource_ref_json, properties_json, semantic_revision)
                    VALUES (:id, :b, :t, :ref, :props, :rev)
                ')->execute([
                    'id' => $plan['targetId'],
                    'b' => $blueprintId,
                    't' => $plan['elementType'],
                    'ref' => $plan['resourceRef'] !== null ? json_encode($plan['resourceRef']) : null,
                    'props' => json_encode($plan['properties'] === [] ? new \stdClass() : $plan['properties']),
                    'rev' => $semanticRevision,
                ]);
                if ($plan['layout'] !== null) {
                    $this->upsertLayout($blueprintId, $plan['targetId'], $plan['layout']);
                }
                break;
            case 'blueprint.element.update':
                $sets = ['semantic_revision = :rev'];
                $params = ['rev' => $semanticRevision, 'b' => $blueprintId, 'id' => $plan['targetId']];
                if ($plan['properties'] !== null) {
                    $sets[] = 'properties_json = :props';
                    $params['props'] = json_encode($plan['properties'] === [] ? new \stdClass() : $plan['properties']);
                }
                if ($plan['resourceRef'] !== false) {
                    $sets[] = 'resource_ref_json = :ref';
                    $params['ref'] = $plan['resourceRef'] !== null ? json_encode($plan['resourceRef']) : null;
                }
                $this->mysql->prepare(
                    'UPDATE blueprint_elements SET ' . implode(', ', $sets)
                    . ' WHERE blueprint_id = :b AND id = :id AND deleted_at IS NULL'
                )->execute($params);
                break;
            case 'blueprint.element.delete':
                $this->mysql->prepare('
                    UPDATE blueprint_elements SET deleted_at = NOW(), semantic_revision = :rev
                    WHERE blueprint_id = :b AND id = :id AND deleted_at IS NULL
                ')->execute(['rev' => $semanticRevision, 'b' => $blueprintId, 'id' => $plan['targetId']]);
                break;
            case 'blueprint.layout.set':
                $this->upsertLayout($blueprintId, $plan['targetId'], $plan['layout']);
                break;
            case 'blueprint.viewport.set':
                $this->mysql->prepare('UPDATE blueprints SET viewport_json = :v WHERE id = :b')
                    ->execute(['v' => json_encode($plan['viewport']), 'b' => $blueprintId]);
                break;
        }
    }

    private function recordOperation(
        string $blueprintId,
        string $changeSetId,
        string $actorUserId,
        array $plan,
        ?array $inverse,
        int $semanticRevision,
        int $layoutRevision,
        string $origin
    ): void {
        $payload = $plan;
        unset($payload['seq']);
        $this->mysql->prepare('
            INSERT INTO blueprint_operations
                (operation_id, blueprint_id, change_set_id, seq, op_type, target_id,
                 payload_json, inverse_json, semantic_revision, layout_revision, actor_user_id, origin)
            VALUES (:op, :b, :cs, :seq, :t, :target, :payload, :inverse, :srev, :lrev, :actor, :origin)
        ')->execute([
            'op' => $plan['operationId'],
            'b' => $blueprintId,
            'cs' => $changeSetId,
            'seq' => $plan['seq'],
            't' => $plan['type'],
            'target' => $plan['targetId'] ?? null,
            'payload' => json_encode($payload),
            'inverse' => $inverse !== null ? json_encode($inverse) : null,
            'srev' => $semanticRevision,
            'lrev' => $layoutRevision,
            'actor' => $actorUserId,
            'origin' => in_array($origin, ['manual', 'copilot', 'launcher'], true) ? $origin : 'manual',
        ]);
    }

    /** The inverse operation (undo groundwork) — computed from PRE-apply state where needed. */
    private function inverseFor(string $blueprintId, array $plan): ?array
    {
        switch ($plan['type']) {
            case 'blueprint.element.create':
                return ['type' => 'blueprint.element.delete', 'targetId' => $plan['targetId']];
            case 'blueprint.element.delete':
            case 'blueprint.element.update': {
                // Called BEFORE applyOperation — this is the row as it stood pre-change.
                $stmt = $this->mysql->prepare('
                    SELECT element_type, resource_ref_json, properties_json FROM blueprint_elements
                    WHERE blueprint_id = :b AND id = :id LIMIT 1
                ');
                $stmt->execute(['b' => $blueprintId, 'id' => $plan['targetId']]);
                $row = $stmt->fetch();
                if (!$row) {
                    return null;
                }
                if ($plan['type'] === 'blueprint.element.delete') {
                    return [
                        'type' => 'blueprint.element.create',
                        'targetId' => $plan['targetId'],
                        'elementType' => (string) $row['element_type'],
                        'resourceRef' => $row['resource_ref_json'] !== null ? json_decode((string) $row['resource_ref_json'], true) : null,
                        'properties' => $row['properties_json'] !== null ? json_decode((string) $row['properties_json'], true) : [],
                    ];
                }
                return [
                    'type' => 'blueprint.element.update',
                    'targetId' => $plan['targetId'],
                    'properties' => $row['properties_json'] !== null ? json_decode((string) $row['properties_json'], true) : [],
                    'resourceRef' => $row['resource_ref_json'] !== null ? json_decode((string) $row['resource_ref_json'], true) : null,
                ];
            }
            default:
                return null; // layout/viewport moves are not undo targets in v1
        }
    }

    private function assertEdgeProperties(array $properties, array $live): void
    {
        $edgeType = (string) ($properties['edgeType'] ?? '');
        if (!in_array($edgeType, self::EDGE_TYPES, true)) {
            throw new \InvalidArgumentException("Unknown edgeType '{$edgeType}'");
        }
        foreach (['sourceId', 'targetId'] as $endpoint) {
            $id = (string) ($properties[$endpoint] ?? '');
            if ($id === '' || !isset($live[$id]) || $live[$id] === 'edge') {
                throw new \InvalidArgumentException("Edge {$endpoint} must reference an existing non-edge element");
            }
        }
    }

    /**
     * Per-element-type properties budget (§11A.1b): ink strokes carry SVG path data
     * (64 KiB) and pasted images carry a client-downscaled data URI (512 KiB); every
     * structured element stays at the tight 16 KiB default.
     */
    private function propertiesCap(string $elementType): int
    {
        return match ($elementType) {
            'image' => 524288,
            'ink' => 65536,
            default => 16384,
        };
    }

    private function assertJsonSize(array $value, string $label, int $cap = 16384): void
    {
        if (strlen((string) json_encode($value)) > $cap) {
            throw new \InvalidArgumentException("{$label} exceeds the " . intdiv($cap, 1024) . ' KiB cap');
        }
    }

    /** @return array<string, mixed> */
    private function fetchElementProperties(string $blueprintId, string $elementId): array
    {
        $stmt = $this->mysql->prepare('
            SELECT properties_json FROM blueprint_elements
            WHERE blueprint_id = :b AND id = :id AND deleted_at IS NULL LIMIT 1
        ');
        $stmt->execute(['b' => $blueprintId, 'id' => $elementId]);
        $raw = $stmt->fetchColumn();
        $decoded = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($decoded) ? $decoded : [];
    }

    private function upsertLayout(string $blueprintId, string $elementId, array $layout): void
    {
        $this->mysql->prepare('
            INSERT INTO blueprint_layouts (blueprint_id, element_id, layout_json)
            VALUES (:b, :id, :layout)
            ON DUPLICATE KEY UPDATE layout_json = VALUES(layout_json)
        ')->execute(['b' => $blueprintId, 'id' => $elementId, 'layout' => json_encode($layout)]);
    }

    private function ownedRow(string $ownerUserId, string $blueprintId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM blueprints WHERE id = :id AND owner_user_id = :o LIMIT 1');
        $stmt->execute(['id' => $blueprintId, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    private function formatBlueprintRow(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'appId' => $row['app_id'] !== null ? (string) $row['app_id'] : null,
            'name' => (string) $row['name'],
            'status' => (string) $row['status'],
            'semanticRevision' => (int) $row['semantic_revision'],
            'layoutRevision' => (int) $row['layout_revision'],
            'viewport' => $row['viewport_json'] !== null ? json_decode((string) $row['viewport_json'], true) : null,
            'createdAt' => (string) $row['created_at'],
            'updatedAt' => (string) $row['updated_at'],
        ];
    }

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
