// FormLogic Flows editor — the editor surface (palette + canvas + properties + toolbar).
//
// Owns the graph's local React Flow state, coarse undo/redo (structural edits, not drags),
// debounced autosave + explicit Save with a dirty indicator, and serialization to/from the
// stored WorkflowGraph. Rendered keyed by flow id so switching flows remounts with fresh state.
// Node capabilities are kept in sync on save (a storage_set/formlogic node auto-declares its
// required capability) so an authored flow can actually execute.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ReactFlowProvider,
  addEdge,
  reconnectEdge,
  useReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { Check, Loader2, PlayCircle, Plus, Redo2, RefreshCw, Save, Undo2, History, X, Zap } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { usePersistentBoolean } from '../../../hooks/usePersistentBoolean';
import { Button } from '../../ui/Button';
import { FlowCanvas } from './FlowCanvas';
import { EMPTY_DESKTOP_PRESENCE, FlowDesktopPresenceContext, FlowFormsContext, FlowNodeSignalsContext, FlowTriggerBindingsContext } from './flowNodeContext';
import { NodePalette } from './NodePalette';
import { NodeProperties, type FlowFormOption } from './NodeProperties';
import { declaredInputNames } from './nodeSummary';
import { getNodeSpec, initialNodeData, EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from './nodeCatalog';
import { graphToReactFlow, reactFlowToGraph, type FlowRFEdge, type FlowRFNode } from './flowGraph';
import {
  computeCapabilitiesFromGraph,
  patchHistoryKey,
  resolveEditorLayout,
  sameResolvedEditorLayout,
  shouldPushPatchHistory,
  type PatchHistoryBurst,
} from './flowEditorLogic';
import { cloneSelection, dagreLayout } from './canvasOps';
import { lintNodeIssues } from '../flowGraphLint';
import type { NodeStatusMap } from '../runStatus';
import type { FlowBinding, FlowDefinition, WorkflowGraph } from '../../../types/flows';
import type { FlowsDesktopPresence } from '../useFlowsDesktopPresence';

/** A unique node id within the current graph (`<type>-<n>`). */
function nextNodeId(type: string, nodes: FlowRFNode[]): string {
  const used = new Set(nodes.map((n) => n.id));
  let i = 1;
  let id = `${type}-${i}`;
  while (used.has(id)) id = `${type}-${++i}`;
  return id;
}

const BELOW_MD_QUERY = '(max-width: 767.98px)';
const LEGACY_INLINE_QUERY = '(min-width: 1024px)';

function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
  return window.matchMedia(query).matches;
}

interface FlowEditorProps {
  flow: FlowDefinition;
  /** Persist the graph; resolves true on success. Called by autosave + explicit Save. */
  onSave: (patch: { flowJson: WorkflowGraph; nodeCapabilities: string[] }) => Promise<boolean>;
  onOpenTestRun: () => void;
  onToggleHistory: () => void;
  onToggleTriggers?: () => void;
  historyOpen: boolean;
  triggersOpen?: boolean;
  triggerCount?: number;
  /** The author's forms (form picker + field helpers in the properties panel). */
  forms?: FlowFormOption[];
  /** App/connector context — drives the context-aware palette + connector pickers (docs §4). */
  context?: FlowEditorContext;
  /** Live per-node run status from the current Test Run's onNodeStatus (drives the canvas pills). */
  nodeStatus?: NodeStatusMap;
  /** FormLogic Desktop presence for editor-only affordances. */
  desktopPresence?: FlowsDesktopPresence;
  /** Bindings targeting this flow, rendered as Trigger node chips (view state only). */
  bindings?: FlowBinding[];
}

