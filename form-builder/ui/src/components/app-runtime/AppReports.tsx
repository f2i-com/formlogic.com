import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Pencil, Trash2, Download, FileBarChart, FileText, Loader2, BarChart3, LineChart, AreaChart, PieChart, CircleDot, Table2, Hash } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportItem, AppReportDocument, AppReportResult } from '../../types/app';
import { isReportDocument } from '../../types/app';
import { ReportResultView } from './ReportResultView';
import { ReportDocumentView } from './ReportDocumentView';
import { ReportBuilder } from './ReportBuilder';
import { DocumentBuilder } from './DocumentBuilder';
import { useDocumentResults } from './useDocumentResults';
import { printReportDocument, readAppPrimary } from './reportPrint';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';

const VIZ_ICON: Record<string, typeof BarChart3> = { bar: BarChart3, line: LineChart, area: AreaChart, pie: PieChart, donut: CircleDot, table: Table2, kpi: Hash };

export function AppReports() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, saveReports } = useAppRuntimeStore();

  const items: AppReportItem[] = config?.app?.reports ?? [];
  const chartReports = items.filter((r): r is AppReport => !isReportDocument(r));
  const documents = items.filter(isReportDocument);
  const appName = config?.app?.name ?? 'App';
  // ownerId is only present on the config for the app owner (stripped for members).
  const isOwner = !!config?.app?.ownerId;

  const [tab, setTab] = useState<'charts' | 'documents'>('charts');
  const [editingReport, setEditingReport] = useState<AppReport | 'new' | null>(null);
  const [editingDoc, setEditingDoc] = useState<AppReportDocument | 'new' | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const saveItem = async (item: AppReportItem, onDone?: (id: string) => void) => {
    const exists = items.some((r) => r.id === item.id);
    const next = exists ? items.map((r) => (r.id === item.id ? item : r)) : [...items, item];
    const ok = await saveReports(next);
    if (ok) { toast.success('Saved'); onDone?.(item.id); }
    return ok;
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const ok = await saveReports(items.filter((r) => r.id !== deleteId));
    if (ok) toast.success('Deleted');
    setDeleteId(null);
  };

  const empty = items.length === 0;

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => navigate(`/app/${appSlug}`)} aria-label="Back to dashboard" className="p-2.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">Reports</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Chart your data and export polished PDFs</p>
        </div>
        {isOwner && (
          tab === 'charts'
            ? <button onClick={() => setEditingReport('new')} aria-label="New report" className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> <span className="hidden sm:inline">New report</span></button>
            : <button onClick={() => setEditingDoc('new')} aria-label="New document" className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> <span className="hidden sm:inline">New document</span></button>
        )}
      </div>

      {/* Tabs */}
      <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-gray-100 dark:bg-slate-800/60 mb-5">
        <button onClick={() => setTab('charts')} aria-pressed={tab === 'charts'} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${tab === 'charts' ? 'bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400'}`}>
          <FileBarChart className="h-4 w-4" /> Charts {chartReports.length > 0 && <span className="text-xs opacity-60">{chartReports.length}</span>}
        </button>
        <button onClick={() => setTab('documents')} aria-pressed={tab === 'documents'} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${tab === 'documents' ? 'bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400'}`}>
          <FileText className="h-4 w-4" /> PDF documents {documents.length > 0 && <span className="text-xs opacity-60">{documents.length}</span>}
        </button>
      </div>

      {tab === 'charts' ? (
        <ChartsPanel
          reports={chartReports}
          appName={appName}
          isOwner={isOwner}
          onNew={() => setEditingReport('new')}
          onEdit={(r) => setEditingReport(r)}
          onDelete={(id) => setDeleteId(id)}
        />
      ) : (
        <DocumentsPanel
          documents={documents}
          allItems={items}
          appName={appName}
          isOwner={isOwner}
          hasCharts={chartReports.length > 0}
          onNew={() => setEditingDoc('new')}
          onEdit={(d) => setEditingDoc(d)}
          onDelete={(id) => setDeleteId(id)}
        />
      )}

      {empty && tab === 'charts' && (
        <p className="sr-only">No reports yet.</p>
      )}

      {editingReport && (
        <ReportBuilder
          report={editingReport === 'new' ? null : editingReport}
          onClose={() => setEditingReport(null)}
          onSave={async (r) => { const ok = await saveItem(r); if (ok) setEditingReport(null); }}
        />
      )}

      {editingDoc && (
        <DocumentBuilder
          document={editingDoc === 'new' ? null : editingDoc}
          reports={items}
          appName={appName}
          onClose={() => setEditingDoc(null)}
          onSave={async (d) => { const ok = await saveItem(d); if (ok) setEditingDoc(null); }}
        />
      )}

      <ConfirmDialog
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete"
        message="Delete this item? This can't be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}

