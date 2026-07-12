<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Owner data exports for a custom app ("your data is yours"):
 *
 *  - SQLite bundle (zip): a consistent snapshot of every member form's per-form
 *    SQLite database (wal_checkpoint + copy), the uploaded files, and a
 *    schema.json describing the app + each form's fields — everything needed
 *    to read the data outside FormLogic.
 *  - SQL dump (.sql, MySQL or SQL Server dialect): each form becomes a TABLE
 *    (one column per field + status/tags/metadata/submitted_at/updated_at,
 *    plus script-computed values), each response becomes a ROW — a plain
 *    relational conversion of the per-form SQLite databases so the data can
 *    be loaded straight into a custom system.
 *
 * Ownership is the CONTROLLER's concern (authorizeAppOwnership) — these
 * methods trust the $app row they're handed.
 */
class AppDataExportService
{
    private const ROW_BATCH = 500;
    /** Rows per multi-row INSERT (SQL Server caps row constructors at 1000). */
    private const INSERT_BATCH = 250;
    /** Reserved column names every table carries — field columns are deduped against them. */
    private const META_COLUMNS = ['id', 'status', 'tags', 'metadata', 'submitted_at', 'updated_at'];

    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private FormService $forms;
    private AppService $apps;
    private string $uploadsPath;
    private LoggerInterface $logger;

