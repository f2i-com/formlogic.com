import { useMemo, cloneElement, type ReactElement } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
} from 'recharts';
import type { AppReportResult } from '../../types/app';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f43f5e', '#84cc16', '#eab308', '#ec4899', '#06b6d4'];
const PRINT_WIDTH = 660;

const fmt = (n: unknown): string => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/** Read the app's accent + whether we're in dark mode, so charts match the runtime theme. */
function useChartTheme(primaryColor?: string, forceLight = false) {
  return useMemo(() => {
    const isDark = !forceLight && typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    let primary = primaryColor;
    if (!primary && typeof document !== 'undefined') {
      const host = document.querySelector('[data-app-runtime]') as HTMLElement | null;
      primary = host ? getComputedStyle(host).getPropertyValue('--app-primary').trim() : '';
    }
    if (!primary) primary = PALETTE[0];
    // Accent leads the categorical palette (de-duplicated), so single-series charts use the app colour.
    const palette = [primary, ...PALETTE.filter((c) => c.toLowerCase() !== primary!.toLowerCase())];
    return {
      isDark,
      primary,
      palette,
      axis: isDark ? '#94a3b8' : '#64748b',
      grid: isDark ? '#1e293b' : '#e2e8f0',
      tooltip: {
        background: isDark ? '#0f172a' : '#ffffff',
        border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
        borderRadius: 10,
        fontSize: 12,
        color: isDark ? '#e2e8f0' : '#0f172a',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      } as const,
    };
  }, [primaryColor, forceLight]);
}

interface Props {
  result: AppReportResult;
  /** Explicit accent (used by the detached PDF print root, which is outside [data-app-runtime]). */
  primaryColor?: string;
  /** Print mode: fixed dimensions + no animation, so charts are fully drawn before window.print(). */
  print?: boolean;
  /** Fill the parent's height (for fixed-size dashboard widget cells) instead of the intrinsic chart height. */
  fill?: boolean;
}