/** Chart reports: list + selected result + export/edit/delete. */
function ChartsPanel({ reports, appName, isOwner, onNew, onEdit, onDelete }: {
  reports: AppReport[]; appName: string; isOwner: boolean; onNew: () => void; onEdit: (r: AppReport) => void; onDelete: (id: string) => void;
}) {
  const { runReport, config } = useAppRuntimeStore();
  // Derive the selection (falling back to the first report) so it never goes stale as the list changes.
  const [clickedId, setClickedId] = useState<string | null>(null);
  const selected = reports.find((r) => r.id === clickedId) ?? reports[0] ?? null;
  const [result, setResult] = useState<AppReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const formName = (fid: string) => config?.forms.find((f) => f.formId === fid)?.displayName ?? 'form';

  useEffect(() => {
    if (!selected) { setResult(null); return; }
    let cancelled = false;
    (async () => {
      setRunning(true); setErr(null);
      try {
        const res = await runReport(selected.spec);
        if (!cancelled) setResult(res);
      } catch {
        if (!cancelled) { setErr('Could not run this report.'); setResult(null); }
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, runReport]);

  const handleExport = () => {
    if (!selected || !result) return;
    const doc: AppReportDocument = { id: selected.id, name: selected.name, description: selected.description, type: 'document', blocks: [{ id: 'b', kind: 'report', reportId: selected.id }] };
    printReportDocument(<ReportDocumentView doc={doc} reports={[selected]} resultsById={{ [selected.id]: result }} print appName={appName} primaryColor={readAppPrimary()} />);
  };

  if (reports.length === 0) {
    return (
      <div className="text-center py-16">
        <FileBarChart className="h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-slate-600" />
        <p className="text-gray-600 dark:text-slate-300 font-medium">No reports yet</p>
        <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">{isOwner ? 'Create a report to chart or list your app’s data.' : 'The app owner hasn’t added any reports.'}</p>
        {isOwner && <button onClick={onNew} className="app-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> New report</button>}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_1fr] gap-4">
      <div className="space-y-2">
        {reports.map((r) => {
          const Icon = VIZ_ICON[r.spec?.viz ?? 'bar'] ?? BarChart3;
          const active = r.id === selected?.id;
          return (
            <button key={r.id} onClick={() => setClickedId(r.id)} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${active ? 'app-bg-primary-light app-border-primary' : 'border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
              <div className={`p-2 rounded-lg shrink-0 ${active ? '' : 'bg-gray-100 dark:bg-slate-800'}`}><Icon className={`h-4 w-4 ${active ? 'app-text-primary' : 'text-gray-500 dark:text-slate-400'}`} /></div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</span>
                <span className="block text-xs text-gray-400 dark:text-slate-500 truncate">{formName(r.spec?.formId ?? '')}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 min-h-[240px]">
        {selected && (
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate">{selected.name}</h2>
              {selected.description && <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{selected.description}</p>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={handleExport} disabled={!result || running} aria-label="Print or save as PDF" title="Opens your browser's print dialog — choose “Save as PDF”." className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50">
                <Download className="h-4 w-4" /><span className="hidden sm:inline">Print / Save PDF</span>
              </button>
              {isOwner && <>
                <button onClick={() => onEdit(selected)} aria-label="Edit report" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => onDelete(selected.id)} aria-label="Delete report" className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"><Trash2 className="h-4 w-4" /></button>
              </>}
            </div>
          </div>
        )}
        {running ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
        ) : err ? (
          <p className="py-16 text-center text-sm text-red-500">{err}</p>
        ) : result ? (
          <ReportResultView result={result} />
        ) : null}
      </div>
    </div>
  );
}

/** PDF documents: list + selected document preview + export/edit/delete. */
function DocumentsPanel({ documents, allItems, appName, isOwner, hasCharts, onNew, onEdit, onDelete }: {
  documents: AppReportDocument[]; allItems: AppReportItem[]; appName: string; isOwner: boolean; hasCharts: boolean; onNew: () => void; onEdit: (d: AppReportDocument) => void; onDelete: (id: string) => void;
}) {
  const [clickedId, setClickedId] = useState<string | null>(null);
  const selected = documents.find((d) => d.id === clickedId) ?? documents[0] ?? null;
  const { resultsById, loading } = useDocumentResults(selected, allItems);

  const handleExport = () => {
    if (!selected) return;
    printReportDocument(<ReportDocumentView doc={selected} reports={allItems} resultsById={resultsById} print appName={appName} primaryColor={readAppPrimary()} />);
  };

  if (documents.length === 0) {
    return (
      <div className="text-center py-16">
        <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-slate-600" />
        <p className="text-gray-600 dark:text-slate-300 font-medium">No PDF documents yet</p>
        <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">{isOwner ? 'Combine several charts and text into one polished PDF report.' : 'The app owner hasn’t added any documents.'}</p>
        {isOwner && <button onClick={onNew} disabled={!hasCharts} title={hasCharts ? undefined : 'Create a chart report first'} className="app-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer disabled:opacity-50"><Plus className="h-4 w-4" /> New document</button>}
        {isOwner && !hasCharts && <p className="text-xs text-gray-400 dark:text-slate-500 mt-2">Create a chart report first.</p>}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_1fr] gap-4">
      <div className="space-y-2">
        {documents.map((d) => {
          const active = d.id === selected?.id;
          const charts = d.blocks.filter((b) => b.kind === 'report').length;
          return (
            <button key={d.id} onClick={() => setClickedId(d.id)} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${active ? 'app-bg-primary-light app-border-primary' : 'border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
              <div className={`p-2 rounded-lg shrink-0 ${active ? '' : 'bg-gray-100 dark:bg-slate-800'}`}><FileText className={`h-4 w-4 ${active ? 'app-text-primary' : 'text-gray-500 dark:text-slate-400'}`} /></div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{d.name}</span>
                <span className="block text-xs text-gray-400 dark:text-slate-500 truncate">{charts} chart{charts === 1 ? '' : 's'} · {d.blocks.length} block{d.blocks.length === 1 ? '' : 's'}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 min-h-[240px]">
        {selected && (
          <div className="flex items-center justify-end gap-1 mb-3">
            <button onClick={handleExport} aria-label="Print or save as PDF" title="Opens your browser's print dialog — choose “Save as PDF”." className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer">
              <Download className="h-4 w-4" /><span className="hidden sm:inline">Print / Save PDF</span>
            </button>
            {isOwner && <>
              <button onClick={() => onEdit(selected)} aria-label="Edit document" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer"><Pencil className="h-4 w-4" /></button>
              <button onClick={() => onDelete(selected.id)} aria-label="Delete document" className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"><Trash2 className="h-4 w-4" /></button>
            </>}
          </div>
        )}
        {selected ? (
          <ReportDocumentView doc={selected} reports={allItems} resultsById={resultsById} loading={loading} appName={appName} />
        ) : null}
      </div>
    </div>
  );
}
