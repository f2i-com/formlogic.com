// Diagrams index (§11A D1): the management list behind /diagrams/all (the sidebar's
// /diagrams is the smart resume-or-new entry). New diagrams open a deferred canvas —
// nothing persists until the first real change. Each diagram is a blueprint row.
// Search + pagination are CLIENT-side: the list endpoint caps at 200 rows and the
// demo's browser-local diagrams merge in client-side, so filtering here covers both.
//
// A workspace page like the others (docs/WORKSPACE_PAGES.md): the Header names it and holds
// "New diagram", and the diagrams are a table of dense rows that turns into cards where there
// is no room for columns.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Map as MapIcon, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, parseServerDate } from '../../lib/utils';
import { Header } from '../../components/layout/Header';
import { PageBody } from '../../components/layout/PageBody';
import { LoadFailure } from '../../components/ui/LoadFailure';
import { Spinner } from '../../components/ui/Spinner';
import { formatDateTimeInZone, useAccountTimezone } from '../../lib/timezone';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH } from '../../components/ui/listLook';
import type { Blueprint } from '../../types/blueprints';

// A screenful of dense rows.
const PAGE_SIZE = 20;

/** A row's action: 32px in the table, a finger's 44px on a card. */
const ROW_ACTION = 'inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300 @xl/list:h-8 @xl/list:w-8 @xl/list:rounded-md';

/** "draft" → "Draft": the status as the server names it, written as a word. */
const statusWord = (status: string) => (status === '' ? '' : status.charAt(0).toUpperCase() + status.slice(1));

/** "Nov 12, 2026, 10:10 AM": when a diagram changed, to the minute. The row's title carries
    the full moment with its seconds and zone. */
function shortWhen(value: string, tz: string): string {
  const date = parseServerDate(value);
  if (isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(date);
  }
}

