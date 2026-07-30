// Diagrams index (§11A D1): the management list behind /diagrams/all (the sidebar's
// /diagrams is the smart resume-or-new entry). New diagrams open a deferred canvas —
// nothing persists until the first real change. Each diagram is a blueprint row.
// Search + pagination are CLIENT-side: the list endpoint caps at 200 rows and the
// demo's browser-local diagrams merge in client-side, so filtering here covers both.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Loader2, Map as MapIcon, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { LoadFailure } from '../../components/ui/LoadFailure';
import { formatDateTimeInZone, useAccountTimezone } from '../../lib/timezone';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { Blueprint } from '../../types/blueprints';

const PAGE_SIZE = 10;

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
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
            <MapIcon className="h-6 w-6 text-primary-600 dark:text-primary-300" />
            Diagrams
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            Sketch what you're building — forms, flows, and what triggers what — before it exists.
          </p>
        </div>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => navigate('/diagrams/new')} leftIcon={<Plus className="h-4 w-4" />}>
          New diagram
        </Button>
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search diagrams"
            aria-label="Search diagrams"
            className="w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-8 pr-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </div>
        {api.isDemoMode() && (
          <p className="w-full text-xs text-gray-400 dark:text-slate-500">
            Demo diagrams stay in this browser — nothing is saved to the server. Sign up free to keep
            them and turn a diagram into a real app.
          </p>
        )}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-gray-400 dark:text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : loadError ? (
        <LoadFailure
          title="We couldn't load your diagrams"
          message={loadError}
          onRetry={() => { setLoadError(null); setLoading(true); setReloadToken((n) => n + 1); }}
        />
      ) : diagrams.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">
          No diagrams yet — create one above, or use "Start with a diagram" on the Dashboard.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-slate-500">
          No diagrams match &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {pageRows.map((diagram) => (
              <div
                key={diagram.id}
                className="group flex items-center gap-3 rounded-xl border border-gray-200/80 bg-white px-4 py-3 hover:border-primary-300 dark:border-slate-700/60 dark:bg-slate-900 dark:hover:border-primary-500/40"
              >
                <button type="button" onClick={() => navigate(`/diagrams/${diagram.id}`)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{diagram.name}</p>
                  <p className="text-xs text-gray-400 dark:text-slate-500">
                    {diagram.status} · rev {diagram.semanticRevision} · updated {formatDateTimeInZone(diagram.updatedAt, tz)}
                  </p>
                </button>
                <Button
                  variant="ghost"
                  size="iconOnly"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => setPendingDelete(diagram)}
                  aria-label={`Delete diagram ${diagram.name}`}
                >
                  <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400 dark:text-slate-500">
                {filtered.length} diagram{filtered.length === 1 ? '' : 's'}
                {query.trim() !== '' ? ' matching' : ''}
              </p>
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
                <span className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
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
            </div>
          )}
        </>
      )}
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
