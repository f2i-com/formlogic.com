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

    public function __construct(MySQLConnection $mysql, SQLiteConnection $sqlite)
    {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
    }

    /**
     * Get all forms for a user (or all if no user specified)
     */
    public function getAllForms(?string $userId = null, array $options = []): array
    {
        $sql = "SELECT * FROM forms";
        $params = [];

        if ($userId) {
            $sql .= " WHERE user_id = :user_id";
            $params['user_id'] = $userId;
        }

        // Add status filter
        if (!empty($options['status'])) {
            $sql .= ($userId ? " AND" : " WHERE") . " status = :status";
            $params['status'] = $options['status'];
        }

        $sql .= " ORDER BY updated_at DESC";

        // Pagination
        $limit = $options['limit'] ?? 50;
        $offset = $options['offset'] ?? 0;
        $sql .= " LIMIT :limit OFFSET :offset";

        $stmt = $this->mysql->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();

        $forms = [];
        while ($row = $stmt->fetch()) {
            $form = Form::fromArray($row);
            // Load fields from SQLite
            $form->fields = $this->getFormFields($form->id);
            $forms[] = $form->toArray();
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
            // Update existing form instead of inserting
            return $this->updateForm($id, $data);
        }

        // Insert into MySQL
        $stmt = $this->mysql->prepare("
            INSERT INTO forms (id, user_id, title, description, status, settings, theme, logic_script, logic_prompt, created_at, updated_at)
            VALUES (:id, :user_id, :title, :description, :status, :settings, :theme, :logic_script, :logic_prompt, :created_at, :updated_at)
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
            $updates[] = "status = :status";
            $params['status'] = $data['status'];

            if ($data['status'] === 'published' && $existing['status'] !== 'published') {
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

        return $this->getForm($formId);
    }

    /**
     * Delete a form
     */
    public function deleteForm(string $formId): bool
    {
        // Delete from MySQL (cascades to related tables)
        $stmt = $this->mysql->prepare("DELETE FROM forms WHERE id = :id");
        $stmt->execute(['id' => $formId]);

        // Delete SQLite database
        $this->sqlite->deleteFormDatabase($formId);

        return $stmt->rowCount() > 0;
    }

    /**
     * Duplicate a form
     */
    public function duplicateForm(string $formId, ?string $userId = null): ?array
    {
        $original = $this->getForm($formId);
        if (!$original) {
            return null;
        }

        $newId = $this->generateUuid();

        // Create new form with copied data
        $newData = [
            'id' => $newId,
            'userId' => $userId ?? $original['userId'],
            'title' => $original['title'] . ' (Copy)',
            'description' => $original['description'],
            'status' => 'draft',
            'settings' => $original['settings'],
            'theme' => $original['theme'],
            'logicScript' => $original['logicScript'] ?? null,
            'logicPrompt' => $original['logicPrompt'] ?? null,
            'fields' => $this->generateDuplicateFieldIds($original['fields']),
        ];

        return $this->createForm($newData);
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
        $db = $this->sqlite->getFormDatabase($formId);

        // Clear existing fields
        $db->exec("DELETE FROM fields");

        // Insert new fields
        $stmt = $db->prepare("
            INSERT INTO fields (id, type, label, description, placeholder, required, field_order, properties, validation, conditional_logic)
            VALUES (:id, :type, :label, :description, :placeholder, :required, :field_order, :properties, :validation, :conditional_logic)
        ");

        foreach ($fields as $index => $field) {
            $stmt->execute([
                'id' => $field['id'] ?? $this->generateHumanFieldId($field['label'] ?? ''),
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
    }

    /**
     * Generate human-friendly field IDs for duplicated fields.
     * Appends '_copy' suffix and deduplicates with numeric counters.
     */
    private function generateDuplicateFieldIds(array $fields): array
    {
        $usedIds = [];
        $result = [];

        foreach ($fields as $field) {
            $baseId = $this->generateHumanFieldId($field['label'] ?? '');
            $finalId = $baseId;
            $counter = 1;
            while (in_array($finalId, $usedIds, true)) {
                $finalId = $baseId . '_' . $counter;
                $counter++;
            }
            $usedIds[] = $finalId;
            $field['id'] = $finalId;
            $result[] = $field;
        }

        return $result;
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
