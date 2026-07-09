// FormLogic Flows — first-class workspace (/flows).
//
// Left: the flow library (workspace flows + app-scoped flows grouped by app; search, create,
// duplicate, rename, enable, delete). Centre: the real graph editor (FlowEditor — React Flow
// canvas, node palette, properties, autosave). Right (lg+): run history for the selected flow +
// a Test Run drawer that executes the flow through the browser executor. Deep-linked by
// ?flow=<id> from the app-level Flows panel.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronLeft, MoreVertical, Copy, Laptop, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Search, Trash2, Workflow, X,
} from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Switch } from '../../components/ui/Switch';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { usePersistentBoolean } from '../../hooks/usePersistentBoolean';
import { api } from '../../lib/api';
import { demoApplyFlowOverlay, demoCreateFlow, demoUpdateFlow, demoDeleteFlow } from '../../lib/demoLocal';
import { toast } from '../../stores/toastStore';
import { FlowEditor } from '../../components/flows/editor/FlowEditor';
import { deriveFlowConnectors } from '../../components/flows/flowConnectors';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from '../../components/flows/editor/nodeCatalog';
import type { FlowFormOption } from '../../components/flows/editor/NodeProperties';
import { FlowRunHistory } from '../../components/flows/FlowRunHistory';
import { TriggersPanel } from '../../components/flows/TriggersPanel';
import { TestRunDrawer } from '../../components/flows/TestRunDrawer';
import { reduceNodeStatus, type NodeStatusMap } from '../../components/flows/runStatus';
import { NewFlowDialog } from '../../components/flows/NewFlowDialog';
import { FlowsOverview } from '../../components/flows/FlowsOverview';
import {
  describeFlowsLastSeen,
  useFlowsDesktopPresence,
  type FlowsDesktopPresence,
} from '../../components/flows/useFlowsDesktopPresence';
import type { FlowStarterTemplate } from '../../components/flows/starterTemplates';
import type { AppListItem } from '../../types/app';
import type { FlowBinding, FlowDefinition, WorkflowGraph } from '../../types/flows';

/** A library group: the workspace (app null) or a specific app, plus its flows. */
interface FlowGroup {
  app: AppListItem | null;
  flows: FlowDefinition[];
}

