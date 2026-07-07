// FormLogic Flows — first-class workspace (/flows).
//
// Left: the flow library (workspace flows + app-scoped flows grouped by app; search, create,
// duplicate, rename, enable, delete). Centre: the real graph editor (FlowEditor — React Flow
// canvas, node palette, properties, autosave). Right (lg+): run history for the selected flow +
// a Test Run drawer that executes the flow through the browser executor. Deep-linked by
// ?flow=<id> from the app-level Flows panel.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronLeft, MoreVertical, Copy, Pencil, Plus, Search, Trash2, Workflow,
} from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Switch } from '../../components/ui/Switch';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { demoApplyFlowOverlay, demoCreateFlow, demoUpdateFlow, demoDeleteFlow } from '../../lib/demoLocal';
import { toast } from '../../stores/toastStore';
import { FlowEditor } from '../../components/flows/editor/FlowEditor';
import { deriveFlowConnectors } from '../../components/flows/flowConnectors';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from '../../components/flows/editor/nodeCatalog';
import type { FlowFormOption } from '../../components/flows/editor/NodeProperties';
import { FlowRunHistory } from '../../components/flows/FlowRunHistory';
import { TestRunDrawer } from '../../components/flows/TestRunDrawer';
import { reduceNodeStatus, type NodeStatusMap } from '../../components/flows/runStatus';
import { NewFlowDialog } from '../../components/flows/NewFlowDialog';
import type { FlowStarterTemplate } from '../../components/flows/starterTemplates';
import type { AppListItem } from '../../types/app';
import type { FlowDefinition, WorkflowGraph } from '../../types/flows';

/** A library group: the workspace (app null) or a specific app, plus its flows. */
interface FlowGroup {
  app: AppListItem | null;
  flows: FlowDefinition[];
}

