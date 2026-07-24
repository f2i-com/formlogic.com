// FormLogic Flows editor — the React Flow canvas.
//
// Ported UX from f2i-web's F2IBuilder (Background + Controls + MiniMap, drag-from-palette drop,
// click-to-select) but self-contained and native to FormLogic, with f2i-web-grade canvas power:
// a custom arrowed + deletable edge, a left-drag selection box (Ctrl multi-select), edge
// reconnection, and a right-click context menu (duplicate / delete / auto-layout / fit / select
// all). All GRAPH state lives in the parent FlowEditor; this component is presentation + interaction
// wiring. Must be rendered inside a <ReactFlowProvider> (FlowEditor provides it).
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  SelectionMode,
  type Connection,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
  type OnConnectStart,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CopyPlus, LayoutGrid, Maximize, MousePointerClick, Search, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FlowNode } from './FlowNode';
import { FlowEdge } from './FlowEdge';
import { NODE_SPECS, EMPTY_FLOW_EDITOR_CONTEXT, isNodeAvailableInContext, type FlowEditorContext, type NodeSpec } from './nodeCatalog';
import { flowNodeRegistry } from '../registry/FlowNodeRegistry';
import { useInstalledNodeStore } from '../../../stores/installedNodeStore';
import type { FlowRFEdge, FlowRFNode } from './flowGraph';
import { PALETTE_DND_MIME } from './NodePalette';
import { FlowNodeSignalsContext } from './flowNodeContext';
import { deriveEdgeRunStates, type NodeRunStatus } from '../runStatus';

/** Minimap fill class for a node's run status (idle → '', so nodeColor's slate default shows). */
function minimapRunClass(status: NodeRunStatus | undefined): string {
  if (!status) return '';
  if (status.status === 'running') return 'fl-mm-running';
  if (status.status === 'error') return 'fl-mm-error';
  return 'fl-mm-done';
}

/** The source end of an in-progress quick-connect drag (the node/handle the edge started from). */
interface QuickConnectSource {
  nodeId: string;
  handleId: string | null;
}

// One custom component for every known node type. Foreign/unknown stored types are added
// per-graph inside the component (useUnknownAwareNodeTypes) so the registry's §4.5
// missing-definition placeholder card renders instead of React Flow's bare default node.
const NODE_TYPES: NodeTypes = Object.fromEntries(NODE_SPECS.map((s) => [s.type, FlowNode]));

/**
 * NODE_TYPES extended with FlowNode entries for any node types present in the graph but
 * absent from the catalog. Keyed on the SORTED distinct unknown-type list so the returned
 * object's identity is stable across drags/renders (React Flow warns on identity churn).
 */
function useUnknownAwareNodeTypes(nodes: FlowRFNode[]): NodeTypes {
  const unknownKey = useMemo(() => {
    const unknown = new Set<string>();
    for (const n of nodes) {
      const t = String(n.type ?? '');
      if (t !== '' && !(t in NODE_TYPES)) unknown.add(t);
    }
    return JSON.stringify(Array.from(unknown).sort());
  }, [nodes]);
  return useMemo(() => {
    if (unknownKey === '[]') return NODE_TYPES;
    return { ...NODE_TYPES, ...Object.fromEntries((JSON.parse(unknownKey) as string[]).map((t) => [t, FlowNode])) };
  }, [unknownKey]);
}
const EDGE_TYPES: EdgeTypes = { flow: FlowEdge };

const PRO_OPTIONS = { hideAttribution: true } as const;
const DEFAULT_MARKER = { type: MarkerType.ArrowClosed, width: 18, height: 18, color: '#94a3b8' } as const;
const DEFAULT_EDGE_OPTIONS = { type: 'flow', deletable: true, focusable: true, reconnectable: true, markerEnd: DEFAULT_MARKER } as const;
// Left-drag PANS — consistent with the diagrams canvas (owner direction: one muscle
// memory across both canvases). Middle/right-drag pan too (a right-click without a
// drag still opens the context menu); the selection BOX moved to Shift+drag.
const PAN_ON_DRAG: number[] = [0, 1, 2];
const SELECTION_KEY = 'Shift';
const MULTI_SELECT_KEYS = ['Meta', 'Control'];
const DELETE_KEYS = ['Backspace', 'Delete'];

