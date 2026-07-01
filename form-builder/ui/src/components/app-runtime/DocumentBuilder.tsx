import { useState, useMemo } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Type, BarChart3, ChevronUp, ChevronDown, Trash2, Loader2 } from 'lucide-react';
import type { AppReportItem, AppReportDocument, ReportDocBlock } from '../../types/app';
import { isReportDocument } from '../../types/app';
import { ReportDocumentView } from './ReportDocumentView';
import { useDocumentResults } from './useDocumentResults';

const uid = () => 'blk_' + Math.random().toString(36).slice(2, 10);
const docId = () => 'doc_' + Math.random().toString(36).slice(2, 10);

/** Compose a multi-chart PDF document from text blocks + saved chart reports. Live-previews as you edit. */
export function DocumentBuilder({ document: doc, reports, appName, onClose, onSave }: {
  document: AppReportDocument | null;
  reports: AppReportItem[];
  appName?: string;
  onClose: () => void;
  onSave: (d: AppReportDocument) => void;
}) {
  const chartReports = useMemo(() => reports.filter((r) => !isReportDocument(r)), [reports]);

  const [name, setName] = useState(doc?.name ?? '');
  const [description, setDescription] = useState(doc?.description ?? '');
  const [blocks, setBlocks] = useState<ReportDocBlock[]>(doc?.blocks ?? []);

  const draft: AppReportDocument = useMemo(
    () => ({ id: doc?.id ?? 'preview', name, description, type: 'document', blocks }),
    [doc, name, description, blocks]
  );
  const { resultsById, loading } = useDocumentResults(draft, reports);

  const addText = () => setBlocks((b) => [...b, { id: uid(), kind: 'text', title: '', body: '' }]);
  const addChart = () => setBlocks((b) => [...b, { id: uid(), kind: 'report', reportId: chartReports[0]?.id ?? '', caption: '' }]);
  const update = (id: string, patch: Partial<ReportDocBlock>) => setBlocks((b) => b.map((x) => (x.id === id ? { ...x, ...patch } as ReportDocBlock : x)));
  const remove = (id: string) => setBlocks((b) => b.filter((x) => x.id !== id));
  const move = (i: number, dir: -1 | 1) => setBlocks((b) => {
    const j = i + dir;
    if (j < 0 || j >= b.length) return b;
    const next = [...b];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const chartIds = useMemo(() => new Set(chartReports.map((r) => r.id)), [chartReports]);
  const blockBroken = (b: ReportDocBlock) => b.kind === 'report' && !(b.reportId && chartIds.has(b.reportId));
  const canSave = name.trim().length > 0 && blocks.length > 0 && !blocks.some(blockBroken);
  const handleSave = () => {
    if (!canSave) return;
    onSave({ id: doc?.id ?? docId(), name: name.trim(), description: description.trim() || undefined, type: 'document', blocks });
  };

  const fieldCls = 'w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950/50 text-sm text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 app-ring-primary';
  const sectionLabel = 'text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500';

  return (
    <Modal isOpen onClose={onClose} title={doc ? 'Edit PDF document' : 'New PDF document'} size="2xl">
      <div className="flex flex-col-reverse lg:grid lg:grid-cols-[minmax(0,380px)_1fr] max-h-[82dvh] lg:max-h-[76dvh] min-h-0">
        {/* Editor */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 min-h-0 lg:border-r border-gray-200 dark:border-slate-800">
          <div>
            <label className={sectionLabel}>Document title</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 performance review" className={`mt-1.5 ${fieldCls}`} />
          </div>
          <div>
            <label className={sectionLabel}>Intro <span className="normal-case font-normal text-gray-400">(optional)</span></label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A short summary shown under the title" className={`mt-1.5 ${fieldCls}`} />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>Content</label>
              <div className="flex gap-1.5">
                <button type="button" onClick={addText} className="inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-slate-700 px-2 py-1 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer"><Type className="h-3.5 w-3.5" /> Text</button>
                <button type="button" onClick={addChart} disabled={chartReports.length === 0} className="inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-slate-700 px-2 py-1 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"><BarChart3 className="h-3.5 w-3.5" /> Chart</button>
              </div>
            </div>

            {chartReports.length === 0 && (
              <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">Create a chart report first to add charts to a document.</p>
            )}

            <div className="mt-2 space-y-2">
              {blocks.length === 0 && <p className="text-xs text-gray-400 dark:text-slate-500 py-4 text-center">No content yet. Add a text block or a chart.</p>}
              {blocks.map((block, i) => (
                <div key={block.id} className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50/60 dark:bg-slate-950/40 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
                      {block.kind === 'text' ? <><Type className="h-3.5 w-3.5" /> Text</> : <><BarChart3 className="h-3.5 w-3.5" /> Chart</>}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 cursor-pointer"><ChevronUp className="h-4 w-4" /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label="Move down" className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-30 cursor-pointer"><ChevronDown className="h-4 w-4" /></button>
                      <button type="button" onClick={() => remove(block.id)} aria-label="Remove block" className="p-1 text-gray-400 hover:text-red-500 cursor-pointer"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {block.kind === 'text' ? (
                    <div className="space-y-2">
                      <input value={block.title ?? ''} onChange={(e) => update(block.id, { title: e.target.value })} placeholder="Heading (optional)" className={fieldCls} aria-label="Text heading" />
                      <textarea value={block.body} onChange={(e) => update(block.id, { body: e.target.value })} placeholder="Explain the charts, the query used, or add context…" rows={3} className={`${fieldCls} resize-y`} aria-label="Text body" />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <select value={block.reportId} onChange={(e) => update(block.id, { reportId: e.target.value })} className={`${fieldCls} ${blockBroken(block) ? 'border-amber-400 dark:border-amber-500/60' : ''}`} aria-label="Chart report">
                        <option value="">Select a report…</option>
                        {chartReports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                      {blockBroken(block) && <p className="text-[11px] text-amber-600 dark:text-amber-400">Pick a chart for this block before saving.</p>}
                      <input value={block.caption ?? ''} onChange={(e) => update(block.id, { caption: e.target.value })} placeholder="Caption (optional)" className={fieldCls} aria-label="Chart caption" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="p-5 overflow-y-auto bg-gray-50/60 dark:bg-slate-950/40 max-h-[42dvh] lg:max-h-none shrink-0 border-b lg:border-b-0 border-gray-200 dark:border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Preview</h3>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <ReportDocumentView doc={draft} reports={reports} resultsById={resultsById} loading={loading} appName={appName} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-white/[0.02]">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!canSave}>{doc ? 'Save changes' : 'Create document'}</Button>
      </div>
    </Modal>
  );
}
