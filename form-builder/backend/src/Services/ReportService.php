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
 *  - field ids are whitelisted (`[A-Za-z0-9_]`) and validated against the form definitions; a ref whose
 *    sanitised form differs is rejected,
 *  - joins are only allowed along a real linked_record relationship (validated by the caller), and joined
 *    rows are status-filtered AND permission-scoped in the ON clause (a view-own caller only sees theirs),
 *  - operators / aggregates / date-buckets / relative-date ops / join types are whitelisted,
 *  - every value is bound as a parameter; comparisons are type-aware (numeric CAST, date normalisation),
 *  - results are row-capped and attached databases are DETACHed afterwards.
 *
 * Field refs: "<fieldId>" (base), "<joinFormId>::<fieldId>" (joined), or the pseudo-fields
 * "__submitted_at" (submission time) and "__status" (workflow status).
 */
class ReportService
{
    private const OPS = ['eq' => '=', 'ne' => '!=', 'gt' => '>', 'lt' => '<', 'gte' => '>=', 'lte' => '<='];
    private const DATE_OPS = ['last_n_days', 'this_month', 'this_year', 'today'];
    private const AGGS = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'];
    private const BUCKETS = ['none', 'day', 'month', 'year'];
    private const VIZ = ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'];
    // Chart types that group + aggregate into a series (label/value pairs).
    private const SERIES_VIZ = ['bar', 'line', 'area', 'pie', 'donut'];
    private const SKIP_TYPES = ['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload'];
    private const NUMERIC_TYPES = ['number', 'rating', 'scale'];
    private const DATE_TYPES = ['date', 'datetime'];
    private const MAX_FILTERS = 25;
    // Drafts + archived never appear in reports; everything else (submitted, reviewed, approved, …) does.
    private const HIDDEN_STATUSES = "('draft', 'archived')";

    public function __construct(private SQLiteConnection $sqlite) {}

    /**
     * @param array $spec  { viz, filters, groupBy, measure, columns, joins?, seriesSort?, sort?, having?, limit? }
     * @param array $fields the base form's field definitions
     * @param array $joins  resolved + authorised joins: [{ formId, via, type:'inner'|'left', scope:'all'|'own', fields, path }]
     */
    public function runReport(array $spec, array $fields, string $formId, string $scope, ?string $userId, array $joins = [], string $timezone = 'UTC'): array
    {
        $viz = in_array($spec['viz'] ?? 'table', self::VIZ, true) ? (string) $spec['viz'] : 'table';

        if (!$this->sqlite->formDatabaseExists($formId)) {
            return ['viz' => $viz, 'columns' => [], 'rows' => [], 'series' => [], 'value' => 0];
        }
        $db = $this->sqlite->getFormDatabase($formId);

        // Relative date filters ("today", "this month", …) are evaluated in the APP's timezone (not the
        // server's UTC), so business users see predictable boundaries. Stored timestamps are UTC; we shift
        // them by the tz's current offset (handles whole + half-hour zones; historical DST for old rows is
        // approximated by the current offset — acceptable for relative filters).
        try { $tz = new \DateTimeZone($timezone !== '' ? $timezone : 'UTC'); } catch (\Throwable $e) { $tz = new \DateTimeZone('UTC'); }
        $nowLocal = new \DateTime('now', $tz);
        $tzOffsetMin = (int) round($tz->getOffset($nowLocal) / 60);
        $tzMod = $tzOffsetMin === 0 ? '' : (($tzOffsetMin > 0 ? '+' : '-') . abs($tzOffsetMin) . ' minutes');
        $localExpr = static fn (string $e): string => $tzMod === '' ? $e : "datetime($e, '$tzMod')";

        $baseFieldById = [];
        foreach ($fields as $f) {
            if (!empty($f['id'])) { $baseFieldById[$f['id']] = $f; }
        }

        // ── ATTACH joined databases ──
        $joinDefs = []; // joinFormId => ['alias','via','type','multi','scope','fieldById']
        $attached = [];
        $ai = 0;
        foreach ($joins as $j) {
            $path = (string) ($j['path'] ?? '');
            if ($path === '' || !is_file($path)) { continue; }
            $via = (string) ($j['via'] ?? '');
            if ($this->clean($via) !== $via || $via === '') { continue; }
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
                'via' => $via,
                'type' => (($j['type'] ?? 'left') === 'inner') ? 'INNER' : 'LEFT',
                'multi' => ($baseFieldById[$via]['properties']['allowMultiple'] ?? false) === true,
                'scope' => (($j['scope'] ?? 'all') === 'own') ? 'own' : 'all',
                'fieldById' => $fb,
            ];
        }

