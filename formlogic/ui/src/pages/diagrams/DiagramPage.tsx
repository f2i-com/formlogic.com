// One diagram at /diagrams/:diagramId (§11A D1): the canvas with a light header. The
// diagram IS a blueprint row — the create path (Dashboard "Start with a diagram") lands
// here, and later slices link it to a materialised app for bi-directional updates.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft, History, Loader2, Map as MapIcon, Sparkles, User as UserIcon, Wand2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useReturnTo } from '../../hooks/useReturnTo';
import { formatDateTimeInZone, useAccountTimezone } from '../../lib/timezone';
import { toast } from '../../stores/toastStore';
import type { Blueprint } from '../../types/blueprints';
import { DiagramCanvas } from './DiagramCanvas';

/** The local pre-persistence draft: /diagrams/new renders this until a change lands. */
function draftBlueprint(): Blueprint {
  return {
    id: '',
    appId: null,
    name: 'Untitled diagram',
    status: 'draft',
    semanticRevision: 0,
    layoutRevision: 0,
    viewport: null,
    createdAt: '',
    updatedAt: '',
    elements: [],
  };
}

export default function DiagramPage() {
  const { diagramId } = useParams<{ diagramId: string }>();
  const navigate = useNavigate();
  // Origin-relative Back: opened from the App Studio Plan step this returns there.
  const backTo = useReturnTo('/diagrams/all');
  // /diagrams/new = a DEFERRED canvas: nothing persists until the first real
  // change (owner direction: never save an empty canvas). The row is created
  // lazily by ensureId() when the canvas commits its first operation; the URL
  // flips to the real id on the next reload.
  const isNew = diagramId === 'new';
  const createdRef = useRef<string | null>(null);
  const createPromiseRef = useRef<Promise<string | null> | null>(null);
  const [diagram, setDiagram] = useState<Blueprint | null>(() => (isNew ? draftBlueprint() : null));
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const nameRef = useRef('Untitled diagram');
  useEffect(() => {
    if (diagram) nameRef.current = diagram.name;
  }, [diagram]);

  const ensureId = useCallback(async (): Promise<string | null> => {
    if (createdRef.current) return createdRef.current;
    // Single-flight creation (audit FL-14): two same-tick first actions must share ONE
    // POST — otherwise each creates its own row and their operations land on different
    // diagram ids. A failed create clears the promise so a later action can retry.
    if (!createPromiseRef.current) {
      createPromiseRef.current = api
        .createBlueprint({ name: nameRef.current })
        .then((res) => {
          if (!res.data?.blueprint) {
            toast.error('Could not create the diagram', typeof res.error === 'string' ? res.error : undefined);
            return null;
          }
          createdRef.current = res.data.blueprint.id;
          return createdRef.current;
        })
        .finally(() => {
          // createdRef is the success fast path; clearing here only re-arms retries.
          createPromiseRef.current = null;
        });
    }
    return createPromiseRef.current;
  }, []);

  const load = useCallback(async () => {
    if (isNew) {
      // First committed change on a draft: swap to the real diagram URL.
      if (createdRef.current) navigate(`/diagrams/${createdRef.current}`, { replace: true });
      return;
    }
    if (!diagramId) return;
    const res = await api.getBlueprint(diagramId);
    if (res.data?.blueprint) {
      setDiagram(res.data.blueprint);
    } else {
      setMissing(true);
      toast.error('Diagram not found', typeof res.error === 'string' ? res.error : undefined);
    }
  }, [diagramId, isNew, navigate]);

  // Route-param change while mounted (e.g. back to /diagrams/new from a real
  // diagram): reset synchronously during render — the sanctioned derived-state
  // pattern — so the draft never flashes stale content.
  const [lastParam, setLastParam] = useState(diagramId);
  if (lastParam !== diagramId) {
    setLastParam(diagramId);
    setDiagram(isNew ? draftBlueprint() : null);
    setMissing(false);
  }

  // A fresh /diagrams/new visit starts un-persisted again (ref writes belong in effects).
  useEffect(() => {
    if (isNew) {
      createdRef.current = null;
      createPromiseRef.current = null;
    }
  }, [diagramId, isNew]);

  useEffect(() => {
    let cancelled = false;
    if (isNew || !diagramId) return;
    void api.getBlueprint(diagramId).then((res) => {
      if (cancelled) return;
      if (res.data?.blueprint) setDiagram(res.data.blueprint);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [diagramId, isNew]);

  // dvh, not vh (audit FL-26): mobile browser chrome shrinks the visual viewport —
  // 100vh clipped the bottom of the workspace behind the URL bar.
  // The editor is a full-window tool with no Header of its own: it takes the window's whole
  // height (less the demo bar when there is one), and on a phone stops at the bottom
  // navigation. Subtracting a 4rem header that is not there left a dead band under the canvas.
  return (
    <div className="flex h-[calc(100dvh-var(--fl-mobile-nav-h)-var(--fl-demo-banner-h,0px))] min-h-0 flex-col md:h-[calc(100dvh-var(--fl-demo-banner-h,0px))]">
      {/* @container/bar: the Timeline's word gives way to its icon by the bar's own width. */}
      <div className="@container/bar flex flex-none items-center gap-1.5 border-b border-gray-200 bg-white px-2 py-1.5 dark:border-slate-700/60 dark:bg-slate-900 sm:gap-3 sm:px-4 sm:py-2">
        <Link
          to={backTo.path}
          className="inline-flex flex-none items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white max-sm:min-h-11"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {backTo.label ?? 'Diagrams'}
        </Link>
        <button
          type="button"
          onClick={() => setShowHistory((open) => !open)}
          title="Build timeline"
          aria-label="Toggle the build timeline"
          aria-pressed={showHistory}
          className={cn(
            'order-last ml-auto inline-flex flex-none items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 max-sm:min-w-11',
            showHistory
              ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300'
              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
          )}
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden @md/bar:inline">Timeline</span>
        </button>
        {/* The name takes the room between the two: it is cut short only when the bar has no
            more to give, and its title says it whole. */}
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <MapIcon className="h-4 w-4 flex-none text-primary-600 dark:text-primary-300" />
          {diagram && renaming ? (
            <input
              autoFocus
              defaultValue={diagram.name}
              aria-label="Diagram name"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenaming(false);
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              onBlur={(e) => {
                setRenaming(false);
                const name = e.currentTarget.value.trim();
                if (name === '' || name === diagram.name) return;
                if (diagram.id === '') {
                  setDiagram((current) => (current ? { ...current, name } : current));
                  return;
                }
                void api.renameBlueprint(diagram.id, name).then((res) => {
                  if (res.data?.blueprint) setDiagram((current) => (current ? { ...current, name } : current));
                  else toast.error('Rename failed', typeof res.error === 'string' ? res.error : undefined);
                });
              }}
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white max-sm:min-h-11 sm:max-w-md"
            />
          ) : (
            <button
              type="button"
              title={diagram ? `${diagram.name} (press to rename)` : undefined}
              aria-label={diagram ? `Rename diagram ${diagram.name}` : undefined}
              onClick={() => { if (diagram) setRenaming(true); }}
              className="min-w-0 truncate rounded px-1 py-0.5 text-left hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-slate-800 max-sm:min-h-11"
            >
              {diagram?.name ?? (missing ? 'Not found' : 'Loading…')}
            </button>
          )}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 bg-gray-50 dark:bg-slate-950">
        {diagram && diagram.id !== '' && showHistory && (
          <BuildTimeline blueprintId={diagram.id} semanticRevision={diagram.semanticRevision} onClose={() => setShowHistory(false)} />
        )}
        <div className="min-h-0 min-w-0 flex-1">
        {diagram ? (
          <ReactFlowProvider>
            <DiagramCanvas
              key={diagram.id}
              blueprint={diagram}
              // One side panel at a time: the timeline and the selection's panel give way to
              // each other, so the canvas keeps its room.
              sidePanelOpen={showHistory}
              onSelect={() => setShowHistory(false)}
              onEnsureId={ensureId}
              onReload={load}
              onRevisions={(semantic, layout) =>
                setDiagram((current) =>
                  current ? { ...current, semanticRevision: semantic, layoutRevision: layout } : current,
                )
              }
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center">
            {missing ? (
              <p className="text-sm text-gray-400 dark:text-slate-500">
                This diagram doesn't exist (or isn't yours). <Link to="/diagrams/all" className="text-primary-600 underline dark:text-primary-300">Back to Diagrams</Link>
              </p>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/** One short line per operation ("added 2 elements", …) for the timeline rows. */
function summarizeOps(operations: Array<{ type: string; targetId: string | null }>): string {
  const counts: Record<string, number> = {};
  for (const op of operations) {
    if (op.type.startsWith('undo-of:')) return 'Undid an earlier change';
    const key = op.type === 'blueprint.element.create'
      ? 'added'
      : op.type === 'blueprint.element.update'
        ? 'updated'
        : op.type === 'blueprint.element.delete'
          ? 'removed'
          : 'arranged';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([verb, n]) => `${verb} ${n} element${n === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : 'No changes';
}

/**
 * §11B O3 — the Build Timeline: every AI and manual action is already an audited
 * operation, so this is a read-only projection of the shared command stream. Copilot
 * batches wear a sparkle, the launcher a wand, your own edits a person.
 */
function BuildTimeline({ blueprintId, semanticRevision, onClose }: { blueprintId: string; semanticRevision: number; onClose: () => void }) {
  // Server timestamps are UTC — show each entry on the viewer's clock.
  const tz = useAccountTimezone();
  const [history, setHistory] = useState<Array<{
    changeSetId: string; origin: string; createdAt: string;
    semanticRevision: number | null; operations: Array<{ type: string; targetId: string | null }>;
  }>>([]);
  useEffect(() => {
    let cancelled = false;
    void api.listBlueprintHistory(blueprintId).then((res) => {
      if (!cancelled) setHistory(res.data?.history ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [blueprintId, semanticRevision]);

  // Desktop: a rail at the canvas's left. Phones (audit FL-26): a sheet over the foot of the
  // canvas, as the selection's panel is, so the canvas keeps the screen's width.
  return (
    <aside
      aria-label="Build timeline"
      className="scrollbar-thin border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900 max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--fl-mobile-nav-h)] max-md:z-40 max-md:max-h-[45dvh] max-md:overflow-y-auto max-md:rounded-t-2xl max-md:border-t max-md:pb-[calc(var(--fl-mobile-fab-h)+0.5rem)] max-md:shadow-2xl md:w-64 md:flex-none md:overflow-y-auto md:border-r"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Build timeline</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the build timeline"
          title="Close"
          className="-my-1 -mr-1 flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white max-md:h-11 max-md:w-11"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {history.length === 0 ? (
        <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">No changes yet — every edit (yours and the AI's) lands here.</p>
      ) : (
        <ol className="space-y-1.5">
          {history.map((entry) => (
            <li key={entry.changeSetId} className="rounded-lg border border-gray-100 px-2.5 py-1.5 dark:border-slate-800">
              <p className="flex items-start gap-1.5 text-xs font-medium text-gray-700 dark:text-slate-200">
                {entry.origin === 'copilot' ? (
                  <Sparkles className="mt-0.5 h-3 w-3 flex-none text-primary-500" />
                ) : entry.origin === 'launcher' ? (
                  <Wand2 className="mt-0.5 h-3 w-3 flex-none text-primary-500" />
                ) : (
                  <UserIcon className="mt-0.5 h-3 w-3 flex-none text-gray-400" />
                )}
                {summarizeOps(entry.operations)}
              </p>
              <p className="mt-0.5 text-[11px] tabular-nums text-gray-500 dark:text-slate-400">
                {formatDateTimeInZone(entry.createdAt, tz)}
                {entry.semanticRevision !== null ? ` · rev ${entry.semanticRevision}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
