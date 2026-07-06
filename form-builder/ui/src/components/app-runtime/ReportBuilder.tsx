import { useState, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Loader2, Plus, X, BarChart3, LineChart, AreaChart, PieChart, CircleDot, Hash, Table2 } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportSpec, AppReportResult, ReportViz, ReportAccent, ReportNumberFormat, ReportSeriesOrder, AppRuntimeForm } from '../../types/app';
import { ReportResultView } from './ReportResultView';

type Field = { id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }>; targetFormId?: string; allowMultiple?: boolean } };
type FieldOpt = { ref: string; label: string; type: string; properties?: Field['properties'] };
type Filter = { field: string; op: string; value: string };
type Join = { via: string; formId: string; type: 'inner' | 'left' };

const LAYOUT_TYPES = ['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload'];
const CHOICE_TYPES = ['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio'];
const DATE_TYPES = ['date', 'datetime'];
const NUMERIC_TYPES = ['number', 'rating', 'scale'];
const SERIES_VIZ: ReportViz[] = ['bar', 'line', 'area', 'pie', 'donut'];

const VIZ_OPTIONS: Array<{ v: ReportViz; label: string; Icon: typeof BarChart3 }> = [
  { v: 'bar', label: 'Bar', Icon: BarChart3 },
  { v: 'line', label: 'Line', Icon: LineChart },
  { v: 'area', label: 'Area', Icon: AreaChart },
  { v: 'pie', label: 'Pie', Icon: PieChart },
  { v: 'donut', label: 'Donut', Icon: CircleDot },
  { v: 'kpi', label: 'Number', Icon: Hash },
  { v: 'table', label: 'Table', Icon: Table2 },
];

/** Colour swatches: 'App colour' (unset) + the named accent palette; charts resolve light/dark hues. */
const ACCENT_SWATCHES: Array<{ key: ReportAccent | undefined; label: string; swatch: string }> = [
  { key: undefined, label: 'App colour', swatch: 'var(--app-primary, #6366f1)' },
  { key: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { key: 'green', label: 'Green', swatch: '#10b981' },
  { key: 'amber', label: 'Amber', swatch: '#f59e0b' },
  { key: 'red', label: 'Red', swatch: '#ef4444' },
  { key: 'violet', label: 'Violet', swatch: '#8b5cf6' },
  { key: 'teal', label: 'Teal', swatch: '#14b8a6' },
];

// Submission time + workflow status are always-available dimensions (server pseudo-fields).
const PSEUDO_FIELDS: FieldOpt[] = [
  { ref: '__submitted_at', label: 'Submitted date', type: 'datetime' },
  { ref: '__status', label: 'Status', type: 'short_text' },
];

const MULTI_CHOICE_TYPES = ['multiple_choice', 'checkbox', 'checkboxes'];

const OP_LABELS: Record<string, string> = {
  eq: 'is', ne: 'is not', contains: 'contains', gt: '>', lt: '<', gte: '≥', lte: '≤',
  has: 'includes', not_has: "doesn't include",
  last_n_days: 'in last (days)', this_month: 'this month', this_year: 'this year', today: 'today',
  notempty: 'is answered', empty: 'is blank',
};

function opsForType(type: string): string[] {
  if (NUMERIC_TYPES.includes(type)) return ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'notempty', 'empty'];
  if (DATE_TYPES.includes(type)) return ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'last_n_days', 'this_month', 'this_year', 'today', 'notempty', 'empty'];
  // Multi-select fields store an array → membership ("includes"), not equality.
  if (MULTI_CHOICE_TYPES.includes(type)) return ['has', 'not_has', 'notempty', 'empty'];
  if (CHOICE_TYPES.includes(type)) return ['eq', 'ne', 'notempty', 'empty'];
  return ['eq', 'ne', 'contains', 'notempty', 'empty'];
}
const NO_VALUE_OPS = ['empty', 'notempty', 'this_month', 'this_year', 'today'];

const uid = () => 'rep_' + Math.random().toString(36).slice(2, 10);

/** Labelled section divider so the editor reads as Data → Display → Format. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h4 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
        {title}
        <span aria-hidden="true" className="h-px flex-1 bg-gray-200 dark:bg-slate-800" />
      </h4>
      {children}
    </section>
  );
}

/**
 * No-code report builder. Live-previews as you change controls; saves a builder-type report.
 * Defaults to the app-runtime store, but `forms`/`runReport` can be injected so the same editor drives
 * form-scoped and public dashboards (Phase 3) — nothing here is app-specific beyond those two deps.
 */
