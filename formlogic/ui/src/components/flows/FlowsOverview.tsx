// FormLogic Flows workspace — the start page at /flows (no flow open).
//
// One responsive surface owns everything that used to be split between the library rail
// and the old overview panel: a compact hero, the flow list (search + scope filter +
// per-flow actions) as the main column, readiness + recent runs in a side rail on large
// screens, and starter templates. Opening a flow leaves this page for the full-page editor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardList, Copy, FileText, Laptop, Loader2, MessageSquare, MoreVertical, Pencil, PhoneIncoming,
  Play, Plus, Power, RefreshCw, Search, Sparkles, Trash2, Workflow, Zap, type LucideIcon,
} from 'lucide-react';
import { listProviders } from '../../client-runtime/flows/aiProviders';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { formatAbsoluteTimeTitle, formatRelativeTime } from './relativeTime';
import { statusChipStyle } from './runHistoryChip';
import { flowStarterTemplatesForConnectors, type FlowStarterTemplate } from './starterTemplates';
import {
  describeFlowsLastSeen,
  type FlowsDesktopPresence,
} from './useFlowsDesktopPresence';
import type { AppListItem } from '../../types/app';
import type { FlowDefinition, FlowRunLog } from '../../types/flows';

/** A library group: the workspace (app null) or a specific app, plus its flows. */
export interface FlowGroup {
  app: AppListItem | null;
  flows: FlowDefinition[];
}

const TEMPLATE_ICON: Record<string, LucideIcon> = {
  blank: FileText,
  'caller-lookup': PhoneIncoming,
  'call-summary': ClipboardList,
  'sms-auto-draft': MessageSquare,
};

interface FlowsOverviewProps {
  groups: FlowGroup[];
  desktopPresence: FlowsDesktopPresence;
  availableConnectorIds?: readonly string[];
  onNewFlow: (template?: FlowStarterTemplate) => void;
  /** Open a flow in the full-page editor. */
  onOpenFlow: (flowId: string) => void;
  /** Open a flow with its run history panel showing (recent-runs rows). */
  onOpenRunFlow: (flowId: string) => void;
  onOpenAiServices: () => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  /** Opens the enable/disable confirm for this flow (the actual toggle happens on confirm). */
  onRequestToggleEnabled: (flow: FlowDefinition) => void;
  onDelete: (flow: FlowDefinition) => void;
}

function RunStatusChip({ run }: { run: FlowRunLog }) {
  const { cls, label } = statusChipStyle(run);
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>;
}

