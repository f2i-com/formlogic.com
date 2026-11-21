<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;

/**
 * Bridges FormLogic Forms (`forms.settings.nativeTableBinding`) directly to a hosted SoftN or
 * container app's live SQLite table so FormLogic forms, responses tables, CRUD screens, reports,
 * charts, and external APIs operate directly on the app's real SQLite records.
 *
 * Security invariants:
 *  - The form's owner (`forms.user_id`) MUST match the target app's owner (`apps.owner_id`).
 *  - Every bound column is validated against `NativeRecordStore::hidden()` and table schema.
 *  - Private (E2EE) forms cannot bind to a native table.
 *  - All writes flow through `NativeAppService::manageRecord()` and dispatch committed
 *    `app.record.*` events through `NativeRecordEventRouter`.
 */
class NativeTableFormBridge
{
    /**
     * @param null|\Closure(): ?NativeRecordEventRouter $recordEventsResolver
     */
    public function __construct(
        private PDO $mysql,
        private NativeAppService $native,
        private ?AppService $apps = null,
        private ?FlowService $flows = null,
        private ?NativeRecordEventRouter $recordEvents = null,
        private ?\Closure $recordEventsResolver = null,
    ) {}

    /**
     * Resolve and authorize the `nativeTableBinding` for `$formId`, or return null for ordinary forms.
     *
     * @return array{
     *   formId: string,
     *   ownerId: string,
     *   appId: string,
     *   databaseAppId: string,
     *   table: string,
     *   primaryKey: list<string>,
     *   columns: array<string, string>,
     *   createdAtColumn: ?string,
     *   statusColumn: ?string
     * }|null
     */
    public function resolveBinding(string $formId): ?array
    {
        if ($formId === '') return null;
        try {
            $stmt = $this->mysql->prepare('SELECT user_id, settings FROM forms WHERE id = :id LIMIT 1');
            $stmt->execute(['id' => $formId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (\Throwable) {
            return null;
        }
        if (!is_array($row)) return null;
        $settings = is_string($row['settings'] ?? null) ? json_decode($row['settings'], true) : (is_array($row['settings'] ?? null) ? $row['settings'] : null);
        if (!is_array($settings) || !is_array($settings['nativeTableBinding'] ?? null)) {
            return null;
        }
        $raw = $settings['nativeTableBinding'];
        $appId = is_string($raw['appId'] ?? null) ? trim($raw['appId']) : '';
        $table = is_string($raw['table'] ?? null) ? trim($raw['table']) : '';
        $formOwner = (string) ($row['user_id'] ?? '');
        if ($appId === '' || $table === '' || $formOwner === '' || preg_match('/^[A-Za-z][A-Za-z0-9_]{0,62}$/D', $table) !== 1) {
            return null;
        }
        // Strictly verify same-account ownership between the form and the target SoftN app.
        try {
            $appStmt = $this->mysql->prepare('SELECT owner_id FROM apps WHERE id = :id LIMIT 1');
            $appStmt->execute(['id' => $appId]);
            $appOwner = $appStmt->fetchColumn();
        } catch (\Throwable) {
            return null;
        }
        if (!is_string($appOwner) || $appOwner !== $formOwner) {
            return null;
        }

        $columns = [];
        if (is_array($raw['columns'] ?? null)) {
            foreach ($raw['columns'] as $fieldId => $colName) {
                if (!is_string($fieldId) || !is_string($colName)) continue;
                if (preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $colName) !== 1) continue;
                if (NativeRecordStore::hidden($colName)) continue;
                $columns[$fieldId] = $colName;
            }
        }
        $pk = [];
        if (is_array($raw['primaryKey'] ?? null)) {
            foreach ($raw['primaryKey'] as $k) {
                if (is_string($k) && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $k) === 1 && !NativeRecordStore::hidden($k)) {
                    $pk[] = $k;
                }
            }
        }
        $createdAtCol = is_string($raw['createdAtColumn'] ?? null)
            && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $raw['createdAtColumn']) === 1
            && !NativeRecordStore::hidden($raw['createdAtColumn'])
            ? $raw['createdAtColumn']
            : null;
        $statusCol = is_string($raw['statusColumn'] ?? null)
            && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $raw['statusColumn']) === 1
            && !NativeRecordStore::hidden($raw['statusColumn'])
            ? $raw['statusColumn']
            : null;

