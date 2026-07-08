// FormLogic Flows editor — the editor surface (palette + canvas + properties + toolbar).
//
// Owns the graph's local React Flow state, coarse undo/redo (structural edits, not drags),
// debounced autosave + explicit Save with a dirty indicator, and serialization to/from the
// stored WorkflowGraph. Rendered keyed by flow id so switching flows remounts with fresh state.
// Node capabilities are kept in sync on save (a storage_set/formlogic node auto-declares its
// required capability) so an authored flow can actually execute.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlowProvider,
  addEdge,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { Check, Loader2, PlayCircle, Plus, Redo2, Save, Undo2, History } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { usePersistentBoolean } from '../../../hooks/usePersistentBoolean';
import { Button } from '../../ui/Button';
import { FlowCanvas } from './FlowCanvas';
import { FlowFormsContext, FlowNodeSignalsContext } from './flowNodeContext';
import { NodePalette } from './NodePalette';
import { NodeProperties, type FlowFormOption } from './NodeProperties';
import { declaredInputNames } from './nodeSummary';
import { getNodeSpec, initialNodeData, EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from './nodeCatalog';
import { graphToReactFlow, reactFlowToGraph, type FlowRFEdge, type FlowRFNode } from './flowGraph';
import { cloneSelection, dagreLayout } from './canvasOps';
import { lintNodeIssues } from '../flowGraphLint';
import type { NodeStatusMap } from '../runStatus';
import type { FlowDefinition, WorkflowGraph } from '../../../types/flows';

/** Union of the flow's declared capabilities + every capability its nodes require. */
function computeCapabilities(graph: WorkflowGraph, existing: string[] | null): string[] {
  const caps = new Set(existing ?? []);
  for (const node of graph.nodes) {
    const cap = getNodeSpec(node.type)?.capability;
    if (cap) caps.add(cap);
  }
  return [...caps];
}

/** A unique node id within the current graph (`<type>-<n>`). */
function nextNodeId(type: string, nodes: FlowRFNode[]): string {
  const used = new Set(nodes.map((n) => n.id));
  let i = 1;
  let id = `${type}-${i}`;
  while (used.has(id)) id = `${type}-${++i}`;
  return id;
}

interface FlowEditorProps {
  flow: FlowDefinition;
  /** Persist the graph; resolves true on success. Called by autosave + explicit Save. */
  onSave: (patch: { flowJson: WorkflowGraph; nodeCapabilities: string[] }) => Promise<boolean>;
  onOpenTestRun: () => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
  /** The author's forms (form picker + field helpers in the properties panel). */
  forms?: FlowFormOption[];
  /** App/connector context — drives the context-aware palette + connector pickers (docs §4). */
  context?: FlowEditorContext;
  /** Live per-node run status from the current Test Run's onNodeStatus (drives the canvas pills). */
  nodeStatus?: NodeStatusMap;
}

function FlowEditorInner({ flow, onSave, onOpenTestRun, onToggleHistory, historyOpen, forms = [], context = EMPTY_FLOW_EDITOR_CONTEXT, nodeStatus }: FlowEditorProps) {
  // Seed React Flow state once (the parent renders this keyed by flow.id, so a flow switch
  // remounts with a fresh initial graph). A lazy useState initializer runs exactly on mount.
  const [initialGraph] = useState(() => graphToReactFlow(flow.flowJson ?? { nodes: [], edges: [] }));
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowRFNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<FlowRFEdge>(initialGraph.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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

  // --- coarse undo/redo (structural edits) --------------------------------
  // The stacks are refs (mutated inside callbacks, never read during render); canUndo/canRedo
  // are mirrored into state so the toolbar buttons enable/disable without a render-time ref read.
  const pastRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
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
  const pushHistory = useCallback(() => {
    pastRef.current.push(serialized);
    if (pastRef.current.length > 50) pastRef.current.shift();
    futureRef.current = [];
    syncHistFlags();
  }, [serialized, syncHistFlags]);
  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    if (prev === undefined) return;
    futureRef.current.push(serialized);
    applyGraph(prev);
    syncHistFlags();
  }, [serialized, applyGraph, syncHistFlags]);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (next === undefined) return;
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
    // Cascade so successive clicks don't stack exactly. Flow-space centre-ish default.
    const k = (nodes.length % 8) * 32;
    addNodeAt(type, { x: 260 + k, y: 160 + k });
  }, [addNodeAt, nodes.length]);

  const patchSelected = useCallback((patch: Record<string, unknown>) => {
    if (!selectedId) return;
    pushHistory();
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
    const ok = await onSave({ flowJson: graph, nodeCapabilities: computeCapabilities(graph, flow.nodeCapabilities) });
    setSaving(false);
    if (ok) setSavedGraph(snapshot);
    return ok;
  }, [saving, serialized, onSave, flow.nodeCapabilities]);

  // Debounced autosave.
  useEffect(() => {
    if (!dirty || saving) return;
    const t = setTimeout(() => { void save(); }, 1400);
    return () => clearTimeout(t);
  }, [dirty, saving, serialized, save]);

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
    <FlowNodeSignalsContext.Provider value={nodeSignals}>
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-gray-200/80 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{flow.name}</p>
          <p className="truncate font-mono text-[11px] text-gray-400 dark:text-slate-500">
            {flow.appId ? 'app flow' : 'workspace flow'} · {flow.slug} · {nodes.length} node{nodes.length === 1 ? '' : 's'}
          </p>
        </div>

        <SaveStatus dirty={dirty} saving={saving} />

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            variant={historyOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={onToggleHistory}
            leftIcon={<History className="h-4 w-4" />}
            aria-pressed={historyOpen}
          >
            <span className="hidden lg:inline">History</span>
          </Button>
          <Button variant="outline" size="sm" onClick={onOpenTestRun} leftIcon={<PlayCircle className="h-4 w-4" />}>
            <span className="hidden sm:inline">Test run</span>
          </Button>
          <Button size="sm" onClick={() => void save()} isLoading={saving} disabled={!dirty && !saving} leftIcon={<Save className="h-4 w-4" />}>
            Save
          </Button>
        </div>
      </div>

      {/* Body: palette | canvas | properties. Palette + properties are lg+ only so the editor
          never overflows horizontally on smaller viewports (the canvas stays usable at any size). */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden lg:flex">
          <NodePalette
            onAddNode={addNodeCenter}
            context={context}
            collapsed={paletteCollapsed}
            onToggleCollapsed={() => setPaletteCollapsed((c) => !c)}
          />
        </div>
        <div className="relative min-w-0 flex-1">
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <div className="pointer-events-none rounded-xl border border-dashed border-gray-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/60 px-5 py-4 text-center">
                <Plus className="mx-auto mb-1 h-5 w-5 text-gray-400" />
                <p className="text-sm font-medium text-gray-600 dark:text-slate-300">Drag a node from the palette</p>
                <p className="text-xs text-gray-400 dark:text-slate-500">or click one to drop it on the canvas</p>
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
        {selectedNode && (
          <div className="hidden lg:flex">
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
    </div>
    </FlowNodeSignalsContext.Provider>
    </FlowFormsContext.Provider>
  );
}

function SaveStatus({ dirty, saving }: { dirty: boolean; saving: boolean }) {
  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
      </span>
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