        try {
            // Resolve a field ref → SQL expression (or null if invalid), and → its field definition.
            $refExpr = function (string $ref) use ($baseFieldById, $joinDefs): ?string {
                if ($ref === '__submitted_at') { return 'r.submitted_at'; }
                if ($ref === '__status') { return 'r.status'; }
                if (str_contains($ref, '::')) {
                    [$jf, $fid] = explode('::', $ref, 2);
                    $jd = $joinDefs[$jf] ?? null;
                    if (!$jd || !isset($jd['fieldById'][$fid]) || $this->clean($fid) !== $fid) { return null; }
                    return "json_extract({$jd['alias']}.answers, '$.\"$fid\"')";
                }
                if (!isset($baseFieldById[$ref]) || $this->clean($ref) !== $ref) { return null; }
                return "json_extract(r.answers, '$.\"$ref\"')";
            };
            $refField = static function (string $ref) use ($baseFieldById, $joinDefs): ?array {
                if ($ref === '__submitted_at') { return ['type' => 'datetime', 'label' => 'Submitted']; }
                if ($ref === '__status') { return ['type' => 'short_text', 'label' => 'Status']; }
                if (str_contains($ref, '::')) {
                    [$jf, $fid] = explode('::', $ref, 2);
                    return $joinDefs[$jf]['fieldById'][$fid] ?? null;
                }
                return $baseFieldById[$ref] ?? null;
            };

            $params = [];

            // ── FROM + JOINs (joined rows are status-filtered + own-scoped IN THE ON CLAUSE) ──
            $from = 'responses r';
            $ji = 0;
            foreach ($joinDefs as $jd) {
                $link = $jd['multi']
                    ? "{$jd['alias']}.id IN (SELECT value FROM json_each(r.answers, '$.\"{$jd['via']}\"'))"
                    : "{$jd['alias']}.id = json_extract(r.answers, '$.\"{$jd['via']}\"')";
                $on = "$link AND {$jd['alias']}.status NOT IN " . self::HIDDEN_STATUSES;
                if ($jd['scope'] === 'own' && $userId) {
                    $jp = ':juid' . $ji++;
                    $on .= " AND json_extract({$jd['alias']}.metadata, '$.submittedByUserId') = $jp";
                    $params[$jp] = $userId;
                }
                $from .= " {$jd['type']} JOIN {$jd['alias']}.responses {$jd['alias']} ON $on";
            }

            // ── WHERE (base status + scope + validated filters) ──
            $where = ['r.status NOT IN ' . self::HIDDEN_STATUSES];
            if ($scope === 'own' && $userId) {
                $where[] = "json_extract(r.metadata, '$.submittedByUserId') = :uid";
                $params[':uid'] = $userId;
            }
            $pi = 0;
            foreach (array_slice((array) ($spec['filters'] ?? []), 0, self::MAX_FILTERS) as $flt) {
                if (!is_array($flt)) { continue; }
                $ref = (string) ($flt['field'] ?? '');
                $expr = $refExpr($ref);
                if ($expr === null) { continue; }
                $fdef = $refField($ref);
                $isNumeric = in_array($fdef['type'] ?? '', self::NUMERIC_TYPES, true);
                $isDate = in_array($fdef['type'] ?? '', self::DATE_TYPES, true) || $ref === '__submitted_at';
                $op = (string) ($flt['op'] ?? 'eq');

                if ($op === 'empty') { $where[] = "($expr IS NULL OR $expr = '' OR $expr = '[]')"; continue; }
                if ($op === 'notempty') { $where[] = "($expr IS NOT NULL AND $expr != '' AND $expr != '[]')"; continue; }

                // Relative date filters — boundaries computed in the app timezone (PHP), bound as params.
                if (in_array($op, self::DATE_OPS, true)) {
                    $le = $localExpr($expr);
                    if ($op === 'last_n_days') {
                        $n = max(1, min((int) ($flt['value'] ?? 30), 3650));
                        $p = ':p' . $pi++;
                        $params[$p] = (clone $nowLocal)->modify("-{$n} days")->format('Y-m-d');
                        $where[] = "date($le) >= $p";
                    } elseif ($op === 'this_month') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y-m');
                        $where[] = "strftime('%Y-%m', $le) = $p";
                    } elseif ($op === 'this_year') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y');
                        $where[] = "strftime('%Y', $le) = $p";
                    } elseif ($op === 'today') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y-m-d');
                        $where[] = "date($le) = $p";
                    }
                    continue;
                }

                // Array membership for multi-select / checkbox fields (and any array-valued answer).
                if ($op === 'has' || $op === 'not_has') {
                    $p = ':p' . $pi++;
                    $params[$p] = (string) ($flt['value'] ?? '');
                    $arr = "CASE WHEN json_valid($expr) AND json_type($expr) = 'array' THEN $expr ELSE json_array($expr) END";
                    $cond = "EXISTS (SELECT 1 FROM json_each($arr) WHERE value = $p)";
                    $where[] = $op === 'has' ? $cond : "NOT $cond";
                    continue;
                }

                if ($op === 'contains') {
                    $p = ':p' . $pi++;
                    $where[] = "$expr LIKE $p ESCAPE '!'";
                    $params[$p] = '%' . strtr((string) ($flt['value'] ?? ''), ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
                    continue;
                }
                if (isset(self::OPS[$op])) {
                    $p = ':p' . $pi++;
                    $params[$p] = (string) ($flt['value'] ?? '');
                    if ($isNumeric) {
                        $where[] = "CAST($expr AS REAL) " . self::OPS[$op] . " CAST($p AS REAL)";
                    } elseif ($isDate) {
                        $where[] = "date($expr) " . self::OPS[$op] . " date($p)";
                    } else {
                        $where[] = "$expr " . self::OPS[$op] . " $p";
                    }
                }
            }
            $whereSql = implode(' AND ', $where);
            $limit = max(1, min((int) ($spec['limit'] ?? 100), 1000));

            // Aggregate expression. Numeric aggregates only apply to numeric fields (else degrade to
            // COUNT); empty strings become NULL so they don't count as 0 in AVG/MIN.
            $aggExpr = function (array $measure) use ($refExpr, $refField): string {
                $fn = in_array($measure['fn'] ?? 'count', self::AGGS, true) ? (string) $measure['fn'] : 'count';
                if ($fn === 'count') { return 'COUNT(*)'; }
                $mref = (string) ($measure['field'] ?? '');
                $mexpr = $refExpr($mref);
                if ($mexpr === null) { return 'COUNT(*)'; }
                if ($fn === 'countDistinct') { return "COUNT(DISTINCT $mexpr)"; }
                if (!in_array($refField($mref)['type'] ?? '', self::NUMERIC_TYPES, true)) { return 'COUNT(*)'; }
                return strtoupper($fn) . "(CAST(NULLIF($mexpr, '') AS REAL))";
            };

            // ── KPI ──
            if ($viz === 'kpi') {
                $stmt = $db->prepare("SELECT " . $aggExpr($spec['measure'] ?? ['fn' => 'count']) . " AS val FROM $from WHERE $whereSql");
                $stmt->execute($params);
                return ['viz' => 'kpi', 'value' => (float) ($stmt->fetchColumn() ?: 0)];
            }

            // ── chart series (group + aggregate; array group-by values are unnested via json_each) ──
            if (in_array($viz, self::SERIES_VIZ, true) && !empty($spec['groupBy']['field'])) {
                $gref = (string) $spec['groupBy']['field'];
                $gcol = $refExpr($gref);
                if ($gcol === null) { return ['viz' => $viz, 'series' => []]; }
                $bucket = (string) ($spec['groupBy']['bucket'] ?? 'none');
                if (!in_array($bucket, self::BUCKETS, true)) { $bucket = 'none'; }
                // Normalise to a JSON array so multi-select answers group per-option and scalars stay 1:1.
                $normArr = "CASE WHEN json_valid($gcol) AND json_type($gcol) = 'array' THEN $gcol ELSE json_array($gcol) END";
                $groupFrom = "$from, json_each($normArr) ge";
                $key = match ($bucket) {
                    'month' => "strftime('%Y-%m', ge.value)",
                    'year'  => "strftime('%Y', ge.value)",
                    'day'   => "date(ge.value)",
                    default => 'ge.value',
                };
                $agg = $aggExpr($spec['measure'] ?? ['fn' => 'count']);
                // Chronological order for date buckets; else by label if asked, else by value.
                $seriesSort = (string) ($spec['seriesSort'] ?? '');
                if ($bucket !== 'none' || $seriesSort === 'label') {
                    $orderBy = 'k ASC';
                } else {
                    $dir = (($spec['sort'] ?? 'desc') === 'asc') ? 'ASC' : 'DESC';
                    $orderBy = "v $dir";
                }
                $havingSql = '';
                if (isset($spec['having']['op']) && isset(self::OPS[$spec['having']['op']])) {
                    $hp = ':hv';
                    $havingSql = " HAVING $agg " . self::OPS[$spec['having']['op']] . " CAST($hp AS REAL)";
                    $params[$hp] = (string) ($spec['having']['value'] ?? 0);
                }
                $stmt = $db->prepare("SELECT $key AS k, $agg AS v FROM $groupFrom WHERE $whereSql GROUP BY k$havingSql ORDER BY $orderBy LIMIT :lim");
                foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
                $stmt->bindValue(':lim', min($limit, 50), PDO::PARAM_INT);
                $stmt->execute();
                $gfield = $refField($gref);
                $series = [];
                foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $rrow) {
                    $label = ($rrow['k'] === null || $rrow['k'] === '') ? '—' : $this->optLabel($gfield, (string) $rrow['k']);
                    $series[] = ['label' => $label, 'value' => (float) $rrow['v']];
                }
                return ['viz' => $viz, 'series' => $series];
            }

            // ── table ──
            $refs = array_values(array_filter((array) ($spec['columns'] ?? []), fn ($ref) => $refExpr((string) $ref) !== null));
            $refs = array_slice($refs, 0, 30);
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
                $columns[] = ['id' => "c$i", 'label' => $refField((string) $ref)['label'] ?? (string) $ref];
            }
            $selectSql = empty($selects) ? 'r.id AS c0' : implode(', ', $selects);
            // Sort: a chosen column/direction, else newest first.
            $orderSql = 'r.submitted_at DESC';
            if (isset($spec['sort']['by'])) {
                $sortExpr = $refExpr((string) $spec['sort']['by']);
                if ($sortExpr !== null) {
                    $sdir = (($spec['sort']['dir'] ?? 'asc') === 'desc') ? 'DESC' : 'ASC';
                    $orderSql = "$sortExpr $sdir";
                }
            }
            $stmt = $db->prepare("SELECT $selectSql, r.submitted_at AS _sa FROM $from WHERE $whereSql ORDER BY $orderSql LIMIT :lim");
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

    /** Whitelist an identifier to safe chars (matches the field-id rules enforced on write). */
    private function clean(string $id): string
    {
        return preg_replace('/[^A-Za-z0-9_]/', '', $id) ?? '';
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
        if (is_string($val) && str_starts_with($val, '[')) {
            $decoded = json_decode($val, true);
            if (is_array($decoded)) {
                return implode(', ', array_map(fn ($v) => $this->optLabel($field, (string) $v), $decoded));
            }
        }
        return $this->optLabel($field, (string) $val);
    }
}
