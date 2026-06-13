<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Models\Form;
use PDO;

class FormService
{
    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private ?WebhookService $webhookService;
    private ?FileStorageService $fileStorageService;

    public function __construct(MySQLConnection $mysql, SQLiteConnection $sqlite, ?WebhookService $webhookService = null, ?FileStorageService $fileStorageService = null)
    {
        $this->fileStorageService = $fileStorageService;
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->webhookService = $webhookService;
    }

    /**
     * Get all forms for a user (or all if no user specified)
     * Supports both offset-based and cursor-based pagination.
     * Cursor-based: pass 'cursor' (updated_at|id) for efficient keyset pagination.
     */
    public function getAllForms(?string $userId = null, array $options = []): array
    {
        $sql = "SELECT * FROM forms";
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
        while ($row = $stmt->fetch()) {
            $form = Form::fromArray($row);
            // Only load fields from SQLite when explicitly requested (avoids N+1 for list views)
            if ($includeFields) {
                $form->fields = $this->getFormFields($form->id);
                $form->fieldCount = count($form->fields);
            } elseif ($form->fieldCount === 0) {
                // Backfill field_count for forms migrated before the column existed
                try {
                    $db = $this->sqlite->getFormDatabase($form->id);
                    $countResult = $db->query("SELECT COUNT(*) FROM fields");
                    $count = (int)$countResult->fetchColumn();
                    if ($count > 0) {
                        $form->fieldCount = $count;
                        $backfillIds[$form->id] = $count;
                    }
                } catch (\Throwable $e) {
                    // SQLite DB may not exist yet for empty forms
                }
            }
            $forms[] = $form->toArray();
        }

        // Persist backfilled counts so this only happens once per form
        if (!empty($backfillIds)) {
            $updateStmt = $this->mysql->prepare("UPDATE forms SET field_count = :cnt WHERE id = :id");
            foreach ($backfillIds as $id => $count) {
                $updateStmt->execute(['cnt' => $count, 'id' => $id]);
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

        // Insert into MySQL
        $stmt = $this->mysql->prepare("
            INSERT INTO forms (id, user_id, title, description, status, settings, theme, logic_script, logic_prompt, icon, created_at, updated_at)
            VALUES (:id, :user_id, :title, :description, :status, :settings, :theme, :logic_script, :logic_prompt, :icon, :created_at, :updated_at)
        ");

        $stmt->execute([
            'id' => $id,
            'user_id' => $data['userId'] ?? null,
            'title' => $data['title'] ?? 'Untitled Form',
            'description' => $data['description'] ?? null,
            'status' => $data['status'] ?? 'draft',
            'settings' => json_encode($data['settings'] ?? []),
            'theme' => json_encode($data['theme'] ?? []),
            'logic_script' => $data['logicScript'] ?? null,
            'logic_prompt' => $data['logicPrompt'] ?? null,
            'icon' => $data['icon'] ?? null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        // Create SQLite database and save fields
        if (!empty($data['fields'])) {
            $this->saveFormFields($id, $data['fields']);
        }

        return $this->getForm($id);
    }

    /**
     * Update an existing form
     */
    public function updateForm(string $formId, array $data): ?array
    {
        // Check form exists
        $existing = $this->getForm($formId);
        if (!$existing) {
            return null;
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

        if (array_key_exists('icon', $data)) {
            $updates[] = "icon = :icon";
            $params['icon'] = $data['icon'];
        }

        if (!empty($updates)) {
            $updates[] = "updated_at = :updated_at";
            $params['updated_at'] = date('Y-m-d H:i:s');

            $sql = "UPDATE forms SET " . implode(', ', $updates) . " WHERE id = :id";
            $stmt = $this->mysql->prepare($sql);
            $stmt->execute($params);
        }

        // Update fields in SQLite if provided
        if (isset($data['fields'])) {
            $this->saveFormFields($formId, $data['fields']);
        }

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
     * Delete a form
     */
    public function deleteForm(string $formId): bool
    {
        // Delete MySQL first within a transaction, then SQLite file
        // This ensures MySQL failure doesn't leave orphaned records with deleted data
        $this->mysql->beginTransaction();
        try {
            // Clean up response_links referencing this form (no FK cascade on this table)
            $linkStmt = $this->mysql->prepare("DELETE FROM response_links WHERE source_form_id = :id1 OR target_form_id = :id2");
            $linkStmt->execute(['id1' => $formId, 'id2' => $formId]);

            // Delete from MySQL (cascades to related tables)
            $stmt = $this->mysql->prepare("DELETE FROM forms WHERE id = :id");
            $stmt->execute(['id' => $formId]);
            $deleted = $stmt->rowCount() > 0;

            $this->mysql->commit();
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }

        // Only delete SQLite after MySQL succeeds
        $this->sqlite->deleteFormDatabase($formId);

        // Clean up uploaded files for this form
        if ($this->fileStorageService !== null) {
            try {
                $this->fileStorageService->deleteFormFiles($formId);
            } catch (\Exception $e) {
                // Don't fail form deletion if file cleanup fails
            }
        }

        return $deleted;
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
                'type' => $row['type'],
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
                    'type' => $field['type'],
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
