<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Validates + sanitizes saved report definitions (apps.reports = AppReportItem[]) against a specific app,
 * so stored/AI-created report config can never reference forms outside the app, non-existent fields, joins
 * that aren't real linked_record relationships, or dangling document blocks. Runtime execution is already
 * permission-scoped (AppPublicController::runReport); this hardens the SAVE boundary.
 *
 * `sanitizeReports()` drops invalid pieces (safe for bulk saves / imports). `validateChartSpec()` rejects
 * hard errors (foreign base form) for the MCP create path so the AI gets clear feedback.
 */
class AppReportService
{
    private const VIZ = ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'];
    private const OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'empty', 'notempty', 'last_n_days', 'this_month', 'this_year', 'today', 'has', 'not_has'];
    private const HAVING_OPS = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte'];
    private const AGG = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'];
    private const BUCKETS = ['none', 'day', 'month', 'year'];
    private const PSEUDO = ['__submitted_at', '__status'];
    // dateRange quick presets ('all' persists but adds no query constraint).
    private const DATE_RANGE_PRESETS = ['all', '7d', '30d', '90d', 'thisMonth', 'ytd'];
    // Dashboard auto-refresh cadences (seconds) — the only values that persist.
    private const REFRESH_INTERVALS = [30, 60, 300];
    // Presentation-only spec options (rendered client-side; never touch the query).
    private const ACCENT_COLORS = ['primary', 'blue', 'green', 'amber', 'red', 'violet', 'teal'];
    private const NUM_FORMATS = ['plain', 'compact', 'currency', 'percent'];
    private const SERIES_ORDERS = ['value_desc', 'value_asc', 'label_asc', 'label_desc'];
    private const AFFIX_MAX = 8;
    private const NAME_MAX = 200;
    private const DESC_MAX = 1000;
    private const TEXT_TITLE_MAX = 200;
    private const TEXT_BODY_MAX = 5000;
    private const MAX_ITEMS = 200;
    private const MAX_BLOCKS = 100;
    private const MAX_WIDGETS = 60;
    /** Upper bound for dashboard custom CSS (plenty for theming, hostile-blob proof). */
    private const DASHBOARD_CSS_MAX = 20000;

    public function __construct(private AppService $appService, private FormService $formService) {}

    /** [formId => [fieldId => fieldDef]] for the forms that belong to this app. */
    private function appFormFields(string $appId): array
    {
        // ONE batched MySQL lookup for all the app's form rows (getFormsByIds preserves the
        // app_forms sort order, so the map keys come out exactly as the per-form loop did).
        $formIds = [];
        foreach ($this->appService->getAppForms($appId) as $af) {
            if (!empty($af['formId'])) { $formIds[] = $af['formId']; }
        }
        $map = [];
        foreach ($this->formService->getFormsByIds($formIds) as $fid => $form) {
            $byId = [];
            foreach (($form['fields'] ?? []) as $f) {
                if (!empty($f['id'])) { $byId[$f['id']] = $f; }
            }
            $map[$fid] = $byId;
        }
        return $map;
    }

    private function clamp(mixed $v, int $max): ?string
    {
        if ($v === null) { return null; }
        $s = trim((string) $v);
        if ($s === '') { return null; }
        return mb_substr($s, 0, $max);
    }

    /**
     * Validate + normalize ONE chart spec against the app (strict: a foreign/invalid base form is an error).
     * @return array{ok:bool, error:?string, spec:array}
     */
    public function validateChartSpec(array $spec, string $appId): array
    {
        return $this->cleanChartSpec($spec, $this->appFormFields($appId));
    }

    /**
     * Sanitize a whole reports array against the app: drop invalid charts, invalid joins/field-refs, and
     * document report-blocks that don't reference a surviving chart. Returns cleaned AppReportItem[].
     */
    public function sanitizeReports(array $reports, string $appId): array
    {
        $formFields = $this->appFormFields($appId);
        $items = array_slice(array_values(array_filter($reports, 'is_array')), 0, self::MAX_ITEMS);

        // First resolve every chart (so document blocks can validate their references), then emit in the
        // ORIGINAL order so a save never silently reshuffles the user's list.
        $cleanChartById = [];
        foreach ($items as $item) {
            if (($item['type'] ?? '') === 'document') { continue; }
            $id = (string) ($item['id'] ?? '');
            if ($id === '' || isset($cleanChartById[$id])) { continue; }
            $res = $this->cleanChartSpec(is_array($item['spec'] ?? null) ? $item['spec'] : [], $formFields);
            if ($res['ok']) { $cleanChartById[$id] = $res['spec']; }
        }

        $out = [];
        $seen = [];
        foreach ($items as $item) {
            $id = (string) ($item['id'] ?? '');
            if ($id === '' || isset($seen[$id])) { continue; }

            if (($item['type'] ?? '') === 'document') {
                $blocks = [];
                foreach (array_slice((array) ($item['blocks'] ?? []), 0, self::MAX_BLOCKS) as $b) {
                    if (!is_array($b)) { continue; }
                    if (($b['kind'] ?? '') === 'text') {
                        $blocks[] = array_filter([
                            'id' => (string) ($b['id'] ?? '') ?: $this->rid('blk'),
                            'kind' => 'text',
                            'title' => $this->clamp($b['title'] ?? null, self::TEXT_TITLE_MAX),
                            'body' => $this->clamp($b['body'] ?? null, self::TEXT_BODY_MAX) ?? '',
                        ], static fn ($v) => $v !== null);
                    } elseif (($b['kind'] ?? '') === 'report' && isset($cleanChartById[(string) ($b['reportId'] ?? '')])) {
                        $blocks[] = array_filter([
                            'id' => (string) ($b['id'] ?? '') ?: $this->rid('blk'),
                            'kind' => 'report',
                            'reportId' => (string) $b['reportId'],
                            'caption' => $this->clamp($b['caption'] ?? null, self::TEXT_TITLE_MAX),
                        ], static fn ($v) => $v !== null);
                    }
                }
                if (!$blocks) { continue; } // drop an empty/all-broken document
                $seen[$id] = true;
                $doc = ['id' => $id, 'name' => $this->clamp($item['name'] ?? 'Document', self::NAME_MAX) ?? 'Document', 'type' => 'document', 'blocks' => array_values($blocks)];
                $desc = $this->clamp($item['description'] ?? null, self::DESC_MAX);
                if ($desc !== null) { $doc['description'] = $desc; }
                $out[] = $doc;
            } elseif (isset($cleanChartById[$id])) {
                $seen[$id] = true;
                $clean = ['id' => $id, 'name' => $this->clamp($item['name'] ?? 'Report', self::NAME_MAX) ?? 'Report', 'type' => 'builder', 'spec' => $cleanChartById[$id]];
                $desc = $this->clamp($item['description'] ?? null, self::DESC_MAX);
                if ($desc !== null) { $clean['description'] = $desc; }
                $out[] = $clean;
            }
        }

        return $out;
    }

    private function rid(string $prefix): string
    {
        return $prefix . '_' . bin2hex(random_bytes(5));
    }

    /**
     * Sanitize a report spec for the ANONYMOUS public form link: field refs are restricted to the
     * form's publicRecordFields whitelist (+ the submitted-date pseudo-field), joins are forbidden,
     * and __status is NOT exposed. Returns a safe spec bound to $formId (never trusts the client).
     */
    public function sanitizePublicSpec(array $spec, string $formId, array $allowedFieldIds): array
    {
        $allowed = array_flip(array_values(array_filter($allowedFieldIds, 'is_string')));
        $refValid = static function (mixed $ref) use ($allowed): bool {
            if (!is_string($ref) || $ref === '') { return false; }
            if ($ref === '__submitted_at') { return true; } // aggregate time trends are safe; __status is not exposed
            if (str_contains($ref, '::')) { return false; }  // no cross-form joins on public links
            return isset($allowed[$ref]);
        };

        $viz = in_array($spec['viz'] ?? '', self::VIZ, true) ? (string) $spec['viz'] : 'bar';
        $clean = ['formId' => $formId, 'viz' => $viz];

        if (!empty($spec['groupBy']['field']) && $refValid($spec['groupBy']['field'])) {
            $gb = ['field' => (string) $spec['groupBy']['field']];
            if (in_array($spec['groupBy']['bucket'] ?? '', self::BUCKETS, true)) { $gb['bucket'] = $spec['groupBy']['bucket']; }
            $clean['groupBy'] = $gb;
        }

        if (!empty($spec['measure']) && is_array($spec['measure'])) {
            $fn = in_array($spec['measure']['fn'] ?? '', self::AGG, true) ? (string) $spec['measure']['fn'] : 'count';
            $m = ['fn' => $fn];
            $mf = $spec['measure']['field'] ?? null;
            if ($mf !== null && $refValid($mf)) {
                $m['field'] = (string) $mf;
            } elseif (in_array($fn, ['sum', 'avg', 'min', 'max'], true)) {
                $m['fn'] = 'count';
            }
            $clean['measure'] = $m;
        }

        if (!empty($spec['filters']) && is_array($spec['filters'])) {
            $filters = [];
            foreach ($spec['filters'] as $f) {
                if (!is_array($f) || !$refValid($f['field'] ?? null) || !in_array($f['op'] ?? '', self::OPS, true)) { continue; }
                $filters[] = array_filter(['field' => (string) $f['field'], 'op' => (string) $f['op'], 'value' => isset($f['value']) ? (string) $f['value'] : null], static fn ($v) => $v !== null);
            }
            if ($filters) { $clean['filters'] = $filters; }
        }
        // filterMode: 'any' ORs the saved filters together at run time. 'all' is the engine default and
        // is never stored; anything but the literal 'any' is dropped.
        if (($spec['filterMode'] ?? null) === 'any') { $clean['filterMode'] = 'any'; }

        if (!empty($spec['columns']) && is_array($spec['columns'])) {
            $cols = array_values(array_filter(array_map('strval', $spec['columns']), $refValid));
            if ($cols) { $clean['columns'] = array_slice($cols, 0, 30); }
        }

        if (in_array($spec['seriesSort'] ?? '', ['value', 'label'], true)) { $clean['seriesSort'] = $spec['seriesSort']; }
        if (isset($spec['sort'])) {
            if (is_string($spec['sort']) && in_array($spec['sort'], ['asc', 'desc'], true)) {
                $clean['sort'] = $spec['sort'];
            } elseif (is_array($spec['sort']) && $refValid($spec['sort']['by'] ?? null)) {
                $clean['sort'] = ['by' => (string) $spec['sort']['by'], 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc'];
            }
        }
        if (isset($spec['limit'])) { $clean['limit'] = max(1, min((int) $spec['limit'], 1000)); }

        return $this->cleanPresentation($spec, $this->cleanRangeAndSeries($spec, $clean, $refValid));
    }

    /**
     * Whitelist the OPTIONAL query additions dateRange + seriesBy using the CALLER's field-ref validator,
     * so the app save path and the anonymous public path each enforce their own visibility rules (the
     * public validator already restricts refs to publicRecordFields and forbids joins). Invalid pieces
     * are dropped, never an error: a bad dateRange.field falls back to the engine's __submitted_at
     * default (the preset is kept), a bad seriesBy.field drops seriesBy entirely.
     */
    private function cleanRangeAndSeries(array $spec, array $clean, callable $refValid): array
    {
        if (is_array($spec['dateRange'] ?? null) && in_array($spec['dateRange']['preset'] ?? null, self::DATE_RANGE_PRESETS, true)) {
            $dr = ['preset' => (string) $spec['dateRange']['preset']];
            $df = $spec['dateRange']['field'] ?? null;
            if ($df !== null && $refValid($df)) { $dr['field'] = (string) $df; }
            $clean['dateRange'] = $dr;
        }
        if (is_array($spec['seriesBy'] ?? null) && $refValid($spec['seriesBy']['field'] ?? null)) {
            $sb = ['field' => (string) $spec['seriesBy']['field']];
            if (isset($spec['seriesBy']['limit']) && is_numeric($spec['seriesBy']['limit'])) {
                $sb['limit'] = max(2, min((int) $spec['seriesBy']['limit'], 8));
            }
            $clean['seriesBy'] = $sb;
        }
        return $clean;
    }

    /**
     * Whitelist the OPTIONAL presentation fields (color/format/decimals/prefix/suffix/showDataLabels/
     * target/horizontal/seriesOrder): enum-validated, clamped, booleans strict — so saves keep them but
     * hostile values can never persist. Presentation-only: safe on both the app and the public path.
     */
    private function cleanPresentation(array $spec, array $clean): array
    {
        if (in_array($spec['color'] ?? null, self::ACCENT_COLORS, true)) { $clean['color'] = (string) $spec['color']; }
        if (in_array($spec['format'] ?? null, self::NUM_FORMATS, true)) { $clean['format'] = (string) $spec['format']; }
        if (isset($spec['decimals']) && is_numeric($spec['decimals'])) { $clean['decimals'] = max(0, min((int) $spec['decimals'], 2)); }
        foreach (['prefix', 'suffix'] as $k) {
            // is_scalar guard: an array/object here would warn on the (string) cast inside clamp().
            $v = is_scalar($spec[$k] ?? null) ? $this->clamp($spec[$k], self::AFFIX_MAX) : null;
            if ($v !== null) { $clean[$k] = $v; }
        }
        if (is_bool($spec['showDataLabels'] ?? null)) { $clean['showDataLabels'] = $spec['showDataLabels']; }
        if (isset($spec['target']) && is_numeric($spec['target']) && is_finite((float) $spec['target'])) { $clean['target'] = $spec['target'] + 0; }
        if (is_bool($spec['horizontal'] ?? null)) { $clean['horizontal'] = $spec['horizontal']; }
        if (in_array($spec['seriesOrder'] ?? null, self::SERIES_ORDERS, true)) { $clean['seriesOrder'] = (string) $spec['seriesOrder']; }
        if (is_bool($spec['sparkline'] ?? null)) { $clean['sparkline'] = $spec['sparkline']; }
        return $clean;
    }

    /** Sanitize a widget-dashboard config (customScreen.dashboard) against an app's forms. */
    public function sanitizeDashboardForApp(array $dashboard, string $appId): array
    {
        return $this->sanitizeDashboard($dashboard, $this->appFormFields($appId));
    }

    /** Build a [formId => [fieldId => def]] map for one form + the forms its linked_record fields target. */
    public function formFieldMap(string $formId): array
    {
        $map = [];
        $form = $this->formService->getForm($formId);
        if (!$form) { return $map; }
        $byId = [];
        foreach (($form['fields'] ?? []) as $f) {
            if (!empty($f['id'])) { $byId[$f['id']] = $f; }
        }
        $map[$formId] = $byId;
        // Include linked target forms so joins/joined-field refs validate for form-scoped dashboards.
        // Targets resolve via ONE batched lookup (input order preserved = the old first-seen order).
        $targetIds = [];
        foreach (($form['fields'] ?? []) as $f) {
            if (($f['type'] ?? '') === 'linked_record' && !empty($f['properties']['targetFormId'])) {
                $tid = (string) $f['properties']['targetFormId'];
                if (!isset($map[$tid])) { $targetIds[] = $tid; }
            }
        }
        foreach ($this->formService->getFormsByIds($targetIds) as $tid => $tform) {
            $tById = [];
            foreach (($tform['fields'] ?? []) as $tf) {
                if (!empty($tf['id'])) { $tById[$tf['id']] = $tf; }
            }
            $map[$tid] = $tById;
        }
        return $map;
    }

    /**
     * Sanitize a widget-dashboard config against a set of form fields: drop widgets whose report spec /
     * list form isn't in scope, clamp layout + counts, cap widget count. Never trusts client geometry.
     *
     * @param array $formFields [formId => [fieldId => def]]
     */
    public function sanitizeDashboard(array $dashboard, array $formFields): array
    {
        $cols = isset($dashboard['cols']) ? max(1, min((int) $dashboard['cols'], 24)) : 12;
        $widgets = is_array($dashboard['widgets'] ?? null) ? $dashboard['widgets'] : [];
        $out = [];
        foreach (array_slice($widgets, 0, self::MAX_WIDGETS) as $w) {
            if (!is_array($w)) { continue; }
            $kind = (string) ($w['kind'] ?? '');
            if (!in_array($kind, ['report', 'list', 'grid', 'text', 'actions', 'activity'], true)) { continue; }

            $layout = is_array($w['layout'] ?? null) ? $w['layout'] : [];
            $ww = max(1, min((int) ($layout['w'] ?? 4), $cols));
            $x = max(0, min((int) ($layout['x'] ?? 0), $cols - 1));
            if ($x + $ww > $cols) { $x = max(0, $cols - $ww); }
            $y = max(0, (int) ($layout['y'] ?? 0));
            $hh = max(1, min((int) ($layout['h'] ?? 2), 12));

            $clean = [
                'id' => (string) ($w['id'] ?? '') ?: $this->rid('w'),
                'kind' => $kind,
                'layout' => ['x' => $x, 'y' => $y, 'w' => $ww, 'h' => $hh],
            ];
            $title = $this->clamp($w['title'] ?? null, self::TEXT_TITLE_MAX);
            if ($title !== null) { $clean['title'] = $title; }

            if ($kind === 'report') {
                $res = $this->cleanChartSpec(is_array($w['spec'] ?? null) ? $w['spec'] : [], $formFields);
                if (!$res['ok']) { continue; } // drop widgets whose base form isn't in scope
                $clean['spec'] = $res['spec'];
            } elseif ($kind === 'list') {
                $fid = (string) ($w['list']['formId'] ?? '');
                if (!isset($formFields[$fid])) { continue; }
                $list = ['formId' => $fid, 'limit' => max(1, min((int) ($w['list']['limit'] ?? 6), 25))];
                foreach (['titleField', 'subtitleField', 'metaField'] as $k) {
                    $ref = (string) ($w['list'][$k] ?? '');
                    if ($ref !== '' && isset($formFields[$fid][$ref])) { $list[$k] = $ref; }
                }
                if (is_bool($w['list']['linkToRecords'] ?? null)) { $list['linkToRecords'] = $w['list']['linkToRecords']; }
                $clean['list'] = $list;
            } elseif ($kind === 'grid') {
                // Records grid: base form must be in scope; columns must be real fields; page size clamped.
                $fid = (string) ($w['grid']['formId'] ?? '');
                if (!isset($formFields[$fid])) { continue; }
                $grid = ['formId' => $fid, 'pageSize' => max(1, min((int) ($w['grid']['pageSize'] ?? 10), 50))];
                $colsIn = is_array($w['grid']['columnFieldIds'] ?? null) ? $w['grid']['columnFieldIds'] : [];
                $validCols = [];
                foreach ($colsIn as $cfid) {
                    $cfid = (string) $cfid;
                    if ($cfid !== '' && isset($formFields[$fid][$cfid])) { $validCols[] = $cfid; }
                }
                if ($validCols) { $grid['columnFieldIds'] = $validCols; }
                $clean['grid'] = $grid;
            } elseif ($kind === 'text') {
                $clean['text'] = ['body' => $this->clamp($w['text']['body'] ?? null, self::TEXT_BODY_MAX) ?? ''];
            }
            // actions/activity carry no extra config.
            $out[] = $clean;
        }
        $dash = ['version' => 1, 'cols' => $cols, 'widgets' => array_values($out)];
        if (is_bool($dashboard['showRangePicker'] ?? null)) { $dash['showRangePicker'] = $dashboard['showRangePicker']; }
        // Custom CSS (dashboard theming): builder-authored rules the runtime scopes to
        // the dashboard container. Dashboards travel inside packs, so the rules are
        // sanitized here — the enforcement point every save path already goes through.
        if (is_string($dashboard['customCss'] ?? null)) {
            $css = $this->sanitizeDashboardCss($dashboard['customCss']);
            if ($css !== '') { $dash['customCss'] = $css; }
        }
        // Auto-refresh cadence (seconds): only the fixed 30 / 60 / 300 steps persist; anything else drops.
        $ri = $dashboard['refreshInterval'] ?? null;
        if (is_numeric($ri) && (float) $ri == (int) $ri && in_array((int) $ri, self::REFRESH_INTERVALS, true)) {
            $dash['refreshInterval'] = (int) $ri;
        }
        return $dash;
    }

    /**
     * Sanitize dashboard custom CSS. CSS cannot run script, but it can call out
     * (url()/@import fetch attacker hosts, leaking viewer IPs) and legacy engines
     * had scriptable values — strip those constructs, keep everything visual.
     * data: image URLs stay allowed so authors can embed textures/patterns.
     * The runtime additionally prefixes every selector with the dashboard's own
     * scope container, so these rules can never restyle the app chrome.
     */
    public function sanitizeDashboardCss(string $css): string
    {
        $css = substr($css, 0, self::DASHBOARD_CSS_MAX);
        // A literal </style> would break out of the runtime's injected tag.
        $css = preg_replace('/<\/?\s*style/i', '', $css) ?? '';
        // No remote fetches: @import always; url(...) unless a data: URI.
        $css = preg_replace('/@import[^;]*;?/i', '', $css) ?? '';
        $css = preg_replace_callback(
            '~url\s*\(\s*(["\']?)([^)"\']*)\1\s*\)~i',
            static fn (array $m) => stripos(trim($m[2]), 'data:') === 0 ? $m[0] : 'none',
            $css
        ) ?? '';
        // Legacy scriptable-CSS constructs (defense in depth for old engines).
        $css = preg_replace('/expression\s*\(|-moz-binding|behavior\s*:/i', '', $css) ?? '';
        return trim($css);
    }

    /**
     * Clean a chart spec: base form must be in the app; joins must be real linked_record relationships to
     * in-app forms; every field ref must resolve (base field, declared-join field, or pseudo-field). Invalid
     * sub-parts are dropped. ok=false only when the base form is missing/foreign.
     *
     * @return array{ok:bool, error:?string, spec:array}
     */
    private function cleanChartSpec(array $spec, array $formFields): array
    {
        $baseId = (string) ($spec['formId'] ?? '');
        if ($baseId === '' || !isset($formFields[$baseId])) {
            return ['ok' => false, 'error' => 'Report form is not part of this app', 'spec' => []];
        }
        $baseFields = $formFields[$baseId];

        $viz = in_array($spec['viz'] ?? '', self::VIZ, true) ? (string) $spec['viz'] : 'bar';
        $clean = ['formId' => $baseId, 'viz' => $viz];

        // Joins: keep only those along a real linked_record field on the base form pointing at an in-app form.
        $joinedFields = []; // joinFormId => [fieldId => def]
        if (!empty($spec['joins']) && is_array($spec['joins'])) {
            $joins = [];
            foreach ($spec['joins'] as $j) {
                if (!is_array($j)) { continue; }
                $via = (string) ($j['via'] ?? '');
                $jf = (string) ($j['formId'] ?? '');
                $viaField = $baseFields[$via] ?? null;
                if (!$viaField || ($viaField['type'] ?? '') !== 'linked_record') { continue; }
                if (($viaField['properties']['targetFormId'] ?? null) !== $jf) { continue; }
                if (!isset($formFields[$jf])) { continue; }
                $joins[] = ['via' => $via, 'formId' => $jf, 'type' => ($j['type'] ?? 'left') === 'inner' ? 'inner' : 'left'];
                $joinedFields[$jf] = $formFields[$jf];
            }
            if ($joins) { $clean['joins'] = $joins; }
        }

        // A field ref resolves if it's a pseudo-field, a base field, or a declared-join field ("<jf>::<fid>").
        $refValid = function (mixed $ref) use ($baseFields, $joinedFields): bool {
            if (!is_string($ref) || $ref === '') { return false; }
            if (in_array($ref, self::PSEUDO, true)) { return true; }
            if (str_contains($ref, '::')) {
                [$jf, $fid] = explode('::', $ref, 2);
                return isset($joinedFields[$jf][$fid]);
            }
            return isset($baseFields[$ref]);
        };

        if (!empty($spec['groupBy']['field']) && $refValid($spec['groupBy']['field'])) {
            $gb = ['field' => (string) $spec['groupBy']['field']];
            if (in_array($spec['groupBy']['bucket'] ?? '', self::BUCKETS, true)) { $gb['bucket'] = $spec['groupBy']['bucket']; }
            $clean['groupBy'] = $gb;
        }

        if (!empty($spec['measure']) && is_array($spec['measure'])) {
            $fn = in_array($spec['measure']['fn'] ?? '', self::AGG, true) ? (string) $spec['measure']['fn'] : 'count';
            $m = ['fn' => $fn];
            $mf = $spec['measure']['field'] ?? null;
            if ($mf !== null && $refValid($mf)) {
                $m['field'] = (string) $mf;
            } elseif (in_array($fn, ['sum', 'avg', 'min', 'max'], true)) {
                $m['fn'] = 'count'; // an aggregate that needs a field but has none degrades to count
            }
            $clean['measure'] = $m;
        }

        if (!empty($spec['filters']) && is_array($spec['filters'])) {
            $filters = [];
            foreach ($spec['filters'] as $f) {
                if (!is_array($f) || !$refValid($f['field'] ?? null) || !in_array($f['op'] ?? '', self::OPS, true)) { continue; }
                $filters[] = array_filter(['field' => (string) $f['field'], 'op' => (string) $f['op'], 'value' => isset($f['value']) ? (string) $f['value'] : null], static fn ($v) => $v !== null);
            }
            if ($filters) { $clean['filters'] = $filters; }
        }
        // filterMode: 'any' ORs the saved filters together at run time. 'all' is the engine default and
        // is never stored; anything but the literal 'any' is dropped.
        if (($spec['filterMode'] ?? null) === 'any') { $clean['filterMode'] = 'any'; }

        if (!empty($spec['columns']) && is_array($spec['columns'])) {
            $cols = array_values(array_filter(array_map('strval', $spec['columns']), $refValid));
            if ($cols) { $clean['columns'] = array_slice($cols, 0, 30); }
        }

        if (in_array($spec['seriesSort'] ?? '', ['value', 'label'], true)) { $clean['seriesSort'] = $spec['seriesSort']; }

        // Sort: a plain 'asc'|'desc' (series direction) OR a table sort object { by, dir }.
        if (isset($spec['sort'])) {
            if (is_string($spec['sort']) && in_array($spec['sort'], ['asc', 'desc'], true)) {
                $clean['sort'] = $spec['sort'];
            } elseif (is_array($spec['sort']) && $refValid($spec['sort']['by'] ?? null)) {
                $clean['sort'] = ['by' => (string) $spec['sort']['by'], 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc'];
            }
        }

        if (!empty($spec['having']) && is_array($spec['having']) && in_array($spec['having']['op'] ?? '', self::HAVING_OPS, true) && is_numeric($spec['having']['value'] ?? null)) {
            $clean['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] + 0];
        }

        if (isset($spec['limit'])) { $clean['limit'] = max(1, min((int) $spec['limit'], 1000)); }

        return ['ok' => true, 'error' => null, 'spec' => $this->cleanPresentation($spec, $this->cleanRangeAndSeries($spec, $clean, $refValid))];
    }
}
