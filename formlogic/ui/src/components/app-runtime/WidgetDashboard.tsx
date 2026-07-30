import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity as ActivityGlyph, AlertCircle, ArrowRight, ChevronRight, Inbox, LayoutGrid, Loader2, Plus, RotateCw, Zap } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { ReportResultView } from './ReportResultView';
import { RecordsGridWidget } from './RecordsGridWidget';
import { formatRelativeTime } from '../../lib/utils';
import { api } from '../../lib/api';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReportResult, DashboardScreen, DashboardWidget } from '../../types/app';
import {
  GRID_ROW, GRID_GAP, DEFAULT_COLS, useWidgetData, fieldsOf, displayAnswer, autoTitle,
  type WidgetDataForm, type WidgetRecord, type ActivityRow, type WidgetDataDeps,
} from './widgetData';
import './dashboard.css';

// Re-export the shared data types so existing consumers can import them from here.
export type { WidgetDataForm, WidgetRecord, ActivityRow, WidgetDataDeps } from './widgetData';

// The card surface reads the --dash-* variables (dashboard.css), so a
// dashboard's custom CSS can retheme every box with one variable override.
const CARD = 'fl-dash-card';

// ── Dashboard date-range picker ────────────────────────────────────────────────

type RangePreset = 'all' | '7d' | '30d' | '90d';

