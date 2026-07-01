import { useState, useMemo, useEffect, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Loader2, Plus, X } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportSpec, AppReportResult } from '../../types/app';
import { ReportResultView } from './ReportResultView';

type Field = { id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }>; targetFormId?: string; allowMultiple?: boolean } };
type FieldOpt = { ref: string; label: string; type: string; properties?: Field['properties'] };
type Filter = { field: string; op: string; value: string };
type Join = { via: string; formId: string; type: 'inner' | 'left' };

const LAYOUT_TYPES = ['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload'];
const CHOICE_TYPES = ['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio'];
const DATE_TYPES = ['date', 'datetime'];
const NUMERIC_TYPES = ['number', 'rating', 'scale'];

// Submission time + workflow status are always-available dimensions (server pseudo-fields).
const PSEUDO_FIELDS: FieldOpt[] = [
  { ref: '__submitted_at', label: 'Submitted date', type: 'datetime' },
  { ref: '__status', label: 'Status', type: 'short_text' },
];

const OP_LABELS: Record<string, string> = {
  eq: 'is', ne: 'is not', contains: 'contains', gt: '>', lt: '<', gte: '≥', lte: '≤',
  last_n_days: 'in last (days)', this_month: 'this month', this_year: 'this year', today: 'today',
  notempty: 'is answered', empty: 'is blank',
};

function opsForType(type: string): string[] {
  if (NUMERIC_TYPES.includes(type)) return ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'notempty', 'empty'];
  if (DATE_TYPES.includes(type)) return ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'last_n_days', 'this_month', 'this_year', 'today', 'notempty', 'empty'];
  if (CHOICE_TYPES.includes(type)) return ['eq', 'ne', 'notempty', 'empty'];
  return ['eq', 'ne', 'contains', 'notempty', 'empty'];
}
const NO_VALUE_OPS = ['empty', 'notempty', 'this_month', 'this_year', 'today'];

const uid = () => 'rep_' + Math.random().toString(36).slice(2, 10);

