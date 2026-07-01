import type { AppReportResult } from '../../types/app';

const PIE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f43f5e', '#84cc16', '#eab308'];

const fmt = (n: unknown): string => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/** Renders a report result (KPI number, bar list, pie/donut, or data table). Theme-aware. */
export function ReportResultView({ result }: { result: AppReportResult }) {
  if (result.viz === 'kpi') {
    return (
      <div className="py-8 text-center">
        <div className="text-5xl sm:text-6xl font-extrabold tracking-tight text-gray-900 dark:text-white tabular-nums">{fmt(result.value)}</div>
      </div>
    );
  }

  if (result.viz === 'bar') {
    const series = result.series ?? [];
    if (series.length === 0) return <EmptyResult />;
    const max = Math.max(1, ...series.map((s) => s.value));
    return (
      <div className="space-y-3 py-2">
        {series.map((s, i) => (
          <div key={s.label + i} className="grid grid-cols-[minmax(80px,140px)_1fr_auto] items-center gap-3">
            <span className="text-sm text-gray-700 dark:text-slate-300 truncate" title={s.label}>{s.label}</span>
            <div className="h-2.5 rounded-full bg-gray-100 dark:bg-slate-800 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.round((s.value / max) * 100))}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
            </div>
            <span className="text-sm text-gray-500 dark:text-slate-400 tabular-nums text-right">{fmt(s.value)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (result.viz === 'pie') {
    const series = result.series ?? [];
    if (series.length === 0) return <EmptyResult />;
    const total = series.reduce((a, s) => a + s.value, 0) || 1;
    // Cumulative start for each slice, computed without mutating a render-scoped accumulator.
    const startAt = series.map((_, i) => series.slice(0, i).reduce((a, x) => a + x.value, 0));
    const stops = series
      .map((s, i) => `${PIE_COLORS[i % PIE_COLORS.length]} ${(startAt[i] / total) * 100}% ${((startAt[i] + s.value) / total) * 100}%`)
      .join(', ');
    return (
      <div className="flex flex-wrap items-center gap-6 py-4">
        <div
          className="h-40 w-40 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${stops})` }}
          role="img"
          aria-label="Pie chart"
        />
        <div className="space-y-1.5 min-w-0">
          {series.map((s, i) => (
            <div key={s.label + i} className="flex items-center gap-2 text-sm">
              <span className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
              <span className="text-gray-700 dark:text-slate-300 truncate" title={s.label}>{s.label}</span>
              <span className="ml-auto text-gray-500 dark:text-slate-400 tabular-nums">{fmt(s.value)} · {Math.round((s.value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // table
  const cols = result.columns ?? [];
  const rows = result.rows ?? [];
  if (rows.length === 0) return <EmptyResult />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-slate-700">
            {cols.map((c) => (
              <th key={c.id} className="text-left font-semibold text-gray-500 dark:text-slate-400 px-3 py-2 whitespace-nowrap">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-100 dark:border-slate-800">
              {cols.map((c) => (
                <td key={c.id} className="px-3 py-2 text-gray-800 dark:text-slate-200 max-w-[280px] truncate" title={String(r[c.id] ?? '')}>{String(r[c.id] ?? '') || '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyResult() {
  return <p className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">No data matches this report yet.</p>;
}