export default function DiagramsIndex() {
  const navigate = useNavigate();
  // Server timestamps are UTC — render them on the viewer's clock (account tz →
  // browser tz → UTC), the platform-chrome convention.
  const tz = useAccountTimezone();
  const [diagrams, setDiagrams] = useState<Blueprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<Blueprint | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  // Name search (case-insensitive); a new query always restarts at page 1 via the
  // clamp below, and deleting the last row of a page falls back a page the same way.
  const filtered = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (wanted === '') return diagrams;
    return diagrams.filter((d) => d.name.toLowerCase().includes(wanted));
  }, [diagrams, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    void api.listBlueprints().then((res) => {
      if (cancelled) return;
      // `?? []` here rendered a failed read as "No diagrams yet", so a broken list looked
      // like an empty one and the owner's diagrams appeared to be gone.
      if (res.error || !res.data) {
        setLoadError(typeof res.error === 'string' ? res.error : 'Please try again.');
      } else {
        setDiagrams(res.data.blueprints ?? []);
        setLoadError(null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refresh = useCallback(async () => {
    const res = await api.listBlueprints();
    // A failed refresh keeps the rows already on screen rather than blanking them.
    if (!res.error && res.data) {
      setDiagrams(res.data.blueprints ?? []);
      setLoadError(null);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    await api.deleteBlueprint(target.id);
    await refresh();
  }, [pendingDelete, refresh]);

  return (
    <div className="min-h-screen">
      <Header
        title="Diagrams"
        actions={
          // The words give way to the icon on a phone, where the header keeps its room for
          // the page's name and the account menu.
          <Button size="sm" onClick={() => navigate('/diagrams/new')} leftIcon={<Plus className="h-4 w-4" />} aria-label="New diagram">
            <span className="hidden sm:inline">New diagram</span>
          </Button>
        }
      />

      <PageBody>
        <div className="@container/list space-y-3">
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Sketch what you're building — forms, flows, and what triggers what — before it exists.
          </p>
          {api.isDemoMode() && (
            <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
              Demo diagrams stay in this browser — nothing is saved to the server. Sign up free to keep
              them and turn a diagram into a real app.
            </p>
          )}

          {/* The search stands with the list: an account with no diagrams has nothing to search. */}
          {(loading || (!loadError && diagrams.length > 0)) && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search diagrams"
                aria-label="Search diagrams"
                className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder:text-slate-500"
              />
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2.5 py-2 text-sm text-gray-500 dark:text-slate-400" role="status">
              <Spinner size="sm" /><span>Loading…</span>
            </div>
          ) : loadError ? (
            <LoadFailure
              title="We couldn't load your diagrams"
              message={loadError}
              onRetry={() => { setLoadError(null); setLoading(true); setReloadToken((n) => n + 1); }}
            />
          ) : diagrams.length === 0 ? (
            // No diagrams: one line where the list would be, with the way to start one.
            <p className={cn(LIST_BOX, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm text-gray-500 dark:text-slate-400')}>
              <span className="flex items-center gap-2">
                <MapIcon className="h-4 w-4 flex-none" aria-hidden="true" />No diagrams yet.
              </span>
              <Button size="sm" variant="secondary" onClick={() => navigate('/diagrams/new')} leftIcon={<Plus className="h-4 w-4 text-primary-600 dark:text-primary-400" />}>
                Start a diagram
              </Button>
            </p>
          ) : filtered.length === 0 ? (
            <p className={cn(LIST_BOX, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm text-gray-500 dark:text-slate-400')}>
              <span className="[overflow-wrap:anywhere]">No diagrams match &ldquo;{query.trim()}&rdquo;.</span>
              <Button size="sm" variant="secondary" onClick={() => { setQuery(''); setPage(1); }}>
                Show every diagram
              </Button>
            </p>
          ) : (
            // Wide: a row per diagram, its actions at the right. Narrow: the same rows as cards,
            // the name on top and the buttons a finger tall beside it.
            <div className={LIST_BOX}>
              <table className={LIST_TABLE}>
                <caption className="sr-only">Diagrams</caption>
                <thead className={LIST_HEAD}>
                  <tr>
                    <th scope="col" className={cn(LIST_TH, 'pl-3')}>Name</th>
                    <th scope="col" className={cn(LIST_TH, 'w-28')}>Status</th>
                    <th scope="col" className={cn(LIST_TH, 'w-24 text-right')}>Revision</th>
                    <th scope="col" className={cn(LIST_TH, 'w-52 pl-6')}>Changed</th>
                    <th scope="col" className={cn(LIST_TH, 'w-24 pr-3')}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className={LIST_BODY}>
                  {pageRows.map((diagram) => (
                    <tr key={diagram.id} className={cn(LIST_ROW, 'relative grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-5 gap-y-1')}>
                      {/* The name takes the spare width and is never cut short: it wraps. On a
                          card it keeps clear of the two actions at the card's top right. */}
                      <th scope="row" className={cn(LIST_CELL, 'col-span-3 pr-24 font-normal @xl/list:pl-3 @xl/list:pr-2')}>
                        <Link
                          to={`/diagrams/${diagram.id}`}
                          className="flex min-h-11 items-center font-semibold text-gray-900 [overflow-wrap:anywhere] hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-white dark:hover:text-primary-300 max-sm:text-[15px] @xl/list:inline @xl/list:min-h-0"
                        >
                          {diagram.name}
                        </Link>
                      </th>
                      <td className={cn(LIST_CELL, 'text-gray-600 dark:text-slate-300')}>
                        <span className={LIST_LABEL}>Status</span>{statusWord(diagram.status)}
                      </td>
                      <td className={cn(LIST_CELL, 'tabular-nums text-gray-600 dark:text-slate-300 @xl/list:text-right')}>
                        <span className={LIST_LABEL}>Revision</span>{diagram.semanticRevision}
                      </td>
                      <td className={cn(LIST_CELL, 'tabular-nums text-gray-600 dark:text-slate-300 @xl/list:whitespace-nowrap @xl/list:pl-6')} title={formatDateTimeInZone(diagram.updatedAt, tz)}>
                        <span className={LIST_LABEL}>Changed</span>{shortWhen(diagram.updatedAt, tz)}
                      </td>
                      <td className={cn(LIST_CELL, 'absolute right-1.5 top-1.5 @xl/list:static @xl/list:py-0.5 @xl/list:pr-2 @xl/list:text-right')}>
                        <span className="inline-flex items-center justify-end gap-0.5">
                          <Link to={`/diagrams/${diagram.id}`} aria-label={`Open diagram ${diagram.name}`} title="Open the canvas" className={ROW_ACTION}>
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(diagram)}
                            aria-label={`Delete diagram ${diagram.name}`}
                            title="Delete the diagram"
                            className={cn(ROW_ACTION, 'cursor-pointer hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400')}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-gray-200 px-3 py-1.5 dark:border-slate-700">
                <p className="text-xs tabular-nums text-gray-500 dark:text-slate-400">
                  {filtered.length.toLocaleString()} diagram{filtered.length === 1 ? '' : 's'}
                  {query.trim() !== '' ? ' matching' : ''}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-xs font-medium tabular-nums text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {currentPage} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </PageBody>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete diagram"
        message={pendingDelete ? `Delete '${pendingDelete.name}'? The forms and flows it references are kept.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