function FlowEditorInner({ flow, onSave, onOpenTestRun, onToggleHistory, onToggleTriggers, historyOpen, triggersOpen = false, triggerCount = 0, forms = [], context = EMPTY_FLOW_EDITOR_CONTEXT, nodeStatus, desktopPresence = EMPTY_DESKTOP_PRESENCE, bindings = [] }: FlowEditorProps) {
  // Seed React Flow state once (the parent renders this keyed by flow.id, so a flow switch
  // remounts with a fresh initial graph). A lazy useState initializer runs exactly on mount.
  const [initialGraph] = useState(() => graphToReactFlow(flow.flowJson ?? { nodes: [], edges: [] }));
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowRFNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<FlowRFEdge>(initialGraph.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failedSaveGraph, setFailedSaveGraph] = useState<string | null>(null);
  const reactFlow = useReactFlow<FlowRFNode, FlowRFEdge>();
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const editorWidthRef = useRef<number | null>(null);
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  // Opt-in space reclaim: collapse the palette to a narrow rail once you don't need it (e.g. a node
  // is selected and Test Run/History is open). Defaults open — today's layout, unchanged.
  const [paletteCollapsed, setPaletteCollapsed] = usePersistentBoolean('flows.paletteCollapsed', false);

  const currentGraph = useMemo(() => reactFlowToGraph(nodes, edges), [nodes, edges]);
  const serialized = useMemo(() => JSON.stringify(currentGraph), [currentGraph]);
  // Per-node authoring lint (missing required prop / dangling edge / bad ref) for the node badges.
  const nodeIssues = useMemo(() => lintNodeIssues(currentGraph), [currentGraph]);
  // Run status + lint issues handed to the canvas node cards via context (never into node data,
  // which would dirty the serialized graph and trip autosave).
  const nodeSignals = useMemo(() => ({ status: nodeStatus ?? {}, issues: nodeIssues }), [nodeStatus, nodeIssues]);
  // Last-saved snapshot as state (not a ref) so `dirty` derives cleanly at render time.
  const [savedGraph, setSavedGraph] = useState<string>(() => JSON.stringify(flow.flowJson ?? { nodes: [], edges: [] }));
  const dirty = serialized !== savedGraph;
  const saveFailed = dirty && failedSaveGraph === serialized;

  // --- coarse undo/redo (structural edits) --------------------------------
  // The stacks are refs (mutated inside callbacks, never read during render); canUndo/canRedo
  // are mirrored into state so the toolbar buttons enable/disable without a render-time ref read.
  const pastRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const patchBurstRef = useRef<PatchHistoryBurst | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const syncHistFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);
  const applyGraph = useCallback((json: string) => {
    const { nodes: n, edges: e } = graphToReactFlow(JSON.parse(json) as WorkflowGraph);
    setNodes(n);
    setEdges(e);
  }, [setNodes, setEdges]);
  const pushHistory = useCallback((preservePatchBurst = false) => {
    if (!preservePatchBurst) patchBurstRef.current = null;
    pastRef.current.push(serialized);
    if (pastRef.current.length > 50) pastRef.current.shift();
    futureRef.current = [];
    syncHistFlags();
  }, [serialized, syncHistFlags]);
  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (prev === undefined) return;
    patchBurstRef.current = null;
    futureRef.current.push(serialized);
    applyGraph(prev);
    syncHistFlags();
  }, [serialized, applyGraph, syncHistFlags]);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (next === undefined) return;
    patchBurstRef.current = null;
    pastRef.current.push(serialized);
    applyGraph(next);
    syncHistFlags();
  }, [serialized, applyGraph, syncHistFlags]);

  // Snapshot before structural (add/remove/connect/patch) edits — NOT position drags.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    if (changes.some((c) => c.type === 'remove')) pushHistory();
    onNodesChangeBase(changes);
    if (changes.some((c) => c.type === 'remove')) setSelectedId(null);
  }, [onNodesChangeBase, pushHistory]);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some((c) => c.type === 'remove')) pushHistory();
    onEdgesChangeBase(changes);
  }, [onEdgesChangeBase, pushHistory]);

  const onConnect = useCallback((connection: Connection) => {
    pushHistory();
    setEdges((eds) => addEdge(connection, eds));
  }, [setEdges, pushHistory]);

  const addNodeAt = useCallback((type: string, position: { x: number; y: number }) => {
    const spec = getNodeSpec(type);
    if (!spec || !spec.executable) return; // display-only nodes are never insertable
    pushHistory();
    setNodes((nds) => {
      const id = nextNodeId(type, nds);
      const node: FlowRFNode = { id, type, position, data: initialNodeData(spec) };
      setSelectedId(id);
      return [...nds, node];
    });
  }, [setNodes, pushHistory]);

  const addNodeCenter = useCallback((type: string) => {
    const rect = canvasHostRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    addNodeAt(type, reactFlow.screenToFlowPosition({ x, y }));
  }, [addNodeAt, reactFlow]);

  const patchSelected = useCallback((patch: Record<string, unknown>) => {
    if (!selectedId) return;
    const key = patchHistoryKey(selectedId, patch);
    const now = Date.now();
    if (shouldPushPatchHistory(patchBurstRef.current, key, now)) pushHistory(true);
    patchBurstRef.current = key ? { key, atMs: now } : null;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== selectedId) return n;
        const data = { ...(n.data as Record<string, unknown>) };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete data[k];
          else data[k] = v;
        }
        return { ...n, data };
      }),
    );
  }, [selectedId, setNodes, pushHistory]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    pushHistory();
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges, pushHistory]);

  // --- multi-select canvas ops (context menu + Ctrl+C/V/A) ----------------
  // The current selection: React Flow's multi-selection (node.selected), falling back to the
  // single properties-panel selection so a right-clicked node still Duplicates / Deletes.
  const clipboardRef = useRef<{ nodes: FlowRFNode[]; edges: FlowRFEdge[] } | null>(null);
  const selectionOf = useCallback((): { nodes: FlowRFNode[]; edges: FlowRFEdge[] } => {
    let selNodes = nodes.filter((n) => n.selected);
    if (selNodes.length === 0 && selectedId) selNodes = nodes.filter((n) => n.id === selectedId);
    const ids = new Set(selNodes.map((n) => n.id));
    const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: selNodes, edges: internal };
  }, [nodes, edges, selectedId]);

  const insertClones = useCallback((sel: { nodes: FlowRFNode[]; edges: FlowRFEdge[] }) => {
    if (sel.nodes.length === 0) return null;
    pushHistory();
    const existing = new Set(nodes.map((n) => n.id));
    const cloned = cloneSelection(sel.nodes, sel.edges, existing, { x: 40, y: 40 });
    setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...cloned.nodes]);
    setEdges((eds) => [...eds.map((e) => ({ ...e, selected: false })), ...cloned.edges]);
    if (cloned.nodes.length === 1) setSelectedId(cloned.nodes[0].id);
    return cloned;
  }, [nodes, setNodes, setEdges, pushHistory]);

  const copySelection = useCallback(() => {
    const sel = selectionOf();
    if (sel.nodes.length > 0) clipboardRef.current = sel;
  }, [selectionOf]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip) return;
    const cloned = insertClones(clip);
    // Cascade: the next paste offsets from the just-pasted nodes.
    if (cloned) clipboardRef.current = cloned;
  }, [insertClones]);

  const duplicateSelection = useCallback(() => {
    insertClones(selectionOf());
  }, [insertClones, selectionOf]);

  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
    setEdges((eds) => eds.map((e) => ({ ...e, selected: true })));
  }, [setNodes, setEdges]);

  const deleteSelection = useCallback(() => {
    const selNodes = nodes.filter((n) => n.selected);
    const nodeIds = new Set((selNodes.length > 0 ? selNodes : selectedId ? nodes.filter((n) => n.id === selectedId) : []).map((n) => n.id));
    const hasSelEdge = edges.some((e) => e.selected);
    if (nodeIds.size === 0 && !hasSelEdge) return;
    pushHistory();
    setNodes((nds) => nds.filter((n) => !nodeIds.has(n.id)));
    setEdges((eds) => eds.filter((e) => !e.selected && !nodeIds.has(e.source) && !nodeIds.has(e.target)));
    if (selectedId && nodeIds.has(selectedId)) setSelectedId(null);
  }, [nodes, edges, selectedId, setNodes, setEdges, pushHistory]);

  const autoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    pushHistory();
    const positions = dagreLayout(nodes, edges, { direction: 'LR' });
    setNodes((nds) => nds.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)));
  }, [nodes, edges, setNodes, pushHistory]);

  const onReconnect = useCallback((oldEdge: FlowRFEdge, connection: Connection) => {
    pushHistory();
    setEdges((eds) => reconnectEdge(oldEdge, connection, eds));
  }, [setEdges, pushHistory]);

  // Quick-connect: an edge dragged into empty canvas creates a node at the drop point + wires it.
  const quickConnect = useCallback(
    (type: string, position: { x: number; y: number }, source: { nodeId: string; handleId: string | null }) => {
      const spec = getNodeSpec(type);
      if (!spec || !spec.executable) return;
      const id = nextNodeId(type, nodes);
      pushHistory();
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), { id, type, position, data: initialNodeData(spec), selected: true }]);
      setEdges((eds) => addEdge({ source: source.nodeId, sourceHandle: source.handleId ?? null, target: id, targetHandle: null }, eds));
      setSelectedId(id);
    },
    [nodes, setNodes, setEdges, pushHistory],
  );

  const hasSelection = useMemo(
    () => nodes.some((n) => n.selected) || edges.some((e) => e.selected) || !!selectedId,
    [nodes, edges, selectedId],
  );

  const save = useCallback(async () => {
    if (saving) return;
    const snapshot = serialized;
    const graph = JSON.parse(snapshot) as WorkflowGraph;
    setSaving(true);
    const ok = await onSave({ flowJson: graph, nodeCapabilities: computeCapabilitiesFromGraph(graph) });
    setSaving(false);
    if (ok) {
      setSavedGraph(snapshot);
      setFailedSaveGraph(null);
    } else {
      setFailedSaveGraph(snapshot);
    }
    return ok;
  }, [saving, serialized, onSave]);

  // Debounced autosave.
  useEffect(() => {
    if (!dirty || saving || saveFailed) return;
    const t = setTimeout(() => { void save(); }, 1400);
    return () => clearTimeout(t);
  }, [dirty, saving, saveFailed, serialized, save]);

  useEffect(() => {
    if (failedSaveGraph !== null && failedSaveGraph !== serialized) setFailedSaveGraph(null);
  }, [failedSaveGraph, serialized]);

  // Keyboard: undo / redo + copy / paste / duplicate / select-all (ignore while typing in a field,
  // which also lets Monaco/textarea handle their own Ctrl+C/V). Delete is React Flow's native,
  // already input-guarded, deleteKeyCode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && key === 'a') { e.preventDefault(); selectAll(); }
      else if (mod && key === 'c') { copySelection(); }
      else if (mod && key === 'v') { pasteClipboard(); }
      else if (mod && key === 'd') { e.preventDefault(); duplicateSelection(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectAll, copySelection, pasteClipboard, duplicateSelection]);

  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;
  const selectedNodePresent = selectedNode !== null;
  const [belowMd, setBelowMd] = useState(() => mediaMatches(BELOW_MD_QUERY, false));
  const [editorLayout, setEditorLayout] = useState(() => resolveEditorLayout({
    editorWidth: null,
    selectedNode: false,
    paletteCollapsedPreference: paletteCollapsed,
    belowMd: mediaMatches(BELOW_MD_QUERY, false),
    legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
  }));
  const editorLayoutRef = useRef(editorLayout);

  const applyEditorLayout = useCallback((width: number | null = editorWidthRef.current) => {
    const next = resolveEditorLayout({
      editorWidth: width,
      selectedNode: selectedNodePresent,
      paletteCollapsedPreference: paletteCollapsed,
      belowMd,
      legacyInline: mediaMatches(LEGACY_INLINE_QUERY, true),
    });
    if (sameResolvedEditorLayout(editorLayoutRef.current, next)) return;
    editorLayoutRef.current = next;
    setEditorLayout(next);
  }, [belowMd, paletteCollapsed, selectedNodePresent]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(BELOW_MD_QUERY);
    const onChange = () => setBelowMd((current) => (current === query.matches ? current : query.matches));
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyEditorLayout();
  }, [applyEditorLayout]);

  useEffect(() => {
    const el = editorRootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width !== 'number') return;
      editorWidthRef.current = width;
      applyEditorLayout(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [applyEditorLayout]);

  useEffect(() => {
    if (editorLayout.palette === 'inline' && mobilePaletteOpen) setMobilePaletteOpen(false);
  }, [editorLayout.palette, mobilePaletteOpen]);

  // Let node cards name a picked form by its title (not its UUID).
  const formsCtx = useMemo(
    () => ({ titleById: (id: string) => forms.find((f) => f.id === id)?.title }),
    [forms],
  );

  // Selectors the SELECTED node can reference: the Trigger's declared inputs ($inputs.*), the raw
  // $event, and any other node's output ($nodes.<id>). Surfaced as copyable chips in the panel.
  const insertHints = useMemo(() => {
    if (!selectedId) return [];
    const hints: string[] = [];
    const trigger = nodes.find((n) => n.type === 'input');
    if (trigger) for (const name of declaredInputNames((trigger.data ?? {}) as Record<string, unknown>)) hints.push(`$inputs.${name}`);
    hints.push('$event');
    for (const n of nodes) {
      if (n.id === selectedId || n.type === 'input' || n.type === 'output') continue;
      hints.push(`$nodes.${n.id}`);
    }
    return hints;
  }, [nodes, selectedId]);

  return (
    <FlowFormsContext.Provider value={formsCtx}>
    <FlowDesktopPresenceContext.Provider value={desktopPresence}>
    <FlowTriggerBindingsContext.Provider value={bindings}>
    <FlowNodeSignalsContext.Provider value={nodeSignals}>
    <div ref={editorRootRef} className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 overflow-hidden border-b border-gray-200/80 bg-white/70 px-3 py-2 dark:border-slate-700/60 dark:bg-slate-900/50">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{flow.name}</p>
            <p className="hidden truncate font-mono text-[11px] text-gray-400 dark:text-slate-500 sm:block">
              {flow.appId ? 'app flow' : 'workspace flow'} · {flow.slug} · {nodes.length} node{nodes.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex flex-none">
            <SaveStatus dirty={dirty} saving={saving} failed={saveFailed} onRetry={() => void save()} compact={editorLayout.toolbar !== 'full'} />
          </div>
        </div>

        {editorLayout.toolbar === 'full' && <ToolbarDivider />}
        <div className="flex flex-none items-center gap-1 whitespace-nowrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobilePaletteOpen(true)}
            leftIcon={<Plus className="h-4 w-4" />}
            className={cn('whitespace-nowrap', editorLayout.palette === 'inline' && 'hidden')}
            aria-label="Add node"
          >
            {editorLayout.toolbar === 'full' && <span>Add node</span>}
          </Button>
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>

        {editorLayout.toolbar === 'full' && <ToolbarDivider />}
        <div className="flex flex-none items-center gap-1 whitespace-nowrap">
          <Button
            variant={triggersOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onToggleTriggers}
            disabled={!onToggleTriggers}
            leftIcon={<Zap className="h-4 w-4" />}
            aria-pressed={triggersOpen}
            aria-label="Triggers"
          >
            {editorLayout.toolbar === 'full' && <span>Triggers</span>}
            <span className="ml-1 rounded-full bg-primary-100 px-1.5 py-0.5 text-[10px] font-semibold text-primary-700 dark:bg-primary-500/20 dark:text-primary-200">
              {triggerCount}
            </span>
          </Button>
          <Button
            variant={historyOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onToggleHistory}
            leftIcon={<History className="h-4 w-4" />}
            aria-pressed={historyOpen}
            aria-label="History"
          >
            {editorLayout.toolbar === 'full' && <span>History</span>}
          </Button>
          <Button variant="outline" size="sm" onClick={onOpenTestRun} leftIcon={<PlayCircle className="h-4 w-4" />} className="whitespace-nowrap" aria-label="Test run">
            {editorLayout.toolbar === 'full' && <span>Test run</span>}
          </Button>
        </div>

        {editorLayout.toolbar === 'full' && <ToolbarDivider />}
        <div className="flex flex-none items-center gap-1 whitespace-nowrap">
          <Button size="sm" onClick={() => void save()} isLoading={saving} disabled={!dirty && !saving} leftIcon={<Save className="h-4 w-4" />} aria-label="Save flow">
            {editorLayout.toolbar !== 'tiny' && <span>Save</span>}
          </Button>
        </div>
      </div>

      {/* Body: palette | canvas | properties. Measured-width tiers keep the canvas usable even
          in a half-snapped desktop window; below-md retains the existing sheet/drawer behavior. */}
      <div className="flex min-h-0 flex-1">
        {editorLayout.palette !== 'hidden' && (
          <NodePalette
            onAddNode={addNodeCenter}
            context={context}
            collapsed={editorLayout.palette === 'rail'}
            onToggleCollapsed={() => setPaletteCollapsed((c) => !c)}
            className="hidden md:flex motion-safe:transition-[width] motion-safe:duration-200"
          />
        )}
        <div ref={canvasHostRef} className="relative min-w-0 flex-1">
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div className="pointer-events-none rounded-xl border border-gray-200/80 bg-white/80 px-5 py-4 text-center shadow-sm dark:border-slate-700/60 dark:bg-slate-900/70">
                <div className="mb-3 flex items-center justify-center">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
                    <Zap className="h-4 w-4" />
                  </span>
                  <span className="relative h-0.5 w-12 bg-gradient-to-r from-primary-400 via-primary-500 to-primary-300 dark:from-primary-300 dark:via-primary-400 dark:to-primary-200">
                    <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-500 dark:bg-primary-300" />
                  </span>
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-300">
                    <Check className="h-4 w-4" />
                  </span>
                </div>
                <p className="text-sm font-semibold text-gray-700 dark:text-slate-200">Wire up your first step</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  {editorLayout.palette === 'inline' ? 'Drag a node from the palette' : 'Tap Add node'}
                </p>
              </div>
            </div>
          )}
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onDropNode={addNodeAt}
            onSelectNode={setSelectedId}
            onDuplicateSelection={duplicateSelection}
            onDeleteSelection={deleteSelection}
            onSelectAll={selectAll}
            onAutoLayout={autoLayout}
            onQuickConnect={quickConnect}
            hasSelection={hasSelection}
            context={context}
          />
        </div>
        {selectedNode && editorLayout.properties === 'inline' && (
          <div className="hidden md:flex motion-safe:transition-[width] motion-safe:duration-200">
            <NodeProperties
              nodeId={selectedNode.id}
              type={String(selectedNode.type)}
              data={(selectedNode.data ?? {}) as Record<string, unknown>}
              onPatch={patchSelected}
              onDelete={deleteSelected}
              forms={forms}
              context={context}
              insertHints={insertHints}
            />
          </div>
        )}
      </div>
      <FlowBottomSheet title="Add node" open={mobilePaletteOpen} onClose={() => setMobilePaletteOpen(false)}>
        <NodePalette
          onAddNode={(type) => {
            addNodeCenter(type);
            setMobilePaletteOpen(false);
          }}
          context={context}
          draggable={false}
          className="w-full bg-white dark:bg-slate-900"
        />
      </FlowBottomSheet>
      {selectedNode && editorLayout.properties === 'sheet' && (
        <FlowBottomSheet title={`${getNodeSpec(String(selectedNode.type))?.label ?? String(selectedNode.type)} settings`} open onClose={() => setSelectedId(null)}>
          <NodeProperties
            nodeId={selectedNode.id}
            type={String(selectedNode.type)}
            data={(selectedNode.data ?? {}) as Record<string, unknown>}
            onPatch={patchSelected}
            onDelete={deleteSelected}
            forms={forms}
            context={context}
            insertHints={insertHints}
            className="w-full border-l-0 bg-white dark:bg-slate-900"
          />
        </FlowBottomSheet>
      )}
    </div>
    </FlowNodeSignalsContext.Provider>
    </FlowTriggerBindingsContext.Provider>
    </FlowDesktopPresenceContext.Provider>
    </FlowFormsContext.Provider>
  );
}

