import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Pencil, Trash2, Download, FileBarChart, Loader2, BarChart3, PieChart, Table2, Hash } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReport, AppReportResult } from '../../types/app';
import { ReportResultView } from './ReportResultView';
import { ReportBuilder } from './ReportBuilder';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { exportReportPdf } from './reportPdf';
import { toast } from '../../stores/toastStore';

const VIZ_ICON: Record<string, typeof BarChart3> = { bar: BarChart3, pie: PieChart, table: Table2, kpi: Hash };

export function AppReports() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, runReport, saveReports } = useAppRuntimeStore();

  const reports: AppReport[] = config?.app?.reports ?? [];
  // ownerId is only present on the config for the app owner (stripped for members).
  const isOwner = !!config?.app?.ownerId;

  const [selectedId, setSelectedId] = useState<string | null>(reports[0]?.id ?? null);
  const [result, setResult] = useState<AppReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppReport | 'new' | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const selected = reports.find((r) => r.id === selectedId) ?? null;
  const formName = (fid: string) => config?.forms.find((f) => f.formId === fid)?.displayName ?? 'form';

  // Run the selected report.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setRunning(true);
      setErr(null);
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
  }, [selectedId, selected, runReport]);

  const handleSave = async (report: AppReport) => {
    const exists = reports.some((r) => r.id === report.id);
    const next = exists ? reports.map((r) => (r.id === report.id ? report : r)) : [...reports, report];
    const ok = await saveReports(next);
    if (ok) {
      setEditing(null);
      setSelectedId(report.id);
      toast.success('Report saved');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const next = reports.filter((r) => r.id !== deleteId);
    const ok = await saveReports(next);
    if (ok) {
      if (selectedId === deleteId) setSelectedId(next[0]?.id ?? null);
      toast.success('Report deleted');
    }
    setDeleteId(null);
  };

  const handleExport = () => {
    if (!selected || !result) return;
    if (!exportReportPdf(selected, result, config?.app?.name ?? 'App')) {
      toast.error('Pop-up blocked', 'Allow pop-ups to export the report as PDF.');
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(`/app/${appSlug}`)} aria-label="Back to dashboard" className="p-2.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">Reports</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Query your data and export as PDF</p>
        </div>
        {isOwner && (
          <button onClick={() => setEditing('new')} className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer">
            <Plus className="h-4 w-4" /> New report
          </button>
        )}
      </div>

      {reports.length === 0 ? (
        <div className="text-center py-16">
          <FileBarChart className="h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-slate-600" />
          <p className="text-gray-600 dark:text-slate-300 font-medium">No reports yet</p>
          <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">{isOwner ? 'Create a report to chart or list your app’s data.' : 'The app owner hasn’t added any reports.'}</p>
          {isOwner && <button onClick={() => setEditing('new')} className="app-btn-primary mt-4 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium cursor-pointer"><Plus className="h-4 w-4" /> New report</button>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,260px)_1fr] gap-4">
          {/* List */}
          <div className="space-y-2">
            {reports.map((r) => {
              const Icon = VIZ_ICON[r.spec?.viz ?? 'bar'] ?? BarChart3;
              const active = r.id === selectedId;
              return (
                <button key={r.id} onClick={() => setSelectedId(r.id)} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors cursor-pointer ${active ? 'app-bg-primary-light app-border-primary' : 'border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/40 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                  <div className={`p-2 rounded-lg shrink-0 ${active ? '' : 'bg-gray-100 dark:bg-slate-800'}`}><Icon className={`h-4 w-4 ${active ? 'app-text-primary' : 'text-gray-500 dark:text-slate-400'}`} /></div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{r.name}</span>
                    <span className="block text-xs text-gray-400 dark:text-slate-500 truncate">{formName(r.spec?.formId ?? '')}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Result */}
          <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 min-h-[240px]">
            {selected && (
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate">{selected.name}</h2>
                  {selected.description && <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{selected.description}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={handleExport} disabled={!result || running} aria-label="Export PDF" title="Export PDF" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50">
                    <Download className="h-4 w-4" /><span className="hidden sm:inline">PDF</span>
                  </button>
                  {isOwner && <>
                    <button onClick={() => setEditing(selected)} aria-label="Edit report" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => setDeleteId(selected.id)} aria-label="Delete report" className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"><Trash2 className="h-4 w-4" /></button>
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
      )}

      {editing && (
        <ReportBuilder
          report={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete report"
        message="Delete this report? This can't be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
