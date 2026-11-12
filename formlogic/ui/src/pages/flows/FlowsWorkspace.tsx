// FormLogic Flows — first-class workspace (/flows), "Automations" in the navigation.
//
// Two sections, each an address: /flows creates a flow, /flows?view=existing lists the flows
// (a table, with the latest runs and the connections under it). With ?flow=<id> set, the
// FULL-PAGE editor (FlowEditor — React Flow canvas, list of steps, properties, autosave) with
// a back link in its bar; the triggers, run history and test run panels are handed to the
// editor, which places one at a time beside the canvas (a drawer on a phone).
// Deep-linked by ?flow=<id> (and &panel=history|triggers|test) from the app-level Flows panel.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Plus, RefreshCw, Sparkles, Workflow } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { PAGE_BODY } from '../../components/layout/PageBody';
import { SectionNav } from '../../components/ui/SectionNav';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { lazyWithRetry } from '../../lib/lazyWithRetry';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { demoApplyFlowOverlay, demoApplyFormBindingOverlay, demoCreateFlow, demoUpdateFlow, demoDeleteFlow } from '../../lib/demoLocal';
import { toast } from '../../stores/toastStore';
import { FlowEditor } from '../../components/flows/editor/FlowEditor';
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

const AiServicesDialog = lazyWithRetry(() => import('../../components/flows/AiServicesDialog'));

/** What the panel at the editor's right is called: on a narrow screen it is a drawer under this name. */
const SIDE_PANEL_TITLE = { triggers: 'Triggers', history: 'Run history', test: 'Test run' } as const;

function bindingReferencesFlow(binding: FlowBinding, flow: FlowDefinition): boolean {
  return binding.flowDefinitionId === flow.id || binding.flow === flow.slug;
}

/**
 * Dedupe a new flow's slug against its scope (and mirror any suffix onto an auto/duplicate name)
 * so repeated creates — several "Untitled flow"s, or copies of a copy — never collide on the
 * server's slug uniqueness.
 */
function uniqueFlowIdentity(name: string, slug: string, siblings: FlowDefinition[]): { name: string; slug: string } {
  const takenSlugs = new Set(siblings.map((f) => f.slug));
  let uniqueSlug = slug;
  let n = 1;
  while (takenSlugs.has(uniqueSlug)) {
    n += 1;
    uniqueSlug = `${slug.slice(0, 60 - String(n).length - 1)}-${n}`;
  }
  return { name: n > 1 && !name.trim().match(/\d$/) ? `${name} ${n}` : name, slug: uniqueSlug };
}