/** No-code report builder. Live-previews as you change controls; saves a builder-type report. */
export function ReportBuilder({ report, onClose, onSave }: { report: AppReport | null; onClose: () => void; onSave: (r: AppReport) => void }) {
  const { config, runReport } = useAppRuntimeStore();
  const forms = useMemo(() => config?.forms ?? [], [config]);

  const initSpec = report?.spec;
  const [name, setName] = useState(report?.name ?? '');
  const [description, setDescription] = useState(report?.description ?? '');
  const [formId, setFormId] = useState(initSpec?.formId ?? forms[0]?.formId ?? '');
  const [viz, setViz] = useState<AppReportSpec['viz']>(initSpec?.viz ?? 'bar');
  const [groupField, setGroupField] = useState(initSpec?.groupBy?.field ?? '');
  const [bucket, setBucket] = useState<NonNullable<AppReportSpec['groupBy']>['bucket']>(initSpec?.groupBy?.bucket ?? 'month');
  const [measureFn, setMeasureFn] = useState<NonNullable<AppReportSpec['measure']>['fn']>(initSpec?.measure?.fn ?? 'count');
  const [measureField, setMeasureField] = useState(initSpec?.measure?.field ?? '');
  const [columns, setColumns] = useState<string[]>(initSpec?.columns ?? []);
  const [filters, setFilters] = useState<Filter[]>((initSpec?.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: String(f.value ?? '') })));
  const [limit, setLimit] = useState(initSpec?.limit ?? 100);
  const [joins, setJoins] = useState<Join[]>((initSpec?.joins as Join[]) ?? []);
  const [seriesSort, setSeriesSort] = useState<'value' | 'label'>((initSpec?.seriesSort as 'value' | 'label') ?? 'value');
  const initTableSort = (initSpec?.sort && typeof initSpec.sort === 'object') ? initSpec.sort as { by: string; dir: 'asc' | 'desc' } : { by: '__submitted_at', dir: 'desc' as const };
  const [tableSort, setTableSort] = useState<{ by: string; dir: 'asc' | 'desc' }>(initTableSort);

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
    if ((viz === 'bar' || viz === 'pie') && !groupable.some((g) => g.ref === groupField)) {
      setGroupField(groupable[0]?.ref ?? '');
    }
    if (viz === 'table' && columns.length === 0) {
      setColumns(baseFields.slice(0, 4).map((f) => f.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId, viz]);

  // Removing a join prunes any refs that pointed at it.
  const removeJoin = (via: string, joinFormId: string) => {
    const prefix = `${joinFormId}::`;
    setJoins((js) => js.filter((j) => !(j.via === via && j.formId === joinFormId)));
    setColumns((c) => c.filter((r) => !r.startsWith(prefix)));
    setFilters((fs) => fs.filter((f) => !f.field.startsWith(prefix)));
    setGroupField((g) => (g.startsWith(prefix) ? '' : g));
    setMeasureField((m) => (m.startsWith(prefix) ? '' : m));
  };

  const spec: AppReportSpec = useMemo(() => {
    const base: AppReportSpec = { formId, viz, filters: filters.filter((f) => f.field), limit };
    if (joins.length) base.joins = joins;
    if (viz === 'bar' || viz === 'pie') {
      base.groupBy = { field: groupField, bucket: groupIsDate ? bucket : 'none' };
      base.measure = { fn: measureFn, field: measureField };
      base.seriesSort = seriesSort;
      base.sort = 'desc';
    }
    if (viz === 'kpi') base.measure = { fn: measureFn, field: measureField };
    if (viz === 'table') base.sort = tableSort;
    if (viz === 'table') base.columns = columns;
    return base;
  }, [formId, viz, joins, groupField, groupIsDate, bucket, measureFn, measureField, columns, filters, limit, seriesSort, tableSort]);

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
          const res = await runReport(spec);
          if (seq === seqRef.current) setPreview(res);
        } catch {
          if (seq === seqRef.current) { setPreviewErr('Could not run this report.'); setPreview(null); }
        } finally {
          if (seq === seqRef.current) setRunning(false);
        }
      })();
    }, 350);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [spec, formId, runReport]);

  const canSave =
    name.trim().length > 0 && !!formId &&
    ((viz !== 'bar' && viz !== 'pie') || !!groupField) &&
    (!measureNeedsField || !!measureField);

  const handleSave = () => {
    if (!canSave) return;
    onSave({ id: report?.id ?? uid(), name: name.trim(), description: description.trim() || undefined, type: 'builder', spec });
  };

  const selectCls = 'rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white px-2.5 py-1.5';

  return (
    <Modal isOpen onClose={onClose} title={report ? 'Edit report' : 'New report'} size="xl">
      <div className="flex flex-col-reverse lg:grid lg:grid-cols-[minmax(0,340px)_1fr] max-h-[80dvh] lg:max-h-[75dvh] min-h-0">
        {/* Controls */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0 lg:border-r border-gray-200 dark:border-slate-800">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Report name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Revenue by month" className={`w-full ${selectCls}`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={`w-full ${selectCls}`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Data from</label>
            <select value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="Source form" className={`w-full ${selectCls}`}>
              {forms.map((f) => <option key={f.formId} value={f.formId}>{f.displayName}</option>)}
            </select>
          </div>

          {linkedFields.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Related data</label>
              <div className="space-y-2">
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
                        <select value={join.type} onChange={(e) => setJoins((js) => js.map((j) => j.via === lf.id && j.formId === targetId ? { ...j, type: e.target.value as 'inner' | 'left' } : j))} className={selectCls} aria-label="Join type">
                          <option value="left">Include all</option>
                          <option value="inner">Only matched</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">Pull fields from linked forms in to group by or list alongside.</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Show as</label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Visualization">
              {(['bar', 'pie', 'kpi', 'table'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={viz === v} onClick={() => setViz(v)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize cursor-pointer ${viz === v ? 'app-bg-primary-light app-text-primary' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'}`}>{v === 'kpi' ? 'Number' : v}</button>
              ))}
            </div>
          </div>

          {(viz === 'bar' || viz === 'pie') && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Group by</label>
              {groupable.length === 0 ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">This form has no fields to group by — pick a different form or add a choice/date field.</p>
              ) : (
                <select value={groupField} onChange={(e) => setGroupField(e.target.value)} aria-label="Group by field" className={`w-full ${selectCls}`}>
                  {groupable.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                </select>
              )}
              {groupIsDate && (
                <select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)} aria-label="Date bucket" className={`w-full mt-2 ${selectCls}`}>
                  <option value="day">By day</option><option value="month">By month</option><option value="year">By year</option>
                </select>
              )}
              <div className="flex items-center gap-2 mt-2">
                <select value={seriesSort} onChange={(e) => setSeriesSort(e.target.value as 'value' | 'label')} aria-label="Sort" className={selectCls}>
                  <option value="value">Sort by value</option><option value="label">Sort by label</option>
                </select>
                <input type="number" min={1} max={50} value={Math.min(limit, 50)} onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 10)))} aria-label="Show top N" title="Show top N" className={`w-20 ${selectCls}`} />
              </div>
            </div>
          )}

          {(viz === 'bar' || viz === 'pie' || viz === 'kpi') && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Measure</label>
              <div className="flex gap-2">
                <select value={measureFn} onChange={(e) => setMeasureFn(e.target.value as typeof measureFn)} aria-label="Measure function" className={selectCls}>
                  <option value="count">Count</option><option value="countDistinct">Unique count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option>
                </select>
                {measureNeedsField && (
                  <select value={measureField} onChange={(e) => setMeasureField(e.target.value)} aria-label="Measure field" className={`flex-1 ${selectCls}`}>
                    <option value="">Select field…</option>
                    {measureFieldOptions.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                  </select>
                )}
              </div>
              {measureNeedsField && !measureField && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Choose a field to {measureFn === 'countDistinct' ? 'count uniquely' : measureFn}.</p>}
              {measureFn !== 'count' && measureFn !== 'countDistinct' && numberFields.length === 0 && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">This form has no number fields to {measureFn}.</p>}
            </div>
          )}

          {viz === 'table' && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Columns</label>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 p-2 space-y-1">
                {allFields.map((f) => (
                  <label key={f.ref} className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" className="app-accent rounded" checked={columns.includes(f.ref)} onChange={(e) => setColumns((c) => e.target.checked ? [...c, f.ref] : c.filter((x) => x !== f.ref))} />
                    <span className="truncate">{f.label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Sort by</span>
                <select value={tableSort.by} onChange={(e) => setTableSort((s) => ({ ...s, by: e.target.value }))} aria-label="Sort column" className={selectCls}>
                  <option value="__submitted_at">Submitted date</option>
                  {columns.map((r) => <option key={r} value={r}>{fieldByRef[r]?.label ?? r}</option>)}
                </select>
                <select value={tableSort.dir} onChange={(e) => setTableSort((s) => ({ ...s, dir: e.target.value as 'asc' | 'desc' }))} aria-label="Sort direction" className={selectCls}>
                  <option value="desc">Newest / high→low</option><option value="asc">Oldest / low→high</option>
                </select>
                <span className="text-xs font-medium text-gray-500 dark:text-slate-400 ml-1">Max rows</span>
                <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))} aria-label="Max rows" className={`w-20 ${selectCls}`} />
              </div>
            </div>
          )}

          {/* Filters */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Filters</label>
            <div className="space-y-2">
              {filters.map((flt, i) => {
                const fld = fieldByRef[flt.field];
                const ops = fld ? opsForType(fld.type) : ['eq', 'ne', 'contains', 'notempty', 'empty'];
                const needsValue = !NO_VALUE_OPS.includes(flt.op);
                const opts = fld?.properties?.options ?? [];
                const inputType = flt.op === 'last_n_days' || NUMERIC_TYPES.includes(fld?.type ?? '') ? 'number' : (DATE_TYPES.includes(fld?.type ?? '') ? 'date' : 'text');
                const set = (patch: Partial<Filter>) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, ...patch } : x));
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={flt.field} aria-label="Filter field" onChange={(e) => { const nf = fieldByRef[e.target.value]; const nops = nf ? opsForType(nf.type) : ['eq']; set({ field: e.target.value, op: nops.includes(flt.op) ? flt.op : nops[0], value: '' }); }} className={`${selectCls} flex-1 min-w-0`}>
                      <option value="">Field…</option>
                      {allFields.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                    </select>
                    <select value={flt.op} aria-label="Filter condition" onChange={(e) => set({ op: e.target.value })} className={selectCls}>
                      {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                    </select>
                    {needsValue && (opts.length > 0 && flt.op !== 'contains' ? (
                      <select value={flt.value} aria-label="Filter value" onChange={(e) => set({ value: e.target.value })} className={`${selectCls} flex-1 min-w-0`}>
                        <option value="">Value…</option>
                        {opts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                      </select>
                    ) : (
                      <input type={inputType} value={flt.value} aria-label="Filter value" onChange={(e) => set({ value: e.target.value })} placeholder={flt.op === 'last_n_days' ? 'days' : 'Value'} className={`${selectCls} flex-1 min-w-0`} />
                    ))}
                    <button type="button" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove filter" className="p-1 text-gray-400 hover:text-red-500 cursor-pointer"><X className="h-4 w-4" /></button>
                  </div>
                );
              })}
              <button type="button" onClick={() => setFilters((fs) => [...fs, { field: '', op: 'eq', value: '' }])} className="inline-flex items-center gap-1 text-xs text-primary-600 dark:text-primary-400 hover:underline cursor-pointer"><Plus className="h-3.5 w-3.5" /> Add filter</button>
            </div>
          </div>
        </div>

        {/* Live preview — capped + on top on mobile, full right column on desktop */}
        <div className="p-5 overflow-y-auto bg-gray-50 dark:bg-slate-950/40 max-h-[40dvh] lg:max-h-none shrink-0 border-b lg:border-b-0 border-gray-200 dark:border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{name.trim() || 'Preview'}</h3>
            {running && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          {previewErr ? (
            <p className="py-10 text-center text-sm text-red-500">{previewErr}</p>
          ) : preview ? (
            <ReportResultView result={preview} />
          ) : (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">Configure the report to see a preview.</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave}>{report ? 'Save changes' : 'Create report'}</Button>
      </div>
    </Modal>
  );
}
