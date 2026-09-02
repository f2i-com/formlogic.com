<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Models\Form;
use PDO;

class FormService
{
    /**
     * Field-id slugs must not collide with the FormLogic expression prelude's globals
     * (a field id like "count"/"sum"/"format" would shadow that builtin in generated
     * expressions). Mirrors the frontend RESERVED_FIELD_IDS (formStore.ts).
     */
    private const RESERVED_FIELD_IDS = [
        '__isArr', 'validators', 'format', 'compliance', 'finance', 'safety',
        'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count', 'value',
        // Field ids become sandbox globals. One that shadows a JavaScript global
        // breaks every expression on the form — `Object` as a field id makes the
        // context installer itself throw — and the validator's stated job is to
        // refuse ids that break scripting, not only the prelude's names.
        'globalThis', 'undefined', 'NaN', 'Infinity', 'eval', 'Object', 'Array',
        'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'JSON',
        'Math', 'Date', 'RegExp', 'Error', 'Promise', 'Map', 'Set', 'WeakMap',
        'WeakSet', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'isNaN',
        'isFinite', 'print', 'console', 'ctx',
    ];

    /**
     * Validate an explicit, client-supplied field id against the same constraints the frontend
     * enforces — so API-created / imported forms can't introduce ids that break scripting,
     * json_extract paths, search, or exports. Returns an error message, or null if valid (or
     * empty, in which case the server generates one). Static so it's unit-testable without a DB.
     */
    public static function fieldIdError(string $id): ?string
    {
        if ($id === '') {
            return null; // server generates a safe id for empty values
        }
        if (strlen($id) > 64) {
            return "Field ID is too long (max 64): {$id}";
        }
        if (!preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/', $id)) {
            return "Field ID must start with a letter or underscore and use only letters, numbers, and underscores: {$id}";
        }
        if (in_array($id, self::RESERVED_FIELD_IDS, true)) {
            return "Field ID is reserved and cannot be used: {$id}";
        }
        // The sandbox wrappers own the `__` prefix (and refuse such context keys).
        if (str_starts_with($id, '__')) {
            return "Field ID cannot start with two underscores (reserved for the runtime): {$id}";
        }
        return null;
    }

    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private ?WebhookService $webhookService;
    private ?FileStorageService $fileStorageService;
    private StoreOpService $storeOps;
    private ?FormEncryptionService $formEncryption = null;

    /**
     * Legacy field-type aliases accepted from older/imported schemas, normalized to the
     * canonical types on BOTH read and write so old data never reaches the renderer
     * (which only knows the canonical set and would show "Field type not supported").
     */
    private const FIELD_TYPE_ALIASES = [
        'text' => 'short_text',
        'textarea' => 'long_text',
    ];

    /** Map a stored/inbound field type onto its canonical name (identity for current types). */
    public static function normalizeFieldType(string $type): string
    {
        return self::FIELD_TYPE_ALIASES[$type] ?? $type;
    }

    /**
     * E2EE post-enable invariant (docs/E2EE_PRIVATE_FORMS_PLAN.md §9.1): a private
     * form can never GAIN a blocked field type (file_upload/camera until P4,
     * linked_record in v1) — the §9.1 preflight bans them at enable time and this
     * gate bans adding them afterwards (enforced on BOTH ends of the invariant).
     *
     * @throws PrivateFormEncryptedException
     */
    private function assertFieldsAllowedOnPrivate(string $formId, mixed $fields): void
    {
        if (!is_array($fields)) {
            return;
        }
        $this->formEncryption ??= new FormEncryptionService($this->mysql);
        if (!$this->formEncryption->isPrivate($formId)) {
            return;
        }
        foreach ($fields as $field) {
            $type = is_array($field) ? (string) ($field['type'] ?? '') : '';
            if (in_array($type, FormEncryptionService::BLOCKED_FIELD_TYPES, true)) {
                throw new PrivateFormEncryptedException(
                    "Field type '{$type}' is not available on private (end-to-end encrypted) forms (private_form_encrypted)."
                );
            }
        }
    }