export function FlowsWorkspace() {
  const [, setSearchParams] = useSearchParams();
  const desktopPresence = useFlowsDesktopPresence();
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newFlowInitialTemplate, setNewFlowInitialTemplate] = useState<FlowStarterTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [rightPanel, setRightPanel] = useState<'history' | 'test' | 'triggers' | null>(null);
  // Opt-in space reclaim: collapse the flow library to a narrow rail once you don't need it (e.g.
  // a flow is open and Test Run/History is open too). Defaults open — today's layout, unchanged.
  const [libraryCollapsed, setLibraryCollapsed] = usePersistentBoolean('flows.libraryCollapsed', false);
  const [historyKey, setHistoryKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<FlowDefinition | null>(null);
  // Live per-node run status from the Test Run drawer's onNodeStatus — lights up the canvas pills.
  // Owned here (not in the drawer) so the editor + drawer, which are siblings, share one source.
  const [nodeStatus, setNodeStatus] = useState<NodeStatusMap>({});
  // The author's forms, fetched once — powers the List/Submit/Update-response form pickers.
  const [forms, setForms] = useState<FlowFormOption[]>([]);
  const [flowBindingsById, setFlowBindingsById] = useState<Record<string, FlowBinding[]>>({});
  const [flowBindingsLoading, setFlowBindingsLoading] = useState<Record<string, boolean>>({});

  // Flat lookup of every flow by id (the editor + drawers work off this).
  const flowById = useMemo(() => {
    const m = new Map<string, FlowDefinition>();
    for (const g of groups) for (const f of g.flows) m.set(f.id, f);
    return m;
  }, [groups]);
  const selectedFlow = selectedId ? flowById.get(selectedId) ?? null : null;

  // Editor context (docs §4): the palette + connector pickers depend on whether the selected flow
  // is app-scoped and which connectors its app actually grants. Workspace flows have no connectors.
  const editorContext = useMemo<FlowEditorContext>(() => {
    if (!selectedFlow?.appId) return EMPTY_FLOW_EDITOR_CONTEXT;
    const app = groups.find((g) => g.app?.id === selectedFlow.appId)?.app ?? null;
    // The app's own forms scope the Find/Submit/Update form picker to a short labelled list.
    const appFormIds = (app?.navConfig ?? []).map((n) => n.formId).filter((id): id is string => typeof id === 'string');
    return { appScoped: true, connectors: deriveFlowConnectors(app), appFormIds };
  }, [selectedFlow, groups]);
  const selectedFlowBindings = selectedFlow ? flowBindingsById[selectedFlow.id] ?? [] : [];
  const allFlows = useMemo(() => groups.flatMap((group) => group.flows), [groups]);

  const fetchFlowBindings = useCallback(async (flow: FlowDefinition) => {
    // Demo too: the seeded demo flows are real server rows with real bindings, and reads are
    // allowed — only a per-browser overlay flow (id unknown to the server) 404s, which reads
    // as "no triggers" rather than an error there.
    setFlowBindingsLoading((map) => ({ ...map, [flow.id]: true }));
    const res = await api.listFlowBindingsForFlow(flow.id);
    setFlowBindingsLoading((map) => ({ ...map, [flow.id]: false }));
    if (res.error || !res.data) {
      if (!api.isDemoMode()) {
        toast.error('Failed to load triggers', typeof res.error === 'string' ? res.error : undefined);
      }
      setFlowBindingsById((map) => ({ ...map, [flow.id]: [] }));
      return;
    }
    const loaded = res.data.bindings;
    setFlowBindingsById((map) => ({ ...map, [flow.id]: loaded }));
  }, []);

  useEffect(() => {
    if (!selectedFlow) return;
    if (flowBindingsById[selectedFlow.id] !== undefined) return;
    void fetchFlowBindings(selectedFlow);
  }, [selectedFlow, flowBindingsById, fetchFlowBindings]);

  // Initial load (+ apply any ?flow=<id> deep-link once the flows are known). All setState runs
  // after awaits — never synchronously in the effect body.
  const loadInitialData = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const demo = api.isDemoMode();
      const [wsRes, appsRes, formsRes] = await Promise.all([
        api.listWorkspaceFlows(),
        api.getApps(),
        api.getForms({ limit: 500 }),
      ]);
      if (wsRes.error || !wsRes.data) throw new Error(typeof wsRes.error === 'string' ? wsRes.error : 'Failed to load workspace flows');
      if (appsRes.error || !appsRes.data) throw new Error(typeof appsRes.error === 'string' ? appsRes.error : 'Failed to load apps');
      if (formsRes.error || !formsRes.data) throw new Error(typeof formsRes.error === 'string' ? formsRes.error : 'Failed to load forms');

      const appList = appsRes.data.apps;
      const appFlowLists = await Promise.all(appList.map((app) => api.listFlows(app.id)));
      const failedAppFlows = appFlowLists.find((result) => result.error || !result.data);
      if (failedAppFlows) throw new Error(typeof failedAppFlows.error === 'string' ? failedAppFlows.error : 'Failed to load app flows');
      if (isCancelled()) return;

      // In the shared demo, merge each scope's server-seeded flows with the per-browser overlay
      // (creates/edits/deletes kept in IndexedDB) so exploring flows persists locally, not to the server.
      const workspaceFlows = demo
        ? await demoApplyFlowOverlay(null, wsRes.data.flows)
        : wsRes.data.flows;
      const appGroups: FlowGroup[] = (
        await Promise.all(
          appList.map(async (app, i) => ({
            app,
            flows: demo
              ? await demoApplyFlowOverlay(app.id, appFlowLists[i].data?.flows ?? [])
              : appFlowLists[i].data?.flows ?? [],
          })),
        )
      ).filter((group) => group.flows.length > 0);
      if (isCancelled()) return;

      const nextGroups: FlowGroup[] = [{ app: null, flows: workspaceFlows }, ...appGroups];
      setApps(appList);
      setGroups(nextGroups);
      setForms(
        formsRes.data.forms.map((form) => ({
          id: form.id,
          title: form.title,
          fields: (form.fields ?? [])
            .filter((field) => field && typeof field.id === 'string')
            .map((field) => ({ id: field.id, label: field.label || field.id })),
        }))
      );
      setLoading(false);
      const target = new URLSearchParams(window.location.search).get('flow');
      if (target && nextGroups.some((group) => group.flows.some((flow) => flow.id === target))) setSelectedId(target);
    } catch (error) {
      if (isCancelled()) return;
      setLoading(false);
      setLoadError(error instanceof Error ? error.message : 'Failed to load flows');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadInitialData(() => cancelled);
    return () => { cancelled = true; };
  }, [loadInitialData]);

  const selectFlow = (id: string | null) => {
    setSelectedId(id);
    setRightPanel(null);
    setNodeStatus({}); // clear stale run pills when switching flows
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('flow', id); else next.delete('flow');
      return next;
    }, { replace: true });
  };

  /** Replace a flow in local state (after a save/rename/toggle). */
  const upsertFlow = useCallback((flow: FlowDefinition) => {
    setGroups((gs) => gs.map((g) => ({ ...g, flows: g.flows.map((f) => (f.id === flow.id ? flow : f)) })));
  }, []);

  const onSaveGraph = useCallback(async ({ flowJson, nodeCapabilities }: { flowJson: WorkflowGraph; nodeCapabilities: string[] }): Promise<boolean> => {
    if (!selectedFlow) return false;
    // Demo: persist the edit to the per-browser overlay (IndexedDB), never the server.
    if (api.isDemoMode()) {
      upsertFlow(await demoUpdateFlow(selectedFlow, { flowJson, nodeCapabilities }));
      return true;
    }
    const res = selectedFlow.appId
      ? await api.updateFlow(selectedFlow.appId, selectedFlow.id, { flowJson, nodeCapabilities })
      : await api.updateWorkspaceFlow(selectedFlow.id, { flowJson, nodeCapabilities });
    if (res.error || !res.data) {
      toast.error('Failed to save flow', typeof res.error === 'string' ? res.error : undefined);
      return false;
    }
    upsertFlow(res.data.flow);
    return true;
  }, [selectedFlow, upsertFlow]);

  const openNewFlow = (template: FlowStarterTemplate | null = null) => {
    setNewFlowInitialTemplate(template);
    setShowNew(true);
  };

  const createFlow = async ({ name, slug, description, template, appId }: { name: string; slug: string; description: string; template: FlowStarterTemplate; appId: string | null }) => {
    setCreating(true);
    // Dedupe the slug (and mirror any suffix onto an auto/duplicate name) so quick repeated
    // creates — e.g. several "Untitled flow"s — never collide on the workspace slug uniqueness.
    const takenSlugs = new Set((groups.find((g) => (g.app?.id ?? null) === appId)?.flows ?? []).map((f) => f.slug));
    let uniqueSlug = slug;
    let n = 1;
    while (takenSlugs.has(uniqueSlug)) {
      n += 1;
      uniqueSlug = `${slug}-${n}`.slice(0, 60);
    }
    const uniqueName = n > 1 && !name.trim().match(/\d$/) ? `${name} ${n}` : name;
    const body = { name: uniqueName, slug: uniqueSlug, description, flowJson: template.flowJson, enabled: true, nodeCapabilities: template.nodeCapabilities };
    const flow = api.isDemoMode()
      ? await demoCreateFlow({ ...body, appId })
      : appId
        ? (await api.createFlow(appId, body)).data?.flow
        : (await api.createWorkspaceFlow(body)).data?.flow;
    setCreating(false);
    if (!flow) {
      toast.error('Failed to create flow');
      return;
    }
    setGroups((gs) => {
      let found = false;
      const next = gs.map((g) => {
        if ((g.app?.id ?? null) !== (flow.appId ?? null)) return g;
        found = true;
        return { ...g, flows: [flow, ...g.flows] };
      });
      if (found) return next;
      const app = flow.appId ? apps.find((candidate) => candidate.id === flow.appId) ?? null : null;
      if (flow.appId && !app) return next;
      return [...next, { app, flows: [flow] }];
    });
    setShowNew(false);
    setNewFlowInitialTemplate(null);
    selectFlow(flow.id);
    toast.success('Flow created', flow.name);
  };

  const duplicateFlow = async (flow: FlowDefinition) => {
    const payload = {
      name: `${flow.name} copy`,
      slug: `${flow.slug}-copy`.slice(0, 60),
      description: flow.description ?? undefined,
      flowJson: flow.flowJson,
      enabled: false,
      nodeCapabilities: flow.nodeCapabilities ?? undefined,
    };
    const created = api.isDemoMode()
      ? await demoCreateFlow({ ...payload, appId: flow.appId ?? null })
      : (flow.appId ? await api.createFlow(flow.appId, payload) : await api.createWorkspaceFlow(payload)).data?.flow;
    if (!created) {
      toast.error('Failed to duplicate flow');
      return;
    }
    setGroups((gs) => gs.map((g) => (g.app?.id ?? null) === (flow.appId ?? null) ? { ...g, flows: [created, ...g.flows] } : g));
    toast.success('Flow duplicated', created.name);
  };

  const renameFlow = async (flow: FlowDefinition, name: string) => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === flow.name) return;
    if (api.isDemoMode()) {
      upsertFlow(await demoUpdateFlow(flow, { name: trimmed }));
      return;
    }
    const res = flow.appId ? await api.updateFlow(flow.appId, flow.id, { name: trimmed }) : await api.updateWorkspaceFlow(flow.id, { name: trimmed });
    if (res.error || !res.data) {
      toast.error('Failed to rename flow', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    upsertFlow(res.data.flow);
  };

  const toggleEnabled = async (flow: FlowDefinition, enabled: boolean) => {
    if (api.isDemoMode()) {
      upsertFlow(await demoUpdateFlow(flow, { enabled }));
      return;
    }
    const res = flow.appId ? await api.updateFlow(flow.appId, flow.id, { enabled }) : await api.updateWorkspaceFlow(flow.id, { enabled });
    if (res.error || !res.data) {
      toast.error('Failed to update flow', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    upsertFlow(res.data.flow);
  };

  const confirmDelete = async () => {
    const flow = pendingDelete;
    setPendingDelete(null);
    if (!flow) return;
    if (api.isDemoMode()) {
      await demoDeleteFlow(flow);
    } else {
      const res = flow.appId ? await api.deleteFlow(flow.appId, flow.id) : await api.deleteWorkspaceFlow(flow.id);
      if (res.error) {
        toast.error('Failed to delete flow', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
    }
    setGroups((gs) => gs.map((g) => ({ ...g, flows: g.flows.filter((f) => f.id !== flow.id) })));
    if (selectedId === flow.id) selectFlow(null);
    toast.success('Flow deleted', flow.name);
  };

  return (
    <div className="flex h-[calc(100dvh-4rem-var(--fl-demo-banner-h,0px))] flex-col overflow-hidden md:h-[calc(100dvh-var(--fl-demo-banner-h,0px))]">
      <Header
        title="Flows"
        actions={
          <>
            <DesktopPresenceChip presence={desktopPresence} />
            <Button size="sm" onClick={() => openNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
              <span className="hidden sm:inline">New flow</span>
              <span className="sm:hidden">New</span>
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* Library */}
        <FlowLibrary
          groups={groups}
          loading={loading}
          query={query}
          onQuery={setQuery}
          selectedId={selectedId}
          onSelect={selectFlow}
          onDuplicate={duplicateFlow}
          onRename={renameFlow}
          onToggleEnabled={toggleEnabled}
          onDelete={setPendingDelete}
          onNew={() => openNewFlow()}
          collapsed={libraryCollapsed}
          onToggleCollapsed={() => setLibraryCollapsed((c) => !c)}
          className={cn(libraryCollapsed ? 'w-14' : 'w-full md:w-72', selectedFlow ? 'hidden md:flex' : 'flex')}
        />

        {/* Editor */}
        <div className={cn('min-w-0 flex-1 flex-col', selectedFlow ? 'flex' : 'hidden md:flex')}>
          {selectedFlow ? (
            <>
              <button
                type="button"
                onClick={() => selectFlow(null)}
                className="flex items-center gap-1 border-b border-gray-200/80 dark:border-slate-700/60 px-3 py-2 text-xs font-medium text-gray-500 dark:text-slate-400 md:hidden"
              >
                <ChevronLeft className="h-4 w-4" /> Library
              </button>
              <div className="min-h-0 flex-1">
                <FlowEditor
                  key={selectedFlow.id}
                  flow={selectedFlow}
                  onSave={onSaveGraph}
                  onOpenTestRun={() => setRightPanel((p) => (p === 'test' ? null : 'test'))}
                  onToggleTriggers={() => setRightPanel((p) => (p === 'triggers' ? null : 'triggers'))}
                  onToggleHistory={() => setRightPanel((p) => (p === 'history' ? null : 'history'))}
                  triggersOpen={rightPanel === 'triggers'}
                  historyOpen={rightPanel === 'history'}
                  triggerCount={selectedFlowBindings.length}
                  forms={forms}
                  context={editorContext}
                  nodeStatus={nodeStatus}
                  desktopPresence={desktopPresence}
                  bindings={selectedFlowBindings}
                />
              </div>
            </>
          ) : (
            loadError ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <EmptyState
                  icon={AlertTriangle}
                  title="Couldn't load flows"
                  description={loadError}
                  action={
                    <Button size="sm" onClick={() => void loadInitialData()} leftIcon={<RefreshCw className="h-4 w-4" />}>
                      Retry
                    </Button>
                  }
                />
              </div>
            ) : loading ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <EmptyState icon={Workflow} title="Loading flows..." description="" />
              </div>
            ) : (
              <FlowsOverview
                flows={allFlows}
                desktopPresence={desktopPresence}
                onNewFlow={openNewFlow}
                onOpenRunFlow={(flowId) => {
                  selectFlow(flowId);
                  setRightPanel('history');
                }}
              />
            )
          )}
        </div>

        {/* Right panel: history / test run (lg+). No border here — the panel's white bg vs the
            canvas's gray provides the seam (docs §4, rail hierarchy: seams by value contrast). */}
        {selectedFlow && rightPanel === 'triggers' && (
          <div className="hidden w-96 flex-none bg-white dark:bg-slate-900 lg:flex">
            <TriggersPanel
              flow={selectedFlow}
              bindings={selectedFlowBindings}
              loading={!!flowBindingsLoading[selectedFlow.id]}
              forms={forms}
              context={editorContext}
              onRefresh={() => fetchFlowBindings(selectedFlow)}
            />
          </div>
        )}
        {selectedFlow && rightPanel === 'history' && (
          <div className="hidden w-96 flex-none bg-white dark:bg-slate-900 lg:flex">
            <FlowRunHistory flowId={selectedFlow.id} flow={selectedFlow} refreshKey={historyKey} />
          </div>
        )}
        {selectedFlow && rightPanel === 'test' && (
          <div className="hidden lg:flex">
            <TestRunDrawer
              flow={selectedFlow}
              onClose={() => setRightPanel(null)}
              onServerRun={() => { setHistoryKey((k) => k + 1); setRightPanel('history'); }}
              onRunStart={() => setNodeStatus({})}
              onNodeStatus={(id, status, info) => setNodeStatus((m) => reduceNodeStatus(m, id, status, info))}
            />
          </div>
        )}
      </div>

      {selectedFlow && rightPanel === 'triggers' && (
        <FlowMobileDrawer title="Triggers" onClose={() => setRightPanel(null)}>
          <TriggersPanel
            flow={selectedFlow}
            bindings={selectedFlowBindings}
            loading={!!flowBindingsLoading[selectedFlow.id]}
            forms={forms}
            context={editorContext}
            onRefresh={() => fetchFlowBindings(selectedFlow)}
          />
        </FlowMobileDrawer>
      )}
      {selectedFlow && rightPanel === 'history' && (
        <FlowMobileDrawer title="Run history" onClose={() => setRightPanel(null)}>
          <FlowRunHistory flowId={selectedFlow.id} flow={selectedFlow} refreshKey={historyKey} />
        </FlowMobileDrawer>
      )}
      {selectedFlow && rightPanel === 'test' && (
        <FlowMobileDrawer title="Test run" onClose={() => setRightPanel(null)}>
          <TestRunDrawer
            flow={selectedFlow}
            onClose={() => setRightPanel(null)}
            onServerRun={() => { setHistoryKey((k) => k + 1); setRightPanel('history'); }}
            onRunStart={() => setNodeStatus({})}
            onNodeStatus={(id, status, info) => setNodeStatus((m) => reduceNodeStatus(m, id, status, info))}
          />
        </FlowMobileDrawer>
      )}

      <NewFlowDialog
        isOpen={showNew}
        onClose={() => {
          setShowNew(false);
          setNewFlowInitialTemplate(null);
        }}
        onCreate={createFlow}
        creating={creating}
        apps={apps}
        initialTemplate={newFlowInitialTemplate}
      />
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete flow"
        message={pendingDelete ? `Delete the flow "${pendingDelete.name}"? Its bindings and run history are kept but it will stop running.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}

function DesktopPresenceChip({ presence }: { presence: FlowsDesktopPresence }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const label =
    presence.kind === 'local'
      ? 'Desktop connected'
      : presence.kind === 'remote'
        ? `Desktop online · ${presence.label}`
        : 'Desktop offline';
  const lastSeen = presence.kind === 'remote' ? describeFlowsLastSeen(presence.lastSeenMs) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={cn(
          'inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          presence.kind === 'none'
            ? 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:bg-slate-800'
            : presence.kind === 'remote'
              ? 'border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/40 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-500/10'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/15',
        )}
      >
        <Laptop className="h-3.5 w-3.5 flex-none" />
        <span
          className={cn(
            'h-1.5 w-1.5 flex-none rounded-full',
            presence.kind === 'none' ? 'bg-gray-400 dark:bg-slate-500' : 'bg-emerald-500',
          )}
        />
        <span className="hidden min-w-0 truncate sm:inline">{label}</span>
        <span className="sm:hidden">Desktop</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-label="Desktop presence"
            className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-start gap-2.5">
              <span
                className={cn(
                  'mt-1 h-2 w-2 flex-none rounded-full',
                  presence.kind === 'none' ? 'bg-gray-400 dark:bg-slate-500' : 'bg-emerald-500',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{label}</p>
                {presence.kind === 'local' && (
                  <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
                    This browser is paired to FormLogic Desktop on this machine.
                  </p>
                )}
                {presence.kind === 'remote' && (
                  <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
                    A linked Desktop is online{lastSeen ? ` · last seen ${lastSeen}` : ''}.
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
                      className="mt-3 w-full"
                      onClick={() => {
                        setOpen(false);
                        navigate('/settings#linked-desktops');
                      }}
                    >
                      Set up in Settings
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FlowMobileDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="lg:hidden">
      <div className="fixed inset-0 z-[80] bg-gray-900/35 dark:bg-slate-950/60" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-y-0 right-0 z-[90] flex w-full max-w-md flex-col bg-white shadow-2xl dark:bg-slate-900"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="absolute right-2 top-2 z-10 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-h-0 flex-1 overflow-hidden [&>div>div:first-child]:pr-12 [&>div>div:nth-child(2)]:pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function FlowLibrary({
  groups, loading, query, onQuery, selectedId, onSelect, onDuplicate, onRename, onToggleEnabled, onDelete, onNew, collapsed = false, onToggleCollapsed, className,
}: {
  groups: FlowGroup[];
  loading: boolean;
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  onToggleEnabled: (flow: FlowDefinition, enabled: boolean) => void;
  onDelete: (flow: FlowDefinition) => void;
  onNew: () => void;
  /** Collapsed to a narrow icon-only rail (space-reclaiming; never hides the panel's existence). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  className?: string;
}) {
  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, flows: g.flows.filter((f) => q === '' || f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)) }))
    .filter((g) => g.flows.length > 0);
  const total = groups.reduce((n, g) => n + g.flows.length, 0);

  // Collapsing swaps in a whole different (icon-rail) subtree, which unmounts the flow list —
  // restore its scroll offset on re-expand rather than snapping back to the top every time.
  const listRef = useRef<HTMLDivElement | null>(null);
  const listScrollTop = useRef(0);
  useEffect(() => {
    if (!collapsed && listRef.current) listRef.current.scrollTop = listScrollTop.current;
  }, [collapsed]);

  if (collapsed) {
    return (
      <aside className={cn('min-h-0 flex-none flex-col items-center gap-2 bg-gray-100/50 dark:bg-slate-900/50 py-2.5', className)}>
        <Button variant="ghost" size="iconOnly" onClick={onToggleCollapsed} aria-label="Expand flow library" title="Expand flow library" className="h-8 w-8">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="iconOnly" onClick={onNew} aria-label="New flow" title="New flow">
          <Plus className="h-4 w-4" />
        </Button>
      </aside>
    );
  }

  return (
    <aside className={cn('min-h-0 flex-none flex-col bg-gray-100/50 dark:bg-slate-900/50', className)}>
      <div className="flex items-center gap-1.5 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search flows"
            aria-label="Search flows"
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="iconOnly"
            onClick={onToggleCollapsed}
            aria-label="Collapse flow library"
            title="Collapse flow library"
            className="h-8 w-8 flex-none"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div
        ref={listRef}
        onScroll={(e) => { listScrollTop.current = e.currentTarget.scrollTop; }}
        className="min-h-0 flex-1 overflow-y-auto p-2.5 space-y-4"
      >
        {loading ? (
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">Loading…</p>
        ) : total === 0 ? (
          <div className="px-1 pt-4 text-center">
            <Workflow className="mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-slate-600" />
            <p className="text-sm font-medium text-gray-600 dark:text-slate-300">No flows yet</p>
            <p className="mb-3 text-xs text-gray-400 dark:text-slate-500">Create your first flow to get started.</p>
            <Button size="sm" onClick={onNew} leftIcon={<Plus className="h-4 w-4" />}>New flow</Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">No flows match "{query}".</p>
        ) : (
          filtered.map((g) => (
            <div key={g.app?.id ?? 'workspace'}>
              <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
                <p className="min-w-0 flex-1 truncate">{g.app ? g.app.name : 'Workspace'}</p>
                <span className="flex-none text-gray-400 dark:text-slate-500">· {g.flows.length}</span>
              </div>
              <div className="space-y-1">
                {g.flows.map((flow) => (
                  <FlowRow
                    key={flow.id}
                    flow={flow}
                    selected={selectedId === flow.id}
                    onSelect={() => onSelect(flow.id)}
                    onDuplicate={() => onDuplicate(flow)}
                    onRename={(name) => onRename(flow, name)}
                    onToggleEnabled={(v) => onToggleEnabled(flow, v)}
                    onDelete={() => onDelete(flow)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function FlowRow({ flow, selected, onSelect, onDuplicate, onRename, onToggleEnabled, onDelete }: {
  flow: FlowDefinition;
  selected: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onToggleEnabled: (v: boolean) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(flow.name);

  const commitRename = () => {
    setRenaming(false);
    onRename(name);
  };

  return (
    <div
      className={cn(
        'group relative rounded-lg border px-2.5 py-2 transition-colors',
        selected
          ? 'border-primary-300 bg-primary-50/70 dark:border-primary-500/40 dark:bg-primary-500/10'
          : 'border-transparent hover:border-gray-200 hover:bg-white dark:hover:border-slate-700 dark:hover:bg-slate-800/40',
      )}
    >
      <div className="flex items-center gap-2">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setRenaming(false); setName(flow.name); } }}
            aria-label="Flow name"
            className="min-w-0 flex-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        ) : (
          <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left focus:outline-none">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'truncate text-sm font-medium',
                  selected ? 'text-primary-700 dark:text-primary-300' : 'text-gray-800 dark:text-slate-200',
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
            <p className={cn('truncate font-mono text-[10px] text-gray-400 dark:text-slate-500', !flow.enabled && 'opacity-60')}>
              {flow.slug} · v{flow.version}
            </p>
          </button>
        )}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={`Flow actions for ${flow.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-700 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <div role="menu" className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lg">
                <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenuOpen(false); setName(flow.name); setRenaming(true); }} />
                <MenuItem icon={Copy} label="Duplicate" onClick={() => { setMenuOpen(false); onDuplicate(); }} />
                <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setMenuOpen(false); onDelete(); }} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <Switch checked={flow.enabled} onChange={onToggleEnabled} label="Enabled" size="sm" />
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
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
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

export default FlowsWorkspace;
