import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity as ActivityGlyph, AlertCircle, ArrowRight, ChevronRight, Inbox, LayoutGrid, Plus, Zap } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { ReportResultView } from './ReportResultView';
import { formatRelativeTime } from '../../lib/utils';
import type { AppReportResult, DashboardScreen, DashboardWidget } from '../../types/app';
import {
  GRID_ROW, GRID_GAP, DEFAULT_COLS, useWidgetData, fieldsOf, displayAnswer, autoTitle,
  type WidgetDataForm, type WidgetRecord, type ActivityRow, type WidgetDataDeps,
} from './widgetData';

// Re-export the shared data types so existing consumers can import them from here.
export type { WidgetDataForm, WidgetRecord, ActivityRow, WidgetDataDeps } from './widgetData';

const CARD = 'rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50';

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
  className?: string;
}

/** Use matchMedia to collapse the grid to a single column on narrow screens. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function WidgetDashboard(props: WidgetDashboardProps) {
  const { dashboard, forms, scope, accent } = props;
  const narrow = useNarrow();
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

  const data = useWidgetData(effectiveWidgets, props);

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
    const hSpan = Math.max(1, w.layout.h || 1);
    if (narrow) return { height: hSpan * GRID_ROW + (hSpan - 1) * GRID_GAP };
    const x = Math.max(0, Math.min(w.layout.x || 0, cols - wSpan));
    const y = Math.max(0, w.layout.y || 0);
    return { gridColumn: `${x + 1} / span ${wSpan}`, gridRow: `${y + 1} / span ${hSpan}` };
  };

  const containerStyle: CSSProperties = narrow
    ? { display: 'flex', flexDirection: 'column', gap: GRID_GAP }
    : { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${GRID_ROW}px`, gap: GRID_GAP };

  return (
    <div className={props.className ?? 'w-full'}>
      {showPicker && (
        <div className="mb-3 flex justify-end">
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
          <div key={w.id} style={cellStyle(w)} className="min-w-0 min-h-0">
            <WidgetView
              widget={w}
              reportResult={data.reportResults[w.id]}
              reportLoading={data.reportLoading}
              reportRefreshing={data.reportLoading && data.reportResults[w.id] !== undefined}
              listRows={data.listData[w.id]}
              listLoading={w.kind === 'list' && !!w.list?.formId && !!props.fetchRecent && data.listData[w.id] === undefined}
              activity={data.activity}
              forms={forms}
              submittableForms={props.submittableForms}
              primaryColor={primaryColor}
              onOpenForm={props.onOpenForm}
              onOpenRecords={props.onOpenRecords}
              onOpenRecord={props.onOpenRecord}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Single widget view (shared by runtime + builder) ────────────────────────────

export interface WidgetViewProps {
  widget: DashboardWidget;
  reportResult?: AppReportResult | null;
  reportLoading: boolean;
  /** True while a widget re-runs (e.g. a range change) but still shows its previous result. */
  reportRefreshing?: boolean;
  listRows?: WidgetRecord[];
  /** True while this list widget's rows are still being fetched (skeleton instead of empty state). */
  listLoading?: boolean;
  activity: ActivityRow[];
  forms: WidgetDataForm[];
  submittableForms?: WidgetDataForm[];
  primaryColor?: string;
  onOpenForm?: (formId: string) => void;
  onOpenRecords?: (formId: string) => void;
  onOpenRecord?: (formId: string, recordId: string) => void;
}

export function WidgetView(p: WidgetViewProps) {
  const { widget: w } = p;

  // Text widget: a plain note, no card chrome header.
  if (w.kind === 'text') {
    return (
      <div className={`${CARD} h-full min-h-0 p-5 overflow-auto`}>
        {w.title && <h3 className="font-semibold tracking-tight text-gray-900 dark:text-white mb-1.5">{w.title}</h3>}
        <p className="text-sm text-gray-600 dark:text-slate-300 whitespace-pre-wrap">{w.text?.body ?? ''}</p>
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
            <ReportResultView result={p.reportResult} spec={w.spec} primaryColor={p.primaryColor} fill />
          </div>
        ) : (
          <WidgetEmpty icon={<AlertCircle className="h-6 w-6 opacity-70" />} text="Couldn't load this widget." />
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
  } else if (w.kind === 'actions') {
    const forms = p.submittableForms ?? [];
    body = (
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
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
        {p.activity.length === 0 ? (
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

  return (
    <div className={`${CARD} h-full min-h-0 flex flex-col`}>
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