const RANGE_PRESETS: Array<{ key: RangePreset; label: string }> = [
  { key: 'all', label: 'All' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

/** A dashboard is range-pickable when a report widget charts time (date-bucketed groupBy) or already
 *  scopes itself with a dateRange. */
function isTimeAware(w: DashboardWidget): boolean {
  if (w.kind !== 'report' || !w.spec) return false;
  const bucket = w.spec.groupBy?.bucket;
  return bucket === 'day' || bucket === 'month' || bucket === 'year' || w.spec.dateRange != null;
}

/** Chart types whose marks drill into the records view (KPI/table have no clickable category marks). */
const DRILL_VIZ = new Set(['bar', 'pie', 'donut', 'line', 'area']);

export interface WidgetDashboardProps extends WidgetDataDeps {
  dashboard: DashboardScreen;
  scope: 'app' | 'form' | 'public';
  /** Explicit accent for form/public scope (app scope reads --app-primary from the runtime host). */
  accent?: string;
  /** Submittable forms for the 'actions' built-in (app scope). */
  submittableForms?: WidgetDataForm[];
  onOpenForm?: (formId: string) => void;
  onOpenRecords?: (formId: string) => void;
  onOpenRecord?: (formId: string, recordId: string) => void;
  /** Grid widgets: server-paginated page fetch (store.fetchResponsePage). */
  fetchPage?: (formId: string, opts: { limit: number; offset: number }) => Promise<{ rows: unknown[]; total: number }>;
  className?: string;
  /** Owner/builder affordance: failed report widgets show a "Details" disclosure (the sanitized
   *  server message) and a per-widget Retry. When omitted it defaults by scope: 'app' → the runtime
   *  store's isOwner(), 'form' → true (the only form-scope host is the owner's preview/play route),
   *  'public' → false. Non-owners always keep the plain "Couldn't load this widget." message. */
  canEdit?: boolean;
}

/**
 * Collapse the grid to a single column when the DASHBOARD is narrow — measured on its
 * own box, not the window.
 *
 * This is the app home every member sees. matchMedia('(max-width: 768px)') asked the
 * wrong question: the host chain is AppRuntimeShell's 256px sidebar at md+ plus 48px of
 * main padding, so at a 769px viewport the grid had ~465px to render the multi-column
 * layout in — the window said "wide", the box was phone-sized, and widgets were squeezed
 * to unreadable slivers. Same arithmetic in the owner-side host with the studio rails.
 *
 * Stacking below 640px of CONTAINER width matches what the widgets can actually render.
 */
const STACK_BELOW_PX = 640;

function useNarrowContainer(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Before the first measurement (width 0) assume narrow: stacking is the safe layout,
  // and a multi-column first paint that immediately reflows is worse than the reverse.
  return [ref, width === 0 || width < STACK_BELOW_PX];
}

export function WidgetDashboard(props: WidgetDashboardProps) {
  const { dashboard, forms, scope, accent } = props;
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const [dashRef, narrow] = useNarrowContainer();
  // Stable per-mount scope for the custom-CSS injection (CSS.escape-safe).
  const scopeId = useMemo(() => `fl-dash-${++dashScopeCounter}`, []);
  const cols = Math.max(1, Math.min(dashboard.cols ?? DEFAULT_COLS, 24));
  const widgets = useMemo(
    () => [...(dashboard.widgets ?? [])].sort((a, b) => (a.layout.y - b.layout.y) || (a.layout.x - b.layout.x)),
    [dashboard.widgets]
  );

  // Per-visit range override (no persistence): the picker's preset is merged into every report
  // widget's spec.dateRange before running — preserving a widget's own dateRange.field, defaulting
  // '__submitted_at'. 'all' clears the override so the untouched specs run (today's behaviour).
  const [range, setRange] = useState<RangePreset>('all');
  const showPicker = dashboard.showRangePicker !== false && widgets.some(isTimeAware);
  const effectiveWidgets = useMemo(() => {
    if (range === 'all') return widgets;
    return widgets.map((w) =>
      w.kind === 'report' && w.spec
        ? { ...w, spec: { ...w.spec, dateRange: { preset: range, field: w.spec.dateRange?.field ?? '__submitted_at' } } }
        : w
    );
  }, [widgets, range]);

  // Auto-refresh (dashboard.refreshInterval = 30 | 60 | 300 seconds): re-run the report widgets on a
  // timer — paused while the tab is hidden, restarted by a manual range change, cleaned up on unmount.
  // Absent/invalid = no timers at all (today's behaviour). Ticks are BACKGROUND refreshes: the hook
  // keeps the previous data visible while refetching, so a wallboard never flickers.
  const ri = (dashboard as DashboardScreen & { refreshInterval?: number }).refreshInterval;
  const refreshSecs = ri === 30 || ri === 60 || ri === 300 ? ri : undefined;
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!refreshSecs || typeof document === 'undefined') return;
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const start = () => { if (timer === undefined) timer = window.setInterval(() => setRefreshTick((n) => n + 1), refreshSecs * 1000); };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
    // `range` is a dep on purpose: a manual range change already refetches, so restart the countdown.
  }, [refreshSecs, range]);

  // App scope: the Activity widget uses ONE server call (GET /app/{slug}/activity — permission
  // filtering + newest-first ordering happen server-side) instead of deriving the feed from the
  // first viewable forms client-side. Demo apps keep the client-side path: their records live
  // partly in this browser's IndexedDB overlay, which only fetchRecent can see. A host-provided
  // fetchActivity always wins.
  const propsFetchActivity = props.fetchActivity;
  const fetchActivity = useMemo(() => {
    if (propsFetchActivity) return propsFetchActivity;
    if (scope !== 'app' || !appSlug || api.isDemoMode()) return undefined;
    return async (limit: number): Promise<ActivityRow[]> => {
      const res = await api.getAppActivity(appSlug, limit);
      // Throw on failure so a background refresh keeps the last good rows (keep-stale-on-fail).
      if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Failed to load activity');
      return (res.data.activity ?? []).map((a) => ({
        id: a.recordId,
        answers: {},
        submittedAt: a.submittedAt,
        formId: a.formId,
        formName: a.formName,
        icon: forms.find((f) => f.formId === a.formId)?.icon,
        title: a.title,
      }));
    };
  }, [propsFetchActivity, scope, appSlug, forms]);

  const data = useWidgetData(effectiveWidgets, { ...props, fetchActivity }, refreshTick);

  // Owners/builders get failed-widget error details + Retry (T14). The store call is safe outside
  // the app runtime too: with no config loaded isOwner() is simply false.
  const runtimeOwner = useAppRuntimeStore((s) => s.isOwner());
  const canEdit = props.canEdit ?? (scope === 'app' ? runtimeOwner : scope === 'form');

  // ── Drill-down (app runtime only): clicking a chart mark filters that form's records view ──────
  // URL contract: /form/{formId}/responses?form={formId}&drill={groupByFieldId}&value={label}&bucket=….
  // Gated on the same permission the records grid enforces (canViewForm = view own/all responses).
  // Joined refs can't filter the records grid, and the pseudo-fields (__submitted_at/__status) only
  // filter client-side — so those drill only in demo mode, where the grid holds every row locally.
  const drillFor = (w: DashboardWidget): ((point: { label: string; series?: string }) => void) | undefined => {
    if (scope !== 'app' || !appSlug) return undefined;
    if (w.kind !== 'report' || !w.spec || !DRILL_VIZ.has(w.spec.viz)) return undefined;
    const spec = w.spec;
    const field = spec.groupBy?.field;
    if (!field || field.includes('::')) return undefined;
    if (field.startsWith('__') && !api.isDemoMode()) return undefined;
    if (!forms.some((f) => f.formId === spec.formId)) return undefined;
    if (props.canViewForm && !props.canViewForm(spec.formId)) return undefined;
    const b = spec.groupBy?.bucket;
    const bucket = b === 'day' || b === 'month' || b === 'year' ? b : undefined;
    return (point) => {
      if (!point.label) return;
      const qs = `?form=${encodeURIComponent(spec.formId)}&drill=${encodeURIComponent(field)}&value=${encodeURIComponent(point.label)}${bucket ? `&bucket=${bucket}` : ''}`;
      navigate(`/app/${appSlug}/form/${spec.formId}/responses${qs}`);
    };
  };

  // Quick-actions widgets grow to fit every button instead of scrolling: the widget reports its
  // natural content height, we translate that into extra grid rows and shift everything below it
  // down by the same amount — so the box expands without overlapping neighbours.
  const [actionsExtra, setActionsExtra] = useState<Record<string, number>>({});
  const reportActionsHeight = (w: DashboardWidget, px: number) => {
    const base = Math.max(1, w.layout.h || 1);
    const need = Math.ceil((px + GRID_GAP) / (GRID_ROW + GRID_GAP));
    const extra = Math.max(0, need - base);
    setActionsExtra((prev) => (prev[w.id] === extra ? prev : { ...prev, [w.id]: extra }));
  };
  const adjusted = useMemo(() => {
    const entries = widgets.map((w) => ({ id: w.id, y: Math.max(0, w.layout.y || 0), h: Math.max(1, w.layout.h || 1) }));
    // Process top-to-bottom so stacked actions widgets accumulate shifts correctly.
    for (const g of [...entries].sort((a, b) => a.y - b.y)) {
      const extra = actionsExtra[g.id] ?? 0;
      if (extra <= 0) continue;
      const bottom = g.y + g.h;
      for (const e of entries) if (e !== g && e.y >= bottom) e.y += extra;
      g.h += extra;
    }
    return new Map(entries.map((e) => [e.id, e]));
  }, [widgets, actionsExtra]);

  if (widgets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center text-gray-400 dark:text-slate-500">
        <LayoutGrid className="h-8 w-8 mb-3" />
        <p className="text-sm">This dashboard has no widgets yet.</p>
      </div>
    );
  }

  const primaryColor = scope === 'app' ? undefined : accent;

  const cellStyle = (w: DashboardWidget): CSSProperties => {
    const wSpan = Math.max(1, Math.min(w.layout.w || 1, cols));
    const adj = adjusted.get(w.id);
    const hSpan = adj?.h ?? Math.max(1, w.layout.h || 1);
    if (narrow) {
      const px = hSpan * GRID_ROW + (hSpan - 1) * GRID_GAP;
      // Stacked layout can't overlap, so actions simply grow to their content.
      return w.kind === 'actions' ? { minHeight: px } : { height: px };
    }
    const x = Math.max(0, Math.min(w.layout.x || 0, cols - wSpan));
    const y = adj?.y ?? Math.max(0, w.layout.y || 0);
    return { gridColumn: `${x + 1} / span ${wSpan}`, gridRow: `${y + 1} / span ${hSpan}` };
  };

  const containerStyle: CSSProperties = narrow
    ? { display: 'flex', flexDirection: 'column', gap: GRID_GAP }
    : { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${GRID_ROW}px`, gap: GRID_GAP };

  return (
    <div ref={dashRef} className={`fl-dash-scope ${props.className ?? 'w-full'}`} id={scopeId}>
      <DashboardCustomCss css={dashboard.customCss} scopeId={scopeId} />
      <div className="fl-dash">
      {showPicker && (
        <div className="fl-dash-range mb-3 flex justify-end">
          <div
            role="group"
            aria-label="Date range"
            className="inline-flex items-center gap-0.5 rounded-lg border border-gray-200/80 bg-white p-0.5 dark:border-slate-700/60 dark:bg-slate-900/50"
          >
            {RANGE_PRESETS.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary ${
                  range === r.key
                    ? 'bg-gray-900 text-white dark:bg-white dark:text-slate-900'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={containerStyle}>
        {effectiveWidgets.map((w) => (
          <div key={w.id} style={cellStyle(w)} className={`fl-dash-widget fl-dash-widget--${w.kind} min-w-0 min-h-0`}>
            <WidgetView
              widget={w}
              reportResult={data.reportResults[w.id]}
              reportLoading={data.reportLoading}
              reportRefreshing={data.reportLoading && data.reportResults[w.id] !== undefined}
              canEdit={canEdit}
              errorDetail={data.reportErrors[w.id]}
              onRetry={canEdit && w.kind === 'report' ? () => data.retryWidget(w.id) : undefined}
              retrying={!!data.retrying[w.id]}
              listRows={data.listData[w.id]}
              listLoading={w.kind === 'list' && !!w.list?.formId && !!props.fetchRecent && data.listData[w.id] === undefined}
              listError={data.listErrors[w.id]}
              activity={data.activity}
              activityError={data.activityError}
              forms={forms}
              submittableForms={props.submittableForms}
              primaryColor={primaryColor}
              onOpenForm={props.onOpenForm}
              onOpenRecords={props.onOpenRecords}
              onOpenRecord={props.onOpenRecord}
              fetchPage={props.fetchPage}
              onPointClick={drillFor(w)}
              onNaturalHeight={w.kind === 'actions' && !narrow ? (px) => reportActionsHeight(w, px) : undefined}
            />
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

// ── Dashboard custom CSS (scoped) ───────────────────────────────────────────────

let dashScopeCounter = 0;

/**
 * Inject the dashboard's custom CSS, scoped to its own container.
 *
 * The rules were already sanitized server-side (no @import / remote url() /
 * scriptable values — AppReportService::sanitizeDashboardCss). Scoping happens
 * here: the browser parses the CSS via a detached stylesheet, and every rule's
 * selector list is prefixed with the dashboard's scope id — including rules
 * nested in @media/@supports — so dashboard theming can never reach the app
 * chrome. Unparseable input simply produces no rules.
 */
function DashboardCustomCss({ css, scopeId }: { css?: string; scopeId: string }) {
  useEffect(() => {
    if (!css || !css.trim()) return;
    let scoped = '';
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      scoped = scopeCssRules(sheet.cssRules, `#${scopeId}`);
    } catch {
      return; // constructed stylesheets unavailable — skip rather than inject unscoped
    }
    if (!scoped) return;
    const el = document.createElement('style');
    el.setAttribute('data-fl-dash-css', scopeId);
    el.textContent = scoped;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, [css, scopeId]);
  return null;
}