    /**
     * The canonical sha256 over a fields array, matching how the client's
     * schemaJson is produced (JSON.stringify semantics: no slash/unicode
     * escaping) — the atomic-publish rule compares this against the latest
     * signed manifest's schema_hash to decide whether the fields are changing.
     *
     * @param array<mixed> $fields
     */
    private function canonicalFieldsHash(array $fields): string
    {
        return hash('sha256', (string) json_encode($fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    public function __construct(MySQLConnection $mysql, SQLiteConnection $sqlite, ?WebhookService $webhookService = null, ?FileStorageService $fileStorageService = null)
    {
        $this->fileStorageService = $fileStorageService;
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->webhookService = $webhookService;
        $this->storeOps = new StoreOpService($this->mysql);
    }

    /**
     * Get all forms for a user (or all if no user specified)
     * Supports both offset-based and cursor-based pagination.
     * Cursor-based: pass 'cursor' (updated_at|id) for efficient keyset pagination.
     */
    public function getAllForms(?string $userId = null, array $options = []): array
    {
        // is_private rides the SAME query (correlated EXISTS — no N+1): the forms
        // list marks end-to-end-encrypted forms with a lock icon (plan §16-P3).
        $sql = "SELECT forms.*, EXISTS(SELECT 1 FROM form_encryption fe WHERE fe.form_id = forms.id) AS is_private FROM forms";
        $params = [];
        $conditions = [];

        if ($userId) {
            $conditions[] = "user_id = :user_id";
            $params['user_id'] = $userId;
        }

        // Add status filter
        if (!empty($options['status'])) {
            $conditions[] = "status = :status";
            $params['status'] = $options['status'];
        }

        // Cursor-based pagination (keyset on updated_at DESC, id DESC)
        $cursor = $options['cursor'] ?? null;
        if ($cursor && is_string($cursor)) {
            $parts = explode('|', $cursor, 2);
            if (count($parts) === 2) {
                $conditions[] = "(updated_at < :cursor_date OR (updated_at = :cursor_date2 AND id < :cursor_id))";
                $params['cursor_date'] = $parts[0];
                $params['cursor_date2'] = $parts[0];
                $params['cursor_id'] = $parts[1];
            }
        }

        if (!empty($conditions)) {
            $sql .= " WHERE " . implode(" AND ", $conditions);
        }

        $sql .= " ORDER BY updated_at DESC, id DESC";

        // Pagination (clamp to safe ranges)
        $limit = max(1, min((int)($options['limit'] ?? 50), 1000));
        $sql .= " LIMIT :limit";

        // Offset only when not using cursor
        if (!$cursor) {
            $offset = max(0, (int)($options['offset'] ?? 0));
            $sql .= " OFFSET :offset";
        }

        $stmt = $this->mysql->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', (int)$limit, PDO::PARAM_INT);
        if (!$cursor) {
            $stmt->bindValue('offset', (int)$offset, PDO::PARAM_INT);
        }
        $stmt->execute();

        $includeFields = $options['includeFields'] ?? false;

        $forms = [];
        $backfillIds = [];
        $respBackfillIds = [];
        while ($row = $stmt->fetch()) {
            $isPrivate = !empty($row['is_private']);
            $form = Form::fromArray($row);
            // Only load fields from SQLite when explicitly requested (avoids N+1 for list views)
            if ($includeFields) {
                $form->fields = $this->getFormFields($form->id);
                $form->fieldCount = count($form->fields);
            } elseif ($form->fieldCount === 0) {
                // Backfill field_count for forms migrated before the column existed.
                // Only open a DB that already exists — don't materialize an empty
                // SQLite file for a field-less draft on this read path (mirrors the
                // response_count backfill below).
                try {
                    if ($this->sqlite->formDatabaseExists($form->id)) {
                        $count = (int)$this->sqlite->getFormDatabase($form->id)
                            ->query("SELECT COUNT(*) FROM fields")->fetchColumn();
                        if ($count > 0) {
                            $form->fieldCount = $count;
                            $backfillIds[$form->id] = $count;
                        }
                    }
                } catch (\Throwable $e) {
                    // SQLite DB may not exist yet for empty forms
                }
            }
            // Backfill response_count once for forms that predate the column (NULL =
            // not yet computed; 0 is a valid computed value). Only opens a per-form
            // SQLite DB that already exists (never resurrects one), and persists the
            // result so it runs at most once per form.
            if ($form->responseCount === null) {
                try {
                    $rcnt = $this->sqlite->formDatabaseExists($form->id)
                        ? (int)$this->sqlite->getFormDatabase($form->id)->query("SELECT COUNT(*) FROM responses")->fetchColumn()
                        : 0;
                    $form->responseCount = $rcnt;
                    $respBackfillIds[$form->id] = $rcnt;
                } catch (\Throwable $e) {
                    // Leave NULL; retry on the next list load.
                }
            }
            $out = $form->toArray();
            $out['isPrivate'] = $isPrivate;
            $forms[] = $out;
        }

        // Persist backfilled counts so this only happens once per form. Preserve
        // updated_at (forms.updated_at is ON UPDATE CURRENT_TIMESTAMP) — a one-time
        // count backfill must NOT rewrite every form's "Last Modified" time.
        if (!empty($backfillIds)) {
            $updateStmt = $this->mysql->prepare("UPDATE forms SET field_count = :cnt, updated_at = updated_at WHERE id = :id");
            foreach ($backfillIds as $id => $count) {
                $updateStmt->execute(['cnt' => $count, 'id' => $id]);
            }
        }
        if (!empty($respBackfillIds)) {
            $respUpdateStmt = $this->mysql->prepare("UPDATE forms SET response_count = :cnt, updated_at = updated_at WHERE id = :id");
            foreach ($respBackfillIds as $id => $count) {
                $respUpdateStmt->execute(['cnt' => $count, 'id' => $id]);
            }
        }

        return $forms;
    }

    /**
     * Get a single form by ID
     */
    public function getForm(string $formId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM forms WHERE id = :id");
        $stmt->execute(['id' => $formId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        $form = Form::fromArray($row);
        $form->fields = $this->getFormFields($formId);
        $form->fieldCount = count($form->fields);

        return $form->toArray();
    }

    /**
     * Batch getForm(): ONE MySQL IN-clause query for all the form rows (instead of one query per
     * form), then the usual per-form field load (fields live in each form's own SQLite database, so
     * they cannot be batched further). Each entry is built through the exact same
     * Form::fromArray → getFormFields → toArray path as getForm(), so per-form output is identical.
     *
     * @param string[] $formIds
     * @return array<string, array<string,mixed>> map of formId => form (missing ids are absent),
     *         ordered to match the (de-duplicated) input order.
     */
    public function getFormsByIds(array $formIds): array
    {
        $formIds = array_values(array_unique(array_filter($formIds, static fn ($id) => is_string($id) && $id !== '')));
        if (empty($formIds)) {
            return [];
        }

        $rowsById = [];
        foreach (array_chunk($formIds, 500) as $chunk) {
            $placeholders = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $this->mysql->prepare("SELECT * FROM forms WHERE id IN ($placeholders)");
            $stmt->execute($chunk);
            while ($row = $stmt->fetch()) {
                $rowsById[$row['id']] = $row;
            }
        }

        // Emit in input order (SQL IN gives no order guarantee) so callers that iterate the
        // map — e.g. field-map builders — behave exactly like the per-form getForm loop did.
        $map = [];
        foreach ($formIds as $fid) {
            if (!isset($rowsById[$fid])) {
                continue;
            }
            $form = Form::fromArray($rowsById[$fid]);
            $form->fields = $this->getFormFields($fid);
            $form->fieldCount = count($form->fields);
            $map[$fid] = $form->toArray();
        }
        return $map;
    }

    /**
     * Create a new form (or update if it already exists - for sync support)
     */
    public function createForm(array $data): array
    {
        $id = $data['id'] ?? $this->generateUuid();
        $now = date('Y-m-d H:i:s');

        // Check if form already exists
        $existing = $this->getForm($id);
        if ($existing) {
            // Verify the current user owns this form before allowing update
            $userId = $data['userId'] ?? null;
            if (!$userId || ($existing['userId'] ?? null) !== $userId) {
                throw new \RuntimeException('A form with this ID already exists');
            }
            return $this->updateForm($id, $data);
        }

        // Cross-store saga (audit FL-DATA-001): the MySQL insert and the durable op
        // record commit atomically; the SQLite fields save follows, and a failure there
        // COMPENSATES (removes the metadata row + any SQLite file this call created) so
        // a half-created form — visible in lists but missing its fields — is never
        // exposed. Respect an already-open transaction (duplicateForm / pack imports).
        $sqliteExisted = $this->sqlite->formDatabaseExists($id);
        $ownTx = !$this->mysql->inTransaction();
        if ($ownTx) {
            $this->mysql->beginTransaction();
        }
        $opId = null;
        try {
            $opId = $this->storeOps->begin('form_create', 'form', $id, $data['userId'] ?? null, [
                'fieldCount' => count($data['fields'] ?? []),
            ]);

            $customScreen = $this->screenForStorage($data['customScreen'] ?? null);
            $stmt = $this->mysql->prepare("
                INSERT INTO forms (id, user_id, title, description, status, settings, theme, logic_script, logic_prompt, custom_screen, custom_screen_trust, custom_screen_provenance, custom_logic, icon, created_at, updated_at, ever_published_at)
                VALUES (:id, :user_id, :title, :description, :status, :settings, :theme, :logic_script, :logic_prompt, :custom_screen, :custom_screen_trust, :custom_screen_provenance, :custom_logic, :icon, :created_at, :updated_at, :ever_published_at)
            ");

            $stmt->execute([
                'id' => $id,
                'user_id' => $data['userId'] ?? null,
                'title' => $data['title'] ?? 'Untitled Form',
                'description' => $data['description'] ?? null,
                'status' => $data['status'] ?? 'draft',
                // E2EE (plan §7): a form CREATED already-published has publication
                // history from birth — it can never become private.
                'ever_published_at' => (($data['status'] ?? 'draft') === 'published') ? $now : null,
                'settings' => json_encode($data['settings'] ?? []),
                'theme' => json_encode($data['theme'] ?? []),
                'logic_script' => $data['logicScript'] ?? null,
                'logic_prompt' => $data['logicPrompt'] ?? null,
                'custom_screen' => !empty($customScreen) ? json_encode($customScreen) : null,
                'custom_screen_trust' => 'owner',
                'custom_screen_provenance' => !empty($customScreen) ? json_encode(['source' => 'owner']) : null,
                'custom_logic' => !empty($data['customLogic']) ? json_encode($data['customLogic']) : null,
                'icon' => $data['icon'] ?? null,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            if ($ownTx) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($ownTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        // Create SQLite database and save fields
        if (!empty($data['fields'])) {
            try {
                $this->saveFormFields($id, $data['fields']);
            } catch (\Throwable $e) {
                try {
                    $delStmt = $this->mysql->prepare("DELETE FROM forms WHERE id = :id");
                    $delStmt->execute(['id' => $id]);
                    if (!$sqliteExisted) {
                        $this->sqlite->deleteFormDatabase($id);
                    }
                    $this->storeOps->finish($opId);
                } catch (\Throwable $compensationError) {
                    // Compensation itself failed — leave the op pending so the
                    // half-created form is operator-visible (reconcile report).
                    $this->storeOps->fail($opId, 'create compensation failed: ' . $compensationError->getMessage());
                    error_log("FormService::createForm — compensation failed for form {$id}: " . $compensationError->getMessage());
                }
                throw $e;
            }
        }

        $this->storeOps->finish($opId);
        return $this->getForm($id);
    }

    /**
     * Update an existing form.
     *
     * E2EE (enable-race + atomic-publish fixes): while the form's encryption row
     * is 'enabling', any field save or status change fails closed with 409
     * encryption_enabling. The optional `encryptionSchema` body key
     * ({schema:{schemaJson,schemaHash}, manifest:{signature,signerKeyId,
     * expiresAt:null}}) is verified against the requester's vault key and
     * applied in the SAME transaction as the field/status save; when the form
     * is private, its fields are changing vs the latest signed schema snapshot,
     * and it is published (or being published), the request MUST carry a valid
     * encryptionSchema — otherwise 409 manifest_required and nothing is saved.
     *
     * @throws EncryptionEnablingException|EncryptionRequestException|PrivateFormEncryptedException
     */
    public function updateForm(string $formId, array $data, ?string $actorUserId = null): ?array
    {
        // Check form exists
        $existing = $this->getForm($formId);
        if (!$existing) {
            return null;
        }

        $encryptionSchema = $data['encryptionSchema'] ?? null;
        unset($data['encryptionSchema']);
        $fieldsProvided = isset($data['fields']);
        $statusProvided = isset($data['status']);

        // ── E2EE gates (pre-write; re-checked under the forms-row lock below) ──
        $this->formEncryption ??= new FormEncryptionService($this->mysql);
        $encState = $this->formEncryption->encryptionState($formId);
        if ($fieldsProvided || $statusProvided || $encryptionSchema !== null) {
            if ($encState === 'enabling') {
                throw new EncryptionEnablingException();
            }
        }
        if ($encryptionSchema !== null && $encState === null) {
            throw new EncryptionRequestException('private_form_not_encrypted', 'This form is not a private form.', 404);
        }
        if ($fieldsProvided && $encState === 'active') {
            $published = ($existing['status'] ?? 'draft') === 'published'
                || ($data['status'] ?? null) === 'published';
            $fieldsChanged = $this->canonicalFieldsHash($data['fields']) !== $this->formEncryption->latestManifestSchemaHash($formId);
            if ($published && $fieldsChanged && $encryptionSchema === null) {
                throw new EncryptionRequestException(
                    'manifest_required',
                    'This private form is published and its fields changed — the save must carry a signed encryptionSchema (manifest_required).',
                    409
                );
            }
        }

        $updates = [];
        $params = ['id' => $formId];

        if (isset($data['title'])) {
            $updates[] = "title = :title";
            $params['title'] = $data['title'];
        }

        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (isset($data['status'])) {
            // Validate status transition
            $validTransitions = [
                'draft' => ['published', 'archived'],
                'published' => ['draft', 'archived'],
                'archived' => ['draft'],
            ];
            $currentStatus = $existing['status'] ?? 'draft';
            $newStatus = $data['status'];
            if ($newStatus !== $currentStatus) {
                $allowed = $validTransitions[$currentStatus] ?? [];
                if (!in_array($newStatus, $allowed, true)) {
                    throw new \InvalidArgumentException(
                        "Cannot transition from '{$currentStatus}' to '{$newStatus}'"
                    );
                }
            }

            $updates[] = "status = :status";
            $params['status'] = $newStatus;

            if ($newStatus === 'published' && $currentStatus !== 'published') {
                $updates[] = "published_at = :published_at";
                $params['published_at'] = date('Y-m-d H:i:s');
                // E2EE Private Forms (plan §7): durable publication history — set on
                // the FIRST publish only (COALESCE keeps the original stamp), never
                // cleared by unpublish/archive. The private-enable preflight requires
                // ever_published_at IS NULL, making the choice irreversible.
                $updates[] = "ever_published_at = COALESCE(ever_published_at, :ever_published_at)";
                $params['ever_published_at'] = date('Y-m-d H:i:s');
            }
        }

        if (isset($data['settings'])) {
            $updates[] = "settings = :settings";
            $params['settings'] = json_encode($data['settings']);
        }

        if (isset($data['theme'])) {
            $updates[] = "theme = :theme";
            $params['theme'] = json_encode($data['theme']);
        }

        if (array_key_exists('logicScript', $data)) {
            $updates[] = "logic_script = :logic_script";
            $params['logic_script'] = $data['logicScript'];
        }

        if (array_key_exists('logicPrompt', $data)) {
            $updates[] = "logic_prompt = :logic_prompt";
            $params['logic_prompt'] = $data['logicPrompt'];
        }

        if (array_key_exists('customScreen', $data)) {
            $customScreen = $this->screenForStorage($data['customScreen']);
            $current = $this->screenForStorage($existing['customScreen'] ?? null);
            // Re-stamp trust ONLY when the screen body actually changes (the same
            // rule AppService already applies). The key rides along in whole-form
            // PUTs — the offline sync, chat/MCP update_form round trips — and an
            // UNCHANGED pack-installed screen was being promoted from 'untrusted'
            // to 'owner', handing unreviewed third-party code the full record and
            // connector SDK without a single byte of it changing.
            $changed = (empty($customScreen)) !== (empty($current))
                || (!empty($customScreen) && !empty($current) && $customScreen != $current);
            if ($changed) {
                $updates[] = "custom_screen = :custom_screen";
                $params['custom_screen'] = !empty($customScreen) ? json_encode($customScreen) : null;
                $updates[] = "custom_screen_trust = 'owner'";
                $updates[] = "custom_screen_provenance = :custom_screen_provenance";
                $params['custom_screen_provenance'] = !empty($customScreen) ? json_encode(['source' => 'owner']) : null;
            }
        }

        if (array_key_exists('customLogic', $data)) {
            $updates[] = "custom_logic = :custom_logic";
            $params['custom_logic'] = !empty($data['customLogic']) ? json_encode($data['customLogic']) : null;
        }

        if (array_key_exists('icon', $data)) {
            $updates[] = "icon = :icon";
            $params['icon'] = $data['icon'];
        }

        // Cross-store saga (audit FL-DATA-001): SQLite fields first, MySQL metadata
        // second, under a durable op record. Fields-first means a fields failure leaves
        // the MySQL row untouched (previously title/settings committed and the fields
        // silently didn't); a MySQL failure AFTER the fields saved compensates by
        // restoring the previous fields, so the update applies all-or-nothing.
        // E2EE: refuse blocked field types on a private form BEFORE any store write
        // (the preflight bans them at enable; this bans adding them afterwards).
        if ($fieldsProvided) {
            $this->assertFieldsAllowedOnPrivate($formId, $data['fields']);
        }
        $opId = null;
        if ($fieldsProvided || !empty($updates)) {
            $opId = $this->storeOps->begin('form_update', 'form', $formId, $existing['userId'] ?? null, [
                'fields' => $fieldsProvided,
                'metadata' => !empty($updates),
            ]);
        }

        $ownTx = !$this->mysql->inTransaction();
        if ($ownTx) {
            $this->mysql->beginTransaction();
        }
        try {
            // Serialize against a concurrent enable: FormEncryptionService::enable
            // holds the same forms-row lock from preflight to commit, so a publish/
            // field save can never interleave between its check and its writes.
            $this->mysql->prepare('SELECT id FROM forms WHERE id = :id FOR UPDATE')->execute(['id' => $formId]);
            if (($fieldsProvided || $statusProvided || $encryptionSchema !== null) && $this->formEncryption->encryptionState($formId) === 'enabling') {
                throw new EncryptionEnablingException();
            }

            // Update fields in SQLite if provided
            if ($fieldsProvided) {
                $this->saveFormFields($formId, $data['fields']);
            }

            if (!empty($updates)) {
                $updates[] = "updated_at = :updated_at";
                $params['updated_at'] = date('Y-m-d H:i:s');

                $sql = "UPDATE forms SET " . implode(', ', $updates) . " WHERE id = :id";
                $stmt = $this->mysql->prepare($sql);
                $stmt->execute($params);
            }

            // Atomic publish (enable-race fix): the signed schema version + manifest
            // land in the SAME transaction as the field/status save — a fields change
            // on a published private form can never commit without its new manifest.
            if ($encryptionSchema !== null) {
                $this->formEncryption->applySchemaPublishInTx(
                    $formId,
                    $actorUserId ?? (string) ($existing['userId'] ?? ''),
                    $encryptionSchema
                );
            }

            if ($ownTx) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($ownTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            if ($fieldsProvided) {
                // Restore the pre-update fields (idempotent: if the new fields never
                // committed this simply rewrites the old ones) so neither store holds a
                // partial update. field_count re-syncs inside saveFormFields.
                try {
                    $this->saveFormFields($formId, $existing['fields'] ?? []);
                    $this->storeOps->finish($opId);
                } catch (\Throwable $compensationError) {
                    $this->storeOps->fail($opId, 'update compensation failed: ' . $compensationError->getMessage());
                    error_log("FormService::updateForm — field restore failed for form {$formId}: " . $compensationError->getMessage());
                }
            } else {
                // Single-store (MySQL) failure — nothing committed, nothing pending.
                $this->storeOps->finish($opId);
            }
            throw $e;
        }

        $this->storeOps->finish($opId);

        $updatedForm = $this->getForm($formId);

        // Dispatch webhook when form is published (strip sensitive internal fields)
        if ($this->webhookService !== null && isset($data['status']) && $data['status'] === 'published' && $existing['status'] !== 'published' && $updatedForm) {
            $webhookPayload = $updatedForm;
            unset($webhookPayload['logicScript'], $webhookPayload['logicPrompt']);
            $this->webhookService->dispatch($formId, 'form.published', $webhookPayload);
        }

        return $updatedForm;
    }

    /**
     * Delete a form — a durable cross-store saga (audit FL-DATA-001).
     *
     * The delete intent (store_ops row) commits in the SAME transaction as the metadata
     * removal, then the on-disk stores (per-form SQLite DB, uploads dir) are removed and
     * VERIFIED. Success is only reported when every store agrees; a disk failure leaves
     * the pending op as the durable, retryable record (re-issued delete, account-erasure
     * resume, or bin/reconcile.php --fix all complete it) and throws
     * FormDeletionIncompleteException instead of faking success — previously this path
     * logged the failure and returned true, silently leaving deleted-form responses
     * (PII) on disk while account erasure trusted the result and dropped the owner.
     *
     * @return bool false when the form doesn't exist (and no deletion is pending)
     * @throws FormDeletionIncompleteException metadata removed but disk cleanup incomplete
     */
    public function deleteForm(string $formId): bool
    {
        // Resume path: a previous attempt already removed the metadata row but its disk
        // cleanup failed — the pending op IS the deletion; finish the disk phase.
        $pendingOp = $this->storeOps->pendingForEntity('form', $formId, 'form_delete');
        $opId = $pendingOp['id'] ?? null;

        if ($opId === null) {
            $ownTx = !$this->mysql->inTransaction();
            if ($ownTx) {
                $this->mysql->beginTransaction();
            }
            try {
                // Lock the row so a concurrent delete of the same form serializes here.
                $ownerStmt = $this->mysql->prepare("SELECT user_id FROM forms WHERE id = :id FOR UPDATE");
                $ownerStmt->execute(['id' => $formId]);
                $ownerRow = $ownerStmt->fetch();

                if ($ownerRow === false) {
                    if ($ownTx) {
                        $this->mysql->commit();
                    }
                    // No metadata row and no pending deletion: report "not found", but
                    // keep the legacy best-effort sweep of stray on-disk artifacts
                    // (e.g. SQLite files left by a rolled-back pack import).
                    $this->runFormDiskCleanup($formId);
                    return false;
                }

                // Durable delete intent, atomic with the metadata removal: if we crash
                // after this commit, the op row survives as the resumable record.
                $opId = $this->storeOps->begin('form_delete', 'form', $formId, $ownerRow['user_id'] ?? null);

                // Clean up response_links referencing this form (no FK cascade on this table)
                $linkStmt = $this->mysql->prepare("DELETE FROM response_links WHERE source_form_id = :id1 OR target_form_id = :id2");
                $linkStmt->execute(['id1' => $formId, 'id2' => $formId]);

                // Delete from MySQL (cascades to related tables)
                $stmt = $this->mysql->prepare("DELETE FROM forms WHERE id = :id");
                $stmt->execute(['id' => $formId]);

                if ($ownTx) {
                    $this->mysql->commit();
                }
            } catch (\Throwable $e) {
                if ($ownTx && $this->mysql->inTransaction()) {
                    $this->mysql->rollBack();
                }
                throw $e;
            }
        }

        // Disk phase — idempotent and verified.
        $errors = $this->runFormDiskCleanup($formId);
        if (empty($errors)) {
            // The entity is verifiably gone from every store; any older pending op
            // about it (e.g. a crashed create) is moot too.
            $this->storeOps->finishAllForEntity('form', $formId);
            return true;
        }

        $this->storeOps->fail($opId, implode('; ', $errors));
        throw new FormDeletionIncompleteException(
            "Form metadata was deleted, but stored data could not be fully removed (" . implode('; ', $errors) . "). "
            . "The deletion is recorded and will be retried — retry the delete or run bin/reconcile.php --fix."
        );
    }

    /**
     * Remove and VERIFY the form's on-disk stores (per-form SQLite DB + uploads dir).
     *
     * @return string[] human-readable failures; empty = both stores verified clean
     */
    private function runFormDiskCleanup(string $formId): array
    {
        $errors = [];

        try {
            if (!$this->sqlite->deleteFormDatabase($formId)) {
                $errors[] = 'per-form SQLite database still present';
            }
        } catch (\Throwable $e) {
            $errors[] = 'SQLite delete failed: ' . $e->getMessage();
        }

        if ($this->fileStorageService !== null) {
            try {
                $this->fileStorageService->deleteFormFiles($formId);
            } catch (\Throwable $e) {
                // Verification below decides — deleteFormFiles failures are otherwise silent.
            }
            if (!$this->fileStorageService->formFilesRemoved($formId)) {
                $errors[] = 'uploaded-files directory still present';
            }
        }

        return $errors;
    }

    /**
     * Resume a deletion whose metadata row is already gone but whose disk cleanup is
     * still pending — reachable from DELETE /api/forms/{id} after the row vanished, so
     * the owner can self-serve the retry instead of dead-ending on a 404.
     *
     * @return bool|null null = no pending deletion owned by $userId (caller 404s);
     *                   true = cleanup completed; false = still failing (caller 503s)
     */
    public function resumePendingDeletion(string $formId, string $userId): ?bool
    {
        try {
            $op = $this->storeOps->pendingForEntity('form', $formId, 'form_delete');
        } catch (\Throwable $e) {
            return null;
        }
        if ($op === null || (string) ($op['user_id'] ?? '') !== $userId) {
            return null;
        }

        $errors = $this->runFormDiskCleanup($formId);
        if (empty($errors)) {
            $this->storeOps->finishAllForEntity('form', $formId);
            return true;
        }
        $this->storeOps->fail($op['id'], implode('; ', $errors));
        return false;
    }

    /**
     * Retry every pending form-deletion cleanup (optionally one user's) — the account-
     * erasure resume path and the reconcile --fix repair.
     *
     * @return array{retried:int, completed:int, stillPending:int}
     */
    public function retryPendingCleanup(?string $userId = null): array
    {
        $retried = 0;
        $completed = 0;
        foreach ($this->storeOps->listPending('form_delete', $userId) as $op) {
            $retried++;
            $errors = $this->runFormDiskCleanup((string) $op['entity_id']);
            if (empty($errors)) {
                $this->storeOps->finishAllForEntity('form', (string) $op['entity_id']);
                $completed++;
            } else {
                $this->storeOps->fail($op['id'], implode('; ', $errors));
            }
        }
        return [
            'retried' => $retried,
            'completed' => $completed,
            'stillPending' => $retried - $completed,
        ];
    }

    /**
     * Pending cross-store ops attributed to a user — account erasure must retain the
     * owner while this is non-zero (disk PII may still exist for their deleted forms).
     */
    public function pendingCleanupCount(?string $userId = null): int
    {
        return $userId === null
            ? $this->storeOps->countPending()
            : $this->storeOps->countPendingForUser($userId);
    }

    /**
     * Duplicate a form
     */
    public function duplicateForm(string $formId, ?string $userId = null): ?array
    {
        // Use transaction with row lock to prevent race conditions
        // (source form deleted/modified between read and copy)
        $this->mysql->beginTransaction();
        try {
            // Lock the source row to prevent concurrent deletion
            $stmt = $this->mysql->prepare("SELECT * FROM forms WHERE id = :id FOR UPDATE");
            $stmt->execute(['id' => $formId]);
            $row = $stmt->fetch();
            if (!$row) {
                $this->mysql->rollBack();
                return null;
            }

            $original = $this->getForm($formId);
            if (!$original) {
                $this->mysql->rollBack();
                return null;
            }

            $newId = $this->generateUuid();

            // Create new form with copied data
            $idMapping = [];
            $newFields = $this->generateDuplicateFieldIds($original['fields'], $idMapping);

            // Update expressions and scripts that reference old field IDs
            if (!empty($idMapping)) {
                foreach ($newFields as &$field) {
                    // Update conditional logic expressions
                    if (!empty($field['conditionalLogic']['expression'])) {
                        $field['conditionalLogic']['expression'] = $this->replaceFieldIds(
                            $field['conditionalLogic']['expression'], $idMapping
                        );
                    }
                    // Update calculation expressions
                    if (!empty($field['properties']['calculationExpression'])) {
                        $field['properties']['calculationExpression'] = $this->replaceFieldIds(
                            $field['properties']['calculationExpression'], $idMapping
                        );
                    }
                }
                unset($field);
            }

            // Update logic script with new field IDs
            $logicScript = $original['logicScript'] ?? null;
            if ($logicScript && !empty($idMapping)) {
                $logicScript = $this->replaceFieldIds($logicScript, $idMapping);
            }

            $newData = [
                'id' => $newId,
                'userId' => $userId ?? $original['userId'],
                'title' => $original['title'] . ' (Copy)',
                'description' => $original['description'],
                'status' => 'draft',
                'settings' => $original['settings'],
                'theme' => $original['theme'],
                'logicScript' => $logicScript,
                'logicPrompt' => $original['logicPrompt'] ?? null,
                'icon' => $original['icon'] ?? null,
                'fields' => $newFields,
            ];

            $result = $this->createForm($newData);
            $this->mysql->commit();
            return $result;
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    /**
     * Get form fields from SQLite
     */
    private function getFormFields(string $formId): array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $stmt = $db->query("SELECT * FROM fields ORDER BY field_order ASC");

        $fields = [];
        while ($row = $stmt->fetch()) {
            $fields[] = [
                'id' => $row['id'],
                'type' => self::normalizeFieldType((string) $row['type']),
                'label' => $row['label'],
                'description' => $row['description'],
                'placeholder' => $row['placeholder'],
                'required' => (bool)$row['required'],
                'order' => (int)$row['field_order'],
                'properties' => json_decode($row['properties'] ?? '{}', true),
                'validation' => json_decode($row['validation'] ?? '[]', true),
                'conditionalLogic' => json_decode($row['conditional_logic'] ?? 'null', true),
            ];
        }

        return $fields;
    }

    /**
     * Save form fields to SQLite
     */
    private function saveFormFields(string $formId, array $fields): void
    {
        // Explicit field IDs supplied by the client must be unique among themselves.
        $explicitIds = array_values(array_filter(
            array_column($fields, 'id'),
            static fn($id) => $id !== null && $id !== ''
        ));
        if (count($explicitIds) !== count(array_unique($explicitIds))) {
            throw new \InvalidArgumentException('Field IDs must be unique within a form');
        }

        // Explicit ids must be safe identifiers (matches the frontend) — protects scripting,
        // json_extract paths, search, and exports from API-/import-supplied unsafe ids.
        foreach ($explicitIds as $explicitId) {
            $err = self::fieldIdError((string) $explicitId);
            if ($err !== null) {
                throw new \InvalidArgumentException($err);
            }
        }

        // Resolve a final, unique id for EVERY field before insert. Fields without
        // an id get one generated from their label; because that generator is
        // label-derived and truncated, two id-less fields with the same label
        // would otherwise produce the same id and the second INSERT would violate
        // the PRIMARY KEY and roll back the whole save. De-duplicate generated ids
        // (numeric suffix) against all ids already in use.
        $usedIds = array_fill_keys($explicitIds, true);
        foreach ($fields as $i => $field) {
            $id = $field['id'] ?? '';
            if ($id === null || $id === '') {
                $base = $this->generateHumanFieldId($field['label'] ?? '');
                if ($base === '') {
                    $base = 'field';
                }
                $finalId = $base;
                $counter = 1;
                while (isset($usedIds[$finalId])) {
                    $finalId = $base . '_' . $counter;
                    $counter++;
                }
                $usedIds[$finalId] = true;
                $fields[$i]['id'] = $finalId;
            }
        }

        $db = $this->sqlite->getFormDatabase($formId);

        // Wrap delete + insert in a transaction to prevent partial field loss on failure
        $db->beginTransaction();
        try {
            // Clear existing fields
            $db->exec("DELETE FROM fields");

            // Insert new fields
            $stmt = $db->prepare("
                INSERT INTO fields (id, type, label, description, placeholder, required, field_order, properties, validation, conditional_logic)
                VALUES (:id, :type, :label, :description, :placeholder, :required, :field_order, :properties, :validation, :conditional_logic)
            ");

            foreach ($fields as $index => $field) {
                $stmt->execute([
                    'id' => $field['id'],
                    'type' => self::normalizeFieldType((string) $field['type']),
                    'label' => $field['label'] ?? null,
                    'description' => $field['description'] ?? null,
                    'placeholder' => $field['placeholder'] ?? null,
                    'required' => (int)($field['required'] ?? false),
                    'field_order' => $field['order'] ?? $index,
                    'properties' => json_encode($field['properties'] ?? []),
                    'validation' => json_encode($field['validation'] ?? []),
                    'conditional_logic' => json_encode($field['conditionalLogic'] ?? null),
                ]);
            }
            $db->commit();
        } catch (\Exception $e) {
            $db->rollBack();
            throw $e;
        }

        // Keep field_count in MySQL in sync for list views
        $countStmt = $this->mysql->prepare("UPDATE forms SET field_count = :cnt WHERE id = :id");
        $countStmt->execute(['cnt' => count($fields), 'id' => $formId]);
    }

    /**
     * Generate human-friendly field IDs for duplicated fields.
     * Appends '_copy' suffix and deduplicates with numeric counters.
     */
    private function generateDuplicateFieldIds(array $fields, array &$idMapping = []): array
    {
        $usedIds = [];
        $result = [];

        foreach ($fields as $field) {
            $oldId = $field['id'] ?? '';
            $baseId = $this->generateHumanFieldId($field['label'] ?? '');
            $finalId = $baseId;
            $counter = 1;
            while (in_array($finalId, $usedIds, true)) {
                $finalId = $baseId . '_' . $counter;
                $counter++;
            }
            $usedIds[] = $finalId;
            if ($oldId !== '' && $oldId !== $finalId) {
                $idMapping[$oldId] = $finalId;
            }
            $field['id'] = $finalId;
            $result[] = $field;
        }

        return $result;
    }

    /**
     * Replace field ID references in an expression or script string.
     * Uses word-boundary matching to avoid partial replacements.
     * Replaces longest IDs first to prevent substring conflicts.
     */
    private function replaceFieldIds(string $text, array $idMapping): string
    {
        // Sort by key length descending to replace longest matches first
        uksort($idMapping, fn($a, $b) => strlen($b) - strlen($a));
        foreach ($idMapping as $oldId => $newId) {
            $text = preg_replace('/\b' . preg_quote($oldId, '/') . '\b/', $newId, $text);
        }
        return $text;
    }

    /**
     * Generate a human-friendly field ID from a label
     */
    private function generateHumanFieldId(string $label): string
    {
        $id = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '_', $label));
        $id = trim($id, '_');
        $id = substr($id, 0, 32);
        return $id ?: 'field';
    }

    /** Strip output-only trust metadata; callers cannot self-assert trust. */
    private function screenForStorage(mixed $screen): ?array
    {
        if (!is_array($screen) || $screen === []) {
            return null;
        }
        unset($screen['_trust'], $screen['_provenance']);
        return $screen;
    }

    /** Internal import boundary: persist server-derived screen provenance. */
    public function setCustomScreenTrust(string $formId, string $trust, array $provenance): void
    {
        if (!in_array($trust, ['owner', 'verified', 'untrusted'], true)) {
            throw new \InvalidArgumentException('Invalid custom-screen trust level');
        }
        $stmt = $this->mysql->prepare(
            'UPDATE forms
                SET custom_screen_trust = :trust,
                    custom_screen_provenance = :provenance,
                    updated_at = updated_at
              WHERE id = :id AND custom_screen IS NOT NULL'
        );
        $stmt->execute([
            'trust' => $trust,
            'provenance' => json_encode($provenance, JSON_UNESCAPED_SLASHES),
            'id' => $formId,
        ]);
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
