<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use InvalidArgumentException;
use PDO;
use RuntimeException;

/**
 * Turns any FormLogic Form App's forms into real tables inside a unified SQLite database
 * (`storage/native-apps/<sha256(appId)>/private/data/application.sqlite`), and coordinates
 * bidirectional sharing across Form Apps, SoftN Apps, and Secondary API Backends.
 *
 * Security invariants:
 *  - All cross-app and form-to-table operations require strict same-account ownership.
 *  - Private (E2EE) forms are skipped and never mirrored into plaintext SQLite tables.
 *  - Table and column identifiers are strictly validated against `/^[A-Za-z][A-Za-z0-9_]{0,62}$/`.
 *  - Legacy per-form responses are migrated safely (`INSERT OR IGNORE`) with zero data loss.
 */
final class FormSqliteDatabaseService
{
    private const LAYOUT_FIELD_TYPES = [
        'welcome_screen',
        'thank_you',
        'statement',
        'section',
        'section_header',
        'page_break',
        'divider',
        'heading',
        'paragraph',
    ];

    private PDO $mysql;

    public function __construct(
        MySQLConnection $mysql,
        private SQLiteConnection $sqlite,
        private AppService $apps,
        private FormService $forms,
        private NativeAppService $native,
        private ?PlanService $plans = null,
    ) {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Describe any app's SQLite database state (works for both Form Apps and SoftN Apps).
     *
     * @return array<string, mixed>
     */
    public function describeAppDatabase(string $appId, string $ownerId): array
    {
        $app = $this->requireOwnedApp($appId, $ownerId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $sharedDbAppId = is_string($settings['sharedDatabaseAppId'] ?? null) && $settings['sharedDatabaseAppId'] !== ''
            ? (string) $settings['sharedDatabaseAppId']
            : $this->native->sharedDatabaseAppId($appId);
        if ($sharedDbAppId !== null && $sharedDbAppId !== $appId) {
            $this->requireOwnedApp($sharedDbAppId, $ownerId);
        }
        $canonicalDbAppId = $sharedDbAppId ?? $appId;
        $hasManagedDb = $this->native->hasManagedDatabase($canonicalDbAppId);
        $unifiedSqlite = !empty($settings['unifiedSqlite']) || $hasManagedDb;

        $tables = [];
        if ($hasManagedDb) {
            try {
                $schemas = $this->native->tableSchemas($canonicalDbAppId);
                $rowCounts = $this->readTableCounts($canonicalDbAppId, array_keys($schemas));
                foreach ($schemas as $tbl => $schema) {
                    $tables[] = [
                        'name' => $tbl,
                        'rows' => $rowCounts[$tbl] ?? 0,
                        'primaryKey' => $schema['primaryKey'] ?? [],
                        'columns' => array_values(array_map(static fn(array $f): array => [
                            'name' => (string) ($f['name'] ?? ''),
                            'type' => (string) ($f['type'] ?? 'TEXT'),
                            'required' => !empty($f['required']),
                            'primary' => !empty($f['primary']),
                        ], $schema['fields'] ?? [])),
                    ];
                }
            } catch (\Throwable) {
                $tables = [];
            }
        }

        // Owned apps for shared-DB topology & eligible targets
        $owned = $this->apps->getAllApps($ownerId);
        $ownedById = [];
        foreach ($owned as $a) {
            if (($a['ownerId'] ?? null) === $ownerId) {
                $ownedById[(string) $a['id']] = $a;
            }
        }
        $connectedApps = [];
        $eligibleTargets = [];
        foreach ($ownedById as $oid => $other) {
            $otherSettings = is_array($other['settings'] ?? null) ? $other['settings'] : [];
            $otherShared = is_string($otherSettings['sharedDatabaseAppId'] ?? null) && $otherSettings['sharedDatabaseAppId'] !== ''
                ? (string) $otherSettings['sharedDatabaseAppId']
                : $this->native->sharedDatabaseAppId($oid);
            if ($otherShared === $canonicalDbAppId && $oid !== $canonicalDbAppId) {
                $connectedApps[] = [
                    'id' => $oid,
                    'name' => $other['name'],
                    'slug' => $other['slug'],
                    'softnApp' => !empty($otherSettings['softnApp']),
                    'unifiedSqlite' => !empty($otherSettings['unifiedSqlite']),
                ];
            }
            if ($oid === $appId || $otherShared !== null) {
                continue;
            }
            $dbGlance = $this->native->databaseGlance($oid);
            if ($dbGlance === null) {
                continue;
            }
            $eligibleTargets[] = [
                'id' => $oid,
                'name' => $other['name'],
                'slug' => $other['slug'],
                'tables' => $dbGlance['tables'],
                'formDatabase' => $dbGlance['formDatabase'],
                'softnApp' => !empty($otherSettings['softnApp']),
            ];
        }

        // Forms currently belonging to this app + all account forms bound to this canonical SQLite DB
        $appForms = $this->apps->getAppForms($appId);
        $appFormList = [];
        foreach ($appForms as $af) {
            $fid = (string) ($af['formId'] ?? '');
            $full = $fid !== '' ? $this->forms->getForm($fid) : null;
            $fSettings = is_array($full['settings'] ?? null) ? $full['settings'] : [];
            $binding = is_array($fSettings['nativeTableBinding'] ?? null) ? $fSettings['nativeTableBinding'] : null;
            $appFormList[] = [
                'formId' => $fid,
                'title' => (string) ($full['title'] ?? ($af['displayName'] ?? 'Form')),
                'boundTable' => is_string($binding['table'] ?? null) ? $binding['table'] : null,
                'boundAppId' => is_string($binding['appId'] ?? null) ? $binding['appId'] : null,
                'fieldCount' => is_array($full['fields'] ?? null) ? count($full['fields']) : 0,
                'isPrivate' => $fid !== '' && $this->isFormPrivateOrEnabling($fid),
            ];
        }

        $linkedForms = [];
        foreach ($this->forms->getAllForms($ownerId, ['limit' => 500]) as $f) {
            $fSettings = is_array($f['settings'] ?? null) ? $f['settings'] : [];
            $binding = is_array($fSettings['nativeTableBinding'] ?? null) ? $fSettings['nativeTableBinding'] : null;
            if ($binding !== null && ($binding['appId'] ?? null) === $canonicalDbAppId) {
                $linkedForms[] = [
                    'id' => $f['id'],
                    'title' => $f['title'],
                    'table' => $binding['table'] ?? '',
                    'status' => $f['status'] ?? 'draft',
                    'managedByForm' => !empty($binding['managedByForm']),
                ];
            }
        }

        $dbOwner = $ownedById[$canonicalDbAppId] ?? null;
        $linkedSoftnAppId = is_string($settings['linkedSoftnAppId'] ?? null) && $settings['linkedSoftnAppId'] !== ''
            ? (string) $settings['linkedSoftnAppId']
            : null;
        $linkedSoftnApp = $linkedSoftnAppId !== null && isset($ownedById[$linkedSoftnAppId])
            ? [
                'id' => $ownedById[$linkedSoftnAppId]['id'],
                'name' => $ownedById[$linkedSoftnAppId]['name'],
                'slug' => $ownedById[$linkedSoftnAppId]['slug'],
            ]
            : null;

        return [
            'appId' => $appId,
            'appName' => $app['name'],
            'softnApp' => !empty($settings['softnApp']),
            'unifiedSqlite' => $unifiedSqlite,
            'hasDatabase' => $hasManagedDb,
            'sharedDatabaseAppId' => $sharedDbAppId,
            'databaseAppId' => $canonicalDbAppId,
            'databaseOwner' => $dbOwner ? [
                'id' => $dbOwner['id'],
                'name' => $dbOwner['name'],
                'slug' => $dbOwner['slug'],
                'softnApp' => !empty($dbOwner['settings']['softnApp']),
                'formDatabase' => $this->native->isFormAppDatabase($canonicalDbAppId),
            ] : null,
            'linkedSoftnApp' => $linkedSoftnApp,
            'tables' => $tables,
            'appForms' => $appFormList,
            'linkedForms' => $linkedForms,
            'connectedApps' => $connectedApps,
            'eligibleTargets' => $eligibleTargets,
        ];
    }

    /**
     * Enable a real Unified SQLite Database on a Form App, turning every non-private form into
     * a real SQLite table, migrating existing per-form submissions, and binding each form live.
     *
     * @return array<string, mixed>
     */
    public function enableForApp(string $appId, string $ownerId): array
    {
        $app = $this->requireOwnedApp($appId, $ownerId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $sharedDbAppId = is_string($settings['sharedDatabaseAppId'] ?? null) && $settings['sharedDatabaseAppId'] !== ''
            ? (string) $settings['sharedDatabaseAppId']
            : null;
        if ($sharedDbAppId !== null && $sharedDbAppId !== $appId) {
            $this->requireOwnedApp($sharedDbAppId, $ownerId);
        }
        $canonicalDbAppId = $sharedDbAppId ?? $appId;

        if ($canonicalDbAppId === $appId) {
            $this->native->initFormAppDatabase($appId);
        } elseif (!$this->native->hasManagedDatabase($canonicalDbAppId)) {
            $this->native->initFormAppDatabase($canonicalDbAppId);
        }

        $syncSummary = $this->syncAppFormsInternal($appId, $canonicalDbAppId, $ownerId);

        $settings['unifiedSqlite'] = true;
        $settings['databaseMode'] = 'sqlite';
        $this->apps->updateApp($appId, ['settings' => $settings]);

        $desc = $this->describeAppDatabase($appId, $ownerId);
        $desc['synced'] = $syncSummary;
        return $desc;
    }

    /**
     * Re-sync all forms in a SQLite-backed Form App into SQLite tables (creating new tables and
     * adding any newly added form fields via ALTER TABLE ADD COLUMN).
     *
     * @return array<string, mixed>
     */
    public function syncAppForms(string $appId, string $ownerId): array
    {
        $app = $this->requireOwnedApp($appId, $ownerId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $sharedDbAppId = is_string($settings['sharedDatabaseAppId'] ?? null) && $settings['sharedDatabaseAppId'] !== ''
            ? (string) $settings['sharedDatabaseAppId']
            : null;
        if ($sharedDbAppId !== null && $sharedDbAppId !== $appId) {
            $this->requireOwnedApp($sharedDbAppId, $ownerId);
        }
        $canonicalDbAppId = $sharedDbAppId ?? $appId;
        if (!$this->native->hasManagedDatabase($canonicalDbAppId)) {
            return $this->enableForApp($appId, $ownerId);
        }
        $syncSummary = $this->syncAppFormsInternal($appId, $canonicalDbAppId, $ownerId);
        $desc = $this->describeAppDatabase($appId, $ownerId);
        $desc['synced'] = $syncSummary;
        return $desc;
    }

    /**
     * Sync a single form's fields to its managed SQLite table (called automatically on form edit
     * or when adding a form to a Unified SQLite Form App).
     *
     * @param array<string, mixed> $form
     * @return array{table: string, columnsAdded: int, rowsMigrated: int}|null
     */
    public function syncSingleFormSchema(string $databaseAppId, array $form, ?string $preferredTable = null): ?array
    {
        $formId = (string) ($form['id'] ?? '');
        if (!$formId) {
            return null;
        }
        $formOwnerId = (string) ($form['userId'] ?? '');
        $targetApp = $this->apps->getApp($databaseAppId);
        if (!$targetApp || $formOwnerId === '' || (string) ($targetApp['ownerId'] ?? '') !== $formOwnerId) {
            return null;
        }
        $fSettings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
        if ($this->isFormPrivateOrEnabling($formId)) {
            return null;
        }
        if (!$this->native->hasManagedDatabase($databaseAppId)) {
            $this->native->initFormAppDatabase($databaseAppId);
        }

        $existingBinding = is_array($fSettings['nativeTableBinding'] ?? null) ? $fSettings['nativeTableBinding'] : null;
        $existingTable = is_string($existingBinding['table'] ?? null) ? $existingBinding['table'] : '';
        $alreadyBoundToDb = $existingBinding !== null
            && ($existingBinding['appId'] ?? null) === $databaseAppId
            && preg_match('/^[A-Za-z][A-Za-z0-9_]{0,62}$/D', $existingTable) === 1;

        $fields = is_array($form['fields'] ?? null) ? $form['fields'] : [];
        $fieldDefs = $this->extractSqlColumnsFromFields($fields);

        $columnsAdded = 0;
        $tableName = '';
        $columnMap = [];
        $createdNewTable = false;

        $this->native->withDatabase($databaseAppId, function (PDO $db) use (
            $alreadyBoundToDb,
            $existingBinding,
            $preferredTable,
            $form,
            $fieldDefs,
            &$tableName,
            &$columnMap,
            &$columnsAdded,
            &$createdNewTable
        ): void {
            $existingTables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_'")->fetchAll(PDO::FETCH_COLUMN);
            $existingTablesSet = array_fill_keys(array_map('strval', $existingTables), true);

            if ($alreadyBoundToDb) {
                $tableName = (string) $existingBinding['table'];
            } else {
                $baseName = self::sanitizeTableName($preferredTable ?: (string) ($form['title'] ?? 'records'));
                $candidate = $baseName;
                $suffix = 2;
                while (isset($existingTablesSet[$candidate])) {
                    $candidate = substr($baseName, 0, 56) . '_' . $suffix;
                    $suffix++;
                }
                $tableName = $candidate;
            }

            $qTable = self::quoteIdent($tableName);
            $tableExists = isset($existingTablesSet[$tableName]);
            if (!$tableExists) {
                $colLines = ['"id" TEXT PRIMARY KEY'];
                $usedCols = ['id' => true, 'status' => true, '_submitted_by_user_id' => true, 'created_at' => true, 'updated_at' => true];
                foreach ($fieldDefs as $def) {
                    $col = self::uniqueColName($def['colName'], $usedCols);
                    $usedCols[$col] = true;
                    $colLines[] = self::quoteIdent($col) . ' ' . $def['sqlType'];
                    $columnMap[$def['fieldId']] = $col;
                }
                $colLines[] = '"status" TEXT NOT NULL DEFAULT \'submitted\'';
                $colLines[] = '"_submitted_by_user_id" TEXT NULL';
                $colLines[] = '"created_at" TEXT NOT NULL DEFAULT (datetime(\'now\'))';
                $colLines[] = '"updated_at" TEXT NOT NULL DEFAULT (datetime(\'now\'))';
                $db->exec("CREATE TABLE IF NOT EXISTS {$qTable} (" . implode(', ', $colLines) . ')');
                $createdNewTable = true;
                $columnsAdded = count($columnMap);
            } else {
                $pragma = $db->query("PRAGMA table_info({$qTable})")->fetchAll(PDO::FETCH_ASSOC);
                $existingCols = [];
                foreach ($pragma as $colInfo) {
                    $cname = (string) ($colInfo['name'] ?? '');
                    if ($cname !== '') {
                        $existingCols[strtolower($cname)] = $cname;
                    }
                }
                if (
                    !isset($existingCols['_submitted_by_user_id'])
                    && !isset($existingCols['submitted_by_user_id'])
                    && (!empty($existingBinding['managedByForm']) || !$alreadyBoundToDb)
                ) {
                    $db->exec("ALTER TABLE {$qTable} ADD COLUMN \"_submitted_by_user_id\" TEXT NULL");
                    $existingCols['_submitted_by_user_id'] = '_submitted_by_user_id';
                }
                $prevColumns = is_array($existingBinding['columns'] ?? null) ? $existingBinding['columns'] : [];
                $usedCols = array_fill_keys(array_values($existingCols), true);
                foreach ($fieldDefs as $def) {
                    $fid = $def['fieldId'];
                    if (isset($prevColumns[$fid]) && isset($existingCols[strtolower((string) $prevColumns[$fid])])) {
                        $columnMap[$fid] = $existingCols[strtolower((string) $prevColumns[$fid])];
                        continue;
                    }
                    if (isset($existingCols[strtolower($def['colName'])])) {
                        $columnMap[$fid] = $existingCols[strtolower($def['colName'])];
                        continue;
                    }
                    // Safe ALTER TABLE ADD COLUMN for new form fields
                    $newCol = self::uniqueColName($def['colName'], $usedCols);
                    $usedCols[$newCol] = true;
                    $db->exec("ALTER TABLE {$qTable} ADD COLUMN " . self::quoteIdent($newCol) . ' ' . $def['sqlType']);
                    $columnMap[$fid] = $newCol;
                    $columnsAdded++;
                }
            }
        });

        // Migrate any existing legacy per-form responses when binding a form for the first time
        $rowsMigrated = 0;
        if (!$alreadyBoundToDb && ($createdNewTable || $tableName !== '')) {
            $rowsMigrated = $this->migrateLegacyFormResponses($formId, $databaseAppId, $tableName, $columnMap);
        }

        // Persist live nativeTableBinding on the form
        $primaryKey = ['id'];
        $createdAtCol = 'created_at';
        $statusCol = 'status';
        $schemas = $this->native->tableSchemas($databaseAppId);
        if (isset($schemas[$tableName])) {
            if (!empty($schemas[$tableName]['primaryKey'])) {
                $primaryKey = $schemas[$tableName]['primaryKey'];
            }
            $fieldNames = array_map(static fn(array $f): string => (string) $f['name'], $schemas[$tableName]['fields'] ?? []);
            if (!in_array('created_at', $fieldNames, true)) {
                $createdAtCol = $existingBinding['createdAtColumn'] ?? null;
            }
            if (!in_array('status', $fieldNames, true)) {
                $statusCol = $existingBinding['statusColumn'] ?? null;
            }
        }

        $fSettings['nativeTableBinding'] = [
            'appId' => $databaseAppId,
            'table' => $tableName,
            'primaryKey' => $primaryKey,
            'columns' => $columnMap,
            'createdAtColumn' => $createdAtCol,
            'statusColumn' => $statusCol,
            'managedByForm' => true,
        ];
        $this->updateFormSettingsRaw($formId, $fSettings);

        return [
            'table' => $tableName,
            'columnsAdded' => $columnsAdded,
            'rowsMigrated' => $rowsMigrated,
        ];
    }

    /**
     * Link an existing FormLogic Form directly to a table in any owned SoftN App or Form App SQLite DB.
     *
     * @param array<string, string>|null $columnMap
     * @return array<string, mixed>
     */
    public function linkExistingFormToTable(
        string $formId,
        string $databaseAppId,
        string $table,
        string $ownerId,
        ?array $columnMap = null
    ): array {
        $this->requireOwnedApp($databaseAppId, $ownerId);
        $canonicalDbAppId = $this->native->databaseAppId($databaseAppId);
        $this->requireOwnedApp($canonicalDbAppId, $ownerId);
        if (!$this->native->hasManagedDatabase($canonicalDbAppId)) {
            throw new InvalidArgumentException('The target app does not have a SQLite database yet.');
        }

        $form = $this->forms->getForm($formId);
        if (!$form || ($form['userId'] ?? null) !== $ownerId) {
            throw new RuntimeException('Form not found', 404);
        }
        $fSettings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
        if ($this->isFormPrivateOrEnabling($formId)) {
            throw new InvalidArgumentException('Private end-to-end encrypted forms cannot be linked to a shared SQLite table.');
        }

        $schemas = $this->native->tableSchemas($canonicalDbAppId);
        if (!isset($schemas[$table])) {
            throw new InvalidArgumentException('Table "' . $table . '" was not found in the app database.');
        }
        $tableSchema = $schemas[$table];
        $validCols = [];
        $createdAtCol = null;
        $statusCol = null;
        foreach ($tableSchema['fields'] ?? [] as $col) {
            $cn = (string) ($col['name'] ?? '');
            if ($cn === '' || NativeRecordStore::hidden($cn)) continue;
            $validCols[strtolower($cn)] = $cn;
            $l = strtolower($cn);
            if ($createdAtCol === null && preg_match('/^(?:created_?at|submitted_?at|inserted_?at)$/', $l) === 1) {
                $createdAtCol = $cn;
            }
            if ($statusCol === null && preg_match('/^(?:status|state|stage)$/', $l) === 1) {
                $statusCol = $cn;
            }
        }

        $resolvedMap = [];
        if (is_array($columnMap) && $columnMap !== []) {
            foreach ($columnMap as $fid => $col) {
                if (!is_string($fid) || !is_string($col)) continue;
                $matched = $validCols[strtolower($col)] ?? null;
                if ($matched !== null) {
                    $resolvedMap[$fid] = $matched;
                }
            }
        } else {
            // Auto-match form fields to SQLite table columns by field ID or normalized label
            foreach (is_array($form['fields'] ?? null) ? $form['fields'] : [] as $field) {
                if (!is_array($field) || empty($field['id'])) continue;
                $type = (string) ($field['type'] ?? '');
                if (in_array($type, self::LAYOUT_FIELD_TYPES, true)) continue;
                $fid = (string) $field['id'];
                $slugId = strtolower(self::sanitizeColName($fid));
                $slugLabel = strtolower(self::sanitizeColName((string) ($field['label'] ?? '')));
                if (isset($validCols[$slugId])) {
                    $resolvedMap[$fid] = $validCols[$slugId];
                } elseif (isset($validCols[$slugLabel])) {
                    $resolvedMap[$fid] = $validCols[$slugLabel];
                }
            }
        }

        if ($resolvedMap === []) {
            throw new InvalidArgumentException('None of this form\'s fields matched columns in "' . $table . '". Provide a columnMap or create a fresh management form from the table.');
        }

        $fSettings['nativeTableBinding'] = [
            'appId' => $canonicalDbAppId,
            'table' => $table,
            'primaryKey' => $tableSchema['primaryKey'] ?? ['id'],
            'columns' => $resolvedMap,
            'createdAtColumn' => $createdAtCol,
            'statusColumn' => $statusCol,
            'managedByForm' => false,
        ];
        $this->updateFormSettingsRaw($formId, $fSettings);

        return [
            'formId' => $formId,
            'databaseAppId' => $canonicalDbAppId,
            'table' => $table,
            'columns' => $resolvedMap,
        ];
    }

    /**
     * Link a Form App to share another app's SQLite database (SoftN App OR another Form App)
     * and optionally auto-create & attach Forms + Charts for selected tables so multiple different
     * Form frontends can sit on top of the exact same live SQLite database.
     *
     * @param list<string> $tables
     * @return array<string, mixed>
     */
    public function attachFormsFromDatabase(
        string $targetFormAppId,
        string $sourceDatabaseAppId,
        string $ownerId,
        array $tables = [],
        bool $includeCharts = true
    ): array {
        $targetApp = $this->requireOwnedApp($targetFormAppId, $ownerId);
        $this->requireOwnedApp($sourceDatabaseAppId, $ownerId);
        $canonicalDbAppId = $this->native->databaseAppId($sourceDatabaseAppId);
        $sourceApp = $this->requireOwnedApp($canonicalDbAppId, $ownerId);
        if (!$this->native->hasManagedDatabase($canonicalDbAppId)) {
            throw new InvalidArgumentException('The source app does not have a SQLite database yet.');
        }

        $schemas = $this->native->tableSchemas($canonicalDbAppId);
        $chosen = [];
        if ($tables === []) {
            foreach (array_keys($schemas) as $tbl) {
                if (in_array($tbl, ['business_settings', 'team_members', 'audit_log'], true)) continue;
                $chosen[] = $tbl;
            }
            $chosen = array_slice($chosen, 0, 12);
        } else {
            foreach ($tables as $tbl) {
                if (is_string($tbl) && isset($schemas[$tbl])) {
                    $chosen[] = $tbl;
                }
            }
        }

        if ($chosen !== [] && $this->plans !== null && !$this->plans->canCreateForms($ownerId, count($chosen))) {
            throw new RuntimeException(
                'You\'ve reached your plan\'s limit of ' . $this->plans->formLimit($ownerId) . ' forms. Delete a form or upgrade to add more.',
                402
            );
        }

        // Record shared-DB link on the target Form App
        $this->apps->setSharedDatabase($ownerId, $targetFormAppId, $canonicalDbAppId);
        if (!empty($sourceApp['settings']['softnApp'])) {
            $tSettings = is_array($targetApp['settings'] ?? null) ? $targetApp['settings'] : [];
            $tSettings['sharedDatabaseAppId'] = $canonicalDbAppId;
            $tSettings['linkedSoftnAppId'] = $canonicalDbAppId;
            $tSettings['unifiedSqlite'] = true;
            $this->apps->updateApp($targetFormAppId, ['settings' => $tSettings]);
        }

        $createdForms = [];
        $newReports = [];
        foreach ($chosen as $tbl) {
            $def = NativeTableFormBridge::buildFormDefinitionFromTable($canonicalDbAppId, $tbl, $schemas[$tbl]);
            $pretty = ucwords(str_replace(['_', '-'], ' ', $tbl));
            $form = $this->forms->createForm([
                'userId' => $ownerId,
                'title' => $pretty,
                'description' => 'Connected live to SQLite table "' . $tbl . '" in ' . $sourceApp['name'] . '.',
                'status' => 'published',
                'fields' => $def['fields'],
                'settings' => [
                    'nativeTableBinding' => $def['binding'],
                ],
            ]);
            $this->apps->addFormToApp($targetFormAppId, (string) $form['id'], $pretty);
            $createdForms[] = ['id' => $form['id'], 'title' => $pretty, 'table' => $tbl];

            if ($includeCharts) {
                $fid = (string) $form['id'];
                $newReports[] = [
                    'id' => 'rep_' . bin2hex(random_bytes(5)),
                    'name' => 'Total ' . $pretty,
                    'type' => 'builder',
                    'spec' => ['formId' => $fid, 'viz' => 'kpi', 'measure' => ['fn' => 'count'], 'color' => 'blue'],
                ];
                if (!empty($def['categoryFields'][0])) {
                    $cf = $def['categoryFields'][0];
                    $newReports[] = [
                        'id' => 'rep_' . bin2hex(random_bytes(5)),
                        'name' => $pretty . ' by ' . $cf['label'],
                        'type' => 'builder',
                        'spec' => [
                            'formId' => $fid,
                            'viz' => 'bar',
                            'groupBy' => ['field' => $cf['id'], 'bucket' => 'none'],
                            'measure' => ['fn' => 'count'],
                            'color' => 'violet',
                            'showDataLabels' => true,
                        ],
                    ];
                }
            }
        }

        if ($includeCharts && $newReports !== []) {
            $freshTarget = $this->apps->getApp($targetFormAppId) ?? $targetApp;
            $existingReports = is_array($freshTarget['reports'] ?? null) ? $freshTarget['reports'] : [];
            $this->apps->updateApp($targetFormAppId, ['reports' => array_merge($existingReports, $newReports)]);
        }

        return [
            'appId' => $targetFormAppId,
            'databaseAppId' => $canonicalDbAppId,
            'formsCreated' => $createdForms,
            'reportsCreated' => count($newReports),
            'database' => $this->describeAppDatabase($targetFormAppId, $ownerId),
        ];
    }

    /**
     * One-click create a SoftN Application (interactive web app OR secondary API backend)
     * connected directly to a Form App's Unified SQLite database, so both share the exact same
     * SQLite tables and backend.
     *
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public function createSoftnAppForFormDatabase(string $formAppId, string $ownerId, array $options = []): array
    {
        $formApp = $this->requireOwnedApp($formAppId, $ownerId);
        $settings = is_array($formApp['settings'] ?? null) ? $formApp['settings'] : [];
        $sharedDbAppId = is_string($settings['sharedDatabaseAppId'] ?? null) && $settings['sharedDatabaseAppId'] !== ''
            ? (string) $settings['sharedDatabaseAppId']
            : null;
        if ($sharedDbAppId !== null && $sharedDbAppId !== $formAppId) {
            $this->requireOwnedApp($sharedDbAppId, $ownerId);
        }
        $canonicalDbAppId = $sharedDbAppId ?? $formAppId;

        if (!$this->native->hasManagedDatabase($canonicalDbAppId)) {
            $this->enableForApp($formAppId, $ownerId);
        }

        $schemas = $this->native->tableSchemas($canonicalDbAppId);
        $tableCols = [];
        foreach ($schemas as $tbl => $schema) {
            $tableCols[$tbl] = array_values(array_map(static fn(array $f): string => (string) $f['name'], $schema['fields'] ?? []));
        }

        $mode = ($options['mode'] ?? 'app') === 'api' ? 'api' : 'app';
        $customName = is_string($options['name'] ?? null) ? trim($options['name']) : '';
        $newName = $customName !== ''
            ? mb_substr($customName, 0, 120)
            : ($formApp['name'] . ($mode === 'api' ? ' API Backend' : ' SoftN App'));

        $newApp = $this->apps->createApp([
            'name' => $newName,
            'description' => ($mode === 'api' ? 'Shared SQLite API backend' : 'Interactive SoftN app')
                . ' connected directly to ' . $formApp['name'] . '\'s SQLite database.',
            'settings' => [
                'softnApp' => true,
                'sharedDatabaseAppId' => $canonicalDbAppId,
            ],
        ], $ownerId);
        $newAppId = (string) $newApp['id'];

        try {
            $this->native->setSharedDatabaseLink($newAppId, $canonicalDbAppId);
            $starter = $mode === 'api'
                ? NativeAppService::sharedApiBackendStarter($newName, $newAppId, $tableCols)
                : NativeAppService::formDatabaseSoftnStarter($newName, $newAppId, $tableCols);
            $installed = $this->native->install($newAppId, $starter, 0, null, [
                'by' => $ownerId,
                'how' => 'page',
                'summary' => 'Created SoftN app connected to Form App SQLite database',
            ]);
            // Remember the linked SoftN backend on the Form App if not already set
            if (empty($settings['linkedSoftnAppId'])) {
                $settings['linkedSoftnAppId'] = $newAppId;
                $settings['unifiedSqlite'] = true;
                $this->apps->updateApp($formAppId, ['settings' => $settings]);
            }
        } catch (\Throwable $e) {
            try { $this->native->remove($newAppId); } catch (\Throwable) {}
            try { $this->apps->deleteApp($newAppId); } catch (\Throwable) {}
            throw $e;
        }

        return [
            'app' => $newApp,
            'project' => $installed,
            'databaseAppId' => $canonicalDbAppId,
            'tables' => array_keys($tableCols),
        ];
    }

    /**
     * Link or unlink a Form App's shared SQLite database pointer (without creating new forms).
     *
     * @return array<string, mixed>
     */
    public function setAppSharedDatabase(string $appId, ?string $targetAppId, string $ownerId): array
    {
        $this->requireOwnedApp($appId, $ownerId);
        $cleanTarget = is_string($targetAppId) && trim($targetAppId) !== '' ? trim($targetAppId) : null;
        if ($cleanTarget !== null) {
            $this->requireOwnedApp($cleanTarget, $ownerId);
            if (!$this->native->hasManagedDatabase($cleanTarget)) {
                throw new InvalidArgumentException('The target app does not have a SQLite database yet. Enable Unified SQLite on that Form App or install its SoftN backend first.');
            }
        }
        $this->apps->setSharedDatabase($ownerId, $appId, $cleanTarget);
        $this->native->setSharedDatabaseLink($appId, $cleanTarget);
        return $this->describeAppDatabase($appId, $ownerId);
    }

    /**
     * Automatically sync a form's SQLite table when its definition is updated (safe no-op for non-managed forms).
     */
    public function maybeSyncFormOnUpdate(string $formId): void
    {
        try {
            $form = $this->forms->getForm($formId);
            if (!$form) return;
            $fSettings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            $binding = is_array($fSettings['nativeTableBinding'] ?? null) ? $fSettings['nativeTableBinding'] : null;
            if ($binding === null || empty($binding['managedByForm']) || !is_string($binding['appId'] ?? null)) {
                return;
            }
            $formOwnerId = (string) ($form['userId'] ?? '');
            $boundApp = $this->apps->getApp((string) $binding['appId']);
            if (!$boundApp || $formOwnerId === '' || (string) ($boundApp['ownerId'] ?? '') !== $formOwnerId) {
                return;
            }
            $this->syncSingleFormSchema((string) $binding['appId'], $form, is_string($binding['table'] ?? null) ? $binding['table'] : null);
        } catch (\Throwable $e) {
            error_log('FormSqliteDatabaseService::maybeSyncFormOnUpdate: ' . $e->getMessage());
        }
    }

    /**
     * Automatically create a SQLite table when a form is added to an app with Unified SQLite enabled.
     */
    public function maybeSyncFormOnAppAttach(string $appId, string $formId, ?string $displayName = null): void
    {
        try {
            $app = $this->apps->getApp($appId);
            if (!$app) return;
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            if (empty($settings['unifiedSqlite'])) return;
            $canonicalDbAppId = is_string($settings['sharedDatabaseAppId'] ?? null) && $settings['sharedDatabaseAppId'] !== ''
                ? (string) $settings['sharedDatabaseAppId']
                : $appId;
            $appOwnerId = (string) ($app['ownerId'] ?? '');
            if ($canonicalDbAppId !== $appId) {
                $dbApp = $this->apps->getApp($canonicalDbAppId);
                if (!$dbApp || $appOwnerId === '' || (string) ($dbApp['ownerId'] ?? '') !== $appOwnerId) {
                    return;
                }
            }
            $form = $this->forms->getForm($formId);
            if (!$form || $appOwnerId === '' || (string) ($form['userId'] ?? '') !== $appOwnerId) return;
            $fSettings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            if (!empty($fSettings['nativeTableBinding']['table'])) return;
            $this->syncSingleFormSchema($canonicalDbAppId, $form, $displayName);
        } catch (\Throwable $e) {
            error_log('FormSqliteDatabaseService::maybeSyncFormOnAppAttach: ' . $e->getMessage());
        }
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /** @return array<string, mixed> */
    private function requireOwnedApp(string $appId, string $ownerId): array
    {
        $app = $this->apps->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $ownerId) {
            throw new RuntimeException('App not found', 404);
        }
        return $app;
    }

    /** @return list<array{formId: string, title: string, table: string, columnsAdded: int, rowsMigrated: int}> */
    private function syncAppFormsInternal(string $appId, string $databaseAppId, string $ownerId): array
    {
        $results = [];
        foreach ($this->apps->getAppForms($appId) as $af) {
            $fid = (string) ($af['formId'] ?? '');
            if ($fid === '') continue;
            $form = $this->forms->getForm($fid);
            if (!$form || ($form['userId'] ?? null) !== $ownerId) continue;
            $afSettings = is_array($af['settings'] ?? null) ? $af['settings'] : [];
            $preferred = is_string($afSettings['packFormId'] ?? null) && $afSettings['packFormId'] !== ''
                ? $afSettings['packFormId']
                : (is_string($af['displayName'] ?? null) && $af['displayName'] !== '' ? $af['displayName'] : (string) ($form['title'] ?? ''));
            $synced = $this->syncSingleFormSchema($databaseAppId, $form, $preferred);
            if ($synced !== null) {
                $results[] = [
                    'formId' => $fid,
                    'title' => (string) ($form['title'] ?? ''),
                    'table' => $synced['table'],
                    'columnsAdded' => $synced['columnsAdded'],
                    'rowsMigrated' => $synced['rowsMigrated'],
                ];
            }
        }
        return $results;
    }

    /**
     * @param list<array<string, mixed>> $fields
     * @return list<array{fieldId: string, colName: string, sqlType: string}>
     */
    private function extractSqlColumnsFromFields(array $fields): array
    {
        $out = [];
        foreach ($fields as $field) {
            if (!is_array($field)) continue;
            $fid = is_string($field['id'] ?? null) ? trim($field['id']) : '';
            $type = is_string($field['type'] ?? null) ? trim($field['type']) : 'short_text';
            if ($fid === '' || in_array($type, self::LAYOUT_FIELD_TYPES, true)) {
                continue;
            }
            $colName = self::sanitizeColName($fid);
            if (NativeRecordStore::hidden($colName)) {
                continue;
            }
            $sqlType = match ($type) {
                'number', 'rating', 'scale', 'slider' => 'REAL',
                default => 'TEXT',
            };
            $out[] = ['fieldId' => $fid, 'colName' => $colName, 'sqlType' => $sqlType];
        }
        return $out;
    }

    /**
     * Authoritative check against `form_encryption` (never a client-writable settings flag).
     */
    private function isFormPrivateOrEnabling(string $formId): bool
    {
        if ($formId === '') {
            return false;
        }
        $stmt = $this->mysql->prepare('SELECT mode, state FROM form_encryption WHERE form_id = :f LIMIT 1');
        $stmt->execute(['f' => $formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return false;
        }
        return ($row['mode'] ?? '') === 'private' || ($row['state'] ?? '') === 'enabling';
    }

    /** @param array<string, string> $columnMap */
    private function migrateLegacyFormResponses(string $formId, string $databaseAppId, string $tableName, array $columnMap): int
    {
        $dbPath = $this->sqlite->getFormDbPath($formId);
        if (!is_file($dbPath)) {
            return 0;
        }
        try {
            $src = $this->sqlite->getFormDatabase($formId, true);
        } catch (\Throwable) {
            return 0;
        }
        $migrated = 0;
        $batchSize = 500;
        $this->native->withDatabase($databaseAppId, static function (PDO $db) use ($src, $tableName, $columnMap, $batchSize, &$migrated): void {
            $qTable = self::quoteIdent($tableName);
            $pragma = $db->query("PRAGMA table_info({$qTable})")->fetchAll(PDO::FETCH_ASSOC);
            $colTypes = [];
            foreach ($pragma as $c) {
                $colTypes[(string) $c['name']] = strtoupper((string) ($c['type'] ?? 'TEXT'));
            }
            $lastRowId = 0;
            $fetch = $src->prepare('SELECT rowid AS _rowid, id, answers, metadata, status, submitted_at, updated_at FROM responses WHERE rowid > :last ORDER BY rowid ASC LIMIT :lim');
            while (true) {
                $fetch->bindValue(':last', $lastRowId, PDO::PARAM_INT);
                $fetch->bindValue(':lim', $batchSize, PDO::PARAM_INT);
                $fetch->execute();
                $rows = $fetch->fetchAll(PDO::FETCH_ASSOC);
                if ($rows === []) {
                    break;
                }
                $db->beginTransaction();
                try {
                    foreach ($rows as $row) {
                        $lastRowId = (int) $row['_rowid'];
                        $answers = is_string($row['answers'] ?? null) ? json_decode($row['answers'], true) : [];
                        if (!is_array($answers)) $answers = [];
                        $metadata = is_string($row['metadata'] ?? null) ? json_decode($row['metadata'], true) : [];
                        $submitterId = is_array($metadata) && is_string($metadata['submittedByUserId'] ?? null) && $metadata['submittedByUserId'] !== ''
                            ? $metadata['submittedByUserId']
                            : null;
                        $cols = [];
                        $vals = [];
                        if (isset($colTypes['id'])) {
                            $cols[] = '"id"';
                            $vals[] = (string) ($row['id'] ?? bin2hex(random_bytes(8)));
                        }
                        foreach ($columnMap as $fid => $colName) {
                            if (!array_key_exists($fid, $answers) || !isset($colTypes[$colName])) continue;
                            $v = $answers[$fid];
                            if (is_array($v)) {
                                $v = json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                            } elseif (is_bool($v)) {
                                $v = $v ? 1 : 0;
                            }
                            if ($v === '' && preg_match('/INT|REAL|FLOA|DOUB|NUMERIC/', $colTypes[$colName]) === 1) {
                                $v = null;
                            }
                            $cols[] = self::quoteIdent($colName);
                            $vals[] = $v;
                        }
                        if (isset($colTypes['status'])) {
                            $cols[] = '"status"';
                            $vals[] = (string) ($row['status'] ?? 'submitted');
                        }
                        if ($submitterId !== null) {
                            if (isset($colTypes['_submitted_by_user_id'])) {
                                $cols[] = '"_submitted_by_user_id"';
                                $vals[] = $submitterId;
                            } elseif (isset($colTypes['submitted_by_user_id'])) {
                                $cols[] = '"submitted_by_user_id"';
                                $vals[] = $submitterId;
                            }
                        }
                        if (isset($colTypes['created_at'])) {
                            $cols[] = '"created_at"';
                            $vals[] = (string) ($row['submitted_at'] ?? gmdate('Y-m-d H:i:s'));
                        }
                        if (isset($colTypes['updated_at'])) {
                            $cols[] = '"updated_at"';
                            $vals[] = (string) ($row['updated_at'] ?? ($row['submitted_at'] ?? gmdate('Y-m-d H:i:s')));
                        }
                        if ($cols === []) continue;
                        $placeholders = implode(', ', array_fill(0, count($cols), '?'));
                        $ins = $db->prepare("INSERT OR IGNORE INTO {$qTable} (" . implode(', ', $cols) . ") VALUES ({$placeholders})");
                        $ins->execute($vals);
                        $migrated += $ins->rowCount();
                    }
                    $db->commit();
                } catch (\Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    throw $e;
                }
                if (count($rows) < $batchSize) {
                    break;
                }
            }
        });
        return $migrated;
    }

    /**
     * @param list<string> $tables
     * @return array<string, int>
     */
    private function readTableCounts(string $databaseAppId, array $tables): array
    {
        if ($tables === []) return [];
        $counts = [];
        try {
            $this->native->withDatabase($databaseAppId, static function (PDO $db) use ($tables, &$counts): void {
                foreach ($tables as $t) {
                    if (preg_match('/^[A-Za-z][A-Za-z0-9_]{0,62}$/D', $t) !== 1) continue;
                    $counts[$t] = (int) $db->query('SELECT COUNT(*) FROM ' . self::quoteIdent($t))->fetchColumn();
                }
            });
        } catch (\Throwable) {
            return $counts;
        }
        return $counts;
    }

    /** @param array<string, mixed> $settings */
    private function updateFormSettingsRaw(string $formId, array $settings): void
    {
        $stmt = $this->mysql->prepare('UPDATE forms SET settings = :settings, updated_at = NOW() WHERE id = :id');
        $stmt->execute([
            'settings' => json_encode($settings, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            'id' => $formId,
        ]);
    }

    public static function sanitizeTableName(string $raw): string
    {
        $s = strtolower(trim($raw));
        $s = (string) preg_replace('/[^a-z0-9]+/', '_', $s);
        $s = trim($s, '_');
        if ($s === '' || !preg_match('/^[a-z]/', $s)) {
            $s = 'tbl_' . ($s !== '' ? $s : 'records');
        }
        if (str_starts_with($s, 'sqlite_')) {
            $s = 'form_' . $s;
        }
        return substr($s, 0, 56);
    }

    public static function sanitizeColName(string $raw): string
    {
        $s = strtolower(trim($raw));
        $s = (string) preg_replace('/[^a-z0-9]+/', '_', $s);
        $s = trim($s, '_');
        if ($s === '' || !preg_match('/^[a-z]/', $s)) {
            $s = 'field_' . ($s !== '' ? $s : 'val');
        }
        if (in_array($s, ['id', 'rowid', 'status', 'created_at', 'updated_at'], true)) {
            $s = 'f_' . $s;
        }
        return substr($s, 0, 56);
    }

    /** @param array<string, bool> $used */
    private static function uniqueColName(string $base, array $used): string
    {
        $candidate = $base;
        $i = 2;
        while (isset($used[$candidate])) {
            $candidate = substr($base, 0, 52) . '_' . $i;
            $i++;
        }
        return $candidate;
    }

    private static function quoteIdent(string $name): string
    {
        return '"' . str_replace('"', '""', $name) . '"';
    }
}