interface FlowCanvasProps {
  nodes: FlowRFNode[];
  edges: FlowRFEdge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  /** Drag-reconnect an existing edge to a new source/target. */
  onReconnect: (oldEdge: FlowRFEdge, newConnection: Connection) => void;
  /** A palette node was dropped at a flow-space position. */
  onDropNode: (type: string, position: { x: number; y: number }) => void;
  onSelectNode: (nodeId: string | null) => void;
  /** Context-menu / shortcut ops (implemented against graph state in FlowEditor). */
  onDuplicateSelection: () => void;
  onDeleteSelection: () => void;
  onSelectAll: () => void;
  onAutoLayout: () => void;
  /** Create a node at `position` and wire the dragged edge from `source` to it (quick-connect). */
  onQuickConnect: (type: string, position: { x: number; y: number }, source: QuickConnectSource) => void;
  /** Whether anything is currently selected (enables the selection-scoped menu items). */
  hasSelection: boolean;
  /** Editor context — filters the quick-connect node list to what's available here (docs §4). */
  context?: FlowEditorContext;
}

export function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onReconnect,
  onDropNode,
  onSelectNode,
  onDuplicateSelection,
  onDeleteSelection,
  onSelectAll,
  onAutoLayout,
  onQuickConnect,
  hasSelection,
  context = EMPTY_FLOW_EDITOR_CONTEXT,
}: FlowCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ReactFlowInstance<FlowRFNode, FlowRFEdge> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; onNode: boolean } | null>(null);
  const connectingRef = useRef<QuickConnectSource | null>(null);
  const [quick, setQuick] = useState<{ x: number; y: number; flow: { x: number; y: number }; source: QuickConnectSource } | null>(null);

  // Live Wire: read the current Test Run's per-node status (provided by FlowEditor, never stored
  // on the graph) so the canvas can light up executed edges and the minimap without any new props.
  const signals = useContext(FlowNodeSignalsContext);

  const nodeTypes = useUnknownAwareNodeTypes(nodes);

  const nodeTypeById = useMemo(() => {
    const byId = new Map<string, string | undefined>();
    for (const n of nodes) byId.set(n.id, n.type);
    return (id: string) => byId.get(id);
  }, [nodes]);

  const edgeRunStates = useMemo(
    () => deriveEdgeRunStates(edges, nodeTypeById, signals.status),
    [edges, nodeTypeById, signals.status],
  );

  // Every edge renders as the custom arrowed/deletable 'flow' edge, with its run-beam state (if
  // any) injected as presentation-only `data.run` — without polluting stored state (docs §1b).
  const styledEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: e.type ?? 'flow',
        markerEnd: e.markerEnd ?? DEFAULT_MARKER,
        data: { ...(e.data ?? {}), run: edgeRunStates[e.id] },
      })),
    [edges, edgeRunStates],
  ) as FlowRFEdge[];

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(PALETTE_DND_MIME);
      if (!type) return;
      const position = instanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (position) onDropNode(type, position);
    },
    [onDropNode],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: FlowRFNode) => onSelectNode(node.id),
    [onSelectNode],
  );
  const handlePaneClick = useCallback(() => { onSelectNode(null); closeMenu(); setQuick(null); }, [onSelectNode, closeMenu]);

  // Quick-connect: remember the source handle; when the drag ends on empty canvas (not a handle),
  // open a searchable node picker at the drop point (official React Flow "add node on edge drop").
  const onConnectStart = useCallback<OnConnectStart>((_event, params) => {
    connectingRef.current = params.nodeId && params.handleType === 'source'
      ? { nodeId: params.nodeId, handleId: params.handleId ?? null }
      : null;
  }, []);
  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    const source = connectingRef.current;
    connectingRef.current = null;
    if (!source || connectionState.isValid) return; // a real connection was made — nothing to do
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    const flow = instanceRef.current?.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    if (!flow) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    const maxX = (rect ? rect.right : window.innerWidth) - 232;
    const maxY = (rect ? rect.bottom : window.innerHeight) - 288;
    setQuick({ x: Math.min(point.clientX, maxX), y: Math.min(point.clientY, maxY), flow, source });
  }, []);

  // Nodes offered by quick-connect: executable + available here, minus the Trigger (no target).
  // Listed through the REGISTRY (FLOW-203) so installed extensions join automatically once they
  // become executable; the executable filter keeps not-yet-runnable contributed nodes out.
  const installedVersion = useInstalledNodeStore((s) => s.version);
  const quickTargets = useMemo(
    () => flowNodeRegistry.listNodeSpecs(context).filter((s) => s.executable && s.type !== 'input' && isNodeAvailableInContext(s, context)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- installedVersion is the registry's change signal
    [context, installedVersion],
  );

  const fitView = useCallback(() => instanceRef.current?.fitView({ padding: 0.2, duration: 300 }), []);
  const runAutoLayout = useCallback(() => {
    onAutoLayout();
    // Let the new positions flush to the store, then frame the whole graph.
    window.setTimeout(fitView, 80);
  }, [onAutoLayout, fitView]);

  const openMenu = useCallback((clientX: number, clientY: number, onNode: boolean) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const maxX = (rect ? rect.right : window.innerWidth) - 184;
    const maxY = (rect ? rect.bottom : window.innerHeight) - 176;
    setMenu({ x: Math.min(clientX, maxX), y: Math.min(clientY, maxY), onNode });
  }, []);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: FlowRFNode) => {
      event.preventDefault();
      onSelectNode(node.id);
      openMenu(event.clientX, event.clientY, true);
    },
    [onSelectNode, openMenu],
  );
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      openMenu((event as MouseEvent).clientX, (event as MouseEvent).clientY, false);
    },
    [openMenu],
  );

  // Escape closes the context menu.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, closeMenu]);

  const miniMapNodeColor = useMemo(() => () => 'rgb(148 163 184)', []);
  // Run coloring on the minimap (docs §5) — the .fl-mm-* classes carry !important fills (index.css)
  // so they win over the inline `fill` react-flow sets from nodeColor above, on any node that has
  // reported a run status; idle nodes keep the slate default untouched.
  const miniMapNodeClassName = useCallback(
    (n: FlowRFNode) => minimapRunClass(signals.status[n.id]),
    [signals.status],
  );
  const selectionScoped = menu?.onNode || hasSelection;

  return (
    <div ref={wrapperRef} className="relative h-full w-full min-w-0" onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow<FlowRFNode, FlowRFEdge>
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        edgesReconnectable
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onInit={(instance) => {
          instanceRef.current = instance;
          instance.fitView({ padding: 0.2, duration: 0 });
        }}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        proOptions={PRO_OPTIONS}
        fitView
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={DELETE_KEYS}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        selectionKeyCode={SELECTION_KEY}
        selectionMode={SelectionMode.Partial}
        panOnDrag={PAN_ON_DRAG}
        className="bg-gray-50 dark:bg-slate-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!text-gray-300 dark:!text-slate-800" />
        <Controls className="!shadow-md" showInteractive={false} />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeClassName={miniMapNodeClassName}
          pannable
          zoomable
          className="hidden rounded-lg !border !border-gray-200 !bg-white dark:!border-slate-700 dark:!bg-slate-900 sm:block"
          maskColor="rgb(148 163 184 / 0.15)"
        />
      </ReactFlow>

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}
            aria-hidden="true"
          />
          <div
            role="menu"
            style={{ top: menu.y, left: menu.x }}
            className="fixed z-50 w-44 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lg"
          >
            {selectionScoped && (
              <>
                <MenuButton icon={CopyPlus} label="Duplicate" onClick={() => { onDuplicateSelection(); closeMenu(); }} />
                <MenuButton icon={Trash2} label="Delete" danger onClick={() => { onDeleteSelection(); closeMenu(); }} />
                <div className="my-1 h-px bg-gray-100 dark:bg-slate-700/60" />
              </>
            )}
            <MenuButton icon={LayoutGrid} label="Auto-layout" onClick={() => { runAutoLayout(); closeMenu(); }} />
            <MenuButton icon={Maximize} label="Fit view" onClick={() => { fitView(); closeMenu(); }} />
            <MenuButton icon={MousePointerClick} label="Select all" onClick={() => { onSelectAll(); closeMenu(); }} />
          </div>
        </>
      )}

      {quick && (
        <QuickConnectMenu
          x={quick.x}
          y={quick.y}
          specs={quickTargets}
          onPick={(type) => { onQuickConnect(type, quick.flow, quick.source); setQuick(null); }}
          onClose={() => setQuick(null)}
        />
      )}
    </div>
  );
}

