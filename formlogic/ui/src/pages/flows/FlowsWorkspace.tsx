// FormLogic Flows — first-class workspace (/flows).
//
// Left: the flow library (workspace flows + app-scoped flows grouped by app; search, create,
// duplicate, rename, enable, delete). Centre: the real graph editor (FlowEditor — React Flow
// canvas, node palette, properties, autosave). Right: measured-width inline panels or the shared
// slide-over drawer for triggers/history/test-run. Deep-linked by
// ?flow=<id> from the app-level Flows panel.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronLeft, MoreVertical, Copy, Laptop, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Power, RefreshCw, Search, Sparkles, Trash2, Workflow, X,
} from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { usePersistentBoolean } from '../../hooks/usePersistentBoolean';
import { api } from '../../lib/api';
import { demoApplyFlowOverlay, demoApplyFormBindingOverlay, demoCreateFlow, demoUpdateFlow, demoDeleteFlow } from '../../lib/demoLocal';
import { toast } from '../../stores/toastStore';
import { FlowEditor } from '../../components/flows/editor/FlowEditor';
import { resolveEditorLayout, sameResolvedEditorLayout } from '../../components/flows/editor/flowEditorLogic';
import type { CloudRunFeedback, FlowExecutionLocation } from '../../components/flows/editor/executionLocation';
import { deriveFlowConnectors } from '../../components/flows/flowConnectors';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from '../../components/flows/editor/nodeCatalog';
import { flowPickOptions } from '../../components/flows/editor/flowCallChecks';
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

const BELOW_MD_QUERY = '(max-width: 767.98px)';
const LEGACY_INLINE_QUERY = '(min-width: 1024px)';
const AiServicesDialog = lazy(() => import('../../components/flows/AiServicesDialog'));

function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
  return window.matchMedia(query).matches;
}

