import { useId, useMemo, useState, cloneElement, type ReactElement } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList, ReferenceLine, Dot,
  type ActiveDotProps,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
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

/** Categorical hues for multi-series charts as [light, dark] pairs — distinct on both surfaces.
 *  The literal 'Other' overflow bucket never uses these; it always gets the muted tone. */
const SERIES_HUES: Array<[string, string]> = [
  ['#4f46e5', '#818cf8'], // indigo
  ['#0284c7', '#38bdf8'], // sky
  ['#059669', '#34d399'], // emerald
  ['#d97706', '#fbbf24'], // amber
  ['#e11d48', '#fb7185'], // rose
  ['#7c3aed', '#a78bfa'], // violet
  ['#0d9488', '#2dd4bf'], // teal
  ['#c026d3', '#e879f9'], // fuchsia
];

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

/** Client-side series re-sort — covers orders the server can't produce (label desc, value order on date buckets).
 *  `getValue` lets pivoted multi-series rows sort by their stacked total instead of a `value` prop. */
function orderSeries<T extends { label: string }>(series: T[], order?: AppReportSpec['seriesOrder'], getValue?: (row: T) => number): T[] {
  if (!order) return series;
  const val = getValue ?? ((row: T) => (row as { label: string; value?: number }).value ?? 0);
  const out = [...series];
  if (order.startsWith('label')) out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  else out.sort((a, b) => val(a) - val(b));
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
      /** Theme-aware categorical colours for multi-series charts: accent leads, then distinct hues. */
      seriesPalette: [accent, ...SERIES_HUES.map((h) => h[isDark ? 1 : 0]).filter((c) => c.toLowerCase() !== accent.toLowerCase())],
      /** Muted tone reserved for the 'Other' overflow bucket. */
      seriesOther: isDark ? '#64748b' : '#9ca3af',
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
  /** When set, chart data points (bars, pie/donut slices, line/area hover points) become clickable and
   *  report the clicked category label (+ series name on stacked/multi-series charts). Absent = exactly
   *  today's inert charts, so print / PDF / public / builder-preview callers are unchanged. */
  onPointClick?: (point: { label: string; series?: string }) => void;
}

