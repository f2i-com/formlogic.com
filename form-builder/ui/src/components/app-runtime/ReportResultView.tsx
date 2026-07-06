import { useId, useMemo, cloneElement, type ReactElement } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList, ReferenceLine,
} from 'recharts';
import type { AppReportResult, AppReportSpec } from '../../types/app';

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f43f5e', '#84cc16', '#eab308', '#ec4899', '#06b6d4'];
const PRINT_WIDTH = 660;

/** Named accents as [light-mode, dark-mode] pairs so a user-picked colour reads on both surfaces. */
const ACCENTS: Record<string, [string, string]> = {
  blue: ['#2563eb', '#60a5fa'],
  green: ['#059669', '#34d399'],
  amber: ['#d97706', '#fbbf24'],
  red: ['#dc2626', '#f87171'],
  violet: ['#7c3aed', '#a78bfa'],
  teal: ['#0d9488', '#2dd4bf'],
};

/** Locale number with either the legacy auto-decimals or a fixed 0–2 decimal places. */
const numPart = (v: number, d?: number): string =>
  d === undefined
    ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
    : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

/** Compact large numbers (1.2k / 3.4M) so axis ticks, data labels and big KPIs don't clip. */
const compactPart = (v: number, d?: number): string => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: d ?? 1 }) + 'M';
  if (a >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: d ?? 1 }) + 'k';
  return numPart(v, d);
};

interface ValueFormatter {
  /** Full value — tooltips, KPI, legend. */
  full: (v: unknown) => string;
  /** Compact value — axis ticks, data labels, donut centre. */
  short: (v: unknown) => string;
}

/** Build the widget's value formatter from its (optional) presentation options. */
function makeFormatter(spec?: AppReportSpec): ValueFormatter {
  const f = spec?.format;
  const d = spec?.decimals != null && Number.isFinite(spec.decimals) ? Math.max(0, Math.min(2, Math.round(spec.decimals))) : undefined;
  const pre = (spec?.prefix ?? (f === 'currency' ? '$' : '')).slice(0, 8);
  const suf = (spec?.suffix ?? (f === 'percent' ? '%' : '')).slice(0, 8);
  const wrap = (s: string) => `${pre}${s}${suf}`;
  return {
    full: (v) => wrap(f === 'compact' ? compactPart(Number(v || 0), d) : numPart(Number(v || 0), d)),
    short: (v) => wrap(compactPart(Number(v || 0), d)),
  };
}

/** Client-side series re-sort — covers orders the server can't produce (label desc, value order on date buckets). */
function orderSeries<T extends { label: string; value: number }>(series: T[], order?: AppReportSpec['seriesOrder']): T[] {
  if (!order) return series;
  const out = [...series];
  if (order.startsWith('label')) out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  else out.sort((a, b) => a.value - b.value);
  if (order.endsWith('desc')) out.reverse();
  return out;
}

/** Read the app's accent + whether we're in dark mode, so charts match the runtime theme. */
function useChartTheme(primaryColor?: string, forceLight = false, accentName?: string) {
  return useMemo(() => {
    const isDark = !forceLight && typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    let primary = primaryColor;
    if (!primary && typeof document !== 'undefined') {
      const host = document.querySelector('[data-app-runtime]') as HTMLElement | null;
      primary = host ? getComputedStyle(host).getPropertyValue('--app-primary').trim() : '';
    }
    if (!primary) primary = PALETTE[0];
    // A named accent (spec.color) overrides the app colour; 'primary'/unset keeps it.
    const named = accentName && accentName !== 'primary' ? ACCENTS[accentName] : undefined;
    const accent = named ? named[isDark ? 1 : 0] : primary;
    // Accent leads the categorical palette (de-duplicated), so single-series charts use it.
    const palette = [accent, ...PALETTE.filter((c) => c.toLowerCase() !== accent.toLowerCase())];
    return {
      isDark,
      accent,
      /** True when the user explicitly picked a named colour (single-hue bars, tinted KPI). */
      hasNamedAccent: !!named,
      palette,
      axis: isDark ? '#94a3b8' : '#64748b',
      grid: isDark ? '#1e293b' : '#e2e8f0',
      surface: isDark ? '#0f172a' : '#ffffff',
      /** Target reference line ink — warm + dashed so it never reads as a data series. */
      target: isDark ? '#fbbf24' : '#b45309',
      tooltip: {
        background: isDark ? '#0f172a' : '#ffffff',
        border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
        borderRadius: 10,
        fontSize: 12,
        color: isDark ? '#e2e8f0' : '#0f172a',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        padding: '8px 12px',
      } as const,
      tooltipLabel: { color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600, fontSize: 11 } as const,
    };
  }, [primaryColor, forceLight, accentName]);
}

