import { describe, expect, it } from 'vitest';
import type {
  AppReportSpec,
  DashboardScreen,
  DashboardWidget,
  DashboardWidgetKind,
  ReportAccent,
  ReportNumberFormat,
  ReportSeriesOrder,
  WidgetLayout,
} from './app';

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE-TIME type pins for the dashboard/report contracts (task T20).
//
// These lock the shapes the backend save boundary (AppReportService::sanitizeDashboard /
// cleanChartSpec) and the widget renderers agree on: AppReportSpec's presentation fields and
// the DashboardWidget / DashboardScreen shapes. If someone widens DashboardWidgetKind, changes
// refreshInterval to a string, or renames a presentation field, this file stops compiling.
//
// NOTE on enforcement: tsconfig.app.json currently EXCLUDES src/**/*.test.ts from `tsc -b`,
// so these pins bite in editors / IDEs and under `vitest --typecheck`, but NOT in the plain
// `npm run build` typecheck today. The trivial runtime asserts at the bottom keep the file
// exercised by the normal vitest run either way.
// ─────────────────────────────────────────────────────────────────────────────

/** Strict type equality (invariance trick — distinguishes `string` from `'a' | 'b'`, etc.). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// ── AppReportSpec: presentation + optional query additions ───────────────────
export type AppReportSpecPins = [
  Expect<Equal<AppReportSpec['color'], ReportAccent | undefined>>,
  Expect<Equal<ReportAccent, 'primary' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal'>>,
  Expect<Equal<AppReportSpec['format'], ReportNumberFormat | undefined>>,
  Expect<Equal<ReportNumberFormat, 'plain' | 'compact' | 'currency' | 'percent'>>,
  Expect<Equal<AppReportSpec['decimals'], number | undefined>>,
  Expect<Equal<AppReportSpec['prefix'], string | undefined>>,
  Expect<Equal<AppReportSpec['suffix'], string | undefined>>,
  Expect<Equal<AppReportSpec['showDataLabels'], boolean | undefined>>,
  Expect<Equal<AppReportSpec['target'], number | undefined>>,
  Expect<Equal<AppReportSpec['horizontal'], boolean | undefined>>,
  Expect<Equal<AppReportSpec['seriesOrder'], ReportSeriesOrder | undefined>>,
  Expect<Equal<ReportSeriesOrder, 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc'>>,
  Expect<Equal<AppReportSpec['sparkline'], boolean | undefined>>,
  // Query additions that ride next to presentation (server whitelists match these exactly):
  Expect<Equal<AppReportSpec['filterMode'], 'all' | 'any' | undefined>>,
  Expect<Equal<NonNullable<AppReportSpec['dateRange']>['preset'], 'all' | '7d' | '30d' | '90d' | 'thisMonth' | 'ytd'>>,
  Expect<Equal<NonNullable<AppReportSpec['seriesBy']>, { field: string; limit?: number }>>,
];

// ── DashboardWidget / DashboardScreen shapes ─────────────────────────────────
export type DashboardShapePins = [
  // The five host-rendered kinds — nothing that could carry author code (no 'code'/'iframe'/'html').
  Expect<Equal<DashboardWidgetKind, 'report' | 'list' | 'text' | 'actions' | 'activity'>>,
  Expect<Equal<DashboardWidget['kind'], DashboardWidgetKind>>,
  Expect<Equal<DashboardWidget['id'], string>>,
  Expect<Equal<DashboardWidget['title'], string | undefined>>,
  Expect<Equal<DashboardWidget['layout'], WidgetLayout>>,
  Expect<Equal<WidgetLayout, { x: number; y: number; w: number; h: number }>>,
  Expect<Equal<DashboardWidget['spec'], AppReportSpec | undefined>>,
  Expect<Equal<
    DashboardWidget['list'],
    { formId: string; titleField?: string; subtitleField?: string; metaField?: string; limit?: number; linkToRecords?: boolean } | undefined
  >>,
  Expect<Equal<DashboardWidget['text'], { body: string } | undefined>>,
  Expect<Equal<DashboardScreen['version'], 1>>,
  Expect<Equal<DashboardScreen['cols'], number | undefined>>,
  Expect<Equal<DashboardScreen['widgets'], DashboardWidget[]>>,
  Expect<Equal<DashboardScreen['showRangePicker'], boolean | undefined>>,
  Expect<Equal<DashboardScreen['refreshInterval'], number | undefined>>,
];

// ── Canonical literals must satisfy the types (excess/missing keys fail to compile) ──
const canonicalSpec = {
  formId: 'form_1',
  viz: 'bar',
  groupBy: { field: 'status', bucket: 'none' },
  measure: { fn: 'count' },
  filterMode: 'any',
  dateRange: { preset: '30d' },
  seriesBy: { field: 'status', limit: 5 },
  color: 'teal',
  format: 'currency',
  decimals: 2,
  prefix: '$',
  suffix: 'k',
  showDataLabels: true,
  target: 100,
  horizontal: false,
  seriesOrder: 'label_asc',
  sparkline: true,
} satisfies AppReportSpec;

const canonicalDashboard = {
  version: 1,
  cols: 12,
  widgets: [
    { id: 'w1', kind: 'report', layout: { x: 0, y: 0, w: 6, h: 3 }, title: 'By status', spec: canonicalSpec },
    { id: 'w2', kind: 'list', layout: { x: 6, y: 0, w: 6, h: 3 }, list: { formId: 'form_1', titleField: 'status', limit: 6, linkToRecords: true } },
    { id: 'w3', kind: 'text', layout: { x: 0, y: 3, w: 12, h: 1 }, text: { body: 'Notes' } },
    { id: 'w4', kind: 'activity', layout: { x: 0, y: 4, w: 6, h: 2 } },
    { id: 'w5', kind: 'actions', layout: { x: 6, y: 4, w: 6, h: 2 } },
  ],
  showRangePicker: true,
  refreshInterval: 60,
} satisfies DashboardScreen;

// ── Negative pins: if any @ts-expect-error stops erroring, the type WIDENED ──
// @ts-expect-error 'iframe' must never become a DashboardWidgetKind (would bypass the host-rendered trust model)
const forbiddenKind: DashboardWidgetKind = 'iframe';
// @ts-expect-error refreshInterval is a number of seconds, never a string
const forbiddenRefresh: DashboardScreen = { version: 1, widgets: [], refreshInterval: '60s' };
// @ts-expect-error DashboardScreen.version is the literal 1
const forbiddenVersion: DashboardScreen = { version: 2, widgets: [] };
// @ts-expect-error viz enum must not silently accept arbitrary strings
const forbiddenViz: AppReportSpec = { formId: 'f', viz: 'gauge' };

// ── Trivial runtime anchor so the pins ship inside a real vitest file ─────────
describe('app dashboard/report type pins', () => {
  it('canonical literals exist at runtime (the real assertions above are compile-time)', () => {
    expect(canonicalDashboard.version).toBe(1);
    expect(canonicalDashboard.widgets).toHaveLength(5);
    expect(canonicalSpec.viz).toBe('bar');
    // Reference the negative-pin values so they are "used" (they only exist to host @ts-expect-error).
    expect(typeof forbiddenKind).toBe('string');
    expect(forbiddenRefresh.version).toBe(1);
    expect(forbiddenVersion.widgets).toHaveLength(0);
    expect(forbiddenViz.formId).toBe('f');
  });
});
