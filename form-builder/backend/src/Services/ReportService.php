<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SQLiteConnection;
use PDO;

/**
 * Runs a no-code report spec against a form's response SQLite database and returns a normalised
 * result (table rows / chart series / a single KPI value).
 *
 * SAFE BY CONSTRUCTION — there is NO user SQL:
 *  - field ids are validated against the form definition (only real fields can be referenced),
 *  - operators / aggregate functions / date buckets are whitelisted,
 *  - every value is bound as a parameter,
 *  - results are row-capped,
 *  - scope ('own' vs 'all') is pushed into the WHERE clause.
 * Answers are stored as JSON in the `responses.answers` column, so fields are read via json_extract.
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
     * @param array  $spec    { viz, filters:[{field,op,value}], groupBy?:{field,bucket}, measure?:{fn,field}, columns?:string[], sort?, limit? }
     * @param array  $fields  the target form's field definitions
     * @param string $scope   'all' | 'own'
     */
    public function runReport(array $spec, array $fields, string $formId, string $scope, ?string $userId): array
    {
        $viz = in_array($spec['viz'] ?? 'table', self::VIZ, true) ? (string) $spec['viz'] : 'table';

        if (!$this->sqlite->formDatabaseExists($formId)) {
            return ['viz' => $viz, 'columns' => [], 'rows' => [], 'series' => [], 'value' => 0, 'total' => 0];
        }
        $db = $this->sqlite->getFormDatabase($formId);

        $fieldById = [];
        foreach ($fields as $f) {
            if (!empty($f['id'])) { $fieldById[$f['id']] = $f; }
        }

        // ── WHERE (status + scope + validated filters, all parameterised) ──
        $where = ["status = 'submitted'"];
        $params = [];
        if ($scope === 'own' && $userId) {
            $where[] = "json_extract(metadata, '$.submittedByUserId') = :uid";
            $params[':uid'] = $userId;
        }
        $pi = 0;
        foreach ($spec['filters'] ?? [] as $flt) {
            $fid = (string) ($flt['field'] ?? '');
            if (!isset($fieldById[$fid])) { continue; }
            $op = (string) ($flt['op'] ?? 'eq');
            $col = $this->fieldExpr($fid);
            if ($op === 'empty') { $where[] = "($col IS NULL OR $col = '')"; continue; }
            if ($op === 'notempty') { $where[] = "($col IS NOT NULL AND $col != '')"; continue; }
            if ($op === 'contains') {
                $p = ':p' . $pi++;
                $where[] = "$col LIKE $p ESCAPE '!'";
                $params[$p] = '%' . strtr((string) ($flt['value'] ?? ''), ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
                continue;
            }
            if (isset(self::OPS[$op])) {
                $p = ':p' . $pi++;
                $where[] = "$col " . self::OPS[$op] . " $p";
                $params[$p] = (string) ($flt['value'] ?? '');
            }
        }
        $whereSql = implode(' AND ', $where);
        $limit = max(1, min((int) ($spec['limit'] ?? 100), 1000));

        // ── KPI: one aggregate over all matching rows ──
        if ($viz === 'kpi') {
            $stmt = $db->prepare("SELECT " . $this->aggExpr($spec['measure'] ?? ['fn' => 'count'], $fieldById) . " AS val FROM responses WHERE $whereSql");
            $stmt->execute($params);
            return ['viz' => 'kpi', 'value' => (float) ($stmt->fetchColumn() ?: 0)];
        }

        // ── bar / pie: group + aggregate → series ──
        if (($viz === 'bar' || $viz === 'pie') && !empty($spec['groupBy']['field'])) {
            $gf = (string) $spec['groupBy']['field'];
            if (!isset($fieldById[$gf])) { return ['viz' => $viz, 'series' => []]; }
            $bucket = (string) ($spec['groupBy']['bucket'] ?? 'none');
            if (!in_array($bucket, self::BUCKETS, true)) { $bucket = 'none'; }
            $gcol = $this->fieldExpr($gf);
            $grp = match ($bucket) {
                'month' => "strftime('%Y-%m', $gcol)",
                'year'  => "strftime('%Y', $gcol)",
                'day'   => "date($gcol)",
                default => $gcol,
            };
            $order = (($spec['sort'] ?? 'desc') === 'asc') ? 'ASC' : 'DESC';
            $stmt = $db->prepare("SELECT $grp AS k, " . $this->aggExpr($spec['measure'] ?? ['fn' => 'count'], $fieldById) . " AS v FROM responses WHERE $whereSql GROUP BY k ORDER BY v $order LIMIT :lim");
            foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
            $stmt->bindValue(':lim', min($limit, 50), PDO::PARAM_INT);
            $stmt->execute();
            $series = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $key = ($r['k'] === null || $r['k'] === '') ? '—' : $this->optLabel($gf, (string) $r['k'], $fieldById);
                $series[] = ['label' => $key, 'value' => (float) $r['v']];
            }
            return ['viz' => $viz, 'series' => $series];
        }

        // ── table: list selected columns ──
        $selFields = array_values(array_filter((array) ($spec['columns'] ?? []), fn ($id) => isset($fieldById[$id])));
        if (empty($selFields)) {
            foreach ($fields as $f) {
                if (count($selFields) >= 5) { break; }
                if (!in_array($f['type'] ?? '', self::SKIP_TYPES, true)) { $selFields[] = $f['id']; }
            }
        }
        $columns = array_map(fn ($id) => ['id' => $id, 'label' => $fieldById[$id]['label'] ?? $id], $selFields);
        $stmt = $db->prepare("SELECT answers, submitted_at FROM responses WHERE $whereSql ORDER BY submitted_at DESC LIMIT :lim");
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':lim', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $ans = json_decode($r['answers'] ?? '{}', true) ?: [];
            $row = ['_submittedAt' => $r['submitted_at'] ?? ''];
            foreach ($selFields as $id) {
                $row[$id] = $this->displayValue($id, $ans[$id] ?? null, $fieldById);
            }
            $rows[] = $row;
        }
        return ['viz' => 'table', 'columns' => $columns, 'rows' => $rows];
    }

    /** json_extract expression for a validated field id (defensively strip quotes/backslashes). */
    private function fieldExpr(string $fid): string
    {
        $safe = str_replace(['"', '\\'], '', $fid);
        return "json_extract(answers, '$.\"$safe\"')";
    }

    private function aggExpr(array $measure, array $fieldById): string
    {
        $fn = in_array($measure['fn'] ?? 'count', self::AGGS, true) ? (string) $measure['fn'] : 'count';
        if ($fn === 'count') { return 'COUNT(*)'; }
        $mf = (string) ($measure['field'] ?? '');
        if (!isset($fieldById[$mf])) { return 'COUNT(*)'; }
        return strtoupper($fn) . "(CAST(" . $this->fieldExpr($mf) . " AS REAL))";
    }

    /** Map a stored value to its option label (choice fields) or the value itself. */
    private function optLabel(string $fid, string $val, array $fieldById): string
    {
        foreach ($fieldById[$fid]['properties']['options'] ?? [] as $o) {
            if (is_array($o) && ($o['value'] ?? null) === $val) { return (string) ($o['label'] ?? $val); }
        }
        return $val;
    }

    private function displayValue(string $fid, mixed $val, array $fieldById): string
    {
        if (is_array($val)) {
            return implode(', ', array_map(fn ($v) => $this->optLabel($fid, (string) $v, $fieldById), $val));
        }
        if ($val === null) { return ''; }
        if (is_bool($val)) { return $val ? 'Yes' : 'No'; }
        return $this->optLabel($fid, (string) $val, $fieldById);
    }
}
