import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Database, ChevronRight, ChevronDown, Download, FileArchive, FileCode2, Loader2 } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

type ExportFormat = 'sqlite' | 'mysql' | 'mssql';

const EXPORT_OPTIONS: Array<{ format: ExportFormat; label: string; hint: string; icon: typeof FileArchive }> = [
  { format: 'sqlite', label: 'SQLite bundle (.zip)', hint: 'Per-form databases + schema.json + files', icon: FileArchive },
  { format: 'mysql', label: 'MySQL dump (.sql)', hint: 'Forms as tables, records as rows', icon: FileCode2 },
  { format: 'mssql', label: 'SQL Server dump (.sql)', hint: 'Same tables in T-SQL', icon: FileCode2 },
];

/** Owner-only "Export data" menu: the whole app's records in portable formats. */
function ExportDataMenu({ appId, appSlug }: { appId: string; appSlug: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const run = async (format: ExportFormat) => {
    if (exporting) return;
    setOpen(false);
    setExporting(format);
    try {
      await api.exportAppData(appId, format, appSlug);
      toast.success('Export ready', 'Your download has started.');
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : undefined);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={exporting !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
      >
        {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export data'}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-72 z-20 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900 shadow-lg overflow-hidden"
        >
          {EXPORT_OPTIONS.map(({ format, label, hint, icon: Icon }) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => { void run(format); }}
              className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset app-ring-primary"
            >
              <Icon className="h-4 w-4 mt-0.5 app-text-primary shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-white">{label}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A lightweight records hub: lists every form in the app the member is allowed to view, each opening
 * that form's records grid (AppDataTable). This is the single entry point to submitted data — it
 * works for chromeless custom-dashboard apps (via the floating Records button) and for apps with the
 * standard nav alike. Responsive: a single column on phones, two/three up on wider screens.
 * The app OWNER additionally gets whole-app data exports (SQLite bundle / MySQL / SQL Server).
 */
export function AppRecordsBrowser() {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, canViewOwn, canViewAll, isOwner } = useAppRuntimeStore();

  if (!config) return null;

  const viewable = config.forms.filter((f) => canViewOwn(f.formId) || canViewAll(f.formId));

  // History-aware back: return to wherever the user came from (dashboard, custom screen, …);
  // fall back to the app home on a fresh deep link with no in-app history.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(`/app/${appSlug}`);
  };

  return (
    <div>
      <PageHeader
        title="Records"
        subtitle="Browse each form's records"
        onBack={goBack}
        backLabel="Back to dashboard"
        actions={isOwner() && config.app.id ? <ExportDataMenu appId={config.app.id} appSlug={appSlug ?? 'app'} /> : undefined}
      />

      {viewable.length === 0 ? (
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50">
          <EmptyState
            icon={Database}
            title="No records to browse"
            description="You don't have permission to view records in this app. Ask the app owner to grant you access."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {viewable.map((f) => (
            <button
              key={f.formId}
              onClick={() => navigate(`/app/${appSlug}/form/${f.formId}/responses`)}
              className="flex items-center gap-3 p-4 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 transition-colors duration-200 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              <div className="p-2 rounded-lg app-bg-primary-light shrink-0">
                <DynamicIcon name={f.icon ?? null} className="h-5 w-5 app-text-primary" fallback={<Database className="h-5 w-5 app-text-primary" />} />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">{f.displayName}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">View records</span>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