        return [
            'formId' => $formId,
            'ownerId' => $formOwner,
            'appId' => $appId,
            'databaseAppId' => $this->native->databaseAppId($appId),
            'table' => $table,
            'primaryKey' => $pk,
            'columns' => $columns,
            'createdAtColumn' => $createdAtCol,
            'statusColumn' => $statusCol,
        ];
    }

    /** Encode a primary-key map into a URL-safe FormLogic response ID. */
    public static function encodeKey(array $keyMap, array $pkNames): string
    {
        if (count($pkNames) === 1) {
            $val = (string) ($keyMap[$pkNames[0]] ?? '');
            if ($val !== '' && preg_match('/^[A-Za-z0-9._-]{1,120}$/D', $val) === 1) {
                return $val;
            }
        }
        return 'nk_' . rtrim(strtr(base64_encode(json_encode($keyMap, JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
    }

    /** Decode a FormLogic response ID back into a NativeRecordStore primary-key map. */
    public static function decodeKey(string $responseId, array $pkNames): ?array
    {
        if ($pkNames === [] || $responseId === '') return null;
        if (str_starts_with($responseId, 'nk_')) {
            $b64 = strtr(substr($responseId, 3), '-_', '+/');
            $pad = strlen($b64) % 4;
            if ($pad > 0) $b64 .= str_repeat('=', 4 - $pad);
            $decoded = json_decode((string) base64_decode($b64, true), true);
            if (!is_array($decoded)) return null;
            $out = [];
            foreach ($pkNames as $col) {
                if (!array_key_exists($col, $decoded) || !is_scalar($decoded[$col])) return null;
                $out[$col] = (string) $decoded[$col];
            }
            return $out;
        }
        if (count($pkNames) === 1) {
            return [$pkNames[0] => $responseId];
        }
        return null;
    }

    /**
     * List rows from the bound SQLite table in canonical FormLogic Response format.
     *
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $options
     * @return list<array<string, mixed>>
     */
    public function listResponses(array $binding, array $options = []): array
    {
        $limit = max(1, min((int) ($options['limit'] ?? 50), 250));
        $offset = max(0, (int) ($options['offset'] ?? 0));
        $nativeOpts = ['limit' => $limit];
        if (isset($options['search']) && is_string($options['search']) && trim($options['search']) !== '') {
            $nativeOpts['q'] = trim($options['search']);
        }
        // Push down simple answersEq filters to NativeRecordStore filters.
        if (is_array($options['answersEq'] ?? null) && $options['answersEq'] !== []) {
            $filters = [];
            foreach ($options['answersEq'] as $fieldId => $val) {
                $col = $binding['columns'][$fieldId] ?? null;
                if ($col !== null && is_scalar($val)) {
                    $filters[] = ['column' => $col, 'op' => 'eq', 'value' => (string) $val];
                }
            }
            if ($filters !== []) {
                $nativeOpts['filter'] = $filters;
            }
        }
        try {
            $res = $this->native->records($binding['appId'], $binding['table'], $offset, null, $nativeOpts);
        } catch (\RuntimeException) {
            return [];
        }
        $rows = is_array($res['rows'] ?? null) ? $res['rows'] : [];
        $pkNames = is_array($res['primaryKey'] ?? null) && $res['primaryKey'] !== []
            ? $res['primaryKey']
            : $binding['primaryKey'];
        $keys = is_array($res['keys'] ?? null) ? $res['keys'] : [];
        $out = [];
        foreach ($rows as $idx => $row) {
            if (!is_array($row)) continue;
            $keyMap = is_array($keys[$idx] ?? null) ? $keys[$idx] : $this->extractKeyFromRow($row, $pkNames);
            $out[] = $this->formatRow($binding, $row, $keyMap, $pkNames, (string) ($idx + $offset + 1));
        }
        return $out;
    }

    /** Read one row by response ID from the bound SQLite table. */
    public function getResponse(array $binding, string $responseId): ?array
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return null;
        try {
            $res = $this->native->manageRecord($binding['appId'], [
                'table' => $binding['table'],
                'action' => 'read',
                'key' => $keyMap,
            ]);
        } catch (\Throwable) {
            return null;
        }
        $values = is_array($res['record']['values'] ?? null)
            ? $res['record']['values']
            : ($res['record']['values'] instanceof \stdClass ? (array) $res['record']['values'] : []);
        return $this->formatRow($binding, $values, $keyMap, $pkNames, $responseId);
    }

    /** Create a new row in the bound SQLite table and dispatch committed record events. */
    public function createResponse(array $binding, array $data): array
    {
        $answers = is_array($data['answers'] ?? null) ? $data['answers'] : [];
        $schemas = $this->native->tableSchemas($binding['appId']);
        $tableSchema = $schemas[$binding['table']] ?? ['fields' => [], 'primaryKey' => $binding['primaryKey'], 'canCreate' => true];
        $fieldsByName = [];
        foreach ($tableSchema['fields'] as $f) {
            $fieldsByName[(string) $f['name']] = $f;
        }
        $values = $this->mapAnswersToColumns($binding, $answers, $fieldsByName, false);
        // If the table has a non-auto text primary key that wasn't provided, supply a UUID.
        $pkNames = $tableSchema['primaryKey'] !== [] ? $tableSchema['primaryKey'] : $binding['primaryKey'];
        if (count($pkNames) === 1) {
            $pkCol = $pkNames[0];
            $pkMeta = $fieldsByName[$pkCol] ?? null;
            if ($pkMeta !== null && empty($pkMeta['auto']) && !array_key_exists($pkCol, $values) && empty($pkMeta['defaultValue'])) {
                if (str_contains(strtoupper((string) ($pkMeta['type'] ?? '')), 'TEXT') || str_contains(strtoupper((string) ($pkMeta['type'] ?? '')), 'CHAR') || ($pkMeta['type'] ?? '') === '') {
                    $values[$pkCol] = $this->uuid();
                }
            }
        }
        // Automatically supply required system/audit columns (created_at, updated_at, is_sample,
        // sequence numbers, and any other NOT NULL columns without defaults) so FormLogic forms
        // write cleanly into both form-managed SQLite tables and full SoftN business app schemas.
        $nowEpoch = time();
        $nowIso = gmdate('Y-m-d H:i:s', $nowEpoch);
        $today = gmdate('Y-m-d', $nowEpoch);
        foreach ($fieldsByName as $colName => $colMeta) {
            if (array_key_exists($colName, $values) && $values[$colName] !== null && $values[$colName] !== '') {
                continue;
            }
            if (!empty($colMeta['auto']) || !empty($colMeta['readOnly'])) {
                continue;
            }
            $isRequired = !empty($colMeta['required']);
            $hasDefault = array_key_exists('defaultValue', $colMeta) && $colMeta['defaultValue'] !== null;
            $lower = strtolower($colName);
            $sqlType = strtoupper((string) ($colMeta['type'] ?? 'TEXT'));
            $isNumericType = preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1;

            if ($lower === 'created_at' || $lower === 'updated_at') {
                $values[$colName] = $isNumericType ? $nowEpoch : $nowIso;
                continue;
            }
            if ($lower === 'is_sample' && !array_key_exists($colName, $values)) {
                $values[$colName] = 0;
                continue;
            }
            if (!$isRequired || $hasDefault) {
                continue;
            }
            if (preg_match('/(?:_number|_code|_ref|^code$|^ref$)$/', $lower) === 1 && !$isNumericType) {
                $prefix = strtoupper(substr(preg_replace('/[^a-zA-Z]/', '', $binding['table']) ?: 'REC', 0, 3));
                $values[$colName] = $prefix . '-' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
            } elseif (preg_match('/_date$|^date$/', $lower) === 1 && !$isNumericType) {
                $values[$colName] = $today;
            } elseif ($isNumericType) {
                $values[$colName] = 0;
            } else {
                $values[$colName] = '';
            }
        }
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        $res = $this->native->manageRecord($binding['appId'], [
            'table' => $binding['table'],
            'action' => 'create',
            'values' => $values,
        ], $subscriptions);
        $this->dispatchEvents($binding['appId']);

        $keyMap = is_array($res['key'] ?? null) ? $res['key'] : $this->extractKeyFromRow($values, $pkNames);
        $id = $keyMap !== [] ? self::encodeKey($keyMap, $pkNames) : $this->uuid();
        if ($keyMap !== []) {
            $fetched = $this->getResponse($binding, $id);
            if ($fetched !== null) return $fetched;
        }
        return $this->formatRow($binding, $values, $keyMap, $pkNames, $id);
    }

    /** Update an existing row in the bound SQLite table and dispatch committed record events. */
    public function updateResponse(array $binding, string $responseId, array $data): ?array
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return null;
        try {
            $current = $this->native->manageRecord($binding['appId'], [
                'table' => $binding['table'],
                'action' => 'read',
                'key' => $keyMap,
            ]);
        } catch (\Throwable) {
            return null;
        }
        $revision = (string) ($current['record']['revision'] ?? '');
        $fieldsByName = [];
        foreach (is_array($current['record']['fields'] ?? null) ? $current['record']['fields'] : [] as $f) {
            $fieldsByName[(string) $f['name']] = $f;
        }
        $answers = is_array($data['answers'] ?? null) ? $data['answers'] : [];
        if (isset($data['status']) && is_string($data['status']) && $binding['statusColumn'] !== null) {
            $statusFieldId = array_search($binding['statusColumn'], $binding['columns'], true);
            if (is_string($statusFieldId) && !array_key_exists($statusFieldId, $answers)) {
                $answers[$statusFieldId] = $data['status'];
            }
        }
        $values = $this->mapAnswersToColumns($binding, $answers, $fieldsByName, true);
        if ($values !== [] && isset($fieldsByName['updated_at']) && !array_key_exists('updated_at', $values) && empty($fieldsByName['updated_at']['readOnly'])) {
            $uType = strtoupper((string) ($fieldsByName['updated_at']['type'] ?? 'TEXT'));
            $values['updated_at'] = preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $uType) === 1 ? time() : gmdate('Y-m-d H:i:s');
        }
        if ($values === []) {
            $existingVals = is_array($current['record']['values'] ?? null)
                ? $current['record']['values']
                : ($current['record']['values'] instanceof \stdClass ? (array) $current['record']['values'] : []);
            return $this->formatRow($binding, $existingVals, $keyMap, $pkNames, $responseId);
        }
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        $this->native->manageRecord($binding['appId'], [
            'table' => $binding['table'],
            'action' => 'update',
            'key' => $keyMap,
            'revision' => $revision,
            'values' => $values,
        ], $subscriptions);
        $this->dispatchEvents($binding['appId']);
        return $this->getResponse($binding, $responseId);
    }

    /** Delete a row from the bound SQLite table and dispatch committed record events. */
    public function deleteResponse(array $binding, string $responseId): bool
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return false;
        try {
            $current = $this->native->manageRecord($binding['appId'], [
                'table' => $binding['table'],
                'action' => 'read',
                'key' => $keyMap,
            ]);
        } catch (\Throwable) {
            return false;
        }
        $revision = (string) ($current['record']['revision'] ?? '');
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        $this->native->manageRecord($binding['appId'], [
            'table' => $binding['table'],
            'action' => 'delete',
            'key' => $keyMap,
            'revision' => $revision,
        ], $subscriptions);
        $this->dispatchEvents($binding['appId']);
        return true;
    }

    /** Count all rows in the bound SQLite table. */
    public function countResponses(array $binding): int
    {
        try {
            return (int) $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding): int {
                $quoted = '"' . str_replace('"', '""', $binding['table']) . '"';
                return (int) $db->query("SELECT COUNT(*) FROM {$quoted}")->fetchColumn();
            });
        } catch (\Throwable) {
            return 0;
        }
    }

    /**
     * Build a FormLogic form definition (fields + nativeTableBinding + starter report specs)
     * directly from a SoftN app SQLite table's schema.
     *
     * @param array{fields: list<array<string, mixed>>, primaryKey: list<string>, canCreate: bool} $schema
     * @return array{
     *   fields: list<array<string, mixed>>,
     *   binding: array<string, mixed>,
     *   numericFields: list<array{id: string, label: string}>,
     *   categoryFields: list<array{id: string, label: string}>
     * }
     */
    public static function buildFormDefinitionFromTable(string $databaseAppId, string $table, array $schema): array
    {
        $fields = [];
        $columns = [];
        $taken = [];
        $createdAtCol = null;
        $statusCol = null;
        $numericFields = [];
        $categoryFields = [];

        foreach ($schema['fields'] as $col) {
            $colName = (string) ($col['name'] ?? '');
            if ($colName === '' || NativeRecordStore::hidden($colName)) continue;
            $type = strtoupper((string) ($col['type'] ?? ''));
            if (str_contains($type, 'BLOB')) continue;

            $lower = strtolower($colName);
            if ($createdAtCol === null && preg_match('/^(?:created_?at|submitted_?at|inserted_?at|date_?created|timestamp)$/', $lower) === 1) {
                $createdAtCol = $colName;
            }
            if ($statusCol === null && preg_match('/^(?:status|state|stage|priority|category|type)$/', $lower) === 1) {
                $statusCol = $colName;
            }
            // Skip auto-increment primary keys from editable form fields (they are tracked as primaryKey).
            if (!empty($col['auto']) && !empty($col['primary'])) {
                continue;
            }
            if (!empty($col['readOnly'])) {
                continue;
            }

            $fieldId = FormService::newFieldId($colName, $taken);
            $taken[$fieldId] = true;
            $label = ucwords(str_replace(['_', '-'], ' ', (string) preg_replace('/(?<=[a-z])(?=[A-Z])/', ' ', $colName)));
            $fieldType = self::inferFieldType($colName, $type);
            $required = !empty($col['required']) && ($col['defaultValue'] ?? null) === null && empty($col['primary']);

            $fields[] = [
                'id' => $fieldId,
                'type' => $fieldType,
                'label' => $label,
                'required' => $required,
                'order' => count($fields),
                'properties' => [],
            ];
            $columns[$fieldId] = $colName;

            if ($fieldType === 'number') {
                $numericFields[] = ['id' => $fieldId, 'label' => $label];
            } elseif (in_array($fieldType, ['short_text', 'dropdown'], true) && !preg_match('/email|phone|url|name|title|id$/i', $lower)) {
                $categoryFields[] = ['id' => $fieldId, 'label' => $label];
            }
        }

        // Prioritize status/priority/category/type columns for starter breakdown charts.
        usort($categoryFields, static function (array $a, array $b) use ($columns): int {
            $score = static fn(string $id): int => preg_match('/status|state|stage|priority|category|type/i', $columns[$id] ?? '') === 1 ? 0 : 1;
            return $score($a['id']) <=> $score($b['id']);
        });

        return [
            'fields' => $fields,
            'binding' => [
                'appId' => $databaseAppId,
                'table' => $table,
                'primaryKey' => $schema['primaryKey'],
                'columns' => $columns,
                'createdAtColumn' => $createdAtCol,
                'statusColumn' => $statusCol,
            ],
            'numericFields' => $numericFields,
            'categoryFields' => $categoryFields,
        ];
    }

    private static function inferFieldType(string $colName, string $sqlType): string
    {
        $lower = strtolower($colName);
        if (str_contains($lower, 'email')) return 'email';
        if (preg_match('/phone|mobile|tel$/', $lower) === 1) return 'phone';
        if (preg_match('/url|website|link/', $lower) === 1) return 'url';
        if (preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1 && !preg_match('/_at$|timestamp|date/', $lower)) {
            return 'number';
        }
        if (preg_match('/_date$|^date$|due_?date|start_?date|end_?date/', $lower) === 1) return 'date';
        if (preg_match('/description|notes|details|body|comment|message|address|summary/', $lower) === 1) return 'long_text';
        return 'short_text';
    }

    /** @return list<string> */
    private function resolvePrimaryKey(array $binding): array
    {
        if ($binding['primaryKey'] !== []) return $binding['primaryKey'];
        $schemas = $this->native->tableSchemas($binding['appId']);
        return $schemas[$binding['table']]['primaryKey'] ?? [];
    }

    /** @return array<string, mixed> */
    private function formatRow(array $binding, array $row, array $keyMap, array $pkNames, string $fallbackId): array
    {
        $answers = [];
        foreach ($binding['columns'] as $fieldId => $colName) {
            if (array_key_exists($colName, $row)) {
                $answers[$fieldId] = $row[$colName];
            }
        }
        $id = $keyMap !== [] ? self::encodeKey($keyMap, $pkNames) : $fallbackId;
        $rawCreated = ($binding['createdAtColumn'] !== null && isset($row[$binding['createdAtColumn']]) && is_scalar($row[$binding['createdAtColumn']]))
            ? $row[$binding['createdAtColumn']]
            : null;
        if ($rawCreated !== null && is_numeric($rawCreated) && (int) $rawCreated > 946684800 && (int) $rawCreated < 4102444800) {
            $createdAt = gmdate('Y-m-d H:i:s', (int) $rawCreated);
        } elseif ($rawCreated !== null && trim((string) $rawCreated) !== '') {
            $createdAt = (string) $rawCreated;
        } else {
            $createdAt = gmdate('Y-m-d H:i:s');
        }
        $rawUpdated = isset($row['updated_at']) && is_scalar($row['updated_at']) ? $row['updated_at'] : null;
        if ($rawUpdated !== null && is_numeric($rawUpdated) && (int) $rawUpdated > 946684800 && (int) $rawUpdated < 4102444800) {
            $updatedAt = gmdate('Y-m-d H:i:s', (int) $rawUpdated);
        } elseif ($rawUpdated !== null && trim((string) $rawUpdated) !== '') {
            $updatedAt = (string) $rawUpdated;
        } else {
            $updatedAt = $createdAt;
        }
        $status = ($binding['statusColumn'] !== null && isset($row[$binding['statusColumn']]) && is_string($row[$binding['statusColumn']]) && $row[$binding['statusColumn']] !== '')
            ? $row[$binding['statusColumn']]
            : 'submitted';

        return [
            'id' => $id,
            'formId' => $binding['formId'],
            'answers' => $answers,
            'status' => $status,
            'submittedAt' => $createdAt,
            'updatedAt' => $updatedAt,
            'metadata' => [
                'nativeTable' => $binding['table'],
                'nativeAppId' => $binding['databaseAppId'],
                'nativeKey' => $keyMap,
            ],
        ];
    }

    /** @return array<string, mixed> */
    private function mapAnswersToColumns(array $binding, array $answers, array $fieldsByName, bool $isUpdate): array
    {
        $values = [];
        foreach ($binding['columns'] as $fieldId => $colName) {
            if (!array_key_exists($fieldId, $answers)) continue;
            $meta = $fieldsByName[$colName] ?? null;
            if ($meta !== null) {
                if (!empty($meta['readOnly'])) continue;
                if ($isUpdate && !empty($meta['primary'])) continue;
            }
            $val = $answers[$fieldId];
            $sqlType = $meta !== null ? strtoupper((string) ($meta['type'] ?? '')) : '';
            $isInt = str_contains($sqlType, 'INT');
            $isReal = preg_match('/REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1;
            // Unwrap linked_record answer shapes (`{ id: "3" }` or `["3"]`) for FK columns.
            if (is_array($val)) {
                if (isset($val['id']) && is_scalar($val['id'])) {
                    $val = $val['id'];
                } elseif (($isInt || $isReal || str_ends_with(strtolower($colName), '_id')) && array_is_list($val) && count($val) === 1) {
                    $first = $val[0];
                    $val = is_array($first) && isset($first['id']) && is_scalar($first['id']) ? $first['id'] : (is_scalar($first) ? $first : json_encode($val, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
                } else {
                    $val = json_encode($val, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                }
            } elseif (is_bool($val)) {
                $val = $val ? 1 : 0;
            }
            if ($val === '' && ($isInt || $isReal)) {
                $val = null;
            } elseif ($isInt && is_string($val) && preg_match('/^-?\d+$/D', trim($val)) === 1) {
                $val = (int) trim($val);
            } elseif ($isReal && is_string($val) && is_numeric(trim($val))) {
                $val = (float) trim($val);
            }
            $values[$colName] = $val;
        }
        return $values;
    }

    /** @return array<string, string> */
    private function extractKeyFromRow(array $row, array $pkNames): array
    {
        $out = [];
        foreach ($pkNames as $col) {
            if (isset($row[$col]) && is_scalar($row[$col])) {
                $out[$col] = (string) $row[$col];
            }
        }
        return $out;
    }

    /** @return list<array{event: string, bindings: list<string>}> */
    private function subscriptionsFor(string $appId): array
    {
        if ($this->flows === null) return [];
        $group = $this->apps !== null ? $this->apps->sharedDatabaseGroupAppIds($appId) : [$appId];
        return $this->flows->nativeRecordSubscriptionsForApps($group);
    }

    private function dispatchEvents(string $appId): void
    {
        $router = $this->recordEvents ?? ($this->recordEventsResolver !== null ? ($this->recordEventsResolver)() : null);
        if ($router === null) return;
        try {
            $this->native->dispatchRecordEvents($appId, $router->for($appId));
        } catch (\Throwable $e) {
            error_log('NativeTableFormBridge: event dispatch pending for app ' . $appId . ': ' . $e->getMessage());
        }
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
