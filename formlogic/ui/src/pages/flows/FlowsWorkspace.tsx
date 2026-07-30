// FormLogic Flows — first-class workspace (/flows).
//
// Two views on one route: with no flow open, the start page (FlowsOverview — hero, flow
// list, readiness, recent runs, templates); with ?flow=<id> set, the FULL-PAGE editor
// (FlowEditor — React Flow canvas, node palette, properties, autosave) with a back link
// in its toolbar, plus measured-width inline panels or the shared slide-over drawer for
// triggers/history/test-run. Deep-linked by ?flow=<id> from the app-level Flows panel.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Plus, RefreshCw, Sparkles, Workflow, X } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
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
import { useReturnTo } from '../../hooks/useReturnTo';
import { FlowsOverview, type FlowGroup } from '../../components/flows/FlowsOverview';
import { useFlowsDesktopPresence } from '../../components/flows/useFlowsDesktopPresence';
import type { FlowStarterTemplate } from '../../components/flows/starterTemplates';
import type { AppListItem } from '../../types/app';
import type { FlowBinding, FlowDefinition, WorkflowGraph } from '../../types/flows';

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
  const navigate = useNavigate();
  // Origin-relative Back: opened as /flows?flow=X FROM another surface (App
  // Studio Automations), the editor's back link returns there; otherwise it
  // falls back to the flows start page (deselect). Internal navigation within
  // the workspace replaces the history entry without state, so the origin only
  // applies to the entry the user arrived on.
  const backTo = useReturnTo('');
  const desktopPresence = useFlowsDesktopPresence();
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showAiServices, setShowAiServices] = useState(false);
  const [newFlowInitialTemplate, setNewFlowInitialTemplate] = useState<FlowStarterTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [rightPanel, setRightPanel] = useState<'history' | 'test' | 'triggers' | null>(null);
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
  const [flowBindingsErrorById, setFlowBindingsErrorById] = useState<Record<string, string | null>>({});
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
    libraryHidden: true,
    belowMd: mediaMatches(BELOW_MD_QUERY, false),
    legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
  }));
  const workspaceLayoutRef = useRef(workspaceLayout);

  const applyWorkspaceLayout = useCallback((width: number | null = workspaceWidthRef.current) => {
    // The full-page editor renders no library rail — only the right panel tier matters here.
    const next = resolveEditorLayout({
      workspaceWidth: width,
      selectedFlow: selectedFlowPresent,
      rightPanelOpen: rightPanel !== null,
      libraryHidden: true,
      belowMd,
      legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
    });
    if (sameResolvedEditorLayout(workspaceLayoutRef.current, next)) return;
    workspaceLayoutRef.current = next;
    setWorkspaceLayout(next);
  }, [belowMd, rightPanel, selectedFlowPresent]);

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
      // Committing [] here made a failed read indistinguishable from a flow with no
      // triggers — the panel then said "No triggers yet", i.e. "nothing starts this
      // automation", about a flow that may well be running in production.
      setFlowBindingsErrorById((map) => ({
        ...map,
        [flow.id]: typeof res.error === 'string' ? res.error : 'Please try again.',
      }));
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
    setFlowBindingsErrorById((map) => (map[flow.id] ? { ...map, [flow.id]: null } : map));
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
      if (target && nextGroups.some((group) => group.flows.some((flow) => flow.id === target))) {
        setSelectedId(target);
        // ?panel= opens the requested side panel with the flow, so a link that
        // promises "run history" actually lands on the run history.
        const panel = params.get('panel');
        if (panel === 'history' || panel === 'triggers' || panel === 'test') setRightPanel(panel);
      }
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
      {/* The page Header renders only on the start page — an open flow takes the FULL page
          (diagram-style: the editor toolbar carries the back link).
          This workspace is a fixed-height box that already sits BELOW the demo/acting
          banner (the height calc above subtracts it), so the Header's banner offset
          (sticky top-[var(--fl-demo-banner-h)]) must NOT apply in here: inside this
          overflow-hidden scrollport the inset takes effect immediately, shifting the
          header down by the banner height. Zeroing the var for this subtree neutralizes
          the offset; the root's own height calc is unaffected (custom properties only
          inherit DOWNWARD from this wrapper). */}
      {!selectedFlow && (
        <div className="[--fl-demo-banner-h:0px]">
          <Header
            title="Automations"
            actions={
              <>
                <AiServicesChip onClick={() => setShowAiServices(true)} />
                <Button size="sm" onClick={() => openNewFlow()} leftIcon={<Plus className="h-4 w-4" />}>
                  <span className="hidden sm:inline">New flow</span>
                  <span className="sm:hidden">New</span>
                </Button>
              </>
            }
          />
        </div>
      )}

      <div ref={workspaceRowRef} className="flex min-h-0 flex-1">
        {selectedFlow ? (
          /* Full-page editor: toolbar + canvas own everything (no library rail). */
          <div className="flex min-w-0 flex-1 flex-col">
            <FlowEditor
              key={selectedFlow.id}
              flow={selectedFlow}
              onBack={() => {
                if (backTo.fromState) navigate(backTo.path);
                else selectFlow(null);
              }}
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
        ) : loadError ? (
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
            groups={groups}
            desktopPresence={desktopPresence}
            availableConnectorIds={availableConnectorIds}
            onNewFlow={openNewFlow}
            onOpenFlow={selectFlow}
            onOpenAiServices={() => setShowAiServices(true)}
            onOpenRunFlow={(flowId) => {
              selectFlow(flowId);
              setRightPanel('history');
            }}
            onDuplicate={duplicateFlow}
            onRename={renameFlow}
            onRequestToggleEnabled={setPendingToggle}
            onDelete={setPendingDelete}
          />
        )}

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
              loadError={flowBindingsErrorById[selectedFlow.id] ?? null}
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
            loadError={flowBindingsErrorById[selectedFlow.id] ?? null}
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

export default FlowsWorkspace;