/** Serialize rules with every selector prefixed by `scope` (recursing into grouping rules). */
function scopeCssRules(rules: CSSRuleList, scope: string): string {
  let out = '';
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selectors = rule.selectorText
        .split(',')
        .map((sel) => `${scope} ${sel.trim()}`)
        .join(', ');
      const body = rule.cssText.slice(rule.cssText.indexOf('{'));
      out += `${selectors} ${body}
`;
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const kind = rule instanceof CSSMediaRule ? '@media' : '@supports';
      out += `${kind} ${rule.conditionText} { ${scopeCssRules(rule.cssRules, scope)} }
`;
    } else if (rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule) {
      // Keyframes/font-face are name-scoped, not selector-scoped — pass through.
      out += `${rule.cssText}
`;
    }
    // Anything else (@import survived nothing server-side; @page etc.) is dropped.
  }
  return out;
}

// ── Single widget view (shared by runtime + builder) ────────────────────────────

export interface WidgetViewProps {
  widget: DashboardWidget;
  reportResult?: AppReportResult | null;
  reportLoading: boolean;
  /** True while a widget re-runs (e.g. a range change) but still shows its previous result. */
  reportRefreshing?: boolean;
  /** Owner/builder view: a failed report widget exposes its sanitized error + Retry. */
  canEdit?: boolean;
  /** Sanitized server message for a failed report widget (never a raw stack/SQL). */
  errorDetail?: string;
  /** Re-runs JUST this widget. Absent = no Retry button (e.g. the builder's inert canvas,
   *  where errorDetail renders as static text instead of a disclosure). */
  onRetry?: () => void;
  /** True while this widget's Retry is in flight. */
  retrying?: boolean;
  listRows?: WidgetRecord[];
  /** True while this list widget's rows are still being fetched (skeleton instead of empty state). */
  listLoading?: boolean;
  /** Sanitized failure message when this list widget's fetch failed (form deleted, no permission,
   *  network error) — zero rows + this set means "couldn't load", not "genuinely empty". */
  listError?: string;
  activity: ActivityRow[];
  /** Sanitized failure message when the activity feed's fetch failed outright — zero rows + this
   *  set means "couldn't load", not "genuinely empty". */
  activityError?: string | null;
  forms: WidgetDataForm[];
  submittableForms?: WidgetDataForm[];
  primaryColor?: string;
  onOpenForm?: (formId: string) => void;
  onOpenRecords?: (formId: string) => void;
  onOpenRecord?: (formId: string, recordId: string) => void;
  /** Report widgets only: makes chart marks clickable (drill-down). Absent = inert charts (builder). */
  onPointClick?: (point: { label: string; series?: string }) => void;
  /** Grid widgets: server-paginated page fetch. Absent on the builder canvas → static preview. */
  fetchPage?: (formId: string, opts: { limit: number; offset: number }) => Promise<{ rows: unknown[]; total: number }>;
  /** Actions widgets only: reports the card height (px) needed to fit every button unscrolled,
   *  re-reported on wrap changes — the dashboard grid grows the cell to match. */
  onNaturalHeight?: (px: number) => void;
}