export function FlowsWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const libraryVisible = searchParams.get('view') === 'existing' && searchParams.get('new') !== '1';
  const navigate = useNavigate();
  // Origin-relative Back: opened as /flows?flow=X FROM another surface (App
  // Studio Automations), the editor's back link returns there; otherwise it
  // falls back to the flows start page (deselect). Internal navigation within
  // the workspace replaces the history entry without state, so the origin only
  // applies to the entry the user arrived on.
  const backTo = useReturnTo('');
  const desktopPresence = useFlowsDesktopPresence(true);
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectedId = searchParams.get('flow');
  const [showAiServices, setShowAiServices] = useState(false);
  const [newFlowInitialTemplate, setNewFlowInitialTemplate] = useState<FlowStarterTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [rightPanel, setRightPanel] = useState<'history' | 'test' | 'triggers' | null>(null);
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
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

  // Flat lookup of every flow by id (the editor + drawers work off this).
  const flowById = useMemo(() => {
    const m = new Map<string, FlowDefinition>();
    for (const g of groups) for (const f of g.flows) m.set(f.id, f);
    return m;
  }, [groups]);
  const selectedFlow = selectedId ? flowById.get(selectedId) ?? null : null;

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
  // `forTheList`: the list of flows reads a row's triggers to say what starts it. A read that
  // fails there says so in the row and nothing more (no toast a row), and leaves the flow unread,
  // so opening it reads again and reports as it always did.
  const fetchFlowBindings = useCallback(async (flow: FlowDefinition, forTheList = false) => {
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
      if (forTheList) {
        setFlowBindingsErrorById((map) => ({ ...map, [flow.id]: typeof res.error === 'string' ? res.error : 'Please try again.' }));
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
    return deferEffect(() => { void fetchFlowBindings(selectedFlow); });
  }, [selectedFlow, flowBindingsById, fetchFlowBindings]);

  // The list's "Starts on" column: the rows on screen ask for their triggers. Each flow is read
  // once (the editor's own read counts), a few at a time, so a page of rows is not a burst.
  const knownBindingsRef = useRef(flowBindingsById);
  const readBindingsRef = useRef(fetchFlowBindings);
  useEffect(() => {
    knownBindingsRef.current = flowBindingsById;
    readBindingsRef.current = fetchFlowBindings;
  });
  const listTriggerReads = useRef({ asked: new Set<string>(), waiting: [] as FlowDefinition[], running: 0 });
  const readListTriggers = useCallback((flows: FlowDefinition[]) => {
    const reads = listTriggerReads.current;
    for (const flow of flows) {
      if (reads.asked.has(flow.id)) continue;
      reads.asked.add(flow.id);
      reads.waiting.push(flow);
    }
    const next = () => {
      while (reads.running < 3 && reads.waiting.length > 0) {
        const flow = reads.waiting.shift()!;
        if (knownBindingsRef.current[flow.id] !== undefined) continue;
        reads.running += 1;
        void readBindingsRef.current(flow, true).catch(() => undefined).then(() => {
          reads.running -= 1;
          next();
        });
      }
    };
    next();
  }, []);

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

        // ?panel= opens the requested side panel with the flow, so a link that
        // promises "run history" actually lands on the run history.
        const panel = params.get('panel');
        if (panel === 'history' || panel === 'triggers' || panel === 'test') setRightPanel(panel);
      }

    } catch (error) {
      if (isCancelled()) return;
      setLoading(false);
      setLoadError(error instanceof Error ? error.message : 'Failed to load flows');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cancelStart = deferEffect(() => { void loadInitialData(() => cancelled); });
    return () => { cancelled = true; cancelStart(); };
  }, [loadInitialData]);

  useEffect(() => {
    const openAiServices = () => setShowAiServices(true);
    window.addEventListener('formlogic:open-ai-services', openAiServices);
    return () => window.removeEventListener('formlogic:open-ai-services', openAiServices);
  }, []);

  const selectFlow = (id: string | null) => {

    setRightPanel(null);
    setNodeStatus({}); // clear stale run pills when switching flows
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('flow', id); else next.delete('flow');
      next.set('view', 'existing');
      next.delete('panel');
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
    setRightPanel(null);
    setSearchParams({}, { replace: true });
  };

  const createFlow = async ({ name, slug, description, template, appId }: { name: string; slug: string; description: string; template: FlowStarterTemplate; appId: string | null }) => {
    setCreating(true);
    const identity = uniqueFlowIdentity(name, slug, groups.find((g) => (g.app?.id ?? null) === appId)?.flows ?? []);
    const body = { ...identity, description, flowJson: template.flowJson, enabled: true, nodeCapabilities: template.nodeCapabilities };
    let flow: FlowDefinition;
    try {
      if (api.isDemoMode()) {
        flow = await demoCreateFlow({ ...body, appId });
      } else {
        const response = appId ? await api.createFlow(appId, body) : await api.createWorkspaceFlow(body);
        if (response.error || !response.data?.flow) throw new Error(typeof response.error === 'string' ? response.error : 'Please try again.');
        flow = response.data.flow;
      }
    } catch (error) {
      toast.error('Failed to create flow', error instanceof Error ? error.message : 'Please try again.');
      return;
    } finally {
      setCreating(false);
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
    setNewFlowInitialTemplate(null);
    selectFlow(flow.id);
    toast.success('Flow created', flow.name);
  };

  const duplicateFlow = async (flow: FlowDefinition) => {
    const payload = {
      ...uniqueFlowIdentity(
        `${flow.name} copy`,
        `${flow.slug}-copy`.slice(0, 60),
        groups.find((g) => (g.app?.id ?? null) === (flow.appId ?? null))?.flows ?? [],
      ),
      description: flow.description ?? undefined,
      flowJson: flow.flowJson,
      enabled: false,
      nodeCapabilities: flow.nodeCapabilities ?? undefined,
    };
    let created: FlowDefinition;
    try {
      if (api.isDemoMode()) {
        created = await demoCreateFlow({ ...payload, appId: flow.appId ?? null });
      } else {
        const response = flow.appId ? await api.createFlow(flow.appId, payload) : await api.createWorkspaceFlow(payload);
        if (response.error || !response.data?.flow) throw new Error(typeof response.error === 'string' ? response.error : 'Please try again.');
        created = response.data.flow;
      }
    } catch (error) {
      toast.error('Failed to duplicate flow', error instanceof Error ? error.message : 'Please try again.');
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
    const updated = await toggleEnabled(flow, !flow.enabled);
    if (!updated) return;
    toast.success(flow.enabled ? 'Flow disabled' : 'Flow enabled', flow.name);
  };

  const toggleEnabled = async (flow: FlowDefinition, enabled: boolean) => {
    if (api.isDemoMode()) {
      upsertFlow(await demoUpdateFlow(flow, { enabled }));
      return true;
    }
    const res = flow.appId ? await api.updateFlow(flow.appId, flow.id, { enabled }) : await api.updateWorkspaceFlow(flow.id, { enabled });
    if (res.error || !res.data) {
      toast.error('Failed to update flow', typeof res.error === 'string' ? res.error : undefined);
      return false;
    }
    upsertFlow(res.data.flow);
    return true;
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

              </>
            }
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {selectedFlow ? (
          /* Full-page editor: toolbar + canvas own everything (no library rail). The panel
             opened from its bar (triggers, run history, a test run) is handed to the editor,
             which places it at the canvas's right, under the bar. */
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
              testRunOpen={rightPanel === 'test'}
              onCloseSidePanel={() => setRightPanel(null)}
              sidePanel={rightPanel === null ? null : {
                title: SIDE_PANEL_TITLE[rightPanel],
                render: (placed) => rightPanel === 'triggers' ? (
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
                ) : rightPanel === 'history' ? (
                  <FlowRunHistory flowId={selectedFlow.id} flow={selectedFlow} />
                ) : (
                  <TestRunDrawer
                    flow={selectedFlow}
                    inputValue={testInputs[selectedFlow.id]}
                    onInputChange={(value) => setTestInputs((drafts) => ({ ...drafts, [selectedFlow.id]: value }))}
                    // The drawer has its own way to close: no second one in the panel's header.
                    hideClose={placed === 'drawer'}
                    onClose={() => setRightPanel(null)}
                    onRunStart={() => setNodeStatus({})}
                    onNodeStatus={(id, status, info) => setNodeStatus((m) => reduceNodeStatus(m, id, status, info))}
                    onCloudRunFeedback={handleCloudRunFeedback}
                  />
                ),
              }}
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
          // The page frame every workspace page has: it starts on the title's line, takes the
          // width it is given, and its two sections are links under the header. Each is an
          // address (/flows, /flows?view=existing), so a reload and Back land on it.
          <div className={cn('min-w-0 flex-1 overflow-y-auto bg-gray-50 dark:bg-slate-950', PAGE_BODY)}>
            <SectionNav
              label="Automation workspace"
              current={libraryVisible ? 'existing' : 'create'}
              items={[
                { value: 'create', label: 'Create a flow', icon: Plus, to: { search: '' } },
                { value: 'existing', label: 'Existing flows', icon: Workflow, to: { search: '?view=existing' }, mark: allFlows.length },
              ]}
            />
            <div className="mt-4 min-w-0">
              {/* Kept while the list is shown, so a name typed here is still here on the way back. */}
              <div hidden={libraryVisible}>
                <NewFlowDialog embedded isOpen onClose={() => selectFlow(null)} onCreate={createFlow} creating={creating} apps={apps} initialTemplate={newFlowInitialTemplate} />
                <p className="mt-3 px-1 text-xs leading-5 text-gray-500 dark:text-slate-400">Using local AI or Aokie? Connect OAIY in <button className="cursor-pointer font-medium text-primary-600 underline underline-offset-2 dark:text-primary-300" onClick={() => navigate('/settings#local-runtime')}>Settings</button>. You can create your flow first.</p>
              </div>
              {libraryVisible && (
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
                  triggersByFlowId={flowBindingsById}
                  triggerErrorsByFlowId={flowBindingsErrorById}
                  onNeedTriggers={readListTriggers}
                  forms={forms}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <ErrorBoundary fallback={<div role="alert" className="fixed bottom-4 right-4 z-50 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">The AI services dialog couldn’t load. Reload this page to try again.</div>}>
      <Suspense fallback={null}>
        {showAiServices && (
          <AiServicesDialog
            isOpen={showAiServices}
            onClose={() => setShowAiServices(false)}
            desktopPresence={desktopPresence}
          />
        )}
      </Suspense>
      </ErrorBoundary>
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

export default FlowsWorkspace;