function bindingReferencesFlow(binding: FlowBinding, flow: FlowDefinition): boolean {
  return binding.flowDefinitionId === flow.id || binding.flow === flow.slug;
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
  // Library scope filter: 'all' | 'workspace' | an app id.
  const [libraryScope, setLibraryScope] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [showAiServices, setShowAiServices] = useState(false);
  const [newFlowInitialTemplate, setNewFlowInitialTemplate] = useState<FlowStarterTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [rightPanel, setRightPanel] = useState<'history' | 'test' | 'triggers' | null>(null);
  // Opt-in space reclaim: collapse the flow library to a narrow rail once you don't need it (e.g.
  // a flow is open and Test Run/History is open too). Defaults open — today's layout, unchanged.
  const [libraryCollapsed, setLibraryCollapsed] = usePersistentBoolean('flows.libraryCollapsed', false);
  const [historyKey, setHistoryKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<FlowDefinition | null>(null);
  // Enable/disable goes through an explicit confirm (no accidental sidebar toggles —
  // disabling a flow stops real automation).
  const [pendingToggle, setPendingToggle] = useState<FlowDefinition | null>(null);
  // Live per-node run status from the Test Run drawer's onNodeStatus — lights up the canvas pills.
  // Owned here (not in the drawer) so the editor + drawer, which are siblings, share one source.
  const [nodeStatus, setNodeStatus] = useState<NodeStatusMap>({});
  // The author's forms, fetched once — powers the List/Submit/Update-response form pickers.
  const [forms, setForms] = useState<FlowFormOption[]>([]);
  const [flowBindingsById, setFlowBindingsById] = useState<Record<string, FlowBinding[]>>({});
  const [flowBindingsLoading, setFlowBindingsLoading] = useState<Record<string, boolean>>({});
  // "Run on" (plan §5.7) cloud feedback per flow id: nodes the cloud runner refused
  // (inline warning — the selection stays saveable) and a typed refusal that means the
  // server has no cloud-run concept at all (the Cloud option disables with that reason).
  const [cloudUnsupportedByFlowId, setCloudUnsupportedByFlowId] = useState<Record<string, string[]>>({});
  const [cloudDisabledReasonByFlowId, setCloudDisabledReasonByFlowId] = useState<Record<string, string>>({});
  const workspaceRowRef = useRef<HTMLDivElement | null>(null);
  const workspaceWidthRef = useRef<number | null>(null);

  // Flat lookup of every flow by id (the editor + drawers work off this).
  const flowById = useMemo(() => {
    const m = new Map<string, FlowDefinition>();
    for (const g of groups) for (const f of g.flows) m.set(f.id, f);
    return m;
  }, [groups]);
  const selectedFlow = selectedId ? flowById.get(selectedId) ?? null : null;
  const selectedFlowPresent = selectedFlow !== null;
  const [belowMd, setBelowMd] = useState(() => mediaMatches(BELOW_MD_QUERY, false));
  const [workspaceLayout, setWorkspaceLayout] = useState(() => resolveEditorLayout({
    workspaceWidth: null,
    selectedFlow: false,
    rightPanelOpen: false,
    libraryCollapsedPreference: libraryCollapsed,
    belowMd: mediaMatches(BELOW_MD_QUERY, false),
    legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
  }));
  const workspaceLayoutRef = useRef(workspaceLayout);

  const applyWorkspaceLayout = useCallback((width: number | null = workspaceWidthRef.current) => {
    const next = resolveEditorLayout({
      workspaceWidth: width,
      selectedFlow: selectedFlowPresent,
      rightPanelOpen: rightPanel !== null,
      libraryCollapsedPreference: libraryCollapsed,
      belowMd,
      legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
    });
    if (sameResolvedEditorLayout(workspaceLayoutRef.current, next)) return;
    workspaceLayoutRef.current = next;
    setWorkspaceLayout(next);
  }, [belowMd, libraryCollapsed, rightPanel, selectedFlowPresent]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(BELOW_MD_QUERY);
    const onChange = () => setBelowMd((current) => (current === query.matches ? current : query.matches));
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyWorkspaceLayout();
  }, [applyWorkspaceLayout]);

  useEffect(() => {
    const el = workspaceRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== 'number') return;
      workspaceWidthRef.current = width;
      applyWorkspaceLayout(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [applyWorkspaceLayout]);

  const allFlows = useMemo(() => groups.flatMap((group) => group.flows), [groups]);
  // The selected flow's sibling flows (same app / same workspace) feed the §9.1 outcome-trigger
  // source picker AND the flow_call child picker — the same lists the runtimes resolve against.
  const selectedAppFlows = useMemo(
    () => (selectedFlow ? allFlows.filter((flow) => flow.appId === selectedFlow.appId) : []),
    [allFlows, selectedFlow],
  );
  // Editor context (docs §4): the palette + connector pickers depend on whether the selected flow
  // is app-scoped and which connectors its app actually grants. Workspace flows have no connectors
  // but DO carry sibling flows (workspace flow_call resolves from the owner's workspace list).
  const editorContext = useMemo<FlowEditorContext>(() => {
    const flowContext = { flows: flowPickOptions(selectedAppFlows), currentFlowId: selectedFlow?.id };
    if (!selectedFlow?.appId) return { ...EMPTY_FLOW_EDITOR_CONTEXT, ...flowContext };
    const app = groups.find((g) => g.app?.id === selectedFlow.appId)?.app ?? null;
    // The app's own forms scope the Find/Submit/Update form picker to a short labelled list.
    const appFormIds = (app?.navConfig ?? []).map((n) => n.formId).filter((id): id is string => typeof id === 'string');
    return { appScoped: true, connectors: deriveFlowConnectors(app), appFormIds, ...flowContext };
  }, [selectedFlow, groups, selectedAppFlows]);
  const selectedFlowBindings = selectedFlow ? flowBindingsById[selectedFlow.id] ?? [] : [];
  const availableConnectorIds = useMemo(
    () => [...new Set(apps.flatMap((app) => deriveFlowConnectors(app).map((connector) => connector.id)))].sort(),
    [apps],
  );
  const effectiveLibraryCollapsed = selectedFlowPresent ? workspaceLayout.library === 'rail' : libraryCollapsed;
  const rightPanelInline = selectedFlowPresent && rightPanel !== null && workspaceLayout.rightPanel === 'rail';
  const rightPanelDrawer = selectedFlowPresent && rightPanel !== null && workspaceLayout.rightPanel === 'drawer';

  const fetchFlowBindings = useCallback(async (flow: FlowDefinition) => {
    // Demo too: the seeded demo flows are real server rows with real bindings, and reads are
    // allowed — only a per-browser overlay flow (id unknown to the server) 404s, which reads
    // as "no triggers" rather than an error there.
    setFlowBindingsLoading((map) => ({ ...map, [flow.id]: true }));
    const res = await api.listFlowBindingsForFlow(flow.id);
    setFlowBindingsLoading((map) => ({ ...map, [flow.id]: false }));
    if (res.error || !res.data) {
      if (api.isDemoMode() && flow.appId === null) {
        const localBindings = (await Promise.all(forms.map(async (form) => (
          await demoApplyFormBindingOverlay(form.id, [])
        )))).flat().filter((binding) => bindingReferencesFlow(binding, flow));
        setFlowBindingsById((map) => ({ ...map, [flow.id]: localBindings }));
        return;
      }
      if (!api.isDemoMode()) {
        toast.error('Failed to load triggers', typeof res.error === 'string' ? res.error : undefined);
      }
      setFlowBindingsById((map) => ({ ...map, [flow.id]: [] }));
      return;
    }
    const serverBindings = res.data.bindings;
    const loaded = api.isDemoMode() && flow.appId === null
      ? (await Promise.all(forms.map(async (form) => {
        const serverRows = serverBindings.filter((binding) => binding.formId === form.id);
        return demoApplyFormBindingOverlay(form.id, serverRows);
      }))).flat().filter((binding) => bindingReferencesFlow(binding, flow))
      : serverBindings;
    setFlowBindingsById((map) => ({ ...map, [flow.id]: loaded }));
  }, [forms]);

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
      const params = new URLSearchParams(window.location.search);
      const target = params.get('flow');
      if (target && nextGroups.some((group) => group.flows.some((flow) => flow.id === target))) setSelectedId(target);
      // ?new=1 (the mobile + quick menu) opens the New-flow dialog straight away, once.
      if (params.get('new') === '1') {
        setShowNew(true);
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('new');
          return next;
        }, { replace: true });
      }
    } catch (error) {
      if (isCancelled()) return;
      setLoading(false);
      setLoadError(error instanceof Error ? error.message : 'Failed to load flows');
    }
  }, [setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    void loadInitialData(() => cancelled);
    return () => { cancelled = true; };
  }, [loadInitialData]);

  useEffect(() => {
    const openAiServices = () => setShowAiServices(true);
    window.addEventListener('formlogic:open-ai-services', openAiServices);
    return () => window.removeEventListener('formlogic:open-ai-services', openAiServices);
  }, []);

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

  /** Persist the "Run on" execution location (plan §5.7) — a per-flow setting saved on change. */
  const saveExecutionLocation = useCallback(async (flow: FlowDefinition, location: FlowExecutionLocation) => {
    if (api.isDemoMode()) {
      upsertFlow(await demoUpdateFlow(flow, { executionLocation: location } as Partial<FlowDefinition>));
      return;
    }
    // The backend's flow read/update API accepts executionLocation (the Phase-5 contract);
    // the api client's update payload type predates the column, hence the one cast here.
    const payload = { executionLocation: location } as Parameters<typeof api.updateFlow>[2];
    const res = flow.appId
      ? await api.updateFlow(flow.appId, flow.id, payload)
      : await api.updateWorkspaceFlow(flow.id, payload);
    if (res.error || !res.data) {
      toast.error('Failed to save the run location', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    upsertFlow({ ...(res.data.flow as FlowDefinition & { executionLocation?: FlowExecutionLocation }), executionLocation: location });
  }, [upsertFlow]);

  /** Cloud-run feedback from the Test Run drawer (plan §5.7 run-time honesty). */
  const handleCloudRunFeedback = useCallback((flowId: string, feedback: CloudRunFeedback) => {
    if (feedback.kind === 'unsupported') {
      setCloudUnsupportedByFlowId((m) => ({ ...m, [flowId]: feedback.nodes }));
      return;
    }
    if (feedback.kind === 'unavailable') {
      setCloudDisabledReasonByFlowId((m) => ({ ...m, [flowId]: feedback.reason }));
      return;
    }
    // 'ok': a cloud run went through — clear any earlier warning for this flow.
    setCloudUnsupportedByFlowId((m) => {
      if (!(flowId in m)) return m;
      const next = { ...m };
      delete next[flowId];
      return next;
    });
  }, []);

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

  const confirmToggleEnabled = async () => {
    const flow = pendingToggle;
    setPendingToggle(null);
    if (!flow) return;
    await toggleEnabled(flow, !flow.enabled);
    toast.success(flow.enabled ? 'Flow disabled' : 'Flow enabled', flow.name);
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
    let trashed = false;
    if (api.isDemoMode()) {
      await demoDeleteFlow(flow);
    } else {
      const res = flow.appId ? await api.deleteFlow(flow.appId, flow.id) : await api.deleteWorkspaceFlow(flow.id);
      if (res.error) {
        toast.error('Failed to delete flow', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      trashed = res.data?.trashed === true;
    }
    setGroups((gs) => gs.map((g) => ({ ...g, flows: g.flows.filter((f) => f.id !== flow.id) })));
    if (selectedId === flow.id) selectFlow(null);
    if (trashed) {
      toast.success('Moved to the recycle bin', `"${flow.name}" can be restored from Settings → Recycle bin for 30 days.`);
    } else {
      toast.success('Flow deleted', flow.name);
    }
  };

  return (
    // Mobile height mirrors AppShell's real bottom-nav padding — pb-[calc(5rem+safe-area)] —
    // so the workspace fills the viewport exactly (4rem here left a 16px page scroll).
    <div className="flex h-[calc(100dvh-5rem-env(safe-area-inset-bottom)-var(--fl-demo-banner-h,0px))] flex-col overflow-hidden md:h-[calc(100dvh-var(--fl-demo-banner-h,0px))]">
      {/* This workspace is a fixed-height box that already sits BELOW the demo/acting
          banner (the height calc above subtracts it), so the Header's banner offset
          (sticky top-[var(--fl-demo-banner-h)]) must NOT apply in here: inside this
          overflow-hidden scrollport the inset takes effect immediately, shifting the
          header down by the banner height — a gap where the header belongs and the
          header overlapping the flow toolbar below it. Zeroing the var for this
          subtree neutralizes the offset; the root's own height calc is unaffected
          (custom properties only inherit DOWNWARD from this wrapper). */}
      <div className="[--fl-demo-banner-h:0px]">
        <Header
          title="Flows"
          actions={
            <>
              <DesktopPresenceChip presence={desktopPresence} />
              <AiServicesChip onClick={() => setShowAiServices(true)} />
              <Button size="sm" onClick={() => openNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
                <span className="hidden sm:inline">New flow</span>
                <span className="sm:hidden">New</span>
              </Button>
            </>
          }
        />
      </div>

      <div ref={workspaceRowRef} className="flex min-h-0 flex-1">
        {/* Library */}
        <FlowLibrary
          groups={groups}
          loading={loading}
          query={query}
          onQuery={setQuery}
          scope={libraryScope}
          onScope={setLibraryScope}
          selectedId={selectedId}
          onSelect={selectFlow}
          onDuplicate={duplicateFlow}
          onRename={renameFlow}
          onRequestToggleEnabled={setPendingToggle}
          onDelete={setPendingDelete}
          onNew={() => openNewFlow()}
          collapsed={effectiveLibraryCollapsed}
          onToggleCollapsed={() => setLibraryCollapsed((c) => !c)}
          className={cn(
            'motion-safe:transition-[width] motion-safe:duration-200',
            effectiveLibraryCollapsed ? 'w-14' : 'w-full md:w-72',
            selectedFlow ? 'hidden md:flex' : 'flex',
          )}
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
                  scopeLabel={selectedFlow.appId
                    ? `${groups.find((g) => g.app?.id === selectedFlow.appId)?.app?.name ?? 'app'} flow`
                    : 'workspace flow'}
                  onExecutionLocationChange={(location) => void saveExecutionLocation(selectedFlow, location)}
                  cloudDisabledReason={cloudDisabledReasonByFlowId[selectedFlow.id] ?? null}
                  cloudUnsupportedNodes={cloudUnsupportedByFlowId[selectedFlow.id] ?? null}
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
                availableConnectorIds={availableConnectorIds}
                onNewFlow={openNewFlow}
                onOpenAiServices={() => setShowAiServices(true)}
                onOpenRunFlow={(flowId) => {
                  selectFlow(flowId);
                  setRightPanel('history');
                }}
              />
            )
          )}
        </div>

        {/* Right panel: triggers / history / test run. No border here — the panel's white bg vs the
            canvas's gray provides the seam (docs §4, rail hierarchy: seams by value contrast). */}
        {rightPanelInline && rightPanel === 'triggers' && selectedFlow && (
          <div className="hidden w-96 flex-none bg-white dark:bg-slate-900 md:flex motion-safe:transition-[width] motion-safe:duration-200">
            <TriggersPanel
              flow={selectedFlow}
              bindings={selectedFlowBindings}
              loading={!!flowBindingsLoading[selectedFlow.id]}
              forms={forms}
              context={editorContext}
              appFlows={selectedAppFlows}
              onRefresh={() => fetchFlowBindings(selectedFlow)}
            />
          </div>
        )}
        {rightPanelInline && rightPanel === 'history' && selectedFlow && (
          <div className="hidden w-96 flex-none bg-white dark:bg-slate-900 md:flex motion-safe:transition-[width] motion-safe:duration-200">
            <FlowRunHistory flowId={selectedFlow.id} flow={selectedFlow} refreshKey={historyKey} />
          </div>
        )}
        {rightPanelInline && rightPanel === 'test' && selectedFlow && (
          <div className="hidden md:flex motion-safe:transition-[width] motion-safe:duration-200">
            <TestRunDrawer
              flow={selectedFlow}
              onClose={() => setRightPanel(null)}
              onServerRun={() => { setHistoryKey((k) => k + 1); setRightPanel('history'); }}
              onRunStart={() => setNodeStatus({})}
              onNodeStatus={(id, status, info) => setNodeStatus((m) => reduceNodeStatus(m, id, status, info))}
              onCloudRunFeedback={handleCloudRunFeedback}
            />
          </div>
        )}
      </div>

      {rightPanelDrawer && rightPanel === 'triggers' && selectedFlow && (
        <FlowMobileDrawer title="Triggers" onClose={() => setRightPanel(null)}>
          <TriggersPanel
            flow={selectedFlow}
            bindings={selectedFlowBindings}
            loading={!!flowBindingsLoading[selectedFlow.id]}
            forms={forms}
            context={editorContext}
            appFlows={selectedAppFlows}
            onRefresh={() => fetchFlowBindings(selectedFlow)}
          />
        </FlowMobileDrawer>
      )}
      {rightPanelDrawer && rightPanel === 'history' && selectedFlow && (
        <FlowMobileDrawer title="Run history" onClose={() => setRightPanel(null)}>
          <FlowRunHistory flowId={selectedFlow.id} flow={selectedFlow} refreshKey={historyKey} />
        </FlowMobileDrawer>
      )}
      {rightPanelDrawer && rightPanel === 'test' && selectedFlow && (
        <FlowMobileDrawer title="Test run" onClose={() => setRightPanel(null)}>
          <TestRunDrawer
            flow={selectedFlow}
            hideClose
            onClose={() => setRightPanel(null)}
            onServerRun={() => { setHistoryKey((k) => k + 1); setRightPanel('history'); }}
            onRunStart={() => setNodeStatus({})}
            onNodeStatus={(id, status, info) => setNodeStatus((m) => reduceNodeStatus(m, id, status, info))}
            onCloudRunFeedback={handleCloudRunFeedback}
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
      <Suspense fallback={null}>
        {showAiServices && (
          <AiServicesDialog
            isOpen={showAiServices}
            onClose={() => setShowAiServices(false)}
            desktopPresence={desktopPresence}
          />
        )}
      </Suspense>
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete flow"
        message={pendingDelete ? (api.isDemoMode()
          ? `Delete the flow "${pendingDelete.name}"? Its bindings and run history are kept but it will stop running.`
          : `Delete the flow "${pendingDelete.name}"? It moves to the recycle bin (bindings included), restorable for 30 days.`) : ''}
        confirmLabel="Delete"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={pendingToggle !== null}
        onClose={() => setPendingToggle(null)}
        onConfirm={confirmToggleEnabled}
        title={pendingToggle?.enabled ? 'Disable flow' : 'Enable flow'}
        message={pendingToggle
          ? pendingToggle.enabled
            ? `Disable "${pendingToggle.name}"? Its triggers stop running until you enable it again.`
            : `Enable "${pendingToggle.name}"? Its triggers start running immediately.`
          : ''}
        confirmLabel={pendingToggle?.enabled ? 'Disable' : 'Enable'}
        variant={pendingToggle?.enabled ? 'danger' : 'default'}
      />
    </div>
  );
}

function AiServicesChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open AI services"
      title="AI services"
      className={cn(
        'inline-flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        'border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/15',
      )}
    >
      <Sparkles className="h-3.5 w-3.5 flex-none" />
      <span className="hidden sm:inline">AI services</span>
      <span className="sm:hidden">AI</span>
    </button>
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
    <div>
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
        {/* flex-col + forced flex-1 children (not h-full percentage chains): the panels inside
            must size as flex items so their inner lists scroll instead of clipping on iOS. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0 [&>*]:flex-1 [&>div>div:first-child]:pr-12 [&>div>div:nth-child(2)]:pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function FlowLibrary({
  groups, loading, query, onQuery, scope, onScope, selectedId, onSelect, onDuplicate, onRename, onRequestToggleEnabled, onDelete, onNew, collapsed = false, onToggleCollapsed, className,
}: {
  groups: FlowGroup[];
  loading: boolean;
  query: string;
  onQuery: (q: string) => void;
  /** Scope filter: 'all', 'workspace', or an app id — refines the library when flows pile up. */
  scope: string;
  onScope: (scope: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDuplicate: (flow: FlowDefinition) => void;
  onRename: (flow: FlowDefinition, name: string) => void;
  /** Opens the enable/disable confirm for this flow (the actual toggle happens on confirm). */
  onRequestToggleEnabled: (flow: FlowDefinition) => void;
  onDelete: (flow: FlowDefinition) => void;
  onNew: () => void;
  /** Collapsed to a narrow icon-only rail (space-reclaiming; never hides the panel's existence). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  className?: string;
}) {
  const q = query.trim().toLowerCase();
  const scoped = scope === 'all'
    ? groups
    : groups.filter((g) => (scope === 'workspace' ? g.app === null : g.app?.id === scope));
  const filtered = scoped
    .map((g) => ({ ...g, flows: g.flows.filter((f) => q === '' || f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)) }))
    .filter((g) => g.flows.length > 0);
  const total = groups.reduce((n, g) => n + g.flows.length, 0);
  const scopedTotal = scoped.reduce((n, g) => n + g.flows.length, 0);

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

      {/* Scope filter — refine to Workspace or one app when flows pile up. Hidden with a
          single group since there is nothing to refine. */}
      {groups.length > 1 && (
        <div className="px-2.5 pb-2">
          <select
            value={scope}
            onChange={(e) => onScope(e.target.value)}
            aria-label="Filter flows by scope"
            className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            <option value="all">All scopes · {total}</option>
            {groups.map((g) => (
              <option key={g.app?.id ?? 'workspace'} value={g.app?.id ?? 'workspace'}>
                {g.app ? g.app.name : 'Workspace'} · {g.flows.length}
              </option>
            ))}
          </select>
        </div>
      )}

      <div
        ref={listRef}
        onScroll={(e) => { listScrollTop.current = e.currentTarget.scrollTop; }}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2.5 space-y-4"
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
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">
            {scopedTotal === 0 ? 'No flows in this scope yet.' : `No flows match "${query}".`}
          </p>
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
                    onRequestToggleEnabled={() => onRequestToggleEnabled(flow)}
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

// Approximate height of the tallest row menu — used to flip the portal menu above the
// trigger when it would clip past the bottom of the viewport (mirrors FormCard's menu).
const FLOW_MENU_HEIGHT = 210;
const FLOW_MENU_WIDTH = 176; // w-44

function FlowRow({ flow, selected, onSelect, onDuplicate, onRename, onRequestToggleEnabled, onDelete }: {
  flow: FlowDefinition;
  selected: boolean;
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
  const closeMenu = () => setMenuRect(null);

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
        {/* Enabled indicator — one glance says whether the flow runs; click to toggle (confirmed). */}
        <button
          type="button"
          onClick={onRequestToggleEnabled}
          aria-label={flow.enabled ? `Disable ${flow.name}` : `Enable ${flow.name}`}
          title={flow.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          className={cn(
            'flex-none cursor-pointer rounded p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
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
            onClick={(e) => setMenuRect(menuOpen ? null : e.currentTarget.getBoundingClientRect())}
            aria-label={`Flow actions for ${flow.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="cursor-pointer rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-slate-700 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {/* Portal + fixed positioning: the library list scrolls (overflow-y-auto), which
              clipped an in-flow absolute menu for the LAST rows — the menu now escapes the
              scroll container and flips above the trigger when the viewport bottom is near. */}
          {menuRect && createPortal(
            <div className="fixed inset-0 z-[70]" onClick={closeMenu}>
              <div
                role="menu"
                aria-label={`Flow actions for ${flow.name}`}
                onClick={(e) => e.stopPropagation()}
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
                <MenuItem icon={Pencil} label="Rename" onClick={() => { closeMenu(); setName(flow.name); setRenaming(true); }} />
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

export default FlowsWorkspace;
