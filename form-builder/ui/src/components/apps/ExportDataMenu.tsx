import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileArchive, FileCode2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

type ExportFormat = 'sqlite' | 'mysql' | 'mssql';

const EXPORT_OPTIONS: Array<{ format: ExportFormat; label: string; hint: string; icon: typeof FileArchive }> = [
  { format: 'sqlite', label: 'SQLite bundle (.zip)', hint: 'Per-form databases + schema.json + files', icon: FileArchive },
  { format: 'mysql', label: 'MySQL dump (.sql)', hint: 'Forms as tables, records as rows', icon: FileCode2 },
  { format: 'mssql', label: 'SQL Server dump (.sql)', hint: 'Same tables in T-SQL', icon: FileCode2 },
];

/**
 * Owner "Export data" dropdown — the whole app's records in portable formats
 * (GET /api/apps/{id}/export/data). Two skins: 'platform' follows the manage
 * pages' indigo tokens; 'app' follows the running app's theme variables.
 */
export function ExportDataMenu({ appId, appSlug, variant = 'platform' }: { appId: string; appSlug: string; variant?: 'platform' | 'app' }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const ring = variant === 'app' ? 'app-ring-primary' : 'focus-visible:ring-primary-500';
  const accent = variant === 'app' ? 'app-text-primary' : 'text-primary-600 dark:text-primary-400';

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
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900/50 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 ${ring}`}
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
              className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${ring}`}
            >
              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${accent}`} />
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