export function WidgetView(p: WidgetViewProps) {
  const { widget: w } = p;

  // Natural-height reporting (actions widgets): observe the wrap container — its height changes
  // when buttons rewrap — and report header + content + padding as the needed card height.
  const measureCardRef = useRef<HTMLDivElement | null>(null);
  const measureBodyRef = useRef<HTMLDivElement | null>(null);
  const onNaturalHeight = p.onNaturalHeight;
  useEffect(() => {
    const card = measureCardRef.current;
    const body = measureBodyRef.current;
    const inner = body?.firstElementChild as HTMLElement | null;
    if (!onNaturalHeight || !card || !body || !inner) return;
    const report = () => {
      // Header + any padding above the scroll body (its rect is stable even if it was scrolled).
      const chrome = body.getBoundingClientRect().top - card.getBoundingClientRect().top;
      // pb-4 on the scroll body (16px) + card borders (2px).
      onNaturalHeight(Math.ceil(chrome + inner.offsetHeight + 18));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(inner);
    ro.observe(card);
    return () => ro.disconnect();
  }, [onNaturalHeight]);

  // Text widget: a plain note, no card chrome header.
  if (w.kind === 'text') {
    return (
      <div className={`${CARD} h-full min-h-0 p-5 overflow-auto`}>
        {w.title && <h3 className="font-semibold tracking-tight text-gray-900 dark:text-white mb-1.5">{w.title}</h3>}
        <p className="text-sm text-gray-600 dark:text-slate-300 whitespace-pre-wrap break-words">{w.text?.body ?? ''}</p>
      </div>
    );
  }

  // List widgets get a "View all" link into the form's records (CRUD) list, when a handler is wired.
  const viewAll = w.kind === 'list' && w.list?.formId && p.onOpenRecords ? (
    <button
      type="button"
      onClick={() => p.onOpenRecords!(w.list!.formId)}
      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium app-text-primary hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary rounded"
    >
      View all <ArrowRight className="h-3 w-3" />
    </button>
  ) : null;
  const header = (w.title || viewAll) ? (
    <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-1.5 shrink-0">
      {w.title ? <h3 className="truncate text-sm font-semibold tracking-tight text-gray-900 dark:text-white">{w.title}</h3> : <span />}
      {viewAll}
    </div>
  ) : null;

  let body: ReactNode = null;

  if (w.kind === 'report') {
    body = (
      <div className="flex-1 min-h-0 px-4 pb-4">
        {p.reportLoading && p.reportResult === undefined ? (
          <ReportSkeleton viz={w.spec?.viz} />
        ) : p.reportResult ? (
          <div className={`h-full min-h-0 transition-opacity ${p.reportRefreshing ? 'opacity-50' : ''}`}>
            <ReportResultView result={p.reportResult} spec={w.spec} primaryColor={p.primaryColor} fill onPointClick={p.onPointClick} />
          </div>
        ) : (
          <WidgetError canEdit={p.canEdit} detail={p.errorDetail} onRetry={p.onRetry} retrying={p.retrying} />
        )}
      </div>
    );
  } else if (w.kind === 'list') {
    const cfg = w.list;
    const form = p.forms.find((f) => f.formId === cfg?.formId);
    const flds = fieldsOf(form);
    const rows = p.listRows ?? [];
    // Rows deep-link to the record when the runtime wires it; linkToRecords additionally lets rows
    // fall through to the form's records view where only that navigation exists. Never a raw href.
    const clickable = !!cfg && (!!p.onOpenRecord || (cfg.linkToRecords === true && !!p.onOpenRecords));
    const openRow = (recordId: string) => {
      if (!cfg) return;
      if (p.onOpenRecord) p.onOpenRecord(cfg.formId, recordId);
      else if (cfg.linkToRecords === true) p.onOpenRecords?.(cfg.formId);
    };
    body = (
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {p.listLoading && p.listRows === undefined ? (
          <ListSkeleton withMeta={!!cfg?.metaField} />
        ) : rows.length === 0 && p.listError ? (
          <WidgetError canEdit={p.canEdit} detail={p.listError} />
        ) : rows.length === 0 ? (
          <WidgetEmpty icon={<Inbox className="h-6 w-6 opacity-70" />} text="No records yet" />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.map((r) => {
              const title = displayAnswer(flds, r.answers || {}, cfg?.titleField) || autoTitle(flds, r.answers || {});
              const subField = displayAnswer(flds, r.answers || {}, cfg?.subtitleField);
              const sub = subField || (r.submittedAt ? formatRelativeTime(r.submittedAt) : '');
              const meta = displayAnswer(flds, r.answers || {}, cfg?.metaField);
              const metaTime = cfg?.metaField && subField && r.submittedAt ? formatRelativeTime(r.submittedAt) : '';
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => openRow(r.id)}
                    disabled={!clickable}
                    className="group relative flex w-full items-center gap-3 px-2 py-2.5 text-left rounded-lg transition-colors enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-800/50 enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{title}</span>
                      {sub && <span className="block truncate text-xs text-gray-400 dark:text-slate-500">{sub}</span>}
                    </span>
                    {cfg?.metaField && (
                      <span className="max-w-[40%] shrink-0 text-right">
                        <span className="block truncate text-sm font-medium tabular-nums text-gray-700 dark:text-slate-200">{meta || '—'}</span>
                        {metaTime && <span className="block text-[11px] text-gray-400 dark:text-slate-500">{metaTime}</span>}
                      </span>
                    )}
                    {clickable && !cfg?.metaField && <RowChevron />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  } else if (w.kind === 'grid') {
    body = (
      <RecordsGridWidget
        widget={w}
        form={p.forms.find((f) => f.formId === w.grid?.formId)}
        fetchPage={p.fetchPage}
        onOpenRecord={p.onOpenRecord}
      />
    );
  } else if (w.kind === 'actions') {
    const forms = p.submittableForms ?? [];
    body = (
      <div ref={measureBodyRef} className="flex-1 min-h-0 overflow-auto px-4 pb-4">
        {forms.length === 0 ? (
          <WidgetEmpty icon={<Zap className="h-6 w-6 opacity-70" />} text="No quick actions available." />
        ) : (
          <div className="flex flex-wrap gap-2">
            {forms.map((f) => (
              <button
                key={f.formId}
                type="button"
                onClick={() => p.onOpenForm?.(f.formId)}
                disabled={!p.onOpenForm}
                className="group inline-flex min-w-0 items-center gap-2 rounded-full border border-gray-200/80 bg-white py-1.5 pl-2 pr-3.5 text-sm font-medium text-gray-700 transition-colors enabled:cursor-pointer enabled:hover:border-gray-300 enabled:hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 app-ring-primary dark:border-slate-700/60 dark:bg-slate-900/50 dark:text-slate-200 dark:enabled:hover:border-slate-600 dark:enabled:hover:bg-slate-800"
              >
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full app-bg-primary-light">
                  <DynamicIcon name={f.icon} className="h-3.5 w-3.5 app-text-primary" fallback={<Plus className="h-3.5 w-3.5 app-text-primary" />} />
                </span>
                <span className="max-w-[11rem] truncate">{f.displayName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (w.kind === 'activity') {
    body = (
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {p.activity.length === 0 && p.activityError ? (
          <WidgetError canEdit={p.canEdit} detail={p.activityError} />
        ) : p.activity.length === 0 ? (
          <WidgetEmpty icon={<ActivityGlyph className="h-6 w-6 opacity-70" />} text="No recent activity." />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {p.activity.map((row) => (
              <li key={`${row.formId}:${row.id}`}>
                <button
                  type="button"
                  onClick={() => p.onOpenRecord?.(row.formId, row.id)}
                  disabled={!p.onOpenRecord}
                  className="group relative flex w-full items-center gap-3 px-2 py-2.5 text-left rounded-lg transition-colors enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-800/50 enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg app-bg-primary-light">
                    <DynamicIcon name={row.icon} className="h-4 w-4 app-text-primary" fallback={<ArrowRight className="h-4 w-4 app-text-primary" />} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{row.title}</span>
                    <span className="block truncate text-xs text-gray-400 dark:text-slate-500">{row.formName} · {formatRelativeTime(row.submittedAt)}</span>
                  </span>
                  {p.onOpenRecord && <RowChevron />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // Actions widgets in view mode (onNaturalHeight wired) hug their content: the grid rows are
  // quantized, so filling the whole cell would leave a stretch of empty card under the buttons.
  const hugContent = w.kind === 'actions' && !!onNaturalHeight;
  return (
    <div ref={measureCardRef} className={`${CARD} ${hugContent ? 'h-auto max-h-full' : 'h-full'} min-h-0 flex flex-col`}>
      {header}
      {body}
    </div>
  );
}

// ── Shared loading / empty states ───────────────────────────────────────────────

/** Hover-only affordance on clickable rows: absolutely positioned so the rest state stays identical. */
function RowChevron() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-x-0.5 -translate-y-1/2 text-gray-400 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-slate-500"
    />
  );
}

/**
 * Failed report widget. Non-owners see only the quiet generic message; owners/builders (canEdit)
 * additionally get a per-widget Retry and a compact "Details" disclosure showing the SANITIZED
 * error string the run returned (batch runs drop per-spec messages, so Details often appears only
 * after a Retry via the single endpoint surfaces one). When onRetry is absent (the builder's
 * pointer-events-none canvas) the detail renders as static text instead of a click-to-open toggle.
 */
function WidgetError({ canEdit, detail, onRetry, retrying }: { canEdit?: boolean; detail?: string; onRetry?: () => void; retrying?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canEdit) {
    return <WidgetEmpty icon={<AlertCircle className="h-6 w-6 opacity-70" />} text="Couldn't load this widget." />;
  }
  return (
    <div className="flex h-full min-h-[72px] flex-col items-center justify-center overflow-auto py-4 text-center text-gray-400 dark:text-slate-500">
      <AlertCircle className="h-6 w-6 opacity-70" />
      <p className="mt-2 text-sm">Couldn't load this widget.</p>
      {(onRetry || detail) && (
        <div className="mt-1.5 flex items-center gap-3">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex items-center gap-1 rounded text-xs font-medium app-text-primary hover:underline disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />} Retry
            </button>
          )}
          {detail && onRetry && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="rounded text-xs font-medium text-gray-500 dark:text-slate-400 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
      )}
      {detail && (open || !onRetry) && (
        <p className="mt-1.5 max-w-full break-words rounded-md bg-gray-100/80 px-2.5 py-1.5 text-xs text-gray-600 dark:bg-slate-800/60 dark:text-slate-300">
          {detail}
        </p>
      )}
    </div>
  );
}

/** Quiet empty / error state shared by every widget kind. */
function WidgetEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-full min-h-[72px] flex-col items-center justify-center py-6 text-center text-gray-400 dark:text-slate-500">
      {icon}
      <p className="mt-2 text-sm">{text}</p>
    </div>
  );
}

/** Pulsing placeholder shaped like the chart it will become. */
function ReportSkeleton({ viz }: { viz?: string }) {
  const tone = 'bg-gray-100 dark:bg-slate-800';
  if (viz === 'kpi') {
    return (
      <div className="flex h-full animate-pulse flex-col items-center justify-center gap-2.5" aria-hidden="true">
        <div className={`h-9 w-24 rounded-lg ${tone}`} />
        <div className={`h-2 w-14 rounded ${tone}`} />
      </div>
    );
  }
  if (viz === 'pie' || viz === 'donut') {
    return (
      <div className="flex h-full animate-pulse items-center justify-center" aria-hidden="true">
        <div className={`h-28 w-28 max-h-[80%] rounded-full ${tone}`} />
      </div>
    );
  }
  if (viz === 'table') {
    return (
      <div className="flex h-full animate-pulse flex-col justify-center gap-2.5 px-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-3 rounded ${tone}`} style={{ width: `${90 - i * 14}%` }} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-full animate-pulse items-end gap-2 pb-1" aria-hidden="true">
      {[45, 70, 55, 85, 60, 35, 75].map((h, i) => (
        <div key={i} className={`min-h-0 flex-1 rounded-t ${tone}`} style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

/** Pulsing placeholder rows while a list widget fetches. */
function ListSkeleton({ withMeta = false }: { withMeta?: boolean }) {
  return (
    <ul className="animate-pulse divide-y divide-gray-100 dark:divide-slate-800" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3 px-2 py-3">
          <span className="min-w-0 flex-1">
            <span className="mb-1.5 block h-3 w-3/5 rounded bg-gray-100 dark:bg-slate-800" />
            <span className="block h-2.5 w-2/5 rounded bg-gray-100 dark:bg-slate-800" />
          </span>
          {withMeta && <span className="h-3 w-10 shrink-0 rounded bg-gray-100 dark:bg-slate-800" />}
        </li>
      ))}
    </ul>
  );
}
