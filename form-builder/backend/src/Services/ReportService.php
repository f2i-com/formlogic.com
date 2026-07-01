<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SQLiteConnection;
use PDO;

/**
 * Runs a no-code report spec against a form's response SQLite database — optionally JOINing related
 * forms through their linked_record relationships — and returns a normalised result (table rows /
 * chart series / a single KPI value).
 *
 * SAFE BY CONSTRUCTION — there is NO user SQL:
 *  - field ids are validated against the form definitions (base + each joined form),
 *  - joins are only allowed along a real linked_record relationship (validated by the caller),
 *  - operators / aggregate functions / date buckets / join types are whitelisted,
 *  - every value is bound as a parameter; the only interpolated identifiers are validated field ids
 *    (quotes/backslashes stripped) and internal alias names,
 *  - results are row-capped, and attached databases are DETACHed afterwards.
 *
 * A field is referenced by id for the base form, or "<joinFormId>::<fieldId>" for a joined form.
 * Joins are cross-file, so each joined form's SQLite is ATTACHed and joined on
 * `<joinAlias>.id = json_extract(r.answers, '$.<viaField>')`.
 */
class ReportService
{
    private const OPS = ['eq' => '=', 'ne' => '!=', 'gt' => '>', 'lt' => '<', 'gte' => '>=', 'lte' => '<='];
    private const AGGS = ['count', 'sum', 'avg', 'min', 'max'];
    private const BUCKETS = ['none', 'day', 'month', 'year'];
    private const VIZ = ['table', 'bar', 'pie', 'kpi'];
    private const SKIP_TYPES = ['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload'];

    public function __construct(private SQLiteConnection $sqlite) {}