export function ReportBuilder({ report, onClose, onSave, forms: formsProp, runReport: runReportProp }: {
  report: AppReport | null;
  onClose: () => void;
  onSave: (r: AppReport) => void;
  forms?: AppRuntimeForm[];
  runReport?: (spec: AppReportSpec) => Promise<AppReportResult | null>;
}) {
  const store = useAppRuntimeStore();
  const forms = useMemo(() => formsProp ?? store.config?.forms ?? [], [formsProp, store.config]);
  const runReport = runReportProp ?? store.runReport;

  const initSpec = report?.spec;
  const [name, setName] = useState(report?.name ?? '');
  const [description, setDescription] = useState(report?.description ?? '');
  const [formId, setFormId] = useState(initSpec?.formId ?? forms[0]?.formId ?? '');
  const [viz, setViz] = useState<ReportViz>(initSpec?.viz ?? 'bar');
  const [groupField, setGroupField] = useState(initSpec?.groupBy?.field ?? '');
  const [bucket, setBucket] = useState<NonNullable<AppReportSpec['groupBy']>['bucket']>(initSpec?.groupBy?.bucket ?? 'month');
  const [measureFn, setMeasureFn] = useState<NonNullable<AppReportSpec['measure']>['fn']>(initSpec?.measure?.fn ?? 'count');
  const [measureField, setMeasureField] = useState(initSpec?.measure?.field ?? '');
  const [columns, setColumns] = useState<string[]>(initSpec?.columns ?? []);
  const [filters, setFilters] = useState<Filter[]>((initSpec?.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: String(f.value ?? '') })));
  const [limit, setLimit] = useState(initSpec?.limit ?? 100);
  const [joins, setJoins] = useState<Join[]>((initSpec?.joins as Join[]) ?? []);
  const initTableSort = (initSpec?.sort && typeof initSpec.sort === 'object') ? initSpec.sort as { by: string; dir: 'asc' | 'desc' } : { by: '__submitted_at', dir: 'desc' as const };
  const [tableSort, setTableSort] = useState<{ by: string; dir: 'asc' | 'desc' }>(initTableSort);

  // Presentation options (all optional; unset = the default look). Legacy `seriesSort: 'label'` maps
  // onto the 4-way order so old reports open with the control reflecting how they already render.
  const [accent, setAccent] = useState<ReportAccent | undefined>(initSpec?.color);
  const [numFormat, setNumFormat] = useState<ReportNumberFormat | undefined>(initSpec?.format);
  const [decimals, setDecimals] = useState<number | undefined>(initSpec?.decimals);
  const [prefix, setPrefix] = useState(initSpec?.prefix ?? '');
  const [suffix, setSuffix] = useState(initSpec?.suffix ?? '');
  const [dataLabels, setDataLabels] = useState<boolean | undefined>(initSpec?.showDataLabels);
  const [target, setTarget] = useState<string>(typeof initSpec?.target === 'number' ? String(initSpec.target) : '');
  const [horizontal, setHorizontal] = useState<boolean | undefined>(initSpec?.horizontal);
  const [seriesOrder, setSeriesOrder] = useState<ReportSeriesOrder | 'auto'>(
    initSpec?.seriesOrder ?? (initSpec?.seriesSort === 'label' ? 'label_asc' : 'auto')
  );

  const isSeries = SERIES_VIZ.includes(viz);
  const isCartesian = viz === 'bar' || viz === 'line' || viz === 'area';

  const baseForm = useMemo(() => forms.find((x) => x.formId === formId), [forms, formId]);
  const baseFields: Field[] = useMemo(() => ((baseForm?.fields ?? []) as Field[]).filter((fl) => !LAYOUT_TYPES.includes(fl.type)), [baseForm]);
  const linkedFields: Field[] = useMemo(
    () => ((baseForm?.fields ?? []) as Field[]).filter((f) => f.type === 'linked_record' && f.properties?.targetFormId && forms.some((x) => x.formId === f.properties?.targetFormId)),
    [baseForm, forms]
  );

  // All selectable refs: base fields, pseudo-fields, and fields of each joined form ("<formId>::<id>").
  const allFields: FieldOpt[] = useMemo(() => {
    const base: FieldOpt[] = baseFields.map((f) => ({ ref: f.id, label: f.label, type: f.type, properties: f.properties }));
    const joined: FieldOpt[] = joins.flatMap((j) => {
      const tf = forms.find((x) => x.formId === j.formId);
      if (!tf) return [];
      return ((tf.fields ?? []) as Field[])
        .filter((fl) => !LAYOUT_TYPES.includes(fl.type))
        .map((f) => ({ ref: `${j.formId}::${f.id}`, label: `${tf.displayName} · ${f.label}`, type: f.type, properties: f.properties }));
    });
    return [...base, ...PSEUDO_FIELDS, ...joined];
  }, [baseFields, joins, forms]);

  const fieldByRef = useMemo(() => Object.fromEntries(allFields.map((f) => [f.ref, f])), [allFields]);
  const groupable = allFields.filter((f) => CHOICE_TYPES.includes(f.type) || DATE_TYPES.includes(f.type) || f.type === 'short_text');
  const numberFields = allFields.filter((f) => NUMERIC_TYPES.includes(f.type));
  const measureNeedsField = measureFn !== 'count';
  const measureFieldOptions = measureFn === 'countDistinct' ? allFields.filter((f) => f.ref !== '__submitted_at') : numberFields;
  const groupIsDate = DATE_TYPES.includes(fieldByRef[groupField]?.type ?? '');

  // Changing the source form invalidates everything that referenced it.
  const prevFormRef = useRef(formId);
  useEffect(() => {
    if (prevFormRef.current !== formId) {
      prevFormRef.current = formId;
      setJoins([]); setGroupField(''); setMeasureField(''); setColumns([]); setFilters([]);
      setTableSort({ by: '__submitted_at', dir: 'desc' });
    }
  }, [formId]);

  // Default group/column choices when the form/viz changes and nothing is set yet.
  useEffect(() => {
    if (isSeries && !groupable.some((g) => g.ref === groupField)) {
      setGroupField(groupable[0]?.ref ?? '');
    }
    if (viz === 'table' && columns.length === 0) {
      setColumns(baseFields.slice(0, 4).map((f) => f.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId, viz]);

  // Removing a join prunes any refs that pointed at it.
  const removeJoin = (via: string, joinFormId: string) => {
    const prefix2 = `${joinFormId}::`;
    setJoins((js) => js.filter((j) => !(j.via === via && j.formId === joinFormId)));
    setColumns((c) => c.filter((r) => !r.startsWith(prefix2)));
    setFilters((fs) => fs.filter((f) => !f.field.startsWith(prefix2)));
    setGroupField((g) => (g.startsWith(prefix2) ? '' : g));
    setMeasureField((m) => (m.startsWith(prefix2) ? '' : m));
  };

  // The QUERY part of the spec — the only part that requires a server round-trip when it changes.
  const querySpec: AppReportSpec = useMemo(() => {
    const base: AppReportSpec = { formId, viz, filters: filters.filter((f) => f.field), limit };
    if (joins.length) base.joins = joins;
    if (isSeries) {
      base.groupBy = { field: groupField, bucket: groupIsDate ? bucket : 'none' };
      base.measure = { fn: measureFn, field: measureField };
      // The server order also decides which rows survive the Top-N cut, so map the 4-way sort onto it.
      base.seriesSort = seriesOrder.startsWith('label') ? 'label' : 'value';
      base.sort = seriesOrder.endsWith('_asc') ? 'asc' : 'desc';
    }
    if (viz === 'kpi') base.measure = { fn: measureFn, field: measureField };
    if (viz === 'table') { base.sort = tableSort; base.columns = columns; }
    return base;
  }, [formId, viz, isSeries, joins, groupField, groupIsDate, bucket, measureFn, measureField, columns, filters, limit, seriesOrder, tableSort]);

  // Full spec = query + presentation. Presentation-only edits re-render the preview instantly
  // (no refetch) because the fetch effect below is keyed on querySpec alone.
  const spec: AppReportSpec = useMemo(() => {
    const s: AppReportSpec = { ...querySpec };
    if (accent) s.color = accent;
    if (numFormat) s.format = numFormat;
    if (decimals !== undefined) s.decimals = decimals;
    const pre = prefix.trim();
    if (pre) s.prefix = pre.slice(0, 8);
    const suf = suffix.trim();
    if (suf) s.suffix = suf.slice(0, 8);
    if (dataLabels !== undefined) s.showDataLabels = dataLabels;
    const tgt = target.trim() === '' ? NaN : Number(target);
    if (Number.isFinite(tgt)) s.target = tgt;
    if (viz === 'bar' && horizontal === false) s.horizontal = false;
    if (isSeries && seriesOrder !== 'auto') s.seriesOrder = seriesOrder;
    return s;
  }, [querySpec, accent, numFormat, decimals, prefix, suffix, dataLabels, target, horizontal, seriesOrder, viz, isSeries]);

  const [preview, setPreview] = useState<AppReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  // Debounced live preview with stale-result protection.
  useEffect(() => {
    if (!formId) return;
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      const seq = ++seqRef.current;
      (async () => {
        setRunning(true);
        setPreviewErr(null);
        try {
          const res = await runReport(querySpec);
          if (seq === seqRef.current) setPreview(res);
        } catch {
          if (seq === seqRef.current) { setPreviewErr('Could not run this report.'); setPreview(null); }
        } finally {
          if (seq === seqRef.current) setRunning(false);
        }
      })();
    }, 350);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [querySpec, formId, runReport]);

  const canSave =
    name.trim().length > 0 && !!formId &&
    (!isSeries || !!groupField) &&
    (!measureNeedsField || !!measureField);

  const handleSave = () => {
    if (!canSave) return;
    onSave({ id: report?.id ?? uid(), name: name.trim(), description: description.trim() || undefined, type: 'builder', spec });
  };

  const fieldCls = 'w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 app-ring-primary focus:border-transparent transition-shadow';
  const selCls = 'rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-2.5 py-1.5 focus:outline-none focus:ring-2 app-ring-primary';
  const sectionLabel = 'text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500';
  const segBtn = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${active ? 'app-bg-primary-light app-text-primary' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`;

  const labelsOn = dataLabels ?? (viz === 'bar');

  return (
    <Modal isOpen onClose={onClose} title={report ? 'Edit report' : 'New report'} size="2xl">
      <div className="flex flex-col-reverse lg:grid lg:grid-cols-[minmax(0,360px)_1fr] max-h-[82dvh] lg:max-h-[76dvh] min-h-0">
        {/* Controls */}
        <div className="p-5 space-y-6 overflow-y-auto flex-1 min-h-0 lg:border-r border-gray-200 dark:border-slate-800">
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className={sectionLabel}>Report name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Revenue by month" className={`mt-1.5 ${fieldCls}`} />
            </div>
            <div>
              <label className={sectionLabel}>Description <span className="normal-case font-normal text-gray-400">(optional)</span></label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this report shows" className={`mt-1.5 ${fieldCls}`} />
            </div>
          </div>

          {/* ── Data: where the numbers come from ── */}
          <Section title="Data">
          <div>
            <label className={sectionLabel}>Data from</label>
            <select value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="Source form" className={`mt-1.5 ${fieldCls}`}>
              {forms.map((f) => <option key={f.formId} value={f.formId}>{f.displayName}</option>)}
            </select>
          </div>

          {linkedFields.length > 0 && (
            <div>
              <label className={sectionLabel}>Related data</label>
              <div className="mt-1.5 space-y-2">
                {linkedFields.map((lf) => {
                  const targetId = lf.properties?.targetFormId as string;
                  const tf = forms.find((x) => x.formId === targetId);
                  const join = joins.find((j) => j.via === lf.id && j.formId === targetId);
                  return (
                    <div key={lf.id} className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer flex-1 min-w-0">
                        <input type="checkbox" className="app-accent rounded shrink-0" checked={!!join} onChange={(e) => e.target.checked ? setJoins((js) => [...js.filter((j) => !(j.via === lf.id)), { via: lf.id, formId: targetId, type: 'left' as const }]) : removeJoin(lf.id, targetId)} />
                        <span className="truncate">{tf?.displayName ?? 'Related'} <span className="text-gray-400 dark:text-slate-500">· via {lf.label}</span></span>
                      </label>
                      {join && (
                        <select value={join.type} onChange={(e) => setJoins((js) => js.map((j) => j.via === lf.id && j.formId === targetId ? { ...j, type: e.target.value as 'inner' | 'left' } : j))} className={selCls} aria-label="Join type">
                          <option value="left">Include all</option>
                          <option value="inner">Only matched</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1.5">Pull in fields from linked forms to group by or list alongside.</p>
            </div>
          )}

          {isSeries && (
            <div className="space-y-3 rounded-xl bg-gray-50 dark:bg-slate-950/40 p-3.5 border border-gray-100 dark:border-slate-800">
              <div>
                <label className={sectionLabel}>Group by</label>
                {groupable.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">This form has no fields to group by — pick a different form or add a choice/date field.</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <select value={groupField} onChange={(e) => setGroupField(e.target.value)} aria-label="Group by field" className={`${selCls} flex-1 min-w-[140px]`}>
                      {groupable.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                    </select>
                    {groupIsDate && (
                      <select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)} aria-label="Date bucket" className={selCls}>
                        <option value="day">By day</option><option value="month">By month</option><option value="year">By year</option>
                      </select>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-2">
                  <label className="text-xs text-gray-500 dark:text-slate-400">Show top</label>
                  <input type="number" min={1} max={50} value={Math.min(limit, 50)} onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 10)))} aria-label="Show top N" className={`w-16 ${selCls}`} />
                  <span className="text-xs text-gray-400 dark:text-slate-500">groups</span>
                </div>
              </div>
              <div>
                <label className={sectionLabel}>Measure</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <select value={measureFn} onChange={(e) => setMeasureFn(e.target.value as typeof measureFn)} aria-label="Measure function" className={selCls}>
                    <option value="count">Count</option><option value="countDistinct">Unique count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option>
                  </select>
                  {measureNeedsField && (
                    <select value={measureField} onChange={(e) => setMeasureField(e.target.value)} aria-label="Measure field" className={`${selCls} flex-1 min-w-[140px]`}>
                      <option value="">Select field…</option>
                      {measureFieldOptions.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                    </select>
                  )}
                </div>
                {measureNeedsField && !measureField && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Choose a field to {measureFn === 'countDistinct' ? 'count uniquely' : measureFn}.</p>}
                {measureFn !== 'count' && measureFn !== 'countDistinct' && numberFields.length === 0 && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">This form has no number fields to {measureFn}.</p>}
              </div>
            </div>
          )}

          {viz === 'kpi' && (
            <div>
              <label className={sectionLabel}>Measure</label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <select value={measureFn} onChange={(e) => setMeasureFn(e.target.value as typeof measureFn)} aria-label="Measure function" className={selCls}>
                  <option value="count">Count</option><option value="countDistinct">Unique count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option>
                </select>
                {measureNeedsField && (
                  <select value={measureField} onChange={(e) => setMeasureField(e.target.value)} aria-label="Measure field" className={`${selCls} flex-1 min-w-[140px]`}>
                    <option value="">Select field…</option>
                    {measureFieldOptions.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                  </select>
                )}
              </div>
              {measureNeedsField && !measureField && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Choose a field to {measureFn === 'countDistinct' ? 'count uniquely' : measureFn}.</p>}
            </div>
          )}

          {viz === 'table' && (
            <div>
              <label className={sectionLabel}>Columns</label>
              <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 p-2 space-y-1">
                {allFields.map((f) => (
                  <label key={f.ref} className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" className="app-accent rounded" checked={columns.includes(f.ref)} onChange={(e) => setColumns((c) => e.target.checked ? [...c, f.ref] : c.filter((x) => x !== f.ref))} />
                    <span className="truncate">{f.label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Sort by</span>
                <select value={tableSort.by} onChange={(e) => setTableSort((s) => ({ ...s, by: e.target.value }))} aria-label="Sort column" className={selCls}>
                  <option value="__submitted_at">Submitted date</option>
                  {columns.map((r) => <option key={r} value={r}>{fieldByRef[r]?.label ?? r}</option>)}
                </select>
                <select value={tableSort.dir} onChange={(e) => setTableSort((s) => ({ ...s, dir: e.target.value as 'asc' | 'desc' }))} aria-label="Sort direction" className={selCls}>
                  <option value="desc">Newest / high→low</option><option value="asc">Oldest / low→high</option>
                </select>
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400 ml-auto">Max rows</span>
                <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))} aria-label="Max rows" className={`w-20 ${selCls}`} />
              </div>
            </div>
          )}

          {/* Filters */}
          <div>
            <label className={sectionLabel}>Filters</label>
            <div className="mt-1.5 space-y-2">
              {filters.map((flt, i) => {
                const fld = fieldByRef[flt.field];
                const ops = fld ? opsForType(fld.type) : ['eq', 'ne', 'contains', 'notempty', 'empty'];
                const needsValue = !NO_VALUE_OPS.includes(flt.op);
                const opts = fld?.properties?.options ?? [];
                const inputType = flt.op === 'last_n_days' || NUMERIC_TYPES.includes(fld?.type ?? '') ? 'number' : (DATE_TYPES.includes(fld?.type ?? '') ? 'date' : 'text');
                const set = (patch: Partial<Filter>) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, ...patch } : x));
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={flt.field} aria-label="Filter field" onChange={(e) => { const nf = fieldByRef[e.target.value]; const nops = nf ? opsForType(nf.type) : ['eq']; set({ field: e.target.value, op: nops.includes(flt.op) ? flt.op : nops[0], value: '' }); }} className={`${selCls} flex-1 min-w-0`}>
                      <option value="">Field…</option>
                      {allFields.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                    </select>
                    <select value={flt.op} aria-label="Filter condition" onChange={(e) => set({ op: e.target.value })} className={selCls}>
                      {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                    </select>
                    {needsValue && (opts.length > 0 && flt.op !== 'contains' ? (
                      <select value={flt.value} aria-label="Filter value" onChange={(e) => set({ value: e.target.value })} className={`${selCls} flex-1 min-w-0`}>
                        <option value="">Value…</option>
                        {opts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                      </select>
                    ) : (
                      <input type={inputType} value={flt.value} aria-label="Filter value" onChange={(e) => set({ value: e.target.value })} placeholder={flt.op === 'last_n_days' ? 'days' : 'Value'} className={`${selCls} flex-1 min-w-0`} />
                    ))}
                    <button type="button" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove filter" className="p-1 text-gray-400 hover:text-red-500 cursor-pointer"><X className="h-4 w-4" /></button>
                  </div>
                );
              })}
              <button type="button" onClick={() => setFilters((fs) => [...fs, { field: '', op: 'eq', value: '' }])} className="inline-flex items-center gap-1 text-xs font-medium app-text-primary hover:underline cursor-pointer"><Plus className="h-3.5 w-3.5" /> Add filter</button>
            </div>
          </div>
          </Section>

          {/* ── Display: how it looks ── */}
          <Section title="Display">
          <div>
            <label className={sectionLabel}>Chart type</label>
            <div className="mt-1.5 grid grid-cols-4 sm:grid-cols-7 lg:grid-cols-4 xl:grid-cols-7 gap-1.5" role="group" aria-label="Chart type">
              {VIZ_OPTIONS.map(({ v, label, Icon }) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={viz === v}
                  onClick={() => setViz(v)}
                  className={`flex flex-col items-center gap-1 rounded-lg border py-2 px-1 text-[11px] font-medium cursor-pointer transition-colors ${viz === v ? 'app-bg-primary-light app-border-primary app-text-primary' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {viz !== 'table' && (
            <div>
              <label className={sectionLabel}>Colour</label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2" role="group" aria-label="Chart colour">
                {ACCENT_SWATCHES.map((s) => {
                  const selected = accent === s.key;
                  return (
                    <button
                      key={s.label}
                      type="button"
                      title={s.label}
                      aria-label={`Colour: ${s.label}`}
                      aria-pressed={selected}
                      onClick={() => setAccent(s.key)}
                      className={`h-7 w-7 rounded-full cursor-pointer transition-shadow ring-offset-2 ring-offset-white dark:ring-offset-slate-900 ${selected ? 'ring-2 ring-gray-800 dark:ring-white' : 'hover:ring-2 hover:ring-gray-300 dark:hover:ring-slate-600'}`}
                      style={{ backgroundColor: s.swatch }}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {viz === 'bar' && (
            <div>
              <label className={sectionLabel}>Bar direction</label>
              <div className="mt-1.5 inline-flex rounded-lg border border-gray-200 dark:border-slate-700 p-0.5" role="group" aria-label="Bar direction">
                <button type="button" aria-pressed={horizontal !== false} onClick={() => setHorizontal(undefined)} className={segBtn(horizontal !== false)}>Horizontal</button>
                <button type="button" aria-pressed={horizontal === false} onClick={() => setHorizontal(false)} className={segBtn(horizontal === false)}>Vertical</button>
              </div>
            </div>
          )}

          {isCartesian && (
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
              <input type="checkbox" className="app-accent rounded" checked={labelsOn} onChange={(e) => setDataLabels(e.target.checked)} />
              Show value labels on the chart
            </label>
          )}

          {(isCartesian || viz === 'kpi') && (
            <div>
              <label className={sectionLabel}>Target <span className="normal-case font-normal text-gray-400">(optional)</span></label>
              <input
                type="number"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={viz === 'kpi' ? 'e.g. 100 — shows progress toward it' : 'e.g. 100 — draws a dashed goal line'}
                aria-label="Target value"
                className={`mt-1.5 ${fieldCls}`}
              />
            </div>
          )}
          </Section>

          {/* ── Format: how numbers read ── */}
          {viz !== 'table' && (
            <Section title="Format">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={sectionLabel}>Numbers</label>
                <select
                  value={numFormat ?? ''}
                  onChange={(e) => setNumFormat((e.target.value || undefined) as ReportNumberFormat | undefined)}
                  aria-label="Number format"
                  className={`mt-1.5 w-full ${selCls}`}
                >
                  <option value="">Auto</option>
                  <option value="plain">Plain · 1,234</option>
                  <option value="compact">Compact · 1.2k</option>
                  <option value="currency">Currency · $1,234</option>
                  <option value="percent">Percent · 42%</option>
                </select>
              </div>
              <div>
                <label className={sectionLabel}>Decimals</label>
                <select
                  value={decimals === undefined ? '' : String(decimals)}
                  onChange={(e) => setDecimals(e.target.value === '' ? undefined : Number(e.target.value))}
                  aria-label="Decimal places"
                  className={`mt-1.5 w-full ${selCls}`}
                >
                  <option value="">Auto</option>
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </div>
              <div>
                <label className={sectionLabel}>Prefix</label>
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={8} placeholder="e.g. €" aria-label="Value prefix" className={`mt-1.5 w-full ${selCls}`} />
              </div>
              <div>
                <label className={sectionLabel}>Suffix</label>
                <input value={suffix} onChange={(e) => setSuffix(e.target.value)} maxLength={8} placeholder="e.g. kg" aria-label="Value suffix" className={`mt-1.5 w-full ${selCls}`} />
              </div>
            </div>
            {isSeries && (
              <div>
                <label className={sectionLabel}>Sort</label>
                <select
                  value={seriesOrder}
                  onChange={(e) => setSeriesOrder(e.target.value as ReportSeriesOrder | 'auto')}
                  aria-label="Series order"
                  className={`mt-1.5 w-full ${selCls}`}
                >
                  <option value="auto">Auto — largest first (dates in order)</option>
                  <option value="value_desc">Value · high → low</option>
                  <option value="value_asc">Value · low → high</option>
                  <option value="label_asc">Label · A → Z</option>
                  <option value="label_desc">Label · Z → A</option>
                </select>
              </div>
            )}
            </Section>
          )}
        </div>

        {/* Live preview — capped + on top on mobile, full right column on desktop */}
        <div className="p-5 overflow-y-auto bg-gray-50/60 dark:bg-slate-950/40 max-h-[42dvh] lg:max-h-none shrink-0 border-b lg:border-b-0 border-gray-200 dark:border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{name.trim() || 'Live preview'}</h3>
              {description.trim() && <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{description.trim()}</p>}
            </div>
            {running && <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />}
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 min-h-[220px] flex flex-col justify-center">
            {previewErr ? (
              <p className="py-10 text-center text-sm text-red-500">{previewErr}</p>
            ) : preview ? (
              <ReportResultView result={preview} spec={spec} />
            ) : (
              <p className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">Configure the report to see a preview.</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave}>{report ? 'Save changes' : 'Create report'}</Button>
      </div>
    </Modal>
  );
}