export function ReportResultView({ result, primaryColor, print = false, fill = false }: Props) {
  const t = useChartTheme(primaryColor, print);

  // KPI ─────────────────────────────────────────────
  if (result.viz === 'kpi') {
    return (
      <div className={print ? 'py-6 text-center' : fill ? 'h-full min-h-0 flex flex-col items-center justify-center text-center' : 'py-10 text-center'}>
        <div className="text-5xl sm:text-6xl font-extrabold tracking-tight text-gray-900 dark:text-white tabular-nums">{fmt(result.value)}</div>
      </div>
    );
  }

  // Table ───────────────────────────────────────────
  if (result.viz === 'table') {
    const cols = result.columns ?? [];
    const rows = result.rows ?? [];
    if (rows.length === 0) return <EmptyResult />;
    return (
      <div className={print ? '' : fill ? 'overflow-auto h-full min-h-0 -mx-1 px-1' : 'overflow-x-auto -mx-1 px-1'}>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-200 dark:border-slate-700">
              {cols.map((c) => (
                <th key={c.id} className="text-left font-semibold text-gray-500 dark:text-slate-400 px-3 py-2 whitespace-nowrap">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-100 dark:border-slate-800 even:bg-gray-50/60 dark:even:bg-slate-800/30">
                {cols.map((c) => (
                  <td key={c.id} className={`px-3 py-2 text-gray-800 dark:text-slate-200 ${print ? '' : 'max-w-[280px] truncate'}`} title={String(r[c.id] ?? '')}>{String(r[c.id] ?? '') || '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Charts ──────────────────────────────────────────
  const series = (result.series ?? []).map((s) => ({ ...s, label: s.label || '—' }));
  if (series.length === 0) return <EmptyResult />;

  // Wrap a chart in fixed dims (print), fill-parent (dashboard widget), or intrinsic height (screen).
  const frame = (height: number, chart: ReactElement) =>
    print
      ? <div style={{ width: PRINT_WIDTH, height }}>{cloneElement(chart as ReactElement<{ width?: number; height?: number }>, { width: PRINT_WIDTH, height })}</div>
      : fill
        ? <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
        : <ResponsiveContainer width="100%" height={height}>{chart}</ResponsiveContainer>;
  const chartWrap = print ? '' : fill ? 'h-full min-h-0' : 'py-1';

  const anim = !print;
  const tick = { fontSize: 12, fill: t.axis };

  if (result.viz === 'line' || result.viz === 'area') {
    const height = print ? 300 : 300;
    const common = (
      <>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: t.grid }} interval="preserveStartEnd" minTickGap={20} />
        <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={44} tickFormatter={(v) => fmt(v)} />
        <Tooltip contentStyle={t.tooltip} formatter={(v) => fmt(v)} cursor={{ stroke: t.grid }} />
      </>
    );
    return (
      <div className={chartWrap}>
        {result.viz === 'area'
          ? frame(height, (
            <AreaChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fl-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={t.primary} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={t.primary} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {common}
              <Area type="monotone" name="Value" dataKey="value" stroke={t.primary} strokeWidth={2.5} fill="url(#fl-area)" isAnimationActive={anim} dot={{ r: 3, fill: t.primary }} activeDot={{ r: 5 }} />
            </AreaChart>
          ))
          : frame(height, (
            <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              {common}
              <Line type="monotone" name="Value" dataKey="value" stroke={t.primary} strokeWidth={2.5} isAnimationActive={anim} dot={{ r: 3, fill: t.primary }} activeDot={{ r: 5 }} />
            </LineChart>
          ))}
      </div>
    );
  }

  if (result.viz === 'pie' || result.viz === 'donut') {
    const total = series.reduce((a, s) => a + s.value, 0) || 1;
    const height = print ? 240 : 260;
    // The legend is rendered as HTML below the chart (not recharts' <Legend>), so it can never
    // overlap the circle — important for the fixed-height PDF export.
    const legendText = print ? 'text-gray-700' : 'text-gray-600 dark:text-slate-300';
    const legendValue = print ? 'text-gray-500' : 'text-gray-400 dark:text-slate-500';
    return (
      <div className={fill ? 'h-full min-h-0 flex flex-col py-1' : chartWrap}>
        <div className={fill ? 'flex-1 min-h-0' : ''}>
        {frame(height, (
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Pie
              data={series}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={result.viz === 'donut' ? '55%' : 0}
              outerRadius="82%"
              paddingAngle={series.length > 1 ? 2 : 0}
              isAnimationActive={anim}
              animationDuration={600}
              label={({ percent }) => (percent && percent > 0.04 ? `${Math.round(percent * 100)}%` : '')}
              labelLine={false}
              stroke={t.isDark ? '#0f172a' : '#ffffff'}
              strokeWidth={2}
            >
              {series.map((_, i) => <Cell key={i} fill={t.palette[i % t.palette.length]} />)}
            </Pie>
            <Tooltip contentStyle={t.tooltip} formatter={(v) => `${fmt(v)} · ${Math.round((Number(v) / total) * 100)}%`} />
          </PieChart>
        ))}
        </div>
        <ul className={`mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5${fill ? ' shrink-0 overflow-auto max-h-20' : ''}`} style={print ? { maxWidth: PRINT_WIDTH } : undefined}>
          {series.map((s, i) => (
            <li key={s.label + i} className="inline-flex items-center gap-1.5 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: t.palette[i % t.palette.length] }} />
              <span className={legendText}>{s.label}</span>
              <span className={`tabular-nums ${legendValue}`}>{fmt(s.value)} · {Math.round((s.value / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // bar (horizontal — labels read left-to-right, wraps well on mobile)
  const barHeight = Math.max(140, Math.min(series.length * 40 + 24, 520));
  const labelWidth = print ? 130 : Math.min(140, Math.max(70, ...series.map((s) => s.label.length * 6.5)));
  return (
    <div className={chartWrap}>
      {frame(barHeight, (
        <BarChart data={series} layout="vertical" margin={{ top: 4, right: 34, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={tick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => fmt(v)} />
          <YAxis type="category" dataKey="label" tick={tick} tickLine={false} axisLine={false} width={labelWidth} />
          <Tooltip contentStyle={t.tooltip} formatter={(v) => fmt(v)} cursor={{ fill: t.isDark ? 'rgba(148,163,184,0.08)' : 'rgba(0,0,0,0.03)' }} />
          <Bar dataKey="value" name="Value" radius={[0, 6, 6, 0]} isAnimationActive={anim} maxBarSize={38}>
            {series.map((_, i) => <Cell key={i} fill={t.palette[i % t.palette.length]} />)}
            <LabelList dataKey="value" position="right" formatter={(v: unknown) => fmt(v)} style={{ fontSize: 11, fill: t.axis }} />
          </Bar>
        </BarChart>
      ))}
    </div>
  );
}

function EmptyResult() {
  return <p className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">No data matches this report yet.</p>;
}