export function FlowsOverview({
  groups, desktopPresence, availableConnectorIds = [], onNewFlow, onOpenFlow, onOpenRunFlow, onOpenAiServices,
  onDuplicate, onRename, onRequestToggleEnabled, onDelete,
}: FlowsOverviewProps) {
  const flows = useMemo(() => groups.flatMap((group) => group.flows), [groups]);
  const [runs, setRuns] = useState<FlowRunLog[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const userId = useAuthStore((state) => state.user?.id);
  const [providerCount, setProviderCount] = useState(() => listProviders(userId).length);
  const flowById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow])), [flows]);
  const flowBySlug = useMemo(() => {
    const map = new Map<string, FlowDefinition>();
    for (const flow of flows) if (!map.has(flow.slug)) map.set(flow.slug, flow);
    return map;
  }, [flows]);
  const visibleTemplates = useMemo(() => flowStarterTemplatesForConnectors(availableConnectorIds), [availableConnectorIds]);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setRunsError(null);
    const res = await api.listMyFlowRuns({ limit: 8 });
    setLoadingRuns(false);
    if (res.error || !res.data) {
      setRunsError(typeof res.error === 'string' ? res.error : 'Could not load recent runs');
      setRuns([]);
      return;
    }
    setRuns(res.data.runs);
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

  const resolveFlow = (run: FlowRunLog): FlowDefinition | null => {
    if (run.flowDefinitionId) {
      const byId = flowById.get(run.flowDefinitionId);
      if (byId) return byId;
    }
    return run.flow ? flowBySlug.get(run.flow) ?? null : null;
  };

  const enabledCount = flows.filter((flow) => flow.enabled).length;

  return (
    <div className="scrollbar-thin h-full min-h-0 w-full overflow-y-auto">
      {/* pb-28 keeps the last rows clear of the floating Desktop-connection chip (fixed
          bottom-left) and the chat launcher (bottom-right). */}
      {/* @container/flows: viewport breakpoints split off a fixed 21–24rem right rail while
          the real content box could be 640px (sidebar 256 + docked chat 384 at 1280), which
          left the flow list ~250px wide and clipped by AppShell's overflow-x-clip. */}
      <div className="@container/flows mx-auto w-full max-w-7xl px-4 pb-28 pt-5 sm:px-6 sm:pt-6 lg:px-8">
        {/* Hero — one glance: what flows do plus how many are live. */}
        <section className="relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white p-5 dark:border-slate-700/60 dark:bg-slate-900 sm:p-6">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-[0.07] blur-2xl dark:opacity-[0.12]"
            style={{ background: 'radial-gradient(70% 100% at 20% 0%, rgb(var(--primary-500)) 0%, transparent 70%)' }}
          />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-primary-600 text-primary-foreground shadow-sm">
                <Workflow className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <h2 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white sm:text-2xl">Automate the busywork</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-600 dark:text-slate-400">
                  Flows run when a call comes in, a form is submitted, or on demand — they look up records, draft replies, and speak on the line.
                </p>
              </div>
            </div>
            {flows.length > 0 && (
              <div className="flex flex-none flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300">
                  <Workflow className="h-3.5 w-3.5" /> {flows.length} flow{flows.length === 1 ? '' : 's'}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                    enabledCount > 0
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                      : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400',
                  )}
                >
                  <Zap className="h-3.5 w-3.5" /> {enabledCount} enabled
                </span>
              </div>
            )}
          </div>
        </section>

        {/* Main grid: flow list + templates | readiness + recent runs. Single column below lg. */}
        <div className="mt-5 grid items-start gap-5 @4xl/flows:grid-cols-[minmax(0,1fr),21rem] @6xl/flows:grid-cols-[minmax(0,1fr),24rem]">
          <div className="min-w-0 space-y-5">
            {flows.length === 0 ? (
              <section className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
                <Workflow className="mx-auto mb-3 h-8 w-8 text-gray-300 dark:text-slate-600" />
                <p className="text-sm font-semibold text-gray-700 dark:text-slate-200">No flows yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-gray-500 dark:text-slate-400">
                  Create your first flow from scratch, or start from a template below.
                </p>
                <Button size="sm" className="mt-4" onClick={() => onNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
                  New flow
                </Button>
              </section>
            ) : (
              <FlowListCard
                groups={groups}
                total={flows.length}
                onNewFlow={() => onNewFlow()}
                onOpenFlow={onOpenFlow}
                onDuplicate={onDuplicate}
                onRename={onRename}
                onRequestToggleEnabled={onRequestToggleEnabled}
                onDelete={onDelete}
              />
            )}

            <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Start from a template</h3>
                <p className="text-xs text-gray-500 dark:text-slate-400">Open the New flow dialog with a starter preselected.</p>
              </div>
              <div className="grid grid-cols-1 gap-2.5 @xl/flows:grid-cols-2">
                {visibleTemplates.map((template) => {
                  const Icon = TEMPLATE_ICON[template.id] ?? FileText;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => onNewFlow(template)}
                      className="group flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10"
                    >
                      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 transition-colors group-hover:bg-primary-100 dark:bg-primary-500/10 dark:text-primary-300 dark:group-hover:bg-primary-500/20">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">{template.name}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-gray-500 dark:text-slate-400">{template.summary}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="min-w-0 space-y-5">
            <DesktopStatusCard presence={desktopPresence} />
            <AiServicesStatusCard providerCount={providerCount} presence={desktopPresence} onOpen={onOpenAiServices} />

            <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Recent runs</h3>
                  <p className="text-xs text-gray-500 dark:text-slate-400">Latest flow activity.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={loadRuns} isLoading={loadingRuns} disabled={loadingRuns} aria-label="Refresh recent runs">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              {runs === null || loadingRuns ? (
                <p className="flex items-center gap-2 py-4 text-xs text-gray-400 dark:text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading recent runs...
                </p>
              ) : runsError ? (
                <p className="py-4 text-xs text-red-600 dark:text-red-400">{runsError}</p>
              ) : runs.length === 0 ? (
                <p className="py-4 text-xs text-gray-400 dark:text-slate-500">No flow runs yet. Test runs and event-triggered runs will appear here.</p>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-slate-800">
                  {runs.map((run) => {
                    const flow = resolveFlow(run);
                    const when = run.startedAt ?? run.createdAt;
                    return (
                      <button
                        key={run.runId}
                        type="button"
                        disabled={!flow}
                        onClick={() => { if (flow) onOpenRunFlow(flow.id); }}
                        className={cn(
                          'flex w-full flex-col gap-1 rounded-lg px-1.5 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                          flow ? 'cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-slate-800/50' : 'cursor-default',
                        )}
                      >
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-slate-200">
                            {flow?.name ?? run.flow ?? run.flowDefinitionId ?? 'Unknown flow'}
                          </span>
                          <span className="flex-none"><RunStatusChip run={run} /></span>
                        </span>
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-slate-400">{run.triggerEvent}</span>
                          <span className="flex-none text-[11px] text-gray-400 dark:text-slate-500" title={formatAbsoluteTimeTitle(when)}>
                            {formatRelativeTime(when)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow list (search + scope filter + per-flow actions)
// ---------------------------------------------------------------------------

function FlowListCard({
  groups, total, onNewFlow, onOpenFlow, onDuplicate, onRename, onRequestToggleEnabled, onDelete,
}: {
  groups: FlowGroup[];
  total: number;
  onNewFlow: () => void;
  onOpenFlow: (flowId: string) => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  onRequestToggleEnabled: (flow: FlowDefinition) => void;
  onDelete: (flow: FlowDefinition) => void;
}) {
  const [query, setQuery] = useState('');
  // Scope filter: 'all' | 'workspace' | an app id — refines the list when flows pile up.
  const [scope, setScope] = useState('all');

  const q = query.trim().toLowerCase();
  const scoped = scope === 'all'
    ? groups
    : groups.filter((g) => (scope === 'workspace' ? g.app === null : g.app?.id === scope));
  const filtered = scoped
    .map((g) => ({ ...g, flows: g.flows.filter((f) => q === '' || f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)) }))
    .filter((g) => g.flows.length > 0);
  const scopedTotal = scoped.reduce((n, g) => n + g.flows.length, 0);

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex flex-col gap-2.5 border-b border-gray-100 p-4 dark:border-slate-800 sm:flex-row sm:items-center">
        <h3 className="flex flex-none items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          Your flows
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            {total}
          </span>
        </h3>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
          <div className="relative min-w-0 flex-1 sm:max-w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search flows"
              aria-label="Search flows"
              className="w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-8 pr-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>
          {groups.length > 1 && (
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-label="Show automations from"
              className="max-w-40 min-h-9 flex-none cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <option value="all">All apps</option>
              {groups.map((g) => (
                <option key={g.app?.id ?? 'workspace'} value={g.app?.id ?? 'workspace'}>
                  {g.app ? g.app.name : 'Workspace'} · {g.flows.length}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="space-y-4 p-3 sm:p-4">
        {filtered.length === 0 ? (
          <p className="px-1 py-2 text-xs text-gray-400 dark:text-slate-500">
            {scopedTotal === 0 ? 'No flows in this scope yet.' : `No flows match "${query}".`}
          </p>
        ) : (
          filtered.map((g) => (
            <div key={g.app?.id ?? 'workspace'}>
              <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
                <p className="min-w-0 flex-1 truncate">{g.app ? g.app.name : 'Workspace'}</p>
                <span className="flex-none text-gray-500 dark:text-slate-400">· {g.flows.length}</span>
              </div>
              <div className="space-y-1">
                {g.flows.map((flow) => (
                  <FlowRow
                    key={flow.id}
                    flow={flow}
                    onSelect={() => onOpenFlow(flow.id)}
                    onDuplicate={() => onDuplicate(flow)}
                    onRename={(name) => onRename(flow, name)}
                    onRequestToggleEnabled={() => onRequestToggleEnabled(flow)}
                    onDelete={() => onDelete(flow)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        <div className="px-1 pt-1">
          <button
            type="button"
            onClick={onNewFlow}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary-600 transition-colors hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 max-sm:min-h-11 dark:text-primary-300 dark:hover:bg-primary-500/10"
          >
            <Plus className="h-3.5 w-3.5" /> New flow
          </button>
        </div>
      </div>
    </section>
  );
}

// Approximate height of the tallest row menu — used to flip the portal menu above the
// trigger when it would clip past the bottom of the viewport (mirrors FormCard's menu).
const FLOW_MENU_HEIGHT = 210;
const FLOW_MENU_WIDTH = 176; // w-44

function FlowRow({ flow, onSelect, onDuplicate, onRename, onRequestToggleEnabled, onDelete }: {
  flow: FlowDefinition;
  onSelect: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  /** Opens the enable/disable confirm (the flow's current state decides the direction). */
  onRequestToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(flow.name);
  const menuOpen = menuRect !== null;
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Focus returns to the trigger on close — the ARIA menu-button pattern (audit FL-27).
  const closeMenu = () => {
    setMenuRect(null);
    triggerRef.current?.focus();
  };

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

  // Menu focus entry: the first item receives focus when the menu opens (FL-27).
  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);

  // Keep the portal menu anchored while the page resizes or scrolls (FL-27).
  useEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setMenuRect(rect);
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuOpen]);

  // Arrow/Home/End/Escape keyboard navigation per the ARIA menu pattern (FL-27).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  };

  return (
    <div className="group relative rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-gray-200 hover:bg-gray-50 dark:hover:border-slate-700 dark:hover:bg-slate-800/40">
      <div className="flex items-center gap-2">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }}
            aria-label="Flow name"
            className="min-w-0 flex-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        ) : (
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'truncate text-sm font-medium text-gray-800 dark:text-slate-200',
                  !flow.enabled && 'opacity-60',
                )}
              >
                {flow.name}
              </span>
              {!flow.enabled && (
                <span className="flex-none rounded-full border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                  off
                </span>
              )}
            </span>
            <p className={cn('truncate font-mono text-[10px] text-gray-500 dark:text-slate-400', !flow.enabled && 'opacity-60')}>
              {flow.slug} · v{flow.version}
            </p>
          </button>
        )}
        {/* Enabled indicator — one glance says whether the flow runs; click to toggle (confirmed). */}
        <button
          type="button"
          onClick={onRequestToggleEnabled}
          aria-label={flow.enabled ? `Disable ${flow.name}` : `Enable ${flow.name}`}
          title={flow.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          className={cn(
            'flex min-h-11 min-w-11 flex-none items-center justify-center cursor-pointer rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
            flow.enabled
              ? 'text-emerald-500 hover:bg-emerald-50 hover:text-emerald-600 dark:text-emerald-400 dark:hover:bg-emerald-500/10'
              : 'text-gray-300 hover:bg-gray-100 hover:text-gray-500 dark:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-400',
          )}
        >
          <Power className="h-4 w-4" />
        </button>
        <div className="relative flex-none">
          <button
            type="button"
            ref={triggerRef}
            onClick={(e) => setMenuRect(menuOpen ? null : e.currentTarget.getBoundingClientRect())}
            aria-label={`Flow actions for ${flow.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex min-h-11 min-w-11 items-center justify-center cursor-pointer rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-700 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {/* Portal + fixed positioning: escapes the page scroll and flips above the
              trigger when the viewport bottom is near. */}
          {menuRect && createPortal(
            <div className="fixed inset-0 z-[70]" onClick={closeMenu}>
              <div
                ref={menuRef}
                role="menu"
                aria-label={`Flow actions for ${flow.name}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={onMenuKeyDown}
                className="absolute w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-900 dark:ring-white/[0.06]"
                style={{
                  ...(menuRect.bottom + FLOW_MENU_HEIGHT > window.innerHeight
                    ? { bottom: window.innerHeight - menuRect.top + 4 }
                    : { top: menuRect.bottom + 4 }),
                  left: Math.min(Math.max(8, menuRect.right - FLOW_MENU_WIDTH), window.innerWidth - FLOW_MENU_WIDTH - 8),
                }}
              >
                <MenuItem
                  icon={flow.enabled ? Power : Play}
                  label={flow.enabled ? 'Disable…' : 'Enable…'}
                  onClick={() => { closeMenu(); onRequestToggleEnabled(); }}
                />
                <div className="my-1 border-t border-gray-100 dark:border-slate-800" />
                <MenuItem icon={Pencil} label="Rename" onClick={() => { closeMenu(); setName(flow.name); renameCommittedRef.current = false; setRenaming(true); }} />
                <MenuItem icon={Copy} label="Duplicate" onClick={() => { closeMenu(); onDuplicate(); }} />
                <MenuItem icon={Trash2} label="Delete" danger onClick={() => { closeMenu(); onDelete(); }} />
              </div>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
        danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Readiness cards
// ---------------------------------------------------------------------------

function AiServicesStatusCard({
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
      ? 'Default Desktop speech ready'
      : presence.kind === 'remote'
        ? 'Linked Desktop speech online'
        : 'Desktop speech offline';
  const speechCopy =
    presence.kind === 'local'
      ? 'Speech nodes use the Desktop aokie-voice service by default when no API service or endpoint is selected.'
      : presence.kind === 'remote'
        ? 'The linked Desktop is online; browser service enumeration is only available for local pairing.'
        : 'Link FormLogic Desktop to use the default speech service, or choose a browser-stored API service on AI nodes.';

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">AI services</h3>
            <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {providerCount} API {providerCount === 1 ? 'service' : 'services'}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-gray-700 dark:text-slate-200">{speechLabel}</p>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">{speechCopy}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={onOpen}>
            Open
          </Button>
        </div>
      </div>
    </section>
  );
}

function DesktopStatusCard({ presence }: { presence: FlowsDesktopPresence }) {
  const navigate = useNavigate();
  const label =
    presence.kind === 'local'
      ? 'Desktop connected'
      : presence.kind === 'remote'
        ? `Desktop online - ${presence.label}`
        : 'Desktop offline';
  const lastSeen = presence.kind === 'remote' ? describeFlowsLastSeen(presence.lastSeenMs) : null;
  const online = presence.kind !== 'none';

  return (
    <section className="rounded-xl border border-gray-200/80 bg-white p-4 dark:border-slate-700/60 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 flex-none items-center justify-center rounded-lg',
            online
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-slate-400',
          )}
        >
          <Laptop className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
            <span className={cn('h-2 w-2 rounded-full', online ? 'bg-emerald-500' : 'bg-gray-400 dark:bg-slate-500')} />
          </div>
          {presence.kind === 'local' && (
            <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
              This browser is paired to FormLogic Desktop on this machine.
            </p>
          )}
          {presence.kind === 'remote' && (
            <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
              A linked Desktop is online{lastSeen ? ` - last seen ${lastSeen}` : ''}.
            </p>
          )}
          {presence.kind === 'none' && (
            <>
              <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
                Desktop-powered nodes (browser, image, speech, Aokie phone) won't run until FormLogic Desktop is running and linked.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => navigate('/settings#linked-desktops')}
              >
                Set up in Settings
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
