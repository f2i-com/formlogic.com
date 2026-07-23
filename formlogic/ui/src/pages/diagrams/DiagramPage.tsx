// One diagram at /diagrams/:diagramId (§11A D1): the canvas with a light header. The
// diagram IS a blueprint row — the create path (Dashboard "Start with a diagram") lands
// here, and later slices link it to a materialised app for bi-directional updates.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft, History, Loader2, Map as MapIcon, Sparkles, User as UserIcon, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
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
  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5 dark:border-slate-700/60 dark:bg-slate-900">
        <Link
          to="/diagrams/all"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Diagrams
        </Link>
        <button
          type="button"
          onClick={() => setShowHistory((open) => !open)}
          title="Build timeline"
          aria-label="Toggle the build timeline"
          aria-pressed={showHistory}
          className="order-last ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <History className="h-3.5 w-3.5" />
          Timeline
        </button>
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
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
              className="rounded-md border border-gray-300 bg-white px-2 py-0.5 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          ) : (
            <button
              type="button"
              title={diagram ? 'Rename diagram' : undefined}
              onClick={() => { if (diagram) setRenaming(true); }}
              className="rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-slate-800"
            >
              {diagram?.name ?? (missing ? 'Not found' : 'Loading…')}
            </button>
          )}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 bg-gray-50 dark:bg-slate-950">
        {diagram && diagram.id !== '' && showHistory && (
          <BuildTimeline blueprintId={diagram.id} semanticRevision={diagram.semanticRevision} />
        )}
        <div className="min-h-0 min-w-0 flex-1">
        {diagram ? (
          <ReactFlowProvider>
            <DiagramCanvas
              key={diagram.id}
              blueprint={diagram}
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
function BuildTimeline({ blueprintId, semanticRevision }: { blueprintId: string; semanticRevision: number }) {
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

  // Phones (audit FL-26): the timeline overlays the canvas instead of squeezing it.
  return (
    <aside className="scrollbar-thin w-64 flex-none overflow-y-auto border-r border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Build timeline</p>
      {history.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-slate-500">No changes yet — every edit (yours and the AI's) lands here.</p>
      ) : (
        <ol className="space-y-2">
          {history.map((entry) => (
            <li key={entry.changeSetId} className="rounded-lg border border-gray-100 px-2.5 py-2 dark:border-slate-800">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-gray-700 dark:text-slate-200">
                {entry.origin === 'copilot' ? (
                  <Sparkles className="h-3 w-3 flex-none text-primary-500" />
                ) : entry.origin === 'launcher' ? (
                  <Wand2 className="h-3 w-3 flex-none text-primary-500" />
                ) : (
                  <UserIcon className="h-3 w-3 flex-none text-gray-400" />
                )}
                {summarizeOps(entry.operations)}
              </p>
              <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">
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
