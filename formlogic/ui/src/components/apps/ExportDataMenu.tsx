import { useEffect, useRef, useState } from 'react';
import { Popover } from '../ui/Popover';
import { ChevronDown, Download, FileArchive, FileCode2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

type ExportFormat = 'sqlite' | 'mysql' | 'mssql';

// Described by PURPOSE, not by file format. Every option was named after a database
// engine, so an owner looking for "my data in a spreadsheet" had three dumps to choose
// between and no way to tell which one was for them. `developer` groups the two that
// genuinely are for a developer.
const EXPORT_OPTIONS: Array<{ format: ExportFormat; label: string; hint: string; icon: typeof FileArchive; developer?: boolean }> = [
  { format: 'sqlite', label: 'Full backup (.zip)', hint: 'Everything — records and uploaded files. For keeping or moving this app.', icon: FileArchive },
  { format: 'mysql', label: 'MySQL dump (.sql)', hint: 'Tables, records and relations.', icon: FileCode2, developer: true },
  { format: 'mssql', label: 'SQL Server dump (.sql)', hint: 'The same tables and relations in T-SQL.', icon: FileCode2, developer: true },
];

/**
 * Owner "Export data" dropdown — the whole app's records in portable formats
 * (GET /api/apps/{id}/export/data). Two skins: 'platform' follows the manage
 * pages' indigo tokens; 'app' follows the running app's theme variables.
 */
export function ExportDataMenu({ appId, appSlug, variant = 'platform' }: { appId: string; appSlug: string; variant?: 'platform' | 'app' }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // In the manage pages the menu is drawn over the page (below). In a running app it stays where
  // it is, inside the app: the app's colours and font are set on the app's own element, and a menu
  // drawn outside it would lose them.
  const inPlace = variant === 'app';

  const ring = variant === 'app' ? 'app-ring-primary' : 'focus-visible:ring-primary-500';
  const accent = variant === 'app' ? 'app-text-primary' : 'text-primary-600 dark:text-primary-400';

  useEffect(() => {
    if (!open) return;
    if (inPlace) {
      // In place it moves with its button; a press anywhere else closes it.
      const away = (event: MouseEvent) => { if (holder.current && !holder.current.contains(event.target as Node)) setOpen(false); };
      document.addEventListener('mousedown', away);
      return () => document.removeEventListener('mousedown', away);
    }
    // Over the page it would stay where the button was while the page moved under it, so it closes
    // when anything scrolls. Listened for as the event goes down: a scroll does not come back up,
    // and the page may scroll inside an element of its own rather than the window. Scrolling the
    // menu itself, when it is taller than the screen, is not the page moving.
    const scrolled = (event: Event) => {
      const panel = menu.current?.closest('[role="dialog"]');
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', scrolled, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', scrolled, { capture: true });
  }, [open, inPlace]);

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

  const choices = (
    <div ref={menu} role="menu">
      {EXPORT_OPTIONS.map(({ format, label, hint, icon: Icon, developer }, i) => (
        <div key={format}>
        {developer && !EXPORT_OPTIONS[i - 1]?.developer && (
          <p className="border-t border-gray-100 px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:border-slate-800 dark:text-slate-500">
            For developers
          </p>
        )}
        <button
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
        </div>
      ))}
      {/* The thing most owners actually want is not in this menu at all. */}
      <p className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-500 dark:border-slate-800 dark:text-slate-400">
        Want a spreadsheet? Open a form&apos;s records and choose Export there.
      </p>
    </div>
  );

  return (
    <div ref={holder} className="relative">
      <button
        ref={trigger}
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
      {/* Over the page, not inside whatever holds the button: in the studio's narrow rail the menu
          is wider than the card around it, which clips what it holds, so half of it was cut off.
          The popover keeps itself inside the window, closes on Escape or a press elsewhere, and
          gives the focus back to the button. */}
      {inPlace
        ? open && <div className="absolute right-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-lg dark:border-slate-700/60 dark:bg-slate-900">{choices}</div>
        : <Popover isOpen={open} onClose={() => setOpen(false)} anchorRef={trigger} placement="bottom-start" ariaLabel="Export data"
          className="w-72 max-w-[calc(100vw-1rem)] rounded-xl">{choices}</Popover>}
    </div>
  );
}
