// FormLogic Flows workspace — the "Existing flows" section of /flows (no flow open).
//
// The flows as one table (cards on a phone): where each lives, what starts it, how its last run
// went and whether it is on, with its actions at the row's right. Under it, the latest runs and
// the two connections flows can use (OAIY Desktop, AI services).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, History, Laptop, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Workflow } from 'lucide-react';
import { listProviders } from '../../client-runtime/flows/aiProviders';
import { getOaiyStatus, subscribeOaiyStatus } from '../../client-runtime/oaiy/oaiyDetection';
import { isOaiyPaired, subscribeOaiyPaired } from '../../client-runtime/oaiy/oaiyRuntime';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Switch } from '../ui/Switch';
import { HELP, LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH, ROW_BOX } from '../ui/listLook';
import { FLOWS_PER_PAGE, lastRunByFlow, pageOf, triggerSummary } from './flowListFacts';
import { formatAbsoluteTimeTitle, formatRelativeTime } from './relativeTime';
import { statusChipStyle } from './runHistoryChip';
import { type FlowStarterTemplate } from './starterTemplates';
import {
  describeFlowsLastSeen,
  type FlowsDesktopPresence,
} from './useFlowsDesktopPresence';
import type { AppListItem } from '../../types/app';
import type { FlowBinding, FlowDefinition, FlowRunLog } from '../../types/flows';

/** A library group: the workspace (app null) or a specific app, plus its flows. */
export interface FlowGroup {
  app: AppListItem | null;
  flows: FlowDefinition[];
}

interface FlowsOverviewProps {
  groups: FlowGroup[];
  desktopPresence: FlowsDesktopPresence;
  availableConnectorIds?: readonly string[];
  onNewFlow: (template?: FlowStarterTemplate) => void;
  /** Open a flow in the full-page editor. */
  onOpenFlow: (flowId: string) => void;
  /** Open a flow with its run history panel showing (a row's last run, the recent runs). */
  onOpenRunFlow: (flowId: string) => void;
  onOpenAiServices: () => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  /** Opens the enable/disable confirm for this flow (the actual toggle happens on confirm). */
  onRequestToggleEnabled: (flow: FlowDefinition) => void;
  onDelete: (flow: FlowDefinition) => void;
  /** The triggers of the flows read so far, by flow id; a flow not in it has not been read yet. */
  triggersByFlowId?: Readonly<Record<string, FlowBinding[] | undefined>>;
  /** Why a flow's triggers could not be read, by flow id. */
  triggerErrorsByFlowId?: Readonly<Record<string, string | null | undefined>>;
  /** The rows on screen: the page reads the triggers of those it has not read yet. */
  onNeedTriggers?: (flows: FlowDefinition[]) => void;
  /** The owner's forms, to name the form a trigger listens to. */
  forms?: readonly { id: string; title: string }[];
}

/** How many of the newest runs are read to say when each flow last ran; the panel shows the first few. */
const RUNS_READ = 50;
const RECENT_RUNS_SHOWN = 6;

function RunStatusChip({ run }: { run: FlowRunLog }) {
  const { cls, label } = statusChipStyle(run);
  return <span className={`inline-block flex-none rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${cls}`}>{label}</span>;
}

