import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Loader2, Plus, ArrowRight, LayoutGrid } from 'lucide-react';
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

  const data = useWidgetData(widgets, props);

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
      <div style={containerStyle}>
        {widgets.map((w) => (
          <div key={w.id} style={cellStyle(w)} className="min-w-0 min-h-0">
            <WidgetView
              widget={w}
              reportResult={data.reportResults[w.id]}
              reportLoading={data.reportLoading}
              listRows={data.listData[w.id]}
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
  listRows?: WidgetRecord[];
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
          <div className="h-full flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-300 dark:text-slate-600" /></div>
        ) : p.reportResult ? (
          <ReportResultView result={p.reportResult} primaryColor={p.primaryColor} fill />
        ) : (
          <p className="h-full flex items-center justify-center text-center text-sm text-gray-400 dark:text-slate-500">Couldn&apos;t load this widget.</p>
        )}
      </div>
    );
  } else if (w.kind === 'list') {
    const form = p.forms.find((f) => f.formId === w.list?.formId);
    const flds = fieldsOf(form);
    const rows = p.listRows ?? [];
    body = (
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400 dark:text-slate-500">No records yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.map((r) => {
              const title = displayAnswer(flds, r.answers || {}, w.list?.titleField) || autoTitle(flds, r.answers || {});
              const sub = displayAnswer(flds, r.answers || {}, w.list?.subtitleField) || (r.submittedAt ? formatRelativeTime(r.submittedAt) : '');
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => w.list && p.onOpenRecord?.(w.list.formId, r.id)}
                    disabled={!p.onOpenRecord}
                    className="flex w-full items-center gap-3 px-2 py-2.5 text-left rounded-lg transition-colors enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-800/50 enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{title}</span>
                      {sub && <span className="block truncate text-xs text-gray-400 dark:text-slate-500">{sub}</span>}
                    </span>
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
          <p className="py-8 text-center text-sm text-gray-400 dark:text-slate-500">No quick actions available.</p>
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
          <p className="py-8 text-center text-sm text-gray-400 dark:text-slate-500">No recent activity.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {p.activity.map((row) => (
              <li key={`${row.formId}:${row.id}`}>
                <button
                  type="button"
                  onClick={() => p.onOpenRecord?.(row.formId, row.id)}
                  disabled={!p.onOpenRecord}
                  className="flex w-full items-center gap-3 px-2 py-2.5 text-left rounded-lg transition-colors enabled:hover:bg-gray-50 dark:enabled:hover:bg-slate-800/50 enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg app-bg-primary-light">
                    <DynamicIcon name={row.icon} className="h-4 w-4 app-text-primary" fallback={<ArrowRight className="h-4 w-4 app-text-primary" />} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{row.title}</span>
                    <span className="block truncate text-xs text-gray-400 dark:text-slate-500">{row.formName} · {formatRelativeTime(row.submittedAt)}</span>
                  </span>
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
