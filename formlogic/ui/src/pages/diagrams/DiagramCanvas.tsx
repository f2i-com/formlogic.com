// Diagram canvas (extensible-flows plan §11/§11A): ONE diagram's editing surface — place
// existing Forms and Flows as concept elements and wire a 'triggers' relationship. EVERY
// mutation rides the §14.3 operation-commit gateway (semantic batches carry
// baseSemanticRevision and reconcile on 409; drags are layout-only batches that can never
// conflict). Elements and edges are CONCEPT-ONLY here (§11.5) — materialisation is the
// §11A.2 D3 slice, so this canvas never mutates forms, flows, or bindings.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FileText, Loader2, Plus, Trash2, Workflow } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { cn, generateId } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import type { Blueprint, BlueprintElement, BlueprintOperation } from '../../types/blueprints';
import type { FlowDefinition } from '../../types/flows';
import type { Form } from '../../types/form';

export const DIAGRAM_INPUT_CLS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
const INPUT_CLS = DIAGRAM_INPUT_CLS;


type BlueprintNodeData = { title: string; elementType: string; concept: boolean };

function BlueprintNodeCard({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  const Icon = d.elementType === 'form' ? FileText : Workflow;
  return (
    <div
      className={cn(
        'min-w-[10rem] rounded-xl border bg-white px-3 py-2.5 shadow-sm dark:bg-slate-900',
        selected ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-gray-200 dark:border-slate-700',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="truncate text-sm font-medium text-gray-900 dark:text-white">{d.title}</span>
      </div>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-slate-500">
        {d.elementType}
        {d.concept ? ' · concept' : ''}
      </p>
    </div>
  );
}

const NODE_TYPES = { blueprint: BlueprintNodeCard };

/** Elements → React Flow nodes/edges (edge elements become RF edges). */
function toCanvas(elements: BlueprintElement[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let autoIndex = 0;
  for (const element of elements) {
    if (element.elementType === 'edge') {
      const props = element.properties as { edgeType?: string; sourceId?: string; targetId?: string };
      edges.push({
        id: element.id,
        source: String(props.sourceId ?? ''),
        target: String(props.targetId ?? ''),
        label: String(props.edgeType ?? 'relation'),
        animated: props.edgeType === 'triggers',
      });
      continue;
    }
    const layout = element.layout as { x?: number; y?: number } | null;
    const position =
      layout && typeof layout.x === 'number' && typeof layout.y === 'number'
        ? { x: layout.x, y: layout.y }
        : { x: 80 + (autoIndex % 4) * 260, y: 80 + Math.floor(autoIndex / 4) * 180 };
    autoIndex++;
    nodes.push({
      id: element.id,
      type: 'blueprint',
      position,
      data: {
        title: String((element.properties as { title?: unknown }).title ?? element.id),
        elementType: element.elementType,
        concept: element.resourceRef === null,
      } satisfies BlueprintNodeData,
    });
  }
  return { nodes, edges };
}

export function DiagramCanvas({
  blueprint,
  onReload,
  onRevisions,
}: {
  blueprint: Blueprint;
  onReload: () => Promise<void>;
  onRevisions: (semantic: number, layout: number) => void;
}) {
  const elements = useMemo(() => blueprint.elements ?? [], [blueprint.elements]);
  const initial = useMemo(() => toCanvas(elements), [elements]);
  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [forms, setForms] = useState<Form[]>([]);
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [placeFormId, setPlaceFormId] = useState('');
  const [placeFlowId, setPlaceFlowId] = useState('');
  const [busy, setBusy] = useState(false);
  // The CURRENT semantic revision (updated by every commit) — held in a ref so callbacks
  // never carry a stale precondition after a sibling commit in the same session.
  const semanticRef = useRef(blueprint.semanticRevision);

  useEffect(() => {
    setNodes(initial.nodes);
  }, [initial]);
  useEffect(() => {
    semanticRef.current = blueprint.semanticRevision;
  }, [blueprint.semanticRevision]);
  useEffect(() => {
    void api.getForms({ limit: 100 }).then((res) => setForms(res.data?.forms ?? []));
    void api.listWorkspaceFlows().then((res) => setFlows(res.data?.flows ?? []));
  }, []);

  const commit = useCallback(
    async (operations: BlueprintOperation[], semantic: boolean): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await api.commitBlueprintOperations(blueprint.id, {
          ...(semantic ? { baseSemanticRevision: semanticRef.current } : {}),
          operations,
        });
        if (res.error || !res.data) {
          const conflicted = typeof res.error === 'object' && res.error !== null
            && (res.error as { code?: string }).code === 'revision_conflict';
          toast.error(
            conflicted ? 'Blueprint changed elsewhere' : 'Blueprint change failed',
            conflicted ? 'Reloaded the latest version — please retry.' : (typeof res.error === 'string' ? res.error : undefined),
          );
          await onReload();
          return false;
        }
        semanticRef.current = res.data.semanticRevision;
        onRevisions(res.data.semanticRevision, res.data.layoutRevision);
        if (semantic) await onReload();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [blueprint.id, onReload, onRevisions],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const placeElement = useCallback(
    (elementType: 'form' | 'flow', resourceId: string, title: string) => {
      const targetId = `el-${generateId()}`;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId,
            elementType,
            resourceRef: { kind: elementType, id: resourceId },
            properties: { title },
            layout: { x: 120 + Math.round(Math.random() * 240), y: 120 + Math.round(Math.random() * 160) },
          },
        ],
        true,
      );
    },
    [commit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'edge',
            properties: {
              edgeType: 'triggers',
              sourceId: connection.source,
              targetId: connection.target,
              state: 'concept',
            },
          },
        ],
        true,
      );
    },
    [commit],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.layout.set',
            targetId: node.id,
            layout: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
          },
        ],
        false,
      );
    },
    [commit],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    // Deleting a node deletes its connected edges first (the gateway refuses dangling edges).
    const connectedEdges = elements
      .filter((element) => element.elementType === 'edge')
      .filter((element) => {
        const props = element.properties as { sourceId?: string; targetId?: string };
        return element.id === selectedId || props.sourceId === selectedId || props.targetId === selectedId;
      })
      .map((element) => element.id);
    const targets = [...new Set([...connectedEdges, selectedId])];
    const ordered = [
      ...targets.filter((id) => elements.find((element) => element.id === id)?.elementType === 'edge'),
      ...targets.filter((id) => elements.find((element) => element.id === id)?.elementType !== 'edge'),
    ];
    setSelectedId(null);
    void commit(
      ordered.map((targetId) => ({
        operationId: `op-${generateId()}`,
        type: 'blueprint.element.delete' as const,
        targetId,
      })),
      true,
    );
  }, [commit, elements, selectedId]);

  const edges = initial.edges;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 dark:border-slate-700/60 dark:bg-slate-900">
        <select value={placeFormId} onChange={(e) => setPlaceFormId(e.target.value)} aria-label="Form to place" className={INPUT_CLS + ' max-w-[14rem] cursor-pointer'}>
          <option value="">Pick a form…</option>
          {forms.map((form) => <option key={form.id} value={form.id}>{form.title}</option>)}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || placeFormId === ''}
          onClick={() => {
            const form = forms.find((candidate) => candidate.id === placeFormId);
            if (form) placeElement('form', form.id, form.title);
          }}
          leftIcon={<Plus className="h-3.5 w-3.5" />}
        >
          Place form
        </Button>
        <select value={placeFlowId} onChange={(e) => setPlaceFlowId(e.target.value)} aria-label="Flow to place" className={INPUT_CLS + ' max-w-[14rem] cursor-pointer'}>
          <option value="">Pick a flow…</option>
          {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name} ({flow.slug})</option>)}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || placeFlowId === ''}
          onClick={() => {
            const flow = flows.find((candidate) => candidate.id === placeFlowId);
            if (flow) placeElement('flow', flow.id, flow.name);
          }}
          leftIcon={<Plus className="h-3.5 w-3.5" />}
        >
          Place flow
        </Button>
        <span className="mx-1 hidden text-xs text-gray-400 dark:text-slate-500 sm:inline">
          Drag between cards to wire a <span className="font-mono">triggers</span> relationship.
        </span>
        <div className="ml-auto flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <span className="font-mono text-[10px] text-gray-400 dark:text-slate-500">
            rev {blueprint.semanticRevision}·{blueprint.layoutRevision}
          </span>
          <Button variant="ghost" size="sm" disabled={busy || selectedId === null} onClick={deleteSelected} aria-label="Delete selected element">
            <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) =>
            setSelectedId(selectedNodes[0]?.id ?? selectedEdges[0]?.id ?? null)
          }
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
