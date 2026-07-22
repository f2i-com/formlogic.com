// Blueprints workspace (extensible-flows plan §11, §25 step 7 — the scoped first UI):
// list/create blueprints and edit ONE small diagram: place existing Forms and Flows as
// concept elements and wire a 'triggers' relationship between them. EVERY mutation rides
// the §14.3 operation-commit gateway (semantic batches carry baseSemanticRevision and
// reconcile on 409; drags are layout-only batches that can never conflict). Elements and
// edges are CONCEPT-ONLY here (§11.5) — materialisation into real bindings is a later
// slice, so this page never mutates forms, flows, or bindings.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FileText, Loader2, Map as MapIcon, Plus, Trash2, Workflow } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, generateId } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { Blueprint, BlueprintElement, BlueprintOperation } from '../../types/blueprints';
import type { FlowDefinition } from '../../types/flows';
import type { Form } from '../../types/form';

const INPUT_CLS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

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

function BlueprintCanvas({
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

export default function BlueprintsWorkspace() {
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [selected, setSelected] = useState<Blueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Blueprint | null>(null);

  const refreshList = useCallback(async () => {
    const res = await api.listBlueprints();
    setBlueprints(res.data?.blueprints ?? []);
    setLoading(false);
  }, []);

  const openBlueprint = useCallback(async (id: string) => {
    const res = await api.getBlueprint(id);
    if (res.data?.blueprint) setSelected(res.data.blueprint);
    else toast.error('Failed to load blueprint', typeof res.error === 'string' ? res.error : undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.listBlueprints().then((res) => {
      if (cancelled) return;
      setBlueprints(res.data?.blueprints ?? []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const create = useCallback(async () => {
    const name = newName.trim();
    if (name === '') return;
    const res = await api.createBlueprint({ name });
    if (res.error || !res.data) {
      toast.error('Failed to create blueprint', typeof res.error === 'string' ? res.error : undefined);
      return;
    }
    setNewName('');
    await refreshList();
    setSelected(res.data.blueprint);
  }, [newName, refreshList]);

  const confirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    await api.deleteBlueprint(target.id);
    if (selected?.id === target.id) setSelected(null);
    await refreshList();
  }, [pendingDelete, refreshList, selected]);

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0">
      <aside className="flex w-72 flex-none flex-col border-r border-gray-200 bg-white dark:border-slate-700/60 dark:bg-slate-900">
        <div className="border-b border-gray-200 p-3 dark:border-slate-700/60">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <MapIcon className="h-4 w-4 text-primary-600 dark:text-primary-300" />
            Blueprints
          </h1>
          <p className="mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500">
            The high-level diagram of what you're building — place forms and flows, wire what triggers what.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
              placeholder="New blueprint name"
              aria-label="New blueprint name"
              className={INPUT_CLS + ' w-full'}
            />
            <Button size="sm" disabled={newName.trim() === ''} onClick={() => void create()} aria-label="Create blueprint">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-2">
          {loading ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-gray-400 dark:text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </p>
          ) : blueprints.length === 0 ? (
            <p className="px-2 py-3 text-xs text-gray-400 dark:text-slate-500">No blueprints yet — create one above.</p>
          ) : (
            blueprints.map((blueprint) => (
              <div
                key={blueprint.id}
                className={cn(
                  'group mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2',
                  selected?.id === blueprint.id
                    ? 'bg-primary-50 dark:bg-primary-500/10'
                    : 'hover:bg-gray-50 dark:hover:bg-slate-800',
                )}
              >
                <button
                  type="button"
                  onClick={() => void openBlueprint(blueprint.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{blueprint.name}</p>
                  <p className="text-[10px] text-gray-400 dark:text-slate-500">
                    {blueprint.status} · rev {blueprint.semanticRevision}
                  </p>
                </button>
                <Button
                  variant="ghost"
                  size="iconOnly"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => setPendingDelete(blueprint)}
                  aria-label={`Delete blueprint ${blueprint.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
            ))
          )}
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 bg-gray-50 dark:bg-slate-950">
        {selected ? (
          <ReactFlowProvider>
            <BlueprintCanvas
              key={selected.id}
              blueprint={selected}
              onReload={() => openBlueprint(selected.id)}
              onRevisions={(semantic, layout) =>
                setSelected((current) =>
                  current ? { ...current, semanticRevision: semantic, layoutRevision: layout } : current,
                )
              }
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-sm text-center text-sm text-gray-400 dark:text-slate-500">
              Pick a blueprint on the left (or create one) to sketch what you're building.
            </p>
          </div>
        )}
      </main>
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete blueprint"
        message={pendingDelete ? `Delete '${pendingDelete.name}'? The forms and flows it references are kept.` : ''}
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
