import { useState, useEffect, type ReactNode } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Plus, Pencil, Trash2, Download, FileBarChart, FileText, BarChart3, LineChart, AreaChart, PieChart, CircleDot, Table2, Hash } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportItem, AppReportDocument, AppReportResult } from '../../types/app';
import { isReportDocument } from '../../types/app';
import { ReportResultView } from './ReportResultView';
import { ReportDocumentView } from './ReportDocumentView';
import { ReportBuilder } from './ReportBuilder';
import { DocumentBuilder } from './DocumentBuilder';
import { useDocumentResults } from './useDocumentResults';
import { printReportDocument, readAppPrimary } from './reportPrint';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';

const VIZ_ICON: Record<string, typeof BarChart3> = { bar: BarChart3, line: LineChart, area: AreaChart, pie: PieChart, donut: CircleDot, table: Table2, kpi: Hash };

/** Icon classes for a master-list row, shared by both panels. */
const listIconCls = (active: boolean) => `h-4 w-4 ${active ? 'app-text-primary' : 'text-gray-500 dark:text-slate-400'}`;

export function AppReports() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, saveReports, isOwner: checkOwner } = useAppRuntimeStore();

  const items: AppReportItem[] = config?.app?.reports ?? [];
  const chartReports = items.filter((r): r is AppReport => !isReportDocument(r));
  const documents = items.filter(isReportDocument);
  const appName = config?.app?.name ?? 'App';
  const isOwner = checkOwner();

  const [tab, setTab] = useState<'charts' | 'documents'>('charts');
  const [editingReport, setEditingReport] = useState<AppReport | 'new' | null>(null);
  const [editingDoc, setEditingDoc] = useState<AppReportDocument | 'new' | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // History-aware back: return to wherever the user came from (dashboard, custom screen, …);
  // fall back to the app home on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}`);
  };

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

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Chart your data and export polished PDFs"
        onBack={goBack}
        backLabel="Back to dashboard"
        actions={isOwner ? (
          tab === 'charts'
            ? <button onClick={() => setEditingReport('new')} aria-label="New report" className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> <span className="hidden sm:inline">New report</span></button>
            : <button onClick={() => setEditingDoc('new')} aria-label="New document" className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> <span className="hidden sm:inline">New document</span></button>
        ) : undefined}
      />

      {/* Tabs */}
      <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-gray-100 dark:bg-slate-800/60 mb-5">
        <button onClick={() => setTab('charts')} aria-pressed={tab === 'charts'} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${tab === 'charts' ? 'bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400'}`}>
          <FileBarChart className="h-4 w-4" /> Charts {chartReports.length > 0 && <span className="text-xs opacity-60 tabular-nums">{chartReports.length}</span>}
        </button>
        <button onClick={() => setTab('documents')} aria-pressed={tab === 'documents'} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${tab === 'documents' ? 'bg-white dark:bg-slate-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-slate-400'}`}>
          <FileText className="h-4 w-4" /> PDF documents {documents.length > 0 && <span className="text-xs opacity-60 tabular-nums">{documents.length}</span>}
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

/**
 * Master list shared by both report panels: a micro-labeled column of selectable rows.
 * Purely presentational — selection state lives in the panel.
 */
function MasterList<T extends { id: string; name: string }>({ label, items, selectedId, onSelect, renderIcon, itemMeta }: {
  label: string;
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderIcon: (item: T, active: boolean) => ReactNode;
  itemMeta: (item: T) => ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500">{label}</p>
      {items.map((item) => {
        const active = item.id === selectedId;
        return (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-current={active ? 'true' : undefined}
            className={`w-full flex items-center gap-3 p-3 rounded-2xl border text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary ${active ? 'app-bg-primary-light app-border-primary' : 'border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
          >
            <div className={`p-2 rounded-lg shrink-0 ${active ? '' : 'bg-gray-100 dark:bg-slate-800'}`}>{renderIcon(item, active)}</div>
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{item.name}</span>
              <span className="block text-xs text-gray-400 dark:text-slate-500 truncate">{itemMeta(item)}</span>
            </div>
          </button>
        );
      })}
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
      <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
        <EmptyState
          icon={FileBarChart}
          title="No reports yet"
          description={isOwner ? 'Create a report to chart or list your app’s data.' : 'The app owner hasn’t added any reports.'}
          action={isOwner ? (
            <button onClick={onNew} className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> New report</button>
          ) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_1fr] gap-4">
      <MasterList
        label="Saved reports"
        items={reports}
        selectedId={selected?.id ?? null}
        onSelect={setClickedId}
        renderIcon={(r, active) => {
          const Icon = VIZ_ICON[r.spec?.viz ?? 'bar'] ?? BarChart3;
          return <Icon className={listIconCls(active)} />;
        }}
        itemMeta={(r) => formName(r.spec?.formId ?? '')}
      />

      <div className="min-w-0 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 p-5 min-h-[240px]">
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
          /* Mirror the coming chart: an axis-label line, the plot area, then a legend row. */
          <div className="space-y-3 py-2" role="status" aria-label="Loading report">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-44 w-full rounded-xl" />
            <div className="flex gap-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
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
      <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
        <EmptyState
          icon={FileText}
          title="No PDF documents yet"
          description={isOwner ? 'Combine several charts and text into one polished PDF report.' : 'The app owner hasn’t added any documents.'}
          action={isOwner ? (
            <div className="flex flex-col items-center gap-2">
              <button onClick={onNew} disabled={!hasCharts} title={hasCharts ? undefined : 'Create a chart report first'} className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer disabled:opacity-50"><Plus className="h-4 w-4" /> New document</button>
              {!hasCharts && <p className="text-xs text-gray-400 dark:text-slate-500">Create a chart report first.</p>}
            </div>
          ) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_1fr] gap-4">
      <MasterList
        label="Saved documents"
        items={documents}
        selectedId={selected?.id ?? null}
        onSelect={setClickedId}
        renderIcon={(_d, active) => <FileText className={listIconCls(active)} />}
        itemMeta={(d) => {
          const charts = d.blocks.filter((b) => b.kind === 'report').length;
          return `${charts} chart${charts === 1 ? '' : 's'} · ${d.blocks.length} block${d.blocks.length === 1 ? '' : 's'}`;
        }}
      />

      <div className="min-w-0 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 p-5 min-h-[240px]">
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
