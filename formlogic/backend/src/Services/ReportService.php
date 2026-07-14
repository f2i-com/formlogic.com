<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Helpers\RecordLabel;
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
    // dateRange quick presets that constrain the query ('all' / unknown values add no constraint).
    private const RANGE_PRESETS = ['7d', '30d', '90d', 'thisMonth', 'ytd'];
    // Chart types that accept a seriesBy second dimension (pie/donut/kpi stay single-dimension).
    private const SERIESBY_VIZ = ['bar', 'line', 'area'];
    // Row cap for the two-dimensional (groupBy × seriesBy) aggregation before the PHP pivot.
    private const MAX_PIVOT_CELLS = 2000;
    private const MAX_FILTERS = 25;
    // Drafts + archived never appear in reports; everything else (submitted, reviewed, approved, …) does.
    private const HIDDEN_STATUSES = "('draft', 'archived')";

    public function __construct(private SQLiteConnection $sqlite, private ?FormService $formService = null) {}

    /**
     * @param array $spec  { viz, filters, filterMode?, groupBy, measure, columns, joins?, seriesSort?, sort?, having?, limit?, dateRange?, seriesBy? }
     * @param array $fields the base form's field definitions
     * @param array $joins  resolved + authorised joins: [{ formId, via, type:'inner'|'left', scope:'all'|'own', fields, path }]
     * @param ?array $resolvableFormIds  target forms whose linked_record labels the caller may reveal in
     *   table cells: an allowlist (app members → only forms they can view), null = resolve any (owner),
     *   [] = resolve none (default; e.g. public). Others render as an opaque "Linked record" placeholder,
     *   never a raw id.
     */
    public function runReport(array $spec, array $fields, string $formId, string $scope, ?string $userId, array $joins = [], string $timezone = 'UTC', ?array $resolvableFormIds = []): array
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
            $filterConds = []; // conditions from the validated user filters (combined below per filterMode)
            foreach (array_slice((array) ($spec['filters'] ?? []), 0, self::MAX_FILTERS) as $flt) {
                if (!is_array($flt)) { continue; }
                $ref = (string) ($flt['field'] ?? '');
                $expr = $refExpr($ref);
                if ($expr === null) { continue; }
                $fdef = $refField($ref);
                $isNumeric = in_array($fdef['type'] ?? '', self::NUMERIC_TYPES, true);
                $isDate = in_array($fdef['type'] ?? '', self::DATE_TYPES, true) || $ref === '__submitted_at';
                $op = (string) ($flt['op'] ?? 'eq');

                if ($op === 'empty') { $filterConds[] = "($expr IS NULL OR $expr = '' OR $expr = '[]')"; continue; }
                if ($op === 'notempty') { $filterConds[] = "($expr IS NOT NULL AND $expr != '' AND $expr != '[]')"; continue; }

                // Relative date filters — boundaries computed in the app timezone (PHP), bound as params.
                if (in_array($op, self::DATE_OPS, true)) {
                    $le = $localExpr($expr);
                    if ($op === 'last_n_days') {
                        $n = max(1, min((int) ($flt['value'] ?? 30), 3650));
                        $p = ':p' . $pi++;
                        $params[$p] = (clone $nowLocal)->modify("-{$n} days")->format('Y-m-d');
                        $filterConds[] = "date($le) >= $p";
                    } elseif ($op === 'this_month') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y-m');
                        $filterConds[] = "strftime('%Y-%m', $le) = $p";
                    } elseif ($op === 'this_year') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y');
                        $filterConds[] = "strftime('%Y', $le) = $p";
                    } elseif ($op === 'today') {
                        $p = ':p' . $pi++;
                        $params[$p] = $nowLocal->format('Y-m-d');
                        $filterConds[] = "date($le) = $p";
                    }
                    continue;
                }

                // Array membership for multi-select / checkbox fields (and any array-valued answer).
                if ($op === 'has' || $op === 'not_has') {
                    $p = ':p' . $pi++;
                    $params[$p] = (string) ($flt['value'] ?? '');
                    $arr = "CASE WHEN json_valid($expr) AND json_type($expr) = 'array' THEN $expr ELSE json_array($expr) END";
                    $cond = "EXISTS (SELECT 1 FROM json_each($arr) WHERE value = $p)";
                    $filterConds[] = $op === 'has' ? $cond : "NOT $cond";
                    continue;
                }

                if ($op === 'contains') {
                    $p = ':p' . $pi++;
                    $filterConds[] = "$expr LIKE $p ESCAPE '!'";
                    $params[$p] = '%' . strtr((string) ($flt['value'] ?? ''), ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
                    continue;
                }
                if (isset(self::OPS[$op])) {
                    $p = ':p' . $pi++;
                    $params[$p] = (string) ($flt['value'] ?? '');
                    if ($isNumeric) {
                        $filterConds[] = "CAST($expr AS REAL) " . self::OPS[$op] . " CAST($p AS REAL)";
                    } elseif ($isDate) {
                        $filterConds[] = "date($expr) " . self::OPS[$op] . " date($p)";
                    } else {
                        $filterConds[] = "$expr " . self::OPS[$op] . " $p";
                    }
                }
            }
            // filterMode 'any' (2+ validated filters only) ORs the USER filters together in one
            // parenthesized group; the base status/scope conditions above and the dateRange constraint
            // below always stay AND'd outside it. 'all'/absent/a single surviving filter keeps today's
            // plain AND chain — byte-identical SQL to the legacy behaviour.
            if (($spec['filterMode'] ?? '') === 'any' && count($filterConds) >= 2) {
                $where[] = '(' . implode(' OR ', $filterConds) . ')';
            } else {
                array_push($where, ...$filterConds);
            }
            // ── dateRange quick preset (dashboard range picker) — the boundary is computed in PHP in the
            // app timezone (same machinery as the relative-date filters above) and bound as a parameter;
            // the preset never reaches SQL. 'all' / unknown presets add no constraint (legacy behaviour).
            $drPreset = is_array($spec['dateRange'] ?? null) ? (string) ($spec['dateRange']['preset'] ?? '') : '';
            if (in_array($drPreset, self::RANGE_PRESETS, true)) {
                $dref = (string) ($spec['dateRange']['field'] ?? '__submitted_at');
                // Only a date-typed field (or the submitted-at pseudo-field) can carry the range; anything
                // else — including refs that don't resolve — falls back to submission time.
                if ($refExpr($dref) === null || !in_array($refField($dref)['type'] ?? '', self::DATE_TYPES, true)) {
                    $dref = '__submitted_at';
                }
                $le = $localExpr((string) $refExpr($dref));
                $params[':drange'] = match ($drPreset) {
                    '7d' => (clone $nowLocal)->modify('-7 days')->format('Y-m-d'),
                    '30d' => (clone $nowLocal)->modify('-30 days')->format('Y-m-d'),
                    '90d' => (clone $nowLocal)->modify('-90 days')->format('Y-m-d'),
                    'thisMonth' => $nowLocal->format('Y-m-01'),
                    default => $nowLocal->format('Y-01-01'), // ytd
                };
                $where[] = "date($le) >= :drange";
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
                $kpi = ['viz' => 'kpi', 'value' => (float) ($stmt->fetchColumn() ?: 0)];

                // Sparkline (spec.sparkline + a date-BUCKETED groupBy): also return the bucketed trend so
                // the renderer can draw a mini axis-less area under the big number. Same whitelisted
                // refExpr/bucket machinery as the chart-series path; chronological; capped at 90 buckets.
                if (($spec['sparkline'] ?? null) === true && !empty($spec['groupBy']['field'])) {
                    $gref = (string) $spec['groupBy']['field'];
                    $gcol = $refExpr($gref);
                    $bucket = (string) ($spec['groupBy']['bucket'] ?? 'none');
                    if ($gcol !== null && in_array($bucket, ['day', 'month', 'year'], true)) {
                        $normArr = "CASE WHEN json_valid($gcol) AND json_type($gcol) = 'array' THEN $gcol ELSE json_array($gcol) END";
                        // Bucket boundaries in the app timezone (same $localExpr as the filters above), so
                        // a day/month/year bucket agrees with a same-field date filter near a boundary.
                        $gIsDate = in_array($refField($gref)['type'] ?? '', self::DATE_TYPES, true) || $gref === '__submitted_at';
                        $gVal = $gIsDate ? $localExpr('ge.value') : 'ge.value';
                        $key = match ($bucket) {
                            'month' => "strftime('%Y-%m', $gVal)",
                            'year'  => "strftime('%Y', $gVal)",
                            default => "date($gVal)",
                        };
                        // Take the MOST RECENT 90 buckets (ORDER BY k DESC), then re-ascend so the sparkline
                        // still reads oldest→newest — a plain ASC LIMIT would freeze on the OLDEST buckets
                        // once a form has more than 90 buckets of history (same fix as the chart-series path).
                        $sparkInner = "SELECT $key AS k, " . $aggExpr($spec['measure'] ?? ['fn' => 'count']) . " AS v
                             FROM $from, json_each($normArr) ge WHERE $whereSql GROUP BY k";
                        $sq = $db->prepare("SELECT k, v FROM ($sparkInner ORDER BY k DESC LIMIT 90) sub ORDER BY k ASC");
                        $sq->execute($params);
                        $trend = [];
                        foreach ($sq->fetchAll(PDO::FETCH_ASSOC) as $row) {
                            if ($row['k'] === null || $row['k'] === '') { continue; }
                            $trend[] = ['label' => (string) $row['k'], 'value' => (float) $row['v']];
                        }
                        if (count($trend) >= 2) { $kpi['series'] = $trend; }
                    }
                }
                return $kpi;
            }

            // ── chart series (group + aggregate; array group-by values are unnested via json_each) ──
            if (in_array($viz, self::SERIES_VIZ, true) && !empty($spec['groupBy']['field'])) {
                $gref = (string) $spec['groupBy']['field'];
                $gcol = $refExpr($gref);
                if ($gcol === null) { return ['viz' => $viz, 'series' => []]; }
                $bucket = (string) ($spec['groupBy']['bucket'] ?? 'none');
                if (!in_array($bucket, self::BUCKETS, true)) { $bucket = 'none'; }
                $isDateBucket = $bucket !== 'none';
                // Normalise to a JSON array so multi-select answers group per-option and scalars stay 1:1.
                $normArr = "CASE WHEN json_valid($gcol) AND json_type($gcol) = 'array' THEN $gcol ELSE json_array($gcol) END";
                $groupFrom = "$from, json_each($normArr) ge";
                // Bucket boundaries in the app timezone (same $localExpr as the filters above), so a
                // day/month/year bucket agrees with a same-field date filter near a boundary.
                $gIsDate = in_array($refField($gref)['type'] ?? '', self::DATE_TYPES, true) || $gref === '__submitted_at';
                $gVal = $gIsDate ? $localExpr('ge.value') : 'ge.value';
                $key = match ($bucket) {
                    'month' => "strftime('%Y-%m', $gVal)",
                    'year'  => "strftime('%Y', $gVal)",
                    'day'   => "date($gVal)",
                    default => 'ge.value',
                };
                $agg = $aggExpr($spec['measure'] ?? ['fn' => 'count']);

                // ── OPTIONAL second dimension (seriesBy) — bar/line/area only. The field passes the SAME
                // whitelist as groupBy (refExpr rejects unknown/undeclared-join refs); the query aggregates
                // by BOTH dims and the series cap + 'Other' bucketing happens in PHP post-aggregation.
                $sbRef = (in_array($viz, self::SERIESBY_VIZ, true) && is_array($spec['seriesBy'] ?? null))
                    ? (string) ($spec['seriesBy']['field'] ?? '') : '';
                $sbExpr = $sbRef !== '' ? $refExpr($sbRef) : null;
                if ($sbExpr !== null) {
                    // Unnest array answers the same way as the primary dimension.
                    $sbNorm = "CASE WHEN json_valid($sbExpr) AND json_type($sbExpr) = 'array' THEN $sbExpr ELSE json_array($sbExpr) END";
                    $groupFrom .= ", json_each($sbNorm) se";
                    $havingSql = '';
                    if (isset($spec['having']['op']) && isset(self::OPS[$spec['having']['op']])) {
                        $havingSql = " HAVING $agg " . self::OPS[$spec['having']['op']] . " CAST(:hv AS REAL)";
                        $params[':hv'] = (string) ($spec['having']['value'] ?? 0);
                    }
                    $pivotInner = "SELECT $key AS k, se.value AS s, $agg AS v FROM $groupFrom WHERE $whereSql GROUP BY k, s$havingSql";
                    // Date buckets: take the MOST RECENT :lim cells (ORDER BY k DESC), then re-ascend so the
                    // pivot still sees chronological order — a plain ASC LIMIT would keep the OLDEST cells
                    // once a report has more history than MAX_PIVOT_CELLS.
                    $pivotSql = $isDateBucket
                        ? "SELECT k, s, v FROM ($pivotInner ORDER BY k DESC LIMIT :lim) sub ORDER BY k ASC"
                        : "$pivotInner ORDER BY k ASC LIMIT :lim";
                    $stmt = $db->prepare($pivotSql);
                    foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
                    $stmt->bindValue(':lim', self::MAX_PIVOT_CELLS, PDO::PARAM_INT);
                    $stmt->execute();
                    return ['viz' => $viz, 'series' => $this->pivotSeries(
                        $stmt->fetchAll(PDO::FETCH_ASSOC),
                        $refField($gref),
                        $refField($sbRef),
                        (int) ($spec['seriesBy']['limit'] ?? 5),
                        min($limit, 50),
                        $isDateBucket || (($spec['seriesSort'] ?? '') === 'label'),
                        ($spec['sort'] ?? 'desc') === 'asc',
                        $isDateBucket
                    )];
                }

                // Chronological order for date buckets; else by label if asked, else by value.
                $seriesSort = (string) ($spec['seriesSort'] ?? '');
                if ($isDateBucket || $seriesSort === 'label') {
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
                $seriesInner = "SELECT $key AS k, $agg AS v FROM $groupFrom WHERE $whereSql GROUP BY k$havingSql";
                // Date buckets: take the MOST RECENT :lim buckets (ORDER BY k DESC), then re-ascend so the
                // chart still reads oldest→newest left-to-right — a plain ASC LIMIT would freeze on the
                // OLDEST buckets once a report has more history than the row cap (the non-date "rank by
                // value" branch above is untouched: it already means the top-N values, not recency).
                $seriesSql = $isDateBucket
                    ? "SELECT k, v FROM ($seriesInner ORDER BY k DESC LIMIT :lim) sub ORDER BY k ASC"
                    : "$seriesInner ORDER BY $orderBy LIMIT :lim";
                $stmt = $db->prepare($seriesSql);
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
            $stmt = $db->prepare("SELECT $selectSql FROM $from WHERE $whereSql ORDER BY $orderSql LIMIT :lim");
            foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
            $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
            $stmt->execute();
            $rawRows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // linked_record columns NEVER render a raw target-record id. When the caller may reveal the
            // target form (permission-gated by $resolvableFormIds) we resolve to a human label; otherwise
            // an opaque "Linked record" placeholder.
            $linkedCols = [];           // "c$i" => ['field' => def, 'resolvable' => bool]
            foreach ($refs as $i => $ref) {
                $f = $refField((string) $ref);
                if (($f['type'] ?? '') === 'linked_record' && !empty($f['properties']['targetFormId'])) {
                    $linkedCols["c$i"] = [
                        'field' => $f,
                        'resolvable' => $this->canResolveForm((string) $f['properties']['targetFormId'], $resolvableFormIds),
                    ];
                }
            }
            $linkedMaps = [];           // "c$i" => [recordId => label]
            foreach ($linkedCols as $col => $info) {
                if (!$info['resolvable']) { continue; }
                $ids = [];
                foreach ($rawRows as $rr) {
                    foreach ($this->linkedIds($rr[$col] ?? null) as $id) { $ids[$id] = $id; }
                }
                $linkedMaps[$col] = $this->resolveLinkedLabelMap($info['field'], array_values($ids));
            }

            $rows = [];
            foreach ($rawRows as $rrow) {
                $row = [];
                foreach ($refs as $i => $ref) {
                    $col = "c$i";
                    if (isset($linkedCols[$col])) {
                        $ids = $this->linkedIds($rrow[$col] ?? null);
                        if (empty($ids)) { $row[$col] = ''; continue; }
                        $map = $linkedMaps[$col] ?? [];
                        $row[$col] = implode(', ', array_map(fn ($id) => $map[$id] ?? 'Linked record', $ids));
                    } else {
                        $row[$col] = $this->displayValue($refField((string) $ref), $rrow[$col] ?? null);
                    }
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

    /**
     * Pivot two-dimension grouped rows (k = groupBy key, s = seriesBy key, v = aggregate) into FLAT
     * chart rows { label, value, series }: keeps the top $seriesLimit (clamped 2..8) series by total
     * value, buckets the remainder into a literal 'Other', caps distinct labels, and maps stored values
     * to option labels. Rows arrive ORDER BY k ASC, so insertion order IS chronological/label order.
     *
     * @param array  $rows          [['k' =>, 's' =>, 'v' =>], …] from the two-dim aggregation
     * @param ?array $gfield        groupBy field definition (option-label mapping)
     * @param ?array $sfield        seriesBy field definition
     * @param bool   $byLabel       true = keep chronological/label order; false = order labels by total value
     * @param bool   $asc           value-order direction when !$byLabel
     * @param bool   $chronological true when $byLabel is chronological (a date bucket): the caller already
     *   SQL-capped the rows to the most RECENT cells, so the most-recent $labelLimit labels are the TAIL of
     *   the (ascending) list, not the head — unlike plain label-sort (e.g. alphabetical), which has no
     *   "recency" and keeps the existing head-slice behaviour.
     */
    private function pivotSeries(array $rows, ?array $gfield, ?array $sfield, int $seriesLimit, int $labelLimit, bool $byLabel, bool $asc, bool $chronological = false): array
    {
        $seriesLimit = max(2, min($seriesLimit, 8));
        $cells = [];         // raw label key => raw series key => summed value
        $labelTotals = [];   // raw label key => total
        $seriesTotals = [];  // raw series key => total
        foreach ($rows as $r) {
            $k = $r['k'] === null ? '' : (string) $r['k'];
            $s = $r['s'] === null ? '' : (string) $r['s'];
            $v = (float) $r['v'];
            $cells[$k][$s] = ($cells[$k][$s] ?? 0.0) + $v;
            $labelTotals[$k] = ($labelTotals[$k] ?? 0.0) + $v;
            $seriesTotals[$s] = ($seriesTotals[$s] ?? 0.0) + $v;
        }
        if (!$byLabel) {
            $asc ? asort($labelTotals) : arsort($labelTotals);
        }
        $labels = $chronological
            ? array_slice(array_keys($labelTotals), -$labelLimit)
            : array_slice(array_keys($labelTotals), 0, $labelLimit);
        arsort($seriesTotals);
        $kept = array_slice(array_keys($seriesTotals), 0, $seriesLimit);

        $out = [];
        foreach ($labels as $k) {
            $label = (string) $k === '' ? '—' : $this->optLabel($gfield, (string) $k);
            foreach ($kept as $s) {
                if (!isset($cells[$k][$s])) { continue; }
                $out[] = [
                    'label' => $label,
                    'value' => (float) $cells[$k][$s],
                    'series' => (string) $s === '' ? '—' : $this->optLabel($sfield, (string) $s),
                ];
            }
            $other = null;
            foreach ($cells[$k] as $s => $v) {
                if (!in_array($s, $kept, true)) { $other = ($other ?? 0.0) + $v; }
            }
            if ($other !== null) { $out[] = ['label' => $label, 'value' => $other, 'series' => 'Other']; }
        }
        return $out;
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

    /** Whether the caller may reveal labels from $targetFormId (see runReport's $resolvableFormIds). */
    private function canResolveForm(string $targetFormId, ?array $resolvableFormIds): bool
    {
        if (!$this->formService) { return false; }            // no way to fetch target fields → don't resolve
        if ($resolvableFormIds === null) { return true; }      // owner: any linked target is theirs
        return in_array($targetFormId, $resolvableFormIds, true);
    }

    /** The referenced target-record id(s) from a stored linked_record value (single id or JSON array). */
    private function linkedIds(mixed $val): array
    {
        if ($val === null || $val === '') { return []; }
        if (is_string($val) && str_starts_with($val, '[')) {
            $decoded = json_decode($val, true);
            if (is_array($decoded)) {
                return array_values(array_filter(
                    array_map(fn ($x) => is_scalar($x) ? (string) $x : '', $decoded),
                    fn ($s) => $s !== ''
                ));
            }
        }
        return [(string) $val];
    }

    /**
     * Build a recordId => human-label map for a linked_record field's referenced ids, reading the target
     * form's fields (FormService) + records (its SQLite). Prefers the field's configured displayFieldIds,
     * else RecordLabel::guess. Records with no derivable label are omitted (caller shows a placeholder).
     *
     * @param string[] $ids
     * @return array<string,string>
     */
    private function resolveLinkedLabelMap(array $field, array $ids): array
    {
        $targetFormId = (string) ($field['properties']['targetFormId'] ?? '');
        if ($targetFormId === '' || empty($ids) || !$this->formService || !$this->sqlite->formDatabaseExists($targetFormId)) {
            return [];
        }
        $targetForm = $this->formService->getForm($targetFormId);
        $targetFields = is_array($targetForm['fields'] ?? null) ? $targetForm['fields'] : [];
        $displayFieldIds = is_array($field['properties']['displayFieldIds'] ?? null) ? $field['properties']['displayFieldIds'] : null;

        $db = $this->sqlite->getFormDatabase($targetFormId);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $db->prepare("SELECT id, answers FROM responses WHERE id IN ($placeholders)");
        $stmt->execute(array_values($ids));

        $map = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $tr) {
            $answers = json_decode((string) ($tr['answers'] ?? '{}'), true);
            if (!is_array($answers)) { $answers = []; }
            $label = '';
            if ($displayFieldIds) {
                $parts = [];
                foreach ($displayFieldIds as $fid) {
                    $tf = null;
                    foreach ($targetFields as $cand) { if (($cand['id'] ?? null) === $fid) { $tf = $cand; break; } }
                    $v = $this->displayValue($tf, $answers[$fid] ?? null);
                    if (trim($v) !== '') { $parts[] = trim($v); }
                }
                $label = implode(' · ', $parts);
            }
            if ($label === '') {
                $label = RecordLabel::guess($targetFields, $answers) ?? '';
            }
            if ($label !== '') { $map[(string) $tr['id']] = $label; }
        }
        return $map;
    }
}
