<?php
declare(strict_types=1);
namespace FormLogic\Services;

use PDO;
use RuntimeException;
use InvalidArgumentException;

/** Owner database maintenance. App-specific validation remains in the app's routes. */
final class NativeRecordStore
{
    public function __construct(private PDO $db) {}

    private static function quote(string $name): string { return '"' . str_replace('"', '""', $name) . '"'; }
    private static function hidden(string $name): bool { return (bool) preg_match('/password|token|secret|code_hash|challenge|encrypted|sealed/i', $name); }

    public function schema(string $table): array
    {
        $tables = $this->db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
        if (!in_array($table, $tables, true)) throw new RuntimeException('Table not found', 404);
        $columns = $this->db->query('PRAGMA table_xinfo(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
        $primary = array_values(array_filter($columns, static fn($c) => $c['pk'] > 0));
        usort($primary, static fn($a, $b) => $a['pk'] <=> $b['pk']);
        $canIdentify = $primary && !array_filter($primary, static fn($c) => self::hidden($c['name']) || str_contains(strtoupper($c['type']), 'BLOB'));
        $sql = $this->db->prepare('SELECT sql FROM sqlite_master WHERE name=?');
        $sql->execute([$table]);
        $primaryIndex = array_filter($this->db->query('PRAGMA index_list(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC), static fn($index) => $index['origin'] === 'pk');
        $rowidTable = !$primaryIndex && !preg_match('/WITHOUT\s+ROWID/i', (string) $sql->fetchColumn());
        $fields = [];
        foreach ($columns as $c) {
            if (self::hidden($c['name'])) continue;
            $type = strtoupper($c['type']);
            $fields[] = ['name' => $c['name'], 'type' => $type, 'primary' => (bool) $c['pk'],
                'required' => (bool) $c['notnull'], 'defaultValue' => $c['dflt_value'],
                'auto' => $rowidTable && count($primary) === 1 && $c['pk'] > 0 && $type === 'INTEGER',
                'readOnly' => $c['hidden'] > 0 || str_contains($type, 'BLOB')];
        }
        return ['fields' => $fields, 'primaryKey' => $canIdentify ? array_column($primary, 'name') : [],
            'canCreate' => !array_filter($columns, static fn($c) => (self::hidden($c['name']) || str_contains(strtoupper($c['type']), 'BLOB')) && $c['notnull'] && $c['dflt_value'] === null)];
    }

    private function find(string $table, array $schema, mixed $key): array
    {
        $names = $schema['primaryKey'];
        if (!$names || !is_array($key) || count($key) !== count($names)) throw new InvalidArgumentException('A complete primary key is required to edit this record.');
        foreach ($names as $name) if (!isset($key[$name]) || !is_scalar($key[$name])) throw new InvalidArgumentException('A complete primary key is required to edit this record.');
        $where = implode(' AND ', array_map(static fn($name) => self::quote($name) . ' = ?', $names));
        $stmt = $this->db->prepare('SELECT * FROM ' . self::quote($table) . ' WHERE ' . $where . ' LIMIT 2');
        $stmt->execute(array_map(static fn($name) => $key[$name], $names));
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (count($rows) !== 1) throw new RuntimeException('This record no longer exists. Refresh the records.', 409);
        return [$rows[0], $where, array_map(static fn($name) => $key[$name], $names)];
    }

    private function revision(array $row): string { return hash('sha256', serialize($row)); }

    public function operate(array $input, array $subscriptions = []): array
    {
        $table = $input['table'] ?? null;
        $action = $input['action'] ?? null;
        if (!is_string($table) || !in_array($action, ['read', 'create', 'update', 'delete'], true)) throw new InvalidArgumentException('Choose a table and record action.');
        $schema = $this->schema($table);
        $this->db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500');
        $began = false;
        try {
            $this->db->exec($action === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
            $began = true;
            if ($action !== 'create') {
                [$row, $where, $keys] = $this->find($table, $schema, $input['key'] ?? null);
                $types = $this->db->prepare('SELECT ' . implode(',', array_map(static fn($field) => 'typeof(' . self::quote($field['name']) . ') AS ' . self::quote($field['name']), $schema['fields'])) . ' FROM ' . self::quote($table) . ' WHERE ' . $where);
                $types->execute($keys);
                $storageTypes = $types->fetch(PDO::FETCH_ASSOC);
                foreach ($schema['fields'] as &$field) if (($storageTypes[$field['name']] ?? '') === 'blob') $field['readOnly'] = true;
                unset($field);
                if ($action === 'read') {
                    $values = [];
                    foreach ($schema['fields'] as &$field) {
                        $value = $row[$field['name']];
                        // Never turn a preview or a binary value into editable source.
                        if ($field['readOnly'] || (is_string($value) && (strlen($value) > 100000 || !mb_check_encoding($value, 'UTF-8')))) { $field['readOnly'] = true; continue; }
                        $values[$field['name']] = $value === null ? null : (is_float($value) ? json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION) : (string) $value);
                    }
                    unset($field);
                    $result = ['record' => ['values' => (object) $values, 'revision' => $this->revision($row), 'fields' => $schema['fields']]];
                } elseif (!is_string($input['revision'] ?? null) || !hash_equals($this->revision($row), $input['revision'])) {
                    throw new RuntimeException('This record changed since you opened it. Close the editor and refresh before trying again.', 409);
                }
            }
            if ($action !== 'read') {
                $this->captureEvents($subscriptions);
                if ($action === 'delete') {
                    $stmt = $this->db->prepare('DELETE FROM ' . self::quote($table) . ' WHERE ' . $where);
                    $stmt->execute($keys);
                } else {
                    if ($action === 'create' && !$schema['canCreate']) throw new InvalidArgumentException('This table requires private or binary fields. Create records through the app instead.');
                    $values = $input['values'] ?? null;
                    if (!is_array($values) || count($values) > 100) throw new InvalidArgumentException('Provide record field values.');
                    $fields = array_column($schema['fields'], null, 'name');
                    foreach ($values as $name => $value) {
                        $field = $fields[$name] ?? null;
                        if (!$field || $field['readOnly'] || ($action === 'update' && $field['primary'])) throw new InvalidArgumentException('This field cannot be edited: ' . $name);
                        if ($value !== null && (!is_scalar($value) || strlen((string) $value) > 100000)) throw new InvalidArgumentException('Field values must be text, numbers, or null (up to 100 KB).');
                        if ($value === null && $field['required']) throw new InvalidArgumentException($name . ' is required.');
                        if ($value !== null && str_contains($field['type'], 'INT') && !preg_match('/^-?\d+$/D', (string) $value)) throw new InvalidArgumentException($name . ' must be a whole number.');
                        if ($value !== null && str_contains($field['type'], 'INT')) {
                            $digits = ltrim(ltrim((string) $value, '-'), '0') ?: '0';
                            $limit = str_starts_with((string) $value, '-') ? '9223372036854775808' : '9223372036854775807';
                            if (strlen($digits) > 19 || (strlen($digits) === 19 && strcmp($digits, $limit) > 0)) throw new InvalidArgumentException($name . ' is outside the SQLite integer range.');
                        }
                        if ($value !== null && preg_match('/REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $field['type']) && (!is_numeric($value) || !is_finite((float) $value))) throw new InvalidArgumentException($name . ' must be a number.');
                    }
                    if ($action === 'create') {
                        $sql = $values ? 'INSERT INTO ' . self::quote($table) . ' (' . implode(',', array_map(self::quote(...), array_keys($values))) . ') VALUES (' . implode(',', array_fill(0, count($values), '?')) . ')' : 'INSERT INTO ' . self::quote($table) . ' DEFAULT VALUES';
                        $params = array_values($values);
                    } else {
                        if (!$values) throw new InvalidArgumentException('Change at least one field before saving.');
                        $sql = 'UPDATE ' . self::quote($table) . ' SET ' . implode(',', array_map(static fn($name) => self::quote($name) . ' = ?', array_keys($values))) . ' WHERE ' . $where;
                        $params = [...array_values($values), ...$keys];
                    }
                    $stmt = $this->db->prepare($sql);
                    foreach ($params as $i => $value) $stmt->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
                    $stmt->execute();
                }
                $result = ['saved' => true];
            }
            $this->db->exec('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            if ($began) $this->db->exec('ROLLBACK');
            if ($error instanceof \PDOException) {
                if (($error->errorInfo[1] ?? 0) === 19) throw new RuntimeException('The database rejected this change. Check required fields, unique values, references, and table rules.', 422);
                if (in_array($error->errorInfo[1] ?? 0, [5, 6], true)) throw new RuntimeException('The database is busy. Please try again.', 409);
            }
            throw $error;
        }
    }

    /** Same durable, redacted event contract as the ZIPP host, including cascaded writes. */
    private function captureEvents(array $subscriptions): void
    {
        if (!$subscriptions) return;
        $this->db->exec('CREATE TABLE IF NOT EXISTS _formlogic_record_events(id TEXT PRIMARY KEY,event_name TEXT NOT NULL,data_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT');
        $tables = $this->db->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($subscriptions as $index => $subscription) {
            if (!preg_match('/^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/D', $subscription['event'] ?? '', $match) || !in_array($match[2], $tables, true) || empty($subscription['bindings'])) continue;
            [, $operation, $table] = $match;
            $fields = $this->schema($table)['fields'];
            usort($fields, static fn($a, $b) => $b['primary'] <=> $a['primary']);
            $pairs = [];
            foreach (array_slice($fields, 0, 40) as $field) {
                $value = ($operation === 'deleted' ? 'OLD.' : 'NEW.') . self::quote($field['name']);
                $pairs[] = $this->db->quote($field['name']);
                $pairs[] = "CASE WHEN typeof($value)='blob' THEN NULL WHEN typeof($value)='text' THEN substr($value,1,400) ELSE $value END";
            }
            $event = $this->db->quote($subscription['event']);
            $bindings = $this->db->quote(json_encode($subscription['bindings'], JSON_THROW_ON_ERROR));
            $action = ['created' => 'INSERT', 'updated' => 'UPDATE', 'deleted' => 'DELETE'][$operation];
            $this->db->exec('CREATE TEMP TRIGGER ' . self::quote('_formlogic_admin_capture_' . $index) . ' AFTER ' . $action . ' ON ' . self::quote($table) . " BEGIN
                SELECT CASE WHEN (SELECT count(*) FROM _formlogic_record_events)>=10000 THEN RAISE(ABORT,'Record automation queue is full') END;
                INSERT INTO _formlogic_record_events VALUES(lower(hex(randomblob(16))),$event,json_object('table'," . $this->db->quote($table) . ",'operation'," . $this->db->quote($operation) . ",'record',json_object(" . implode(',', $pairs) . "),'recordPreview',json('true')),$bindings,unixepoch()); END");
        }
    }
}