/** A searchable node picker opened when an edge is dropped on empty canvas (quick-connect). */
function QuickConnectMenu({ x, y, specs, onPick, onClose }: {
  x: number;
  y: number;
  specs: NodeSpec[];
  onPick: (type: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const results = q === ''
    ? specs
    : specs.filter((s) => s.label.toLowerCase().includes(q) || s.type.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Add a connected node"
        style={{ top: y, left: x }}
        className="fixed z-50 flex max-h-72 w-56 flex-col rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl"
      >
        <div className="border-b border-gray-100 dark:border-slate-800 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                else if (e.key === 'Enter' && results.length > 0) onPick(results[0].type);
              }}
              placeholder="Add a node…"
              aria-label="Search nodes to connect"
              className="w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1">
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-gray-400 dark:text-slate-500">No nodes match "{query}".</p>
          ) : (
            results.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.type}
                  type="button"
                  onClick={() => onPick(s.type)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 dark:text-slate-200 hover:bg-primary-50 dark:hover:bg-primary-500/10 focus:outline-none focus-visible:bg-primary-50 dark:focus-visible:bg-primary-500/10"
                >
                  <Icon className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-400" />
                  <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

function MenuButton({ icon: Icon, label, onClick, danger }: {
  icon: typeof CopyPlus;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors focus:outline-none',
        danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800',
      )}
    >
      <Icon className="h-4 w-4 flex-none" />
      {label}
    </button>
  );
}