function ToolbarDivider() {
  return <div className="hidden h-4 w-px flex-none bg-gray-200 dark:bg-slate-700 sm:block" aria-hidden="true" />;
}

function FlowBottomSheet({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div>
      <div className="fixed inset-0 z-[80] bg-gray-900/30 dark:bg-slate-950/60" onClick={onClose} aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-x-0 bottom-0 z-[90] flex max-h-[70dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-gray-200/80 px-3 py-2 dark:border-slate-700/60">
          <h4 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden [&>div>div:last-child]:pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
      </section>
    </div>
  );
}

function SaveStatus({
  dirty,
  saving,
  failed,
  onRetry,
  compact = false,
}: {
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  onRetry: () => void;
  compact?: boolean;
}) {
  if (compact) {
    if (saving) {
      return (
        <span role="status" aria-label="Saving" title="Saving" className="flex h-8 w-8 items-center justify-center text-gray-500 dark:text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      );
    }
    if (failed) {
      return (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Save failed – retry"
          title="Save failed – retry"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      );
    }
    const label = dirty ? 'Unsaved changes' : 'Saved';
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full',
          dirty ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {dirty ? <span className="h-2 w-2 rounded-full bg-amber-500" /> : <Check className="h-3.5 w-3.5" />}
      </span>
    );
  }

  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
      </span>
    );
  }
  if (failed) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15"
      >
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Save failed · Retry
      </button>
    );
  }
  return (
    <span className={cn('flex items-center gap-1.5 text-xs', dirty ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}>
      {dirty ? <span className="h-2 w-2 rounded-full bg-amber-500" /> : <Check className="h-3.5 w-3.5" />}
      {dirty ? 'Unsaved changes' : 'Saved'}
    </span>
  );
}

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
