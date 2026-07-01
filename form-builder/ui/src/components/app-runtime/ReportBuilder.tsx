import { useState, useMemo, useEffect, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Loader2, Plus, X } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportSpec, AppReportResult } from '../../types/app';
import { ReportResultView } from './ReportResultView';

type Field = { id: string; label: string; type: string; properties?: { options?: Array<{ value: string; label?: string }> } };
type Filter = { field: string; op: string; value: string };

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

  const fields: Field[] = useMemo(() => {
    const f = forms.find((x) => x.formId === formId);
    return ((f?.fields ?? []) as Field[]).filter((fl) => !LAYOUT_TYPES.includes(fl.type));
  }, [forms, formId]);

  const groupable = fields.filter((f) => CHOICE_TYPES.includes(f.type) || DATE_TYPES.includes(f.type) || f.type === 'short_text');
  const numberFields = fields.filter((f) => f.type === 'number');
  const groupIsDate = DATE_TYPES.includes(fields.find((f) => f.id === groupField)?.type ?? '');

  // Default group/column choices when the form changes and nothing is set yet.
  useEffect(() => {
    if ((viz === 'bar' || viz === 'pie') && !groupable.some((g) => g.id === groupField)) {
      setGroupField(groupable[0]?.id ?? '');
    }
    if (viz === 'table' && columns.length === 0) {
      setColumns(fields.slice(0, 4).map((f) => f.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId, viz]);

  const spec: AppReportSpec = useMemo(() => {
    const base: AppReportSpec = { formId, viz, filters: filters.filter((f) => f.field), limit };
    if (viz === 'bar' || viz === 'pie') { base.groupBy = { field: groupField, bucket: groupIsDate ? bucket : 'none' }; base.measure = { fn: measureFn, field: measureField }; base.sort = 'desc'; }
    if (viz === 'kpi') { base.measure = { fn: measureFn, field: measureField }; }
    if (viz === 'table') { base.columns = columns; }
    return base;
  }, [formId, viz, groupField, groupIsDate, bucket, measureFn, measureField, columns, filters, limit]);

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
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_1fr] gap-0 max-h-[75dvh]">
        {/* Controls */}
        <div className="p-5 space-y-4 overflow-y-auto border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-slate-800">
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
                {groupable.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
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
                    {numberFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
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
                {fields.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-300 cursor-pointer">
                    <input type="checkbox" className="app-accent rounded" checked={columns.includes(f.id)} onChange={(e) => setColumns((c) => e.target.checked ? [...c, f.id] : c.filter((x) => x !== f.id))} />
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
                const fld = fields.find((f) => f.id === flt.field);
                const opts = fld?.properties?.options ?? [];
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    <select value={flt.field} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className={`${selectCls} flex-1 min-w-0`}>
                      <option value="">Field…</option>
                      {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
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

        {/* Live preview */}
        <div className="p-5 overflow-y-auto bg-gray-50 dark:bg-slate-950/40">
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
