import { useState, useMemo, useEffect, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Loader2, Plus, X } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportSpec, AppReportResult } from '../../types/app';
import { ReportResultView } from './ReportResultView';

type Field = { id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }>; targetFormId?: string } };
type FieldOpt = { ref: string; label: string; type: string; properties?: Field['properties'] };
type Filter = { field: string; op: string; value: string };
type Join = { via: string; formId: string; type: 'inner' | 'left' };

const LAYOUT_TYPES = ['welcome_screen', 'thank_you', 'statement', 'signature', 'file_upload'];
const CHOICE_TYPES = ['dropdown', 'multiple_choice', 'checkbox', 'radio'];
const DATE_TYPES = ['date', 'datetime'];
const OPS: Array<{ v: string; label: string }> = [
  { v: 'eq', label: 'is' }, { v: 'ne', label: 'is not' }, { v: 'contains', label: 'contains' },
  { v: 'gt', label: '>' }, { v: 'lt', label: '<' }, { v: 'gte', label: '≥' }, { v: 'lte', label: '≤' },
  { v: 'notempty', label: 'is answered' }, { v: 'empty', label: 'is blank' },
];

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

  const baseForm = useMemo(() => forms.find((x) => x.formId === formId), [forms, formId]);
  const baseFields: Field[] = useMemo(() => ((baseForm?.fields ?? []) as Field[]).filter((fl) => !LAYOUT_TYPES.includes(fl.type)), [baseForm]);
  // linked_record fields whose target form is also in this app → available as joins ("related data").
  const linkedFields: Field[] = useMemo(
    () => ((baseForm?.fields ?? []) as Field[]).filter((f) => f.type === 'linked_record' && f.properties?.targetFormId && forms.some((x) => x.formId === f.properties?.targetFormId)),
    [baseForm, forms]
  );

  // All selectable fields = base fields (ref = id) + fields of each joined form (ref = "<formId>::<id>").
  const allFields: FieldOpt[] = useMemo(() => {
    const base: FieldOpt[] = baseFields.map((f) => ({ ref: f.id, label: f.label, type: f.type, properties: f.properties }));
    const joined: FieldOpt[] = joins.flatMap((j) => {
      const tf = forms.find((x) => x.formId === j.formId);
      if (!tf) return [];
      return ((tf.fields ?? []) as Field[])
        .filter((fl) => !LAYOUT_TYPES.includes(fl.type))
        .map((f) => ({ ref: `${j.formId}::${f.id}`, label: `${tf.displayName} · ${f.label}`, type: f.type, properties: f.properties }));
    });
    return [...base, ...joined];
  }, [baseFields, joins, forms]);

  const groupable = allFields.filter((f) => CHOICE_TYPES.includes(f.type) || DATE_TYPES.includes(f.type) || f.type === 'short_text');
  const numberFields = allFields.filter((f) => f.type === 'number');
  const groupIsDate = DATE_TYPES.includes(allFields.find((f) => f.ref === groupField)?.type ?? '');

  // Changing the source form invalidates joins (they reference the base form's links) — reset them.
  const prevFormRef = useRef(formId);
  useEffect(() => {
    if (prevFormRef.current !== formId) {
      prevFormRef.current = formId;
      setJoins([]);
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

  const spec: AppReportSpec = useMemo(() => {
    const base: AppReportSpec = { formId, viz, filters: filters.filter((f) => f.field), limit };
    if (joins.length) { base.joins = joins; }
    if (viz === 'bar' || viz === 'pie') { base.groupBy = { field: groupField, bucket: groupIsDate ? bucket : 'none' }; base.measure = { fn: measureFn, field: measureField }; base.sort = 'desc'; }
    if (viz === 'kpi') { base.measure = { fn: measureFn, field: measureField }; }
    if (viz === 'table') { base.columns = columns; }
    return base;
  }, [formId, viz, joins, groupField, groupIsDate, bucket, measureFn, measureField, columns, filters, limit]);

  const [preview, setPreview] = useState<AppReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live preview.
  useEffect(() => {
    if (!formId) return;
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      (async () => {
        setRunning(true);
        setPreviewErr(null);
        try {
          const res = await runReport(spec);
          setPreview(res);
        } catch {
          setPreviewErr('Could not run this report.');
          setPreview(null);
        } finally {
          setRunning(false);
        }
      })();
    }, 350);
    return () => { if (debRef.current) clearTimeout(debRef.current); };
  }, [spec, formId, runReport]);

  const measureNeedsField = measureFn !== 'count';
  const canSave = name.trim().length > 0 && formId && (viz !== 'bar' && viz !== 'pie' ? true : !!groupField);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: report?.id ?? uid(),
      name: name.trim(),
      description: description.trim() || undefined,
      type: 'builder',
      spec,
    });
  };

  const selectCls = 'rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white px-2.5 py-1.5';

  return (
    <Modal isOpen onClose={onClose} title={report ? 'Edit report' : 'New report'} size="xl">
      {/* On mobile the preview sits on top (capped) so you see results while the controls scroll below;
          on lg it's the right column. flex-col-reverse renders the preview (source-order 2) first. */}
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
            <select value={formId} onChange={(e) => setFormId(e.target.value)} className={`w-full ${selectCls}`}>
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
                        <input type="checkbox" className="app-accent rounded shrink-0" checked={!!join} onChange={(e) => setJoins((js) => e.target.checked ? [...js.filter((j) => !(j.via === lf.id)), { via: lf.id, formId: targetId, type: 'left' as const }] : js.filter((j) => !(j.via === lf.id && j.formId === targetId)))} />
                        <span className="truncate">{tf?.displayName ?? 'Related'} <span className="text-gray-400 dark:text-slate-500">· via {lf.label}</span></span>
                      </label>
                      {join && (
                        <select value={join.type} onChange={(e) => setJoins((js) => js.map((j) => j.via === lf.id && j.formId === targetId ? { ...j, type: e.target.value as 'inner' | 'left' } : j))} className={selectCls} title="Join type">
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
            <div className="flex flex-wrap gap-2">
              {(['bar', 'pie', 'kpi', 'table'] as const).map((v) => (
                <button key={v} type="button" onClick={() => setViz(v)} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize cursor-pointer ${viz === v ? 'app-bg-primary-light app-text-primary' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400'}`}>{v === 'kpi' ? 'Number' : v}</button>
              ))}
            </div>
          </div>

          {(viz === 'bar' || viz === 'pie') && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Group by</label>
              <select value={groupField} onChange={(e) => setGroupField(e.target.value)} className={`w-full ${selectCls}`}>
                {groupable.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
              </select>
              {groupIsDate && (
                <select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)} className={`w-full mt-2 ${selectCls}`}>
                  <option value="day">By day</option><option value="month">By month</option><option value="year">By year</option>
                </select>
              )}
            </div>
          )}

          {(viz === 'bar' || viz === 'pie' || viz === 'kpi') && (
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Measure</label>
              <div className="flex gap-2">
                <select value={measureFn} onChange={(e) => setMeasureFn(e.target.value as typeof measureFn)} className={selectCls}>
                  <option value="count">Count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option>
                </select>
                {measureNeedsField && (
                  <select value={measureField} onChange={(e) => setMeasureField(e.target.value)} className={`flex-1 ${selectCls}`}>
                    <option value="">Select field…</option>
                    {numberFields.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                  </select>
                )}
              </div>
              {measureNeedsField && numberFields.length === 0 && <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">This form has no number fields to {measureFn}.</p>}
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
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 dark:text-slate-400">Max rows</label>
                <input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))} className={`w-24 ${selectCls}`} />
              </div>
            </div>
          )}

          {/* Filters */}
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Filters</label>
            <div className="space-y-2">
              {filters.map((flt, i) => {
                const opNeedsValue = !['empty', 'notempty'].includes(flt.op);
                const fld = allFields.find((f) => f.ref === flt.field);
                const opts = fld?.properties?.options ?? [];
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={flt.field} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className={`${selectCls} flex-1 min-w-0`}>
                      <option value="">Field…</option>
                      {allFields.map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
                    </select>
                    <select value={flt.op} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value } : x))} className={selectCls}>
                      {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                    {opNeedsValue && (opts.length > 0 ? (
                      <select value={flt.value} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className={`${selectCls} flex-1 min-w-0`}>
                        <option value="">Value…</option>
                        {opts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                      </select>
                    ) : (
                      <input value={flt.value} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="Value" className={`${selectCls} flex-1 min-w-0`} />
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