export function FlowsOverview({
  groups, desktopPresence, onNewFlow, onOpenFlow, onOpenRunFlow, onOpenAiServices,
  onDuplicate, onRename, onRequestToggleEnabled, onDelete,
  triggersByFlowId, triggerErrorsByFlowId, onNeedTriggers, forms,
}: FlowsOverviewProps) {
  const flows = useMemo(() => groups.flatMap((group) => group.flows), [groups]);
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  // Every run there is was read: a flow without one among them has never run.
  const [runsComplete, setRunsComplete] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const userId = useAuthStore((state) => state.user?.id);
  const [providerCount, setProviderCount] = useState(() => listProviders(userId).length);
  const lastRuns = useMemo(() => lastRunByFlow(runs ?? [], flows), [runs, flows]);
  const flowById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow])), [flows]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setRunsError(null);
    const res = await api.listMyFlowRuns({ limit: RUNS_READ });
    setLoadingRuns(false);
    if (res.error || !res.data) {
      setRunsError(typeof res.error === 'string' ? res.error : 'Could not load recent runs');
      setRuns([]);
      setRunsComplete(false);
      return;
    }
    setRuns(res.data.runs);
    setRunsComplete(typeof res.data.total === 'number' ? res.data.total <= res.data.runs.length : res.data.runs.length < RUNS_READ);
  }, []);

  useEffect(() => {
    // Leading await: the load (and its setStates) runs after the effect body returns
    // (react-hooks/set-state-in-effect convention).
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await loadRuns();
    })();
    return () => { cancelled = true; };
  }, [loadRuns]);

  // A tab left open (e.g. overnight test calls) showed a stale list until the manual
  // Refresh — refetch whenever the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadRuns();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadRuns]);

  useEffect(() => {
    const refresh = () => setProviderCount(listProviders(userId).length);
    refresh();
    window.addEventListener('formlogic:ai-services-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('formlogic:ai-services-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);

  const recent = (runs ?? []).slice(0, RECENT_RUNS_SHOWN);

  return (
    // @container/list: the table follows the room the list really has (the sidebar and a docked
    // chat take their share of the window), not the screen's width.
    <div className="@container/list min-w-0 w-full">
      {flows.length === 0 ? (
        <div className={cn(LIST_BOX, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm text-gray-500 dark:text-slate-400')}>
          <Workflow className="h-4 w-4 flex-none" aria-hidden="true" />
          <p className="min-w-0 flex-1">No flows yet. Create one from a blank canvas or from a starting point.</p>
          <Button size="sm" onClick={() => onNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
            New flow
          </Button>
        </div>
      ) : (
        <FlowList
          groups={groups}
          runs={runs}
          runsError={runsError}
          runsComplete={runsComplete}
          lastRuns={lastRuns}
          triggersByFlowId={triggersByFlowId}
          triggerErrorsByFlowId={triggerErrorsByFlowId}
          onNeedTriggers={onNeedTriggers}
          forms={forms}
          onOpenFlow={onOpenFlow}
          onOpenRunFlow={onOpenRunFlow}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onRequestToggleEnabled={onRequestToggleEnabled}
          onDelete={onDelete}
        />
      )}

      {/* What happened lately and what flows can reach, as panels beside each other; the last
          one stays clear of the chat button fixed at the window's corner. */}
      <div className="mt-4 grid items-start gap-4 pb-12 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel
          title="Recent runs"
          icon={<History className="h-4 w-4" />}
          description="The latest runs of every flow, newest first."
          actions={(
            <Button variant="ghost" size="sm" onClick={loadRuns} isLoading={loadingRuns} disabled={loadingRuns} aria-label="Refresh recent runs" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        >
          {runs === null || loadingRuns ? (
            <p className={cn(HELP, 'flex items-center gap-2')}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading recent runs...
            </p>
          ) : runsError ? (
            <p className="text-xs leading-5 text-red-600 dark:text-red-400">{runsError}</p>
          ) : recent.length === 0 ? (
            <p className={HELP}>No flow runs yet. Test runs and event-triggered runs will appear here.</p>
          ) : (
            <div className={ROW_BOX}>
              {recent.map((run) => {
                const flow = (run.flowDefinitionId ? flowById.get(run.flowDefinitionId) : undefined) ?? flows.find((candidate) => candidate.slug === run.flow) ?? null;
                const when = run.startedAt ?? run.createdAt;
                return (
                  <button
                    key={run.runId}
                    type="button"
                    disabled={!flow}
                    onClick={() => { if (flow) onOpenRunFlow(flow.id); }}
                    className={cn(
                      'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 max-sm:py-2.5',
                      flow ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03]' : 'cursor-default',
                    )}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-gray-800 dark:text-slate-200">
                        {flow?.name ?? run.flow ?? run.flowDefinitionId ?? 'Unknown flow'}
                      </span>
                      <RunStatusChip run={run} />
                    </span>
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-slate-400">{run.triggerEvent}</span>
                      <span className="flex-none text-[11px] tabular-nums text-gray-500 dark:text-slate-400" title={formatAbsoluteTimeTitle(when)}>
                        {formatRelativeTime(when)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
        <DesktopStatusPanel presence={desktopPresence} />
        <AiServicesStatusPanel providerCount={providerCount} presence={desktopPresence} onOpen={onOpenAiServices} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The table of flows (search + location filter + per-flow actions)
// ---------------------------------------------------------------------------

// Where a flow lives has a column of its own once the table has room; before that the name's
// cell says it. When it last ran joins a little earlier.
const WHERE_COLUMN = '@xl/list:hidden @5xl/list:table-cell';
const LAST_RUN_COLUMN = '@xl/list:hidden @3xl/list:table-cell';
const ROW_ACTION = 'inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-primary-300 max-sm:h-11 max-sm:w-11';

function FlowList({
  groups, runs, runsError, runsComplete, lastRuns, triggersByFlowId, triggerErrorsByFlowId, onNeedTriggers, forms,
  onOpenFlow, onOpenRunFlow, onDuplicate, onRename, onRequestToggleEnabled, onDelete,
}: {
  groups: FlowGroup[];
  runs: FlowRunLog[] | null;
  runsError: string | null;
  runsComplete: boolean;
  lastRuns: Map<string, FlowRunLog>;
  triggersByFlowId?: Readonly<Record<string, FlowBinding[] | undefined>>;
  triggerErrorsByFlowId?: Readonly<Record<string, string | null | undefined>>;
  onNeedTriggers?: (flows: FlowDefinition[]) => void;
  forms?: readonly { id: string; title: string }[];
  onOpenFlow: (flowId: string) => void;
  onOpenRunFlow: (flowId: string) => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  onRequestToggleEnabled: (flow: FlowDefinition) => void;
  onDelete: (flow: FlowDefinition) => void;
}) {
  const [query, setQuery] = useState('');
  // Location filter: 'all' | 'workspace' | an app id — narrows the list when flows pile up.
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(1);

  const q = query.trim().toLowerCase();
  // One flat list in the order the groups came (the workspace's flows, then each app's): the
  // "Lives in" column says where a flow is, so no group headings stand between the rows.
  const rows = useMemo(() => groups
    .filter((group) => scope === 'all' || (scope === 'workspace' ? group.app === null : group.app?.id === scope))
    .flatMap((group) => group.flows.map((flow) => ({ flow, where: group.app ? group.app.name : 'Workspace' }))), [groups, scope]);
  const matching = useMemo(() => rows.filter(({ flow }) => q === '' || flow.name.toLowerCase().includes(q) || flow.slug.toLowerCase().includes(q)), [rows, q]);
  const shown = pageOf(matching, page, FLOWS_PER_PAGE);
  const formTitles = useMemo(() => new Map((forms ?? []).map((form) => [form.id, form.title])), [forms]);

  // The rows on screen ask for their triggers; the page reads each flow's once and keeps them.
  const shownIds = shown.rows.map(({ flow }) => flow.id).join(' ');
  const needTriggers = useRef(onNeedTriggers);
  useEffect(() => { needTriggers.current = onNeedTriggers; });
  const shownFlows = useRef<FlowDefinition[]>([]);
  useEffect(() => { shownFlows.current = shown.rows.map(({ flow }) => flow); });
  useEffect(() => {
    if (shownIds !== '') needTriggers.current?.(shownFlows.current);
  }, [shownIds]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 @md/list:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search flows"
            aria-label="Search flows"
            className="h-9 w-full rounded-lg border border-gray-300 bg-white pl-8 pr-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </div>
        {groups.length > 1 && (
          <select
            value={scope}
            onChange={(e) => { setScope(e.target.value); setPage(1); }}
            aria-label="Show flows from"
            className="h-9 max-w-48 flex-none cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            <option value="all">All locations</option>
            {groups.map((g) => (
              <option key={g.app?.id ?? 'workspace'} value={g.app?.id ?? 'workspace'}>
                {g.app ? g.app.name : 'Workspace'} · {g.flows.length}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className={LIST_BOX}>
        {matching.length === 0 ? (
          <p className="px-3 py-2.5 text-sm text-gray-500 dark:text-slate-400">
            {rows.length === 0 ? 'No flows here yet.' : `No flows match "${query}".`}
          </p>
        ) : (
          <table className={LIST_TABLE}>
            <caption className="sr-only">Your flows</caption>
            <thead className={LIST_HEAD}>
              <tr>
                <th scope="col" className={cn(LIST_TH, 'pl-3')}>Flow</th>
                <th scope="col" className={cn(LIST_TH, 'w-40', WHERE_COLUMN)}>Lives in</th>
                <th scope="col" className={cn(LIST_TH, 'w-44 @4xl/list:w-60')}>Starts on</th>
                <th scope="col" className={cn(LIST_TH, 'w-40', LAST_RUN_COLUMN)}>Last run</th>
                <th scope="col" className={cn(LIST_TH, 'w-20')}>Enabled</th>
                <th scope="col" className={cn(LIST_TH, 'w-[140px] pr-3')}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={LIST_BODY}>
              {shown.rows.map(({ flow, where }) => (
                <FlowRow
                  key={flow.id}
                  flow={flow}
                  where={where}
                  triggers={triggersByFlowId?.[flow.id]}
                  triggerError={triggerErrorsByFlowId?.[flow.id] ?? null}
                  formTitle={(id) => formTitles.get(id)}
                  lastRun={lastRuns.get(flow.id) ?? null}
                  runsRead={runs !== null}
                  runsError={runsError}
                  runsComplete={runsComplete}
                  onOpen={() => onOpenFlow(flow.id)}
                  onOpenRuns={() => onOpenRunFlow(flow.id)}
                  onDuplicate={() => onDuplicate(flow)}
                  onRename={(name) => onRename(flow, name)}
                  onRequestToggleEnabled={() => onRequestToggleEnabled(flow)}
                  onDelete={() => onDelete(flow)}
                />
              ))}
            </tbody>
          </table>
        )}
        <nav aria-label="Flow pages" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-gray-200 px-3 py-1.5 dark:border-slate-700">
          <p aria-live="polite" className="text-xs tabular-nums text-gray-500 dark:text-slate-400">
            {matching.length === 0 ? '0 flows' : `${shown.from}–${shown.to} of ${matching.length} flows`}{shown.pages > 1 && ` · Page ${shown.page} of ${shown.pages}`}
          </p>
          {shown.pages > 1 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={shown.page === 1} onClick={() => setPage(shown.page - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={shown.page === shown.pages} onClick={() => setPage(shown.page + 1)}>Next</Button>
            </div>
          )}
        </nav>
      </div>
    </div>
  );
}

function FlowRow({
  flow, where, triggers, triggerError, formTitle, lastRun, runsRead, runsError, runsComplete,
  onOpen, onOpenRuns, onDuplicate, onRename, onRequestToggleEnabled, onDelete,
}: {
  flow: FlowDefinition;
  /** "Workspace", or the name of the app the flow belongs to. */
  where: string;
  triggers: FlowBinding[] | undefined;
  triggerError: string | null;
  formTitle: (formId: string) => string | undefined;
  lastRun: FlowRunLog | null;
  runsRead: boolean;
  runsError: string | null;
  runsComplete: boolean;
  onOpen: () => void;
  onOpenRuns: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  /** Opens the enable/disable confirm (the flow's current state decides the direction). */
  onRequestToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(flow.name);

  // Commit exactly ONCE per rename (audit FL-27): Enter commits and unmounts the
  // input, whose trailing blur used to fire commitRename a second time.
  const renameCommittedRef = useRef(false);
  const commitRename = () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    setRenaming(false);
    onRename(name);
  };
  const cancelRename = () => {
    renameCommittedRef.current = true; // suppress the trailing blur commit too
    setRenaming(false);
    setName(flow.name);
  };

  const starts = triggers && !triggerError ? triggerSummary(triggers, formTitle) : null;
  const when = lastRun ? lastRun.startedAt ?? lastRun.createdAt : null;

  return (
    // A card (no room for columns) is three short lines: the name and its switch, where it lives
    // and what starts it, its last run and the actions. The table ignores the card's placing.
    <tr className={cn(LIST_ROW, 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1')}>
      <th scope="row" className={cn(LIST_CELL, 'col-span-2 self-center font-normal @xl/list:pl-3')}>
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }}
            aria-label="Flow name"
            className="h-8 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            {/* A card gives the whole name; a table row keeps one line, and the name's column takes the spare width. */}
            <button
              type="button"
              onClick={onOpen}
              title={flow.name}
              className={cn(
                'min-w-0 cursor-pointer rounded text-left font-semibold [overflow-wrap:anywhere] hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:text-primary-300 max-sm:py-1.5 max-sm:text-[15px] @xl/list:truncate',
                flow.enabled ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400',
              )}
            >
              {flow.name}
            </button>
            <span className="hidden flex-none rounded bg-gray-100 px-1 text-[10px] font-semibold text-gray-600 dark:bg-slate-800 dark:text-slate-300 @xl/list:inline @5xl/list:hidden">{where}</span>
            <span className="hidden min-w-0 flex-none truncate font-mono text-[11px] text-gray-500 dark:text-slate-400 @6xl/list:inline">{flow.slug} · v{flow.version}</span>
          </span>
        )}
      </th>
      <td className={cn(LIST_CELL, 'truncate text-gray-700 dark:text-slate-300', WHERE_COLUMN)}>
        <span className={LIST_LABEL}>Lives in</span>{where}
      </td>
      {/* A read that failed is never shown as "No trigger": that would say nothing starts a flow
          that may well be running. */}
      <td className={cn(LIST_CELL, 'col-span-2 text-gray-700 dark:text-slate-300 @xl/list:truncate')} title={triggerError || starts?.detail || undefined}>
        <span className={LIST_LABEL}>Starts on</span>
        {triggerError
          ? <span className="text-gray-500 dark:text-slate-400">Could not load</span>
          : starts
            ? <span className={cn((starts.detail === '' || starts.allOff) && 'text-gray-500 dark:text-slate-400')}>{starts.text}</span>
            : <span className="text-gray-400 dark:text-slate-500" aria-label="Loading">…</span>}
      </td>
      <td className={cn(LIST_CELL, LAST_RUN_COLUMN)}>
        <span className={LIST_LABEL}>Last run</span>
        {lastRun ? (
          <button
            type="button"
            onClick={onOpenRuns}
            title={`${formatAbsoluteTimeTitle(when) ?? ''} · open the run history`}
            className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11"
          >
            <RunStatusChip run={lastRun} />
            <span className="truncate tabular-nums text-gray-600 dark:text-slate-300">{formatRelativeTime(when)}</span>
          </button>
        ) : !runsRead ? (
          <span className="text-gray-400 dark:text-slate-500" aria-label="Loading">…</span>
        ) : runsError ? (
          <span className="text-gray-500 dark:text-slate-400" title={runsError}>Could not load</span>
        ) : runsComplete ? (
          <span className="text-gray-500 dark:text-slate-400">Never</span>
        ) : (
          <span className="text-gray-500 dark:text-slate-400" title={`Not among the latest ${RUNS_READ} runs. The run history has every run.`}>Not lately</span>
        )}
      </td>
      {/* One glance says whether the flow runs; pressing asks first (disabling stops real work).
          On a card the switch stands at the name's right and needs no heading. */}
      <td className={cn(LIST_CELL, 'col-start-3 row-start-1 self-center')}>
        <span className="flex items-center max-sm:min-h-11" title={flow.enabled ? 'Enabled. Press to disable.' : 'Disabled. Press to enable.'}>
          <Switch size="sm" checked={flow.enabled} onChange={onRequestToggleEnabled} ariaLabel={`Enable ${flow.name}`} />
        </span>
      </td>
      <td className={cn(LIST_CELL, 'col-span-2 self-end justify-self-end @xl/list:py-0.5 @xl/list:pr-2 @xl/list:text-right')}>
        <span className="flex items-center gap-0.5 @xl/list:inline-flex">
          <button type="button" onClick={onOpenRuns} aria-label={`Run history of ${flow.name}`} title="Run history" className={ROW_ACTION}><History className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" onClick={() => { setName(flow.name); renameCommittedRef.current = false; setRenaming(true); }} aria-label={`Rename ${flow.name}`} title="Rename" className={ROW_ACTION}><Pencil className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" onClick={onDuplicate} aria-label={`Duplicate ${flow.name}`} title="Duplicate" className={ROW_ACTION}><Copy className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" onClick={onDelete} aria-label={`Delete ${flow.name}`} title="Delete" className={cn(ROW_ACTION, 'hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400')}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
        </span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// What flows can reach: the desktop connection and the AI services
// ---------------------------------------------------------------------------

function AiServicesStatusPanel({
  providerCount,
  presence,
  onOpen,
}: {
  providerCount: number;
  presence: FlowsDesktopPresence;
  onOpen: () => void;
}) {
  const speechLabel =
    presence.kind === 'local'
      ? 'Local speech routing'
      : presence.kind === 'remote'
        ? 'Linked desktop routing'
        : 'Choose AI for your steps';
  const speechCopy =
    presence.kind === 'local'
      ? 'Speech steps use the Desktop aokie-voice service by default when no API service or endpoint is selected.'
      : presence.kind === 'remote'
        ? 'The linked Desktop is online; browser service enumeration is only available for local pairing.'
        : 'Select a configured service on each AI step. OAIY plugins and local models are managed through your desktop connection.';

  return (
    <Panel
      title="AI services"
      icon={<Sparkles className="h-4 w-4" />}
      actions={<Button variant="outline" size="sm" onClick={onOpen}>Open</Button>}
    >
      <p className="text-[13px] font-medium text-gray-800 dark:text-slate-200">
        {providerCount} API {providerCount === 1 ? 'service' : 'services'} · {speechLabel}
      </p>
      <p className={cn(HELP, 'mt-1')}>{speechCopy}</p>
    </Panel>
  );
}

function DesktopStatusPanel({ presence }: { presence: FlowsDesktopPresence }) {
  const navigate = useNavigate();
  const [oaiy, setOaiy] = useState(getOaiyStatus);
  const [paired, setPaired] = useState(isOaiyPaired);
  useEffect(() => subscribeOaiyStatus(setOaiy), []);
  useEffect(() => subscribeOaiyPaired(setPaired), []);
  const oaiyConnected = oaiy.available && paired;
  const label = oaiyConnected ? 'OAIY Desktop connected' : oaiy.available ? 'OAIY Desktop detected' :
    presence.kind === 'local'
      ? 'Legacy desktop connected'
      : presence.kind === 'remote'
        ? `Desktop online - ${presence.label}`
        : 'OAIY Desktop is not connected';
  const lastSeen = presence.kind === 'remote' ? describeFlowsLastSeen(presence.lastSeenMs) : null;
  const online = oaiyConnected || presence.kind !== 'none';

  return (
    <Panel
      title="Desktop connection"
      icon={<Laptop className="h-4 w-4" />}
      actions={<Button variant="outline" size="sm" onClick={() => navigate('/settings#local-runtime')}>{online ? 'Manage connection' : 'Set up OAIY'}</Button>}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium text-gray-800 dark:text-slate-200">
        <span aria-hidden="true" className={cn('h-2 w-2 flex-none rounded-full', online ? 'bg-emerald-500' : 'bg-gray-400 dark:bg-slate-500')} />
        {label}
      </p>
      {oaiy.available && <p className={cn(HELP, 'mt-1')}>{paired ? 'Connected for this browser session. Available actions depend on your installed plugins and services.' : 'Connect this browser to use its plugins and local services.'}</p>}
      {!oaiy.available && presence.kind === 'local' && (
        <p className={cn(HELP, 'mt-1')}>This browser is paired to the legacy desktop companion on this machine.</p>
      )}
      {!oaiy.available && presence.kind === 'remote' && (
        <p className={cn(HELP, 'mt-1')}>A linked Desktop is online{lastSeen ? ` - last seen ${lastSeen}` : ''}.</p>
      )}
      {!oaiy.available && presence.kind === 'none' && (
        <p className={cn(HELP, 'mt-1')}>OAIY adds local AI, browser tools and Aokie phone actions. You can build and test other steps without connecting a desktop.</p>
      )}
    </Panel>
  );
}