export function ReportResultView({ result, spec, primaryColor, print = false, fill = false, onPointClick }: Props) {
  const t = useChartTheme(primaryColor, print, spec?.color);
  // Unique gradient id per chart INSTANCE — a shared id makes every area chart on a dashboard resolve
  // the FIRST widget's <defs> (wrong colour + double-applied opacity), a classic recharts collision.
  const gradId = 'flg' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const vf = useMemo(() => makeFormatter(spec), [spec]);
  const target = typeof spec?.target === 'number' && Number.isFinite(spec.target) ? spec.target : undefined;

  // ── Drill-down affordances — attached ONLY when the caller wires onPointClick (never in print) ──
  const canClick = !!onPointClick && !print;
  // Hovered mark index for the subtle dim on single-series bar / pie cells (inert charts never set it).
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  /** Category label from a recharts click datum (bar entry / pie sector / active dot all carry payload). */
  const pointFrom = (data: unknown, series?: string): { label: string; series?: string } | null => {
    const d = data as { payload?: { label?: unknown }; name?: unknown } | null | undefined;
    const raw = d?.payload?.label ?? d?.name;
    if (raw == null || raw === '' || raw === '—') return null; // '—' = the empty-label placeholder
    return series === undefined ? { label: String(raw) } : { label: String(raw), series };
  };
  const clickPoint = (series?: string) => (data: unknown) => {
    const pt = pointFrom(data, series);
    if (pt && onPointClick) onPointClick(pt);
  };
  /** Click + cursor for Bar/Pie marks (recharts item handlers receive (data, index, event)). */
  const markEvents = (series?: string) => (canClick ? { cursor: 'pointer', onClick: clickPoint(series) } : {});
  /** Hover tracking for charts whose Cells render the dim treatment (single-series bar, pie/donut). */
  const hoverEvents = canClick ? { onMouseEnter: (_: unknown, i: number) => setHoverIdx(i), onMouseLeave: () => setHoverIdx(null) } : {};
  /** Clickable hover dot for line/area points — function form so the dot receives the point's payload. */
  const clickableDot = (r: number, series?: string) => (dp: ActiveDotProps) => (
    <Dot
      {...dp}
      r={r}
      strokeWidth={2}
      stroke={t.surface}
      cursor="pointer"
      onClick={() => { const pt = pointFrom(dp, series); if (pt && onPointClick) onPointClick(pt); }}
    />
  );

  // KPI ─────────────────────────────────────────────
  if (result.viz === 'kpi') {
    // Sparkline (spec.sparkline + a date-bucketed series in the result): the big number stays the
    // total, with a small axis-less trend underneath. Without both pieces the KPI renders as before.
    const sparkRows = spec?.sparkline === true ? (result.series ?? []).map((s) => ({ label: s.label || '—', value: s.value })) : [];
    const hasSpark = sparkRows.length >= 2;
    const value = result.value == null && hasSpark ? sparkRows.reduce((a, s) => a + s.value, 0) : Number(result.value || 0);
    const pct = target !== undefined && target > 0 ? Math.max(0, Math.min(999, Math.round((value / target) * 100))) : null;
    const sparkChart = (w?: number, h?: number) => (
      <AreaChart width={w} height={h} data={sparkRows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`${gradId}sp`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.accent} stopOpacity={0.3} />
            <stop offset="100%" stopColor={t.accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={t.accent} strokeWidth={1.5} fill={`url(#${gradId}sp)`} fillOpacity={1} isAnimationActive={!print} dot={false} activeDot={false} />
      </AreaChart>
    );
    return (
      <div className={print ? 'py-6 text-center' : fill ? 'h-full min-h-0 flex flex-col items-center justify-center text-center' : 'py-10 text-center'}>
        <div
          className={`max-w-full truncate px-2 font-extrabold tracking-tight tabular-nums ${(pct !== null || hasSpark) && fill ? 'text-4xl sm:text-5xl' : 'text-5xl sm:text-6xl'} ${t.hasNamedAccent ? '' : 'text-gray-900 dark:text-white'}`}
          style={t.hasNamedAccent ? { color: t.accent } : undefined}
          title={vf.full(value)}
        >
          {fill ? vf.short(value) : vf.full(value)}
        </div>
        {hasSpark && (
          <div className={`mx-auto mt-2 w-full max-w-[240px] px-2 ${fill ? 'h-8' : 'h-10'}`} aria-hidden="true">
            {print
              ? sparkChart(224, 40)
              : <ResponsiveContainer width="100%" height="100%">{sparkChart()}</ResponsiveContainer>}
          </div>
        )}
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
  const rawSeries = (result.series ?? []).map((s) => ({ ...s, label: s.label || '—' }));
  if (rawSeries.length === 0) return <EmptyResult />;

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

  // ── Multi-series (rows carry `series` — a seriesBy 2nd dimension; bar/line/area only) ──
  // Pivot the flat {label, value, series} rows into one row per label with a column per series,
  // then render stacked bars / one line-area per series. Results without `series` never enter
  // this branch, so single-series charts render exactly as before.
  const hasSeriesDim = rawSeries.some((r) => r.series != null && r.series !== '');
  if (hasSeriesDim && (result.viz === 'bar' || result.viz === 'line' || result.viz === 'area')) {
    // Distinct series names in first-appearance order; the 'Other' overflow bucket goes last.
    const names: string[] = [];
    for (const r of rawSeries) { const n = r.series ?? 'Other'; if (!names.includes(n)) names.push(n); }
    if (names.includes('Other')) { names.splice(names.indexOf('Other'), 1); names.push('Other'); }

    const labels: string[] = [];
    const byLabel = new Map<string, Record<string, number>>();
    for (const r of rawSeries) {
      let rec = byLabel.get(r.label);
      if (!rec) { rec = {}; byLabel.set(r.label, rec); labels.push(r.label); }
      const key = r.series ?? 'Other';
      rec[key] = (rec[key] ?? 0) + r.value;
    }
    type PivotRow = { label: string; __total: number } & Record<string, number | string>;
    const rows = orderSeries(
      labels.map((l) => {
        const rec = byLabel.get(l)!;
        const row: PivotRow = { label: l, __total: 0 };
        for (const n of names) { const v = rec[n] ?? 0; row[n] = v; row.__total += v; }
        return row;
      }),
      spec?.seriesOrder,
      (r) => r.__total
    );

    // Theme-aware categorical colours: accent leads; 'Other' is always the muted tone.
    const colorOf = new Map<string, string>();
    let ci = 0;
    for (const n of names) colorOf.set(n, n === 'Other' ? t.seriesOther : t.seriesPalette[ci++ % t.seriesPalette.length]);

    const multiTooltip = (
      <Tooltip
        content={(tp: unknown) => renderMultiTooltip(tp, vf, t)}
        cursor={result.viz === 'bar' ? { fill: t.isDark ? 'rgba(148,163,184,0.08)' : 'rgba(0,0,0,0.03)' } : { stroke: t.grid }}
      />
    );
    const showTotals = spec?.showDataLabels !== false;

    let chart: ReactElement;
    let height = 300;
    if (result.viz === 'line' || result.viz === 'area') {
      const margin = { top: 8, right: 12, left: 0, bottom: 0 };
      const common = (
        <>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: t.grid }} interval="preserveStartEnd" minTickGap={20} />
          <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={48} tickFormatter={(v) => vf.short(v)} />
          {multiTooltip}
          {target !== undefined && (
            <ReferenceLine y={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTopRight')} />
          )}
        </>
      );
      chart = result.viz === 'area' ? (
        // Flat reduced-opacity fills (no gradient) so overlapping series stay readable.
        <AreaChart data={rows} margin={margin}>
          {common}
          {names.map((n) => (
            <Area key={n} type="monotone" name={n} dataKey={n} stroke={colorOf.get(n)} strokeWidth={2} fill={colorOf.get(n)} fillOpacity={0.14} isAnimationActive={anim} dot={rows.length <= 20 ? { r: 3, fill: colorOf.get(n), stroke: t.surface, strokeWidth: 1.5 } : false} activeDot={canClick ? clickableDot(4, n) : { r: 4, strokeWidth: 2, stroke: t.surface }} />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={rows} margin={margin}>
          {common}
          {names.map((n) => (
            <Line key={n} type="monotone" name={n} dataKey={n} stroke={colorOf.get(n)} strokeWidth={2} isAnimationActive={anim} dot={rows.length <= 20 ? { r: 3, fill: colorOf.get(n), stroke: t.surface, strokeWidth: 1.5 } : false} activeDot={canClick ? clickableDot(4.5, n) : { r: 4.5, strokeWidth: 2, stroke: t.surface }} />
          ))}
        </LineChart>
      );
    } else if (spec?.horizontal === false) {
      // Vertical stacked columns; the stack total labels sit on the top segment.
      chart = (
        <BarChart data={rows} margin={{ top: showTotals ? 22 : 12, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ ...tick, fontSize: 11 }} tickLine={false} axisLine={{ stroke: t.grid }} minTickGap={8} />
          <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={48} tickFormatter={(v) => vf.short(v)} />
          {multiTooltip}
          {target !== undefined && (
            <ReferenceLine y={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTopRight')} />
          )}
          {names.map((n, i) => (
            <Bar key={n} dataKey={n} name={n} stackId="s" fill={colorOf.get(n)} isAnimationActive={anim} maxBarSize={42} radius={i === names.length - 1 ? [6, 6, 0, 0] : undefined} {...markEvents(n)}>
              {showTotals && i === names.length - 1 && (
                <LabelList dataKey="__total" position="top" formatter={(v: unknown) => vf.short(v)} style={labelStyle} />
              )}
            </Bar>
          ))}
        </BarChart>
      );
    } else {
      // Default horizontal stacked rows (same conventions as the single-series bar).
      height = Math.max(140, Math.min(rows.length * 40 + 24, 520));
      const labelWidth = print ? 130 : Math.min(140, Math.max(70, ...rows.map((r) => r.label.length * 6.5)));
      chart = (
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 34, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={tick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v) => vf.short(v)} />
          <YAxis type="category" dataKey="label" tick={tick} tickLine={false} axisLine={false} width={labelWidth} />
          {multiTooltip}
          {target !== undefined && (
            <ReferenceLine x={target} stroke={t.target} strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain" label={targetLabel('insideTop')} />
          )}
          {names.map((n, i) => (
            <Bar key={n} dataKey={n} name={n} stackId="s" fill={colorOf.get(n)} isAnimationActive={anim} maxBarSize={38} radius={i === names.length - 1 ? [0, 6, 6, 0] : undefined} {...markEvents(n)}>
              {showTotals && i === names.length - 1 && (
                <LabelList dataKey="__total" position="right" formatter={(v: unknown) => vf.short(v)} style={{ fontSize: 11, fill: t.axis }} />
              )}
            </Bar>
          ))}
        </BarChart>
      );
    }

    return (
      <div className={fill ? 'h-full min-h-0 flex flex-col py-1' : chartWrap}>
        <div className={fill ? 'flex-1 min-h-0' : ''}>{frame(height, chart)}</div>
        {names.length > 1 && <SeriesLegend names={names} colorOf={colorOf} fill={fill} print={print} />}
      </div>
    );
  }

  const series = orderSeries(rawSeries, spec?.seriesOrder);

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
              <Area type="monotone" name="Value" dataKey="value" stroke={t.accent} strokeWidth={2} fill={`url(#${gradId})`} fillOpacity={1} isAnimationActive={anim} dot={series.length <= 20 ? { r: 3, fill: t.accent, stroke: t.surface, strokeWidth: 1.5 } : false} activeDot={canClick ? clickableDot(4.5) : { r: 4.5, strokeWidth: 2, stroke: t.surface }}>
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
                activeDot={canClick ? clickableDot(5) : { r: 5, strokeWidth: 2, stroke: t.surface }}
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
              {...markEvents()}
              {...hoverEvents}
            >
              {series.map((_, i) => (
                <Cell key={i} fill={t.palette[i % t.palette.length]} cursor={canClick ? 'pointer' : undefined} fillOpacity={canClick && hoverIdx === i ? 0.8 : undefined} />
              ))}
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
  const barCells = series.map((_, i) => (
    <Cell key={i} fill={t.hasNamedAccent ? t.accent : t.palette[i % t.palette.length]} cursor={canClick ? 'pointer' : undefined} fillOpacity={canClick && hoverIdx === i ? 0.8 : undefined} />
  ));

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
            <Bar dataKey="value" name="Value" radius={[6, 6, 0, 0]} isAnimationActive={anim} maxBarSize={42} {...markEvents()} {...hoverEvents}>
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
          <Bar dataKey="value" name="Value" radius={[0, 6, 6, 0]} isAnimationActive={anim} maxBarSize={38} {...markEvents()} {...hoverEvents}>
            {barCells}
            {showBarLabels && <LabelList dataKey="value" position="right" formatter={(v: unknown) => vf.short(v)} style={{ fontSize: 11, fill: t.axis }} />}
          </Bar>
        </BarChart>
      ))}
    </div>
  );
}

function EmptyResult() {
  return (
    <div className="flex h-full min-h-[96px] flex-col items-center justify-center py-8 text-center text-gray-400 dark:text-slate-500">
      <BarChart3 className="mb-2 h-6 w-6 opacity-60" aria-hidden="true" />
      <p className="text-sm">No data matches this report yet.</p>
    </div>
  );
}

type ChartTheme = ReturnType<typeof useChartTheme>;

/** Tooltip for multi-series charts: one line per series (swatch + value) plus a Total row. */
function renderMultiTooltip(props: unknown, vf: ValueFormatter, t: ChartTheme) {
  const { active, payload, label } = props as {
    active?: boolean;
    payload?: Array<{ name?: string | number; value?: number | string; color?: string; dataKey?: string | number }>;
    label?: string | number;
  };
  const items = (payload ?? []).filter((p) => p.dataKey !== '__total');
  if (!active || items.length === 0) return null;
  const total = items.reduce((a, p) => a + (Number(p.value) || 0), 0);
  return (
    <div style={{ ...t.tooltip, minWidth: 150 }}>
      <div style={{ ...t.tooltipLabel, marginBottom: 4 }}>{String(label ?? '')}</div>
      {items.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1.5px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.color, flexShrink: 0 }} />
          <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(p.name ?? '')}</span>
          <span style={{ marginLeft: 'auto', paddingLeft: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{vf.full(p.value)}</span>
        </div>
      ))}
      {items.length > 1 && (
        <div style={{ display: 'flex', marginTop: 5, paddingTop: 5, borderTop: t.tooltip.border, fontWeight: 600 }}>
          <span>Total</span>
          <span style={{ marginLeft: 'auto', paddingLeft: 12, fontVariantNumeric: 'tabular-nums' }}>{vf.full(total)}</span>
        </div>
      )}
    </div>
  );
}

/** Compact HTML legend under multi-series charts (never overlaps the plot, fixed-width-safe in print). */
function SeriesLegend({ names, colorOf, fill, print }: { names: string[]; colorOf: Map<string, string>; fill: boolean; print: boolean }) {
  return (
    <ul
      className={`mt-2 flex flex-wrap justify-center gap-x-3.5 gap-y-1${fill ? ' shrink-0 overflow-auto max-h-14' : ''}`}
      style={print ? { maxWidth: PRINT_WIDTH } : undefined}
    >
      {names.map((n) => (
        <li key={n} className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium ${print ? 'text-gray-600' : 'text-gray-600 dark:text-slate-300'}`}>
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: colorOf.get(n) }} />
          <span className="max-w-[10rem] truncate">{n}</span>
        </li>
      ))}
    </ul>
  );
}