interface Props {
  result: AppReportResult;
  /** The spec that produced the result — read ONLY for presentation options (color/format/target/…). Optional:
   *  callers that don't pass it get exactly the default look. */
  spec?: AppReportSpec;
  /** Explicit accent (used by the detached PDF print root, which is outside [data-app-runtime]). */
  primaryColor?: string;
  /** Print mode: fixed dimensions + no animation, so charts are fully drawn before window.print(). */
  print?: boolean;
  /** Fill the parent's height (for fixed-size dashboard widget cells) instead of the intrinsic chart height. */
  fill?: boolean;
}

export function ReportResultView({ result, spec, primaryColor, print = false, fill = false }: Props) {
  const t = useChartTheme(primaryColor, print, spec?.color);
  // Unique gradient id per chart INSTANCE — a shared id makes every area chart on a dashboard resolve
  // the FIRST widget's <defs> (wrong colour + double-applied opacity), a classic recharts collision.
  const gradId = 'flg' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const vf = useMemo(() => makeFormatter(spec), [spec]);
  const target = typeof spec?.target === 'number' && Number.isFinite(spec.target) ? spec.target : undefined;

  // KPI ─────────────────────────────────────────────
  if (result.viz === 'kpi') {
    const value = Number(result.value || 0);
    const pct = target !== undefined && target > 0 ? Math.max(0, Math.min(999, Math.round((value / target) * 100))) : null;
    return (
      <div className={print ? 'py-6 text-center' : fill ? 'h-full min-h-0 flex flex-col items-center justify-center text-center' : 'py-10 text-center'}>
        <div
          className={`max-w-full truncate px-2 font-extrabold tracking-tight tabular-nums ${pct !== null && fill ? 'text-4xl sm:text-5xl' : 'text-5xl sm:text-6xl'} ${t.hasNamedAccent ? '' : 'text-gray-900 dark:text-white'}`}
          style={t.hasNamedAccent ? { color: t.accent } : undefined}
          title={vf.full(value)}
        >
          {fill ? vf.short(value) : vf.full(value)}
        </div>
        {pct !== null && (
          <div className="mt-2.5 w-full max-w-[240px] mx-auto px-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-slate-800">
              <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: t.accent }} />
            </div>
            <p className="mt-1 text-center text-[11px] tabular-nums text-gray-400 dark:text-slate-500">{pct}% of {vf.full(target)} target</p>
          </div>
        )}
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
  const series = orderSeries((result.series ?? []).map((s) => ({ ...s, label: s.label || '—' })), spec?.seriesOrder);
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
  const labelStyle = { fontSize: 10, fill: t.axis } as const;
  const targetLabel = (position: 'insideTopRight' | 'insideTop') =>
    ({ value: `Target ${vf.short(target)}`, position, fill: t.target, fontSize: 10, fontWeight: 600 } as const);

  if (result.viz === 'line' || result.viz === 'area') {
    const height = 300;
    // Data labels are opt-in on trends (a number on every point is clutter by default).
    const showLabels = spec?.showDataLabels === true;
    const common = (
      <>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: t.grid }} interval="preserveStartEnd" minTickGap={20} />
        <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={48} tickFormatter={(v) => vf.short(v)} />
        <Tooltip contentStyle={t.tooltip} labelStyle={t.tooltipLabel} formatter={(v) => vf.full(v)} cursor={{ stroke: t.grid }} />
        {target !== undefined && (
          <ReferenceLine y={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTopRight')} />
        )}
      </>
    );
    const margin = { top: showLabels ? 18 : 8, right: 12, left: 0, bottom: 0 };
    return (
      <div className={chartWrap}>
        {result.viz === 'area'
          ? frame(height, (
            // AREA reads as area: pronounced gradient wash, thinner stroke, no per-point dots.
            <AreaChart data={series} margin={margin}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={t.accent} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={t.accent} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              {common}
              <Area type="monotone" name="Value" dataKey="value" stroke={t.accent} strokeWidth={2} fill={`url(#${gradId})`} fillOpacity={1} isAnimationActive={anim} dot={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: t.surface }}>
                {showLabels && <LabelList dataKey="value" position="top" formatter={(v: unknown) => vf.short(v)} style={labelStyle} />}
              </Area>
            </AreaChart>
          ))
          : frame(height, (
            // LINE stays crisp: no fill, dots only on short series (surface-ringed so they clear the line).
            <LineChart data={series} margin={margin}>
              {common}
              <Line
                type="monotone"
                name="Value"
                dataKey="value"
                stroke={t.accent}
                strokeWidth={2.5}
                isAnimationActive={anim}
                dot={series.length <= 20 ? { r: 3, fill: t.accent, stroke: t.surface, strokeWidth: 1.5 } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: t.surface }}
              >
                {showLabels && <LabelList dataKey="value" position="top" formatter={(v: unknown) => vf.short(v)} style={labelStyle} />}
              </Line>
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
        {/* inline-block in print: the wrapper shrink-wraps the fixed-width chart so the centre overlay aligns. */}
        <div className={`relative ${fill ? 'flex-1 min-h-0' : print ? 'inline-block' : ''}`}>
        {frame(height, (
          <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Pie
              data={series}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={result.viz === 'donut' ? '52%' : 0}
              outerRadius="74%"
              paddingAngle={series.length > 1 ? 2 : 0}
              isAnimationActive={anim}
              animationDuration={600}
              label={({ percent }) => (series.length > 1 && percent && percent > 0.05 ? `${Math.round(percent * 100)}%` : '')}
              labelLine={false}
              stroke={t.surface}
              strokeWidth={2}
            >
              {series.map((_, i) => <Cell key={i} fill={t.palette[i % t.palette.length]} />)}
            </Pie>
            <Tooltip contentStyle={t.tooltip} formatter={(v) => `${vf.full(v)} · ${Math.round((Number(v) / total) * 100)}%`} />
          </PieChart>
        ))}
        {result.viz === 'donut' && (
          // Total in the donut hole — the headline the ring is a breakdown of.
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={`max-w-[45%] truncate text-lg font-bold tabular-nums ${print ? 'text-gray-900' : 'text-gray-900 dark:text-white'}`} title={vf.full(total)}>{vf.short(total)}</span>
            <span className={`text-[10px] font-medium uppercase tracking-wider ${print ? 'text-gray-400' : 'text-gray-400 dark:text-slate-500'}`}>Total</span>
          </div>
        )}
        </div>
        <ul className={`mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5${fill ? ' shrink-0 overflow-auto max-h-20' : ''}`} style={print ? { maxWidth: PRINT_WIDTH } : undefined}>
          {series.map((s, i) => (
            <li key={s.label + i} className="inline-flex items-center gap-1.5 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: t.palette[i % t.palette.length] }} />
              <span className={legendText}>{s.label}</span>
              <span className={`tabular-nums ${legendValue}`}>{vf.full(s.value)} · {Math.round((s.value / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // bar — horizontal rows by default (labels read left-to-right, wraps well on mobile);
  // spec.horizontal === false renders classic vertical columns instead.
  // Bars show value labels by default (legacy look); showDataLabels: false hides them.
  const showBarLabels = spec?.showDataLabels !== false;
  // One accent per chart when the user picked a colour; the legacy categorical cycle otherwise.
  const barCells = series.map((_, i) => <Cell key={i} fill={t.hasNamedAccent ? t.accent : t.palette[i % t.palette.length]} />);

  if (spec?.horizontal === false) {
    return (
      <div className={chartWrap}>
        {frame(300, (
          <BarChart data={series} margin={{ top: showBarLabels ? 22 : 12, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ ...tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={8} />
            <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={48} tickFormatter={(v) => vf.short(v)} />
            <Tooltip contentStyle={t.tooltip} labelStyle={t.tooltipLabel} formatter={(v) => vf.full(v)} cursor={{ fill: t.isDark ? 'rgba(148,163,184,0.08)' : 'rgba(0,0,0,0.03)' }} />
            {target !== undefined && (
              <ReferenceLine y={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTopRight')} />
            )}
            <Bar dataKey="value" name="Value" radius={[6, 6, 0, 0]} isAnimationActive={anim} maxBarSize={42}>
              {barCells}
              {showBarLabels && <LabelList dataKey="value" position="top" formatter={(v: unknown) => vf.short(v)} style={labelStyle} />}
            </Bar>
          </BarChart>
        ))}
      </div>
    );
  }

  const barHeight = Math.max(140, Math.min(series.length * 40 + 24, 520));
  const labelWidth = print ? 130 : Math.min(140, Math.max(70, ...series.map((s) => s.label.length * 6.5)));
  return (
    <div className={chartWrap}>
      {frame(barHeight, (
        <BarChart data={series} layout="vertical" margin={{ top: 4, right: 34, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={tick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => vf.short(v)} />
          <YAxis type="category" dataKey="label" tick={tick} tickLine={false} axisLine={false} width={labelWidth} />
          <Tooltip contentStyle={t.tooltip} labelStyle={t.tooltipLabel} formatter={(v) => vf.full(v)} cursor={{ fill: t.isDark ? 'rgba(148,163,184,0.08)' : 'rgba(0,0,0,0.03)' }} />
          {target !== undefined && (
            <ReferenceLine x={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTop')} />
          )}
          <Bar dataKey="value" name="Value" radius={[0, 6, 6, 0]} isAnimationActive={anim} maxBarSize={38}>
            {barCells}
            {showBarLabels && <LabelList dataKey="value" position="right" formatter={(v: unknown) => vf.short(v)} style={{ fontSize: 11, fill: t.axis }} />}
          </Bar>
        </BarChart>
      ))}
    </div>
  );
}

function EmptyResult() {
  return <p className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">No data matches this report yet.</p>;
}