export function FlowsWorkspace() {
  const [, setSearchParams] = useSearchParams();
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rightPanel, setRightPanel] = useState<'history' | 'test' | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<FlowDefinition | null>(null);
  // Live per-node run status from the Test Run drawer's onNodeStatus — lights up the canvas pills.
  // Owned here (not in the drawer) so the editor + drawer, which are siblings, share one source.
  const [nodeStatus, setNodeStatus] = useState<NodeStatusMap>({});
  // The author's forms, fetched once — powers the List/Submit/Update-response form pickers.
  const [forms, setForms] = useState<FlowFormOption[]>([]);

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

  // Initial load (+ apply any ?flow=<id> deep-link once the flows are known). All setState runs
  // after awaits — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const demo = api.isDemoMode();
      const [wsRes, appsRes, formsRes] = await Promise.all([
        api.listWorkspaceFlows(),
        api.getApps(),
        api.getForms({ limit: 500 }),
      ]);
      const appList = appsRes.data?.apps ?? [];
      const appFlowLists = await Promise.all(appList.map((a) => api.listFlows(a.id)));
      if (cancelled) return;
      // In the shared demo, merge each scope's server-seeded flows with the per-browser overlay
      // (creates/edits/deletes kept in IndexedDB) so exploring flows persists locally, not to the server.
      const workspaceFlows = demo
        ? await demoApplyFlowOverlay(null, wsRes.data?.flows ?? [])
        : wsRes.data?.flows ?? [];
      const appGroups: FlowGroup[] = (
        await Promise.all(
          appList.map(async (a, i) => ({
            app: a,
            flows: demo
              ? await demoApplyFlowOverlay(a.id, appFlowLists[i].data?.flows ?? [])
              : appFlowLists[i].data?.flows ?? [],
          })),
        )
      ).filter((g) => g.flows.length > 0);
      const nextGroups: FlowGroup[] = [{ app: null, flows: workspaceFlows }, ...appGroups];
      setGroups(nextGroups);
      setForms(
        (formsRes.data?.forms ?? []).map((f) => ({
          id: f.id,
          title: f.title,
          fields: (f.fields ?? [])
            .filter((x) => x && typeof x.id === 'string')
            .map((x) => ({ id: x.id, label: x.label || x.id })),
        }))
      );
      setLoading(false);
      const target = new URLSearchParams(window.location.search).get('flow');
      if (target && nextGroups.some((g) => g.flows.some((f) => f.id === target))) setSelectedId(target);
    })();
    return () => { cancelled = true; };
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

  const createFlow = async ({ name, slug, description, template }: { name: string; slug: string; description: string; template: FlowStarterTemplate }) => {
    setCreating(true);
    // Dedupe the slug (and mirror any suffix onto an auto/duplicate name) so quick repeated
    // creates — e.g. several "Untitled flow"s — never collide on the workspace slug uniqueness.
    const takenSlugs = new Set(groups.flatMap((g) => g.flows.map((f) => f.slug)));
    let uniqueSlug = slug;
    let n = 1;
    while (takenSlugs.has(uniqueSlug)) {
      n += 1;
      uniqueSlug = `${slug}-${n}`.slice(0, 60);
    }
    const uniqueName = n > 1 && !name.trim().match(/\d$/) ? `${name} ${n}` : name;
    const body = { name: uniqueName, slug: uniqueSlug, description, flowJson: template.flowJson, enabled: true, nodeCapabilities: template.nodeCapabilities };
    const flow = api.isDemoMode() ? await demoCreateFlow({ ...body, appId: null }) : (await api.createWorkspaceFlow(body)).data?.flow;
    setCreating(false);
    if (!flow) {
      toast.error('Failed to create flow');
      return;
    }
    setGroups((gs) => gs.map((g) => (g.app === null ? { ...g, flows: [flow, ...g.flows] } : g)));
    setShowNew(false);
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
    <div className="flex h-[calc(100dvh-4rem)] flex-col overflow-hidden md:h-screen">
      <Header
        title="Flows"
        actions={
          <Button size="sm" onClick={() => setShowNew(true)} leftIcon={<Plus className="h-4 w-4" />}>
            <span className="hidden sm:inline">New flow</span>
            <span className="sm:hidden">New</span>
          </Button>
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
          onNew={() => setShowNew(true)}
          className={cn('w-full md:w-72', selectedFlow ? 'hidden md:flex' : 'flex')}
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
                  onToggleHistory={() => setRightPanel((p) => (p === 'history' ? null : 'history'))}
                  historyOpen={rightPanel === 'history'}
                  forms={forms}
                  context={editorContext}
                  nodeStatus={nodeStatus}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <EmptyState
                icon={Workflow}
                title={loading ? 'Loading flows…' : 'Select a flow'}
                description={loading ? '' : 'Pick a flow from the library to open it in the editor, or create a new one.'}
                action={!loading ? (
                  <Button size="sm" onClick={() => setShowNew(true)} leftIcon={<Plus className="h-4 w-4" />}>New flow</Button>
                ) : undefined}
              />
            </div>
          )}
        </div>

        {/* Right panel: history / test run (lg+) */}
        {selectedFlow && rightPanel === 'history' && (
          <div className="hidden w-96 flex-none border-l border-gray-200/80 dark:border-slate-700/60 bg-white dark:bg-slate-900 lg:flex">
            <FlowRunHistory flowId={selectedFlow.id} refreshKey={historyKey} />
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

      <NewFlowDialog isOpen={showNew} onClose={() => setShowNew(false)} onCreate={createFlow} creating={creating} />
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

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function FlowLibrary({
  groups, loading, query, onQuery, selectedId, onSelect, onDuplicate, onRename, onToggleEnabled, onDelete, onNew, className,
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
  className?: string;
}) {
  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, flows: g.flows.filter((f) => q === '' || f.name.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)) }))
    .filter((g) => g.flows.length > 0);
  const total = groups.reduce((n, g) => n + g.flows.length, 0);

  return (
    <aside className={cn('min-h-0 flex-none flex-col border-r border-gray-200/80 dark:border-slate-700/60 bg-gray-50/50 dark:bg-slate-900/30', className)}>
      <div className="border-b border-gray-200/80 dark:border-slate-700/60 p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search flows"
            aria-label="Search flows"
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 space-y-4">
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
              <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
                {g.app ? g.app.name : 'Workspace'}
              </p>
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
            <p className={cn('truncate text-sm font-medium', selected ? 'text-primary-700 dark:text-primary-300' : 'text-gray-800 dark:text-slate-200')}>{flow.name}</p>
            <p className="truncate font-mono text-[10px] text-gray-400 dark:text-slate-500">{flow.slug} · v{flow.version}{flow.enabled ? '' : ' · off'}</p>
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