    /**
     * @param array  $spec   { viz, filters, groupBy, measure, columns, joins?, sort?, limit? }
     * @param array  $fields the base form's field definitions
     * @param array  $joins  resolved + authorised joins: [{ formId, via, type:'inner'|'left', fields, path }]
     */
    public function runReport(array $spec, array $fields, string $formId, string $scope, ?string $userId, array $joins = []): array
    {
        $viz = in_array($spec['viz'] ?? 'table', self::VIZ, true) ? (string) $spec['viz'] : 'table';

        if (!$this->sqlite->formDatabaseExists($formId)) {
            return ['viz' => $viz, 'columns' => [], 'rows' => [], 'series' => [], 'value' => 0];
        }
        $db = $this->sqlite->getFormDatabase($formId);

        $safe = static fn (string $k): string => str_replace(['"', '\\'], '', $k);

        // ── ATTACH joined databases ──
        $joinDefs = []; // joinFormId => ['alias','via','type','fieldById']
        $attached = [];
        $ai = 0;
        foreach ($joins as $j) {
            $path = (string) ($j['path'] ?? '');
            if ($path === '' || !is_file($path)) { continue; }
            $alias = 'j' . $ai++;
            try {
                $db->exec("ATTACH DATABASE '" . str_replace("'", "''", $path) . "' AS $alias");
            } catch (\Throwable $e) {
                continue;
            }
            $attached[] = $alias;
            $fb = [];
            foreach (($j['fields'] ?? []) as $f) {
                if (!empty($f['id'])) { $fb[$f['id']] = $f; }
            }
            $joinDefs[(string) $j['formId']] = [
                'alias' => $alias,
                'via' => $safe((string) ($j['via'] ?? '')),
                'type' => (($j['type'] ?? 'left') === 'inner') ? 'INNER' : 'LEFT',
                'fieldById' => $fb,
            ];
        }

        try {
            $baseFieldById = [];
            foreach ($fields as $f) {
                if (!empty($f['id'])) { $baseFieldById[$f['id']] = $f; }
            }

            // Resolve a field ref → SQL expression, or null if invalid.
            $refExpr = static function (string $ref) use ($baseFieldById, $joinDefs, $safe): ?string {
                if (str_contains($ref, '::')) {
                    [$jf, $fid] = explode('::', $ref, 2);
                    $jd = $joinDefs[$jf] ?? null;
                    if (!$jd || !isset($jd['fieldById'][$fid])) { return null; }
                    return "json_extract({$jd['alias']}.answers, '$.\"" . $safe($fid) . "\"')";
                }
                if (!isset($baseFieldById[$ref])) { return null; }
                return "json_extract(r.answers, '$.\"" . $safe($ref) . "\"')";
            };
            // Resolve a field ref → its field definition (for option labels / display).
            $refField = static function (string $ref) use ($baseFieldById, $joinDefs): ?array {
                if (str_contains($ref, '::')) {
                    [$jf, $fid] = explode('::', $ref, 2);
                    return $joinDefs[$jf]['fieldById'][$fid] ?? null;
                }
                return $baseFieldById[$ref] ?? null;
            };

            // ── FROM + JOINs ──
            $from = 'responses r';
            foreach ($joinDefs as $jd) {
                $from .= " {$jd['type']} JOIN {$jd['alias']}.responses {$jd['alias']} ON {$jd['alias']}.id = json_extract(r.answers, '$.\"{$jd['via']}\"')";
            }

            // ── WHERE (base status + scope + validated filters) ──
            $where = ["r.status = 'submitted'"];
            $params = [];
            if ($scope === 'own' && $userId) {
                $where[] = "json_extract(r.metadata, '$.submittedByUserId') = :uid";
                $params[':uid'] = $userId;
            }
            $pi = 0;
            foreach ($spec['filters'] ?? [] as $flt) {
                $expr = $refExpr((string) ($flt['field'] ?? ''));
                if ($expr === null) { continue; }
                $op = (string) ($flt['op'] ?? 'eq');
                if ($op === 'empty') { $where[] = "($expr IS NULL OR $expr = '')"; continue; }
                if ($op === 'notempty') { $where[] = "($expr IS NOT NULL AND $expr != '')"; continue; }
                if ($op === 'contains') {
                    $p = ':p' . $pi++;
                    $where[] = "$expr LIKE $p ESCAPE '!'";
                    $params[$p] = '%' . strtr((string) ($flt['value'] ?? ''), ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
                    continue;
                }
                if (isset(self::OPS[$op])) {
                    $p = ':p' . $pi++;
                    $where[] = "$expr " . self::OPS[$op] . " $p";
                    $params[$p] = (string) ($flt['value'] ?? '');
                }
            }
            $whereSql = implode(' AND ', $where);
            $limit = max(1, min((int) ($spec['limit'] ?? 100), 1000));

            $aggExpr = function (array $measure) use ($refExpr): string {
                $fn = in_array($measure['fn'] ?? 'count', self::AGGS, true) ? (string) $measure['fn'] : 'count';
                if ($fn === 'count') { return 'COUNT(*)'; }
                $mexpr = $refExpr((string) ($measure['field'] ?? ''));
                if ($mexpr === null) { return 'COUNT(*)'; }
                return strtoupper($fn) . "(CAST($mexpr AS REAL))";
            };

            // ── KPI ──
            if ($viz === 'kpi') {
                $stmt = $db->prepare("SELECT " . $aggExpr($spec['measure'] ?? ['fn' => 'count']) . " AS val FROM $from WHERE $whereSql");
                $stmt->execute($params);
                return ['viz' => 'kpi', 'value' => (float) ($stmt->fetchColumn() ?: 0)];
            }

            // ── bar / pie ──
            if (($viz === 'bar' || $viz === 'pie') && !empty($spec['groupBy']['field'])) {
                $gref = (string) $spec['groupBy']['field'];
                $gcol = $refExpr($gref);
                if ($gcol === null) { return ['viz' => $viz, 'series' => []]; }
                $bucket = (string) ($spec['groupBy']['bucket'] ?? 'none');
                if (!in_array($bucket, self::BUCKETS, true)) { $bucket = 'none'; }
                $grp = match ($bucket) {
                    'month' => "strftime('%Y-%m', $gcol)",
                    'year'  => "strftime('%Y', $gcol)",
                    'day'   => "date($gcol)",
                    default => $gcol,
                };
                $order = (($spec['sort'] ?? 'desc') === 'asc') ? 'ASC' : 'DESC';
                $stmt = $db->prepare("SELECT $grp AS k, " . $aggExpr($spec['measure'] ?? ['fn' => 'count']) . " AS v FROM $from WHERE $whereSql GROUP BY k ORDER BY v $order LIMIT :lim");
                foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
                $stmt->bindValue(':lim', min($limit, 50), PDO::PARAM_INT);
                $stmt->execute();
                $gfield = $refField($gref);
                $series = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $rrow) {
                    $key = ($rrow['k'] === null || $rrow['k'] === '') ? '—' : $this->optLabel($gfield, (string) $rrow['k']);
                    $series[] = ['label' => $key, 'value' => (float) $rrow['v']];
                }
                return ['viz' => $viz, 'series' => $series];
            }

            // ── table ──
            $refs = array_values(array_filter((array) ($spec['columns'] ?? []), fn ($ref) => $refExpr((string) $ref) !== null));
            if (empty($refs)) {
                foreach ($fields as $f) {
                    if (count($refs) >= 5) { break; }
                    if (!in_array($f['type'] ?? '', self::SKIP_TYPES, true)) { $refs[] = $f['id']; }
                }
            }
            $selects = [];
            $columns = [];
            foreach ($refs as $i => $ref) {
                $selects[] = $refExpr((string) $ref) . " AS c$i";
                $fdef = $refField((string) $ref);
                $columns[] = ['id' => "c$i", 'label' => $fdef['label'] ?? (string) $ref];
            }
            $selectSql = empty($selects) ? 'r.id AS c0' : implode(', ', $selects);
            $stmt = $db->prepare("SELECT $selectSql, r.submitted_at AS _sa FROM $from WHERE $whereSql ORDER BY r.submitted_at DESC LIMIT :lim");
            foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
            $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
            $stmt->execute();
            $rows = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $rrow) {
                $row = [];
                foreach ($refs as $i => $ref) {
                    $row["c$i"] = $this->displayValue($refField((string) $ref), $rrow["c$i"] ?? null);
                }
                $rows[] = $row;
            }
            return ['viz' => 'table', 'columns' => $columns, 'rows' => $rows];
        } finally {
            foreach ($attached as $alias) {
                try { $db->exec("DETACH DATABASE $alias"); } catch (\Throwable $e) { /* connection closes at request end anyway */ }
            }
        }
    }

    /** Map a stored value to its option label (choice fields) or the value itself. */
    private function optLabel(?array $field, string $val): string
    {
        foreach ($field['properties']['options'] ?? [] as $o) {
            if (is_array($o) && ($o['value'] ?? null) === $val) { return (string) ($o['label'] ?? $val); }
        }
        return $val;
    }

    private function displayValue(?array $field, mixed $val): string
    {
        if ($val === null) { return ''; }
        // json_extract returns a JSON array string for array answers; decode for display.
        if (is_string($val) && str_starts_with($val, '[')) {
            $decoded = json_decode($val, true);
            if (is_array($decoded)) {
                return implode(', ', array_map(fn ($v) => $this->optLabel($field, (string) $v), $decoded));
            }
        }
        return $this->optLabel($field, (string) $val);
    }
}