    public function __construct(
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        FormService $forms,
        AppService $apps,
        string $uploadsPath = '',
        ?LoggerInterface $logger = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->forms = $forms;
        $this->apps = $apps;
        $this->uploadsPath = rtrim($uploadsPath !== '' ? $uploadsPath : __DIR__ . '/../../storage/uploads', '/\\');
        $this->logger = $logger ?? new NullLogger();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared: the app's forms with fields + stable export table names
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The app's member forms (with fields), each assigned a unique, SQL-friendly
     * export table name derived from its display name.
     *
     * @return array<int, array{form: array, table: string, displayName: string}>
     */
    private function exportForms(array $app): array
    {
        $members = $this->apps->getAppForms((string) $app['id']);
        $ids = array_values(array_unique(array_map(static fn ($m) => (string) $m['formId'], $members)));
        $byId = $this->forms->getFormsByIds($ids);
        $used = [];
        $out = [];
        foreach ($members as $m) {
            $form = $byId[(string) $m['formId']] ?? null;
            if (!$form) {
                continue;
            }
            $display = trim((string) ($m['displayName'] ?? '')) ?: (string) ($form['title'] ?? 'Form');
            $out[] = [
                'form' => $form,
                'table' => $this->uniqueName($this->sqlName($display, 'form'), $used, 55),
                'displayName' => $display,
            ];
        }
        return $out;
    }

    /** Lowercase snake-case identifier from arbitrary text; never empty. */
    private function sqlName(string $raw, string $fallback): string
    {
        $s = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '_', $raw) ?? '', '_'));
        if ($s === '') {
            $s = $fallback;
        }
        if (preg_match('/^[0-9]/', $s) === 1) {
            $s = 'f_' . $s;
        }
        return substr($s, 0, 60);
    }

    /** @param array<string, true> $used */
    private function uniqueName(string $base, array &$used, int $maxLen = 60): string
    {
        $name = substr($base, 0, $maxLen);
        $n = 2;
        while (isset($used[$name])) {
            $suffix = '_' . $n++;
            $name = substr($base, 0, $maxLen - strlen($suffix)) . $suffix;
        }
        $used[$name] = true;
        return $name;
    }

    /** Distinct script-computed field names present in a form's data. @return string[] */
    private function computedNames(PDO $db): array
    {
        try {
            return array_map('strval', $db->query('SELECT DISTINCT field_name FROM computed ORDER BY field_name')->fetchAll(PDO::FETCH_COLUMN));
        } catch (\Throwable $e) {
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SQLite bundle
    // ─────────────────────────────────────────────────────────────────────────

    /** Export the app's data as a zip of SQLite snapshots + schema.json (+ uploads). Returns the zip path. */
    public function exportSqliteBundle(array $app): string
    {
        $exportForms = $this->exportForms($app);
        $tmpBase = $this->tmpDir();
        $staging = $tmpBase . '/app-data-' . bin2hex(random_bytes(6));
        if (!mkdir($staging, 0700, true)) {
            throw new \RuntimeException('Could not create export staging directory');
        }
        $zipPath = $tmpBase . '/app-data-' . bin2hex(random_bytes(6)) . '.zip';

        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException('Could not create the export archive');
        }

        try {
            $schemaForms = [];
            foreach ($exportForms as $ef) {
                $form = $ef['form'];
                $formId = (string) $form['id'];
                $entry = [
                    'formId' => $formId,
                    'name' => $ef['displayName'],
                    'title' => $form['title'] ?? '',
                    'description' => $form['description'] ?? '',
                    'sqliteFile' => null,
                    'responseCount' => 0,
                    'fields' => array_map(static fn ($f) => [
                        'id' => $f['id'] ?? '',
                        'type' => $f['type'] ?? '',
                        'label' => $f['label'] ?? '',
                        'required' => (bool) ($f['required'] ?? false),
                        'options' => $f['properties']['options'] ?? null,
                    ], $form['fields'] ?? []),
                ];

                if ($this->sqlite->formDatabaseExists($formId)) {
                    // Consistent snapshot: checkpoint the WAL, then copy the main file
                    // (same recipe as account backups — a live copy without the
                    // checkpoint could miss recent writes still in the -wal).
                    try {
                        $this->sqlite->getFormDatabase($formId)->exec('PRAGMA wal_checkpoint(FULL)');
                    } catch (\Throwable $e) {
                        $this->logger->warning('App data export: WAL checkpoint failed (continuing)', [
                            'formId' => $formId, 'error' => $e->getMessage(),
                        ]);
                    }
                    $staged = $staging . '/' . $ef['table'] . '.sqlite';
                    if (!copy($this->sqlite->getFormDbPath($formId), $staged)) {
                        throw new \RuntimeException("Could not snapshot the database for \"{$ef['displayName']}\"");
                    }
                    try {
                        $entry['responseCount'] = (int) (new PDO('sqlite:' . $staged))->query('SELECT COUNT(*) FROM responses')->fetchColumn();
                    } catch (\Throwable $e) {
                        // informational only
                    }
                    $entry['sqliteFile'] = 'data/' . $ef['table'] . '.sqlite';
                    $zip->addFile($staged, $entry['sqliteFile']);

                    // Uploaded files referenced by this form's answers.
                    $dir = $this->uploadsPath . '/' . preg_replace('/[^a-zA-Z0-9\-]/', '', $formId);
                    if (is_dir($dir)) {
                        foreach (scandir($dir) ?: [] as $name) {
                            if ($name === '.' || $name === '..' || $name === '.pending') {
                                continue;
                            }
                            $abs = $dir . '/' . $name;
                            if (is_file($abs) && !is_link($abs) && is_file($dir . '/.pending/' . $name) === false) {
                                $zip->addFile($abs, 'files/' . $ef['table'] . '/' . $name);
                            }
                        }
                    }
                }
                $schemaForms[] = $entry;
            }

            $schema = [
                'kind' => 'formlogic.appDataExport',
                'formatVersion' => 1,
                'exportedAt' => gmdate('c'),
                'app' => [
                    'id' => $app['id'] ?? '',
                    'name' => $app['name'] ?? '',
                    'slug' => $app['slug'] ?? '',
                    'description' => $app['description'] ?? '',
                ],
                'forms' => $schemaForms,
            ];
            $zip->addFromString('schema.json', json_encode($schema, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) ?: '{}');
            $zip->addFromString('README.txt', $this->bundleReadme());

            if (!$zip->close()) {
                throw new \RuntimeException('Could not finalize the export archive');
            }
            return $zipPath;
        } catch (\Throwable $e) {
            @$zip->close();
            @unlink($zipPath);
            throw $e;
        } finally {
            $this->removeDir($staging);
        }
    }

    private function bundleReadme(): string
    {
        return <<<TXT
FormLogic app data export
=========================

data/<form>.sqlite   One SQLite database per form. Open with any SQLite client.
                     Tables: responses (id, answers JSON keyed by field id,
                     metadata JSON, status, submitted_at, updated_at — times in
                     UTC), computed (script-set values), tags, fields (the form
                     structure), script_logs.
files/<form>/        Uploaded files. A file_upload answer inside responses.answers
                     references them by storedFilename.
schema.json          The app + every form's field definitions (id, type, label,
                     options) — the key for reading responses.answers.

Prefer plain SQL? The same export is available as a MySQL or SQL Server dump
(forms as tables, records as rows) from the app's Records page.
TXT;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SQL dumps (MySQL / SQL Server)
    // ─────────────────────────────────────────────────────────────────────────

    /** Export the app's data as a relational SQL dump. Returns the .sql file path. */
    public function exportSqlDump(array $app, string $dialect): string
    {
        $path = $this->tmpDir() . '/app-data-' . bin2hex(random_bytes(6)) . '.sql';
        $fh = fopen($path, 'wb');
        if ($fh === false) {
            throw new \RuntimeException('Could not create the export file');
        }
        try {
            $this->generateSqlDump($app, $dialect, static function (string $text, bool $isStatement) use ($fh): void {
                fwrite($fh, $isStatement ? $text . ";\n\n" : $text . "\n");
            });
            fclose($fh);
            return $path;
        } catch (\Throwable $e) {
            @fclose($fh);
            @unlink($path);
            throw $e;
        }
    }

    /**
     * Generate the dump through $sink(text, isStatement): statements arrive
     * WITHOUT a terminator (the file writer adds ";"); comments/blank lines
     * arrive with isStatement=false. Split out so tests can execute each
     * statement against a real server.
     */
    public function generateSqlDump(array $app, string $dialect, callable $sink): void
    {
        if (!in_array($dialect, ['mysql', 'mssql'], true)) {
            throw new \InvalidArgumentException('Unknown SQL dialect');
        }
        $exportForms = $this->exportForms($app);

        $sink('-- FormLogic app data export — ' . ($dialect === 'mysql' ? 'MySQL' : 'SQL Server') . ' dialect', false);
        $sink('-- App: ' . str_replace(["\r", "\n"], ' ', (string) ($app['name'] ?? '')) . ' (' . ($app['slug'] ?? '') . ')', false);
        $sink('-- Exported (UTC): ' . gmdate('Y-m-d H:i:s'), false);
        $sink('-- One table per form; one row per record. submitted_at / updated_at are UTC.', false);
        $sink('-- Zone-less datetime answers are the wall-clock time the respondent picked.', false);
        $sink('-- Multi-value answers (checkboxes, files, locations, links) are JSON text.', false);
        $sink('', false);
        if ($dialect === 'mysql') {
            $sink('SET NAMES utf8mb4', true);
            $sink('SET FOREIGN_KEY_CHECKS = 0', true);
            $sink('', false);
        }

        foreach ($exportForms as $ef) {
            $this->dumpFormTable($ef, $dialect, $sink);
        }

        if ($dialect === 'mysql') {
            $sink('SET FOREIGN_KEY_CHECKS = 1', true);
        }
    }

    /** @param array{form: array, table: string, displayName: string} $ef */
    private function dumpFormTable(array $ef, string $dialect, callable $sink): void
    {
        $form = $ef['form'];
        $formId = (string) $form['id'];
        $table = $ef['table'];
        $q = fn (string $ident): string => $dialect === 'mysql' ? "`{$ident}`" : "[{$ident}]";

        $db = $this->sqlite->formDatabaseExists($formId) ? $this->sqlite->getFormDatabase($formId) : null;

        // Columns: field columns first (deduped against the reserved meta names),
        // then script-computed columns, then the meta columns.
        $used = [];
        foreach (self::META_COLUMNS as $m) {
            $used[$m] = true;
        }
        $fieldCols = [];
        foreach ($form['fields'] ?? [] as $f) {
            $type = (string) ($f['type'] ?? '');
            // Display-only pseudo fields hold no data.
            if (in_array($type, ['statement', 'welcome_screen', 'thank_you'], true)) {
                continue;
            }
            $fieldCols[] = [
                'column' => $this->uniqueName($this->sqlName((string) ($f['id'] ?? ''), 'field'), $used),
                'fieldId' => (string) ($f['id'] ?? ''),
                'type' => $type,
                'label' => (string) ($f['label'] ?? ''),
            ];
        }
        $computedCols = [];
        foreach ($db ? $this->computedNames($db) : [] as $name) {
            $computedCols[] = [
                'column' => $this->uniqueName($this->sqlName('computed_' . $name, 'computed'), $used),
                'name' => $name,
            ];
        }

        $sink('-- ' . str_replace(["\r", "\n"], ' ', $ef['displayName']) . " ({$formId})", false);
        if ($dialect === 'mysql') {
            $sink("DROP TABLE IF EXISTS {$q($table)}", true);
        } else {
            $sink("IF OBJECT_ID(N'dbo.{$table}', N'U') IS NOT NULL DROP TABLE [dbo].[{$table}]", true);
        }

        $lines = [];
        $lines[] = "  {$q('id')} " . ($dialect === 'mysql' ? 'VARCHAR(36)' : 'NVARCHAR(36)') . ' NOT NULL PRIMARY KEY';
        $lines[] = "  {$q('status')} " . ($dialect === 'mysql' ? 'VARCHAR(32)' : 'NVARCHAR(32)') . ' NULL';
        foreach ($fieldCols as $c) {
            $comment = $dialect === 'mysql'
                ? ' COMMENT ' . $this->mysqlString($c['label'] !== '' ? $c['label'] : $c['fieldId'])
                : '';
            $lines[] = "  {$q($c['column'])} {$this->columnType($c['type'], $dialect)} NULL{$comment}";
        }
        foreach ($computedCols as $c) {
            $comment = $dialect === 'mysql' ? ' COMMENT ' . $this->mysqlString('script-computed: ' . $c['name']) : '';
            $lines[] = "  {$q($c['column'])} {$this->textType($dialect)} NULL{$comment}";
        }
        $lines[] = "  {$q('tags')} {$this->textType($dialect)} NULL";
        $lines[] = "  {$q('metadata')} {$this->textType($dialect)} NULL";
        $lines[] = "  {$q('submitted_at')} " . ($dialect === 'mysql' ? 'DATETIME' : 'DATETIME2') . ' NULL';
        $lines[] = "  {$q('updated_at')} " . ($dialect === 'mysql' ? 'DATETIME' : 'DATETIME2') . ' NULL';

        $create = "CREATE TABLE " . ($dialect === 'mysql' ? $q($table) : "[dbo].[{$table}]") . " (\n" . implode(",\n", $lines) . "\n)"
            . ($dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '');
        $sink($create, true);

        if ($db === null) {
            $sink('', false);
            return;
        }

        $columnList = array_merge(
            [$q('id'), $q('status')],
            array_map(static fn ($c) => $q($c['column']), $fieldCols),
            array_map(static fn ($c) => $q($c['column']), $computedCols),
            [$q('tags'), $q('metadata'), $q('submitted_at'), $q('updated_at')]
        );
        $insertHead = 'INSERT INTO ' . ($dialect === 'mysql' ? $q($table) : "[dbo].[{$table}]")
            . ' (' . implode(', ', $columnList) . ") VALUES\n";

        $offset = 0;
        $rowsBuffer = [];
        while (true) {
            $stmt = $db->prepare('SELECT id, answers, metadata, status, submitted_at, updated_at FROM responses ORDER BY rowid LIMIT :lim OFFSET :off');
            $stmt->bindValue('lim', self::ROW_BATCH, PDO::PARAM_INT);
            $stmt->bindValue('off', $offset, PDO::PARAM_INT);
            $stmt->execute();
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            if ($rows === []) {
                break;
            }
            $offset += count($rows);

            [$computedByResponse, $tagsByResponse] = $this->childRows($db, array_column($rows, 'id'));

            foreach ($rows as $row) {
                $answers = json_decode((string) $row['answers'], true);
                $answers = is_array($answers) ? $answers : [];
                $vals = [
                    $this->stringLiteral((string) $row['id'], $dialect),
                    $this->stringLiteral((string) ($row['status'] ?? 'submitted'), $dialect),
                ];
                foreach ($fieldCols as $c) {
                    $vals[] = $this->sqlValue($answers[$c['fieldId']] ?? null, $c['type'], $dialect);
                }
                foreach ($computedCols as $c) {
                    $vals[] = $this->sqlValue($computedByResponse[$row['id']][$c['name']] ?? null, 'computed', $dialect);
                }
                $tags = $tagsByResponse[$row['id']] ?? [];
                $vals[] = $tags === [] ? 'NULL' : $this->stringLiteral(json_encode($tags) ?: '[]', $dialect);
                $meta = (string) ($row['metadata'] ?? '');
                $vals[] = ($meta === '' || $meta === 'null') ? 'NULL' : $this->stringLiteral($meta, $dialect);
                $vals[] = $this->datetimeLiteral((string) ($row['submitted_at'] ?? ''), $dialect);
                $vals[] = $this->datetimeLiteral((string) ($row['updated_at'] ?? ''), $dialect);

                $rowsBuffer[] = '(' . implode(', ', $vals) . ')';
                if (count($rowsBuffer) >= self::INSERT_BATCH) {
                    $sink($insertHead . implode(",\n", $rowsBuffer), true);
                    $rowsBuffer = [];
                }
            }
        }
        if ($rowsBuffer !== []) {
            $sink($insertHead . implode(",\n", $rowsBuffer), true);
        }
        $sink('', false);
    }

    /**
     * Batch-load computed values + tags for a set of response ids.
     *
     * @param string[] $ids
     * @return array{0: array<string, array<string, mixed>>, 1: array<string, string[]>}
     */
    private function childRows(PDO $db, array $ids): array
    {
        $computed = [];
        $tags = [];
        if ($ids === []) {
            return [$computed, $tags];
        }
        $ph = implode(',', array_fill(0, count($ids), '?'));
        try {
            $stmt = $db->prepare("SELECT response_id, field_name, field_value FROM computed WHERE response_id IN ($ph)");
            $stmt->execute($ids);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $decoded = json_decode((string) $r['field_value'], true);
                $computed[(string) $r['response_id']][(string) $r['field_name']] = $decoded ?? $r['field_value'];
            }
        } catch (\Throwable $e) {
            // computed table may not exist on very old form DBs
        }
        try {
            $stmt = $db->prepare("SELECT response_id, tag FROM tags WHERE response_id IN ($ph) ORDER BY id");
            $stmt->execute($ids);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $tags[(string) $r['response_id']][] = (string) $r['tag'];
            }
        } catch (\Throwable $e) {
            // ditto
        }
        return [$computed, $tags];
    }

    private function textType(string $dialect): string
    {
        return $dialect === 'mysql' ? 'LONGTEXT' : 'NVARCHAR(MAX)';
    }

    /** SQL column type for a field type. Freeform text stays TEXT so no value can overflow the column. */
    private function columnType(string $fieldType, string $dialect): string
    {
        switch ($fieldType) {
            case 'number':
            case 'rating':
            case 'scale':
                return $dialect === 'mysql' ? 'DOUBLE' : 'FLOAT';
            case 'date':
                return 'DATE';
            case 'time':
                return 'TIME';
            case 'datetime':
                return $dialect === 'mysql' ? 'DATETIME' : 'DATETIME2';
            default:
                return $this->textType($dialect);
        }
    }

    /** Render one answer as a SQL literal for its column type (unparseable → NULL for typed columns). */
    private function sqlValue(mixed $v, string $fieldType, string $dialect): string
    {
        if ($v === null || $v === '' || (is_array($v) && $v === [])) {
            return 'NULL';
        }
        switch ($fieldType) {
            case 'number':
            case 'rating':
            case 'scale':
                return is_numeric($v) ? (string) (float) $v : 'NULL';
            case 'date':
                return (is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}/', $v) === 1)
                    ? $this->stringLiteral(substr($v, 0, 10), $dialect)
                    : 'NULL';
            case 'time':
                if (is_string($v) && preg_match('/^(\d{2}:\d{2})(:\d{2})?$/', trim($v), $m) === 1) {
                    return $this->stringLiteral($m[1] . ($m[2] ?? ':00'), $dialect);
                }
                return 'NULL';
            case 'datetime':
                return $this->datetimeLiteral(is_string($v) ? $v : '', $dialect);
            default:
                if (is_bool($v)) {
                    return $this->stringLiteral($v ? 'true' : 'false', $dialect);
                }
                if (is_array($v) || is_object($v)) {
                    return $this->stringLiteral(json_encode($v, JSON_UNESCAPED_SLASHES) ?: 'null', $dialect);
                }
                return $this->stringLiteral((string) $v, $dialect);
        }
    }

    /**
     * A DATETIME literal from the stored value. Offset-less values ("Y-m-d H:i:s"
     * server timestamps, "Y-m-dTH:i" datetime-local answers) pass through as the
     * wall clock they are; full ISO instants are converted to UTC.
     */
    private function datetimeLiteral(string $v, string $dialect): string
    {
        $v = trim($v);
        if ($v === '') {
            return 'NULL';
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/', $v, $m) === 1) {
            return $this->stringLiteral($m[1] . ' ' . $m[2] . ($m[3] ?? ':00'), $dialect);
        }
        if (preg_match('/[Zz]$|[+-]\d{2}:?\d{2}$/', $v) === 1) {
            try {
                $d = new \DateTimeImmutable($v);
                return $this->stringLiteral($d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s'), $dialect);
            } catch (\Throwable $e) {
                return 'NULL';
            }
        }
        return 'NULL';
    }

    private function stringLiteral(string $s, string $dialect): string
    {
        return $dialect === 'mysql' ? $this->mysqlString($s) : $this->mssqlString($s);
    }

    private function mysqlString(string $s): string
    {
        return "'" . str_replace(
            ['\\', "'", "\r", "\n", "\0", "\x1a"],
            ['\\\\', "\\'", '\\r', '\\n', '\\0', '\\Z'],
            $s
        ) . "'";
    }

    private function mssqlString(string $s): string
    {
        // N'…' (unicode); the only escape is doubling quotes. NULs can't live in
        // a T-SQL literal — strip them.
        return "N'" . str_replace("'", "''", str_replace("\0", '', $s)) . "'";
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Temp-file plumbing (mirrors AccountBackupService)
    // ─────────────────────────────────────────────────────────────────────────

    private function tmpDir(): string
    {
        $dir = sys_get_temp_dir() . '/formlogic-app-exports';
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException('Could not create the export temp directory');
        }
        // Opportunistic sweep of leftovers older than 2h (crashed/abandoned exports).
        foreach (glob($dir . '/app-data-*') ?: [] as $old) {
            if (is_file($old) && filemtime($old) < time() - 7200) {
                @unlink($old);
            }
        }
        return $dir;
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $f) {
            if ($f !== '.' && $f !== '..') {
                $p = $dir . '/' . $f;
                is_dir($p) ? $this->removeDir($p) : @unlink($p);
            }
        }
        @rmdir($dir);
    }
}
