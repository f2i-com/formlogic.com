// Diagram canvas (extensible-flows plan §11/§11A): ONE diagram's editing surface — place
// existing Forms and Flows as concept elements and wire a 'triggers' relationship. EVERY
// mutation rides the §14.3 operation-commit gateway (semantic batches carry
// baseSemanticRevision and reconcile on 409; drags are layout-only batches that can never
// conflict). Elements and edges are CONCEPT-ONLY here (§11.5) — materialisation is the
// §11A.2 D3 slice, so this canvas never mutates forms, flows, or bindings.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
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


type SketchField = { name: string; type: string };
type BlueprintNodeData = { title: string; elementType: string; concept: boolean; fields: SketchField[] };

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
      {/* §11A D2: the ER look — a form entity shows its sketched fields as rows. */}
      {d.elementType === 'form' && d.fields.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-gray-100 pt-1.5 dark:border-slate-800">
          {d.fields.slice(0, 8).map((field) => (
            <li key={field.name} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate font-mono text-gray-700 dark:text-slate-300">{field.name}</span>
              <span className="flex-none text-gray-400 dark:text-slate-500">{field.type}</span>
            </li>
          ))}
          {d.fields.length > 8 && (
            <li className="text-[10px] text-gray-400 dark:text-slate-500">+{d.fields.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

const SKETCH_FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'email', 'phone', 'checkbox', 'dropdown'] as const;

/**
 * §11A D2: the selection editor — a right rail that edits the selected element through
 * ONE element.update operation on Save. Form entities edit title + sketched fields;
 * relation edges edit cardinality + the FK field the materialiser (D3) will create.
 * Draft state is local until Save, so typing never floods the gateway.
 */
function SelectionPanel({
  element,
  busy,
  onSave,
}: {
  element: BlueprintElement;
  busy: boolean;
  onSave: (properties: Record<string, unknown>) => void;
}) {
  const isRelation = element.elementType === 'edge'
    && (element.properties as { edgeType?: string }).edgeType === 'relation';
  const isForm = element.elementType === 'form';
  const [title, setTitle] = useState(String((element.properties as { title?: unknown }).title ?? ''));
  const [fields, setFields] = useState<SketchField[]>(() => sketchFields(element.properties));
  const [cardinality, setCardinality] = useState(String((element.properties as { cardinality?: unknown }).cardinality ?? '1:N'));
  const [fkField, setFkField] = useState(String((element.properties as { fkField?: unknown }).fkField ?? ''));

  if (!isForm && !isRelation) return null;

  const save = () => {
    if (isRelation) {
      onSave({ ...element.properties, cardinality, fkField: fkField.trim() });
      return;
    }
    onSave({
      ...element.properties,
      title: title.trim() === '' ? 'Untitled form' : title.trim(),
      fields: fields.filter((field) => field.name.trim() !== '').map((field) => ({ name: field.name.trim(), type: field.type })),
    });
  };

  return (
    <div className="scrollbar-thin w-64 flex-none overflow-y-auto border-l border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900">
      {isForm ? (
        <>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">Form title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Entity title" className={INPUT_CLS + ' w-full'} />
          <div className="mt-3 mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Fields</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFields((rows) => [...rows, { name: '', type: 'short_text' }])}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              Add
            </Button>
          </div>
          <div className="space-y-1.5">
            {fields.length === 0 && (
              <p className="text-[11px] text-gray-400 dark:text-slate-500">No fields sketched yet — the materialised form starts empty.</p>
            )}
            {fields.map((field, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <input
                  value={field.name}
                  onChange={(e) => setFields((rows) => rows.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)))}
                  placeholder="field_name"
                  aria-label={`Field name ${index + 1}`}
                  className={INPUT_CLS + ' w-full font-mono text-xs'}
                />
                <select
                  value={field.type}
                  onChange={(e) => setFields((rows) => rows.map((row, i) => (i === index ? { ...row, type: e.target.value } : row)))}
                  aria-label={`Field type ${index + 1}`}
                  className={INPUT_CLS + ' w-24 flex-none cursor-pointer text-xs'}
                >
                  {SKETCH_FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <Button
                  variant="ghost"
                  size="iconOnly"
                  onClick={() => setFields((rows) => rows.filter((_, i) => i !== index))}
                  aria-label={`Remove field ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-gray-400 hover:text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-xs font-medium text-gray-500 dark:text-slate-400">Relation</p>
          <label className="mb-1 block text-[11px] text-gray-400 dark:text-slate-500">Cardinality</label>
          <select value={cardinality} onChange={(e) => setCardinality(e.target.value)} aria-label="Relation cardinality" className={INPUT_CLS + ' w-full cursor-pointer'}>
            <option value="1:N">1:N — one source, many targets</option>
            <option value="1:1">1:1 — one to one</option>
          </select>
          <label className="mt-3 mb-1 block text-[11px] text-gray-400 dark:text-slate-500">FK field (created on the target form)</label>
          <input value={fkField} onChange={(e) => setFkField(e.target.value)} placeholder="customer" aria-label="Relation FK field" className={INPUT_CLS + ' w-full font-mono text-xs'} />
        </>
      )}
      <Button size="sm" className="mt-3 w-full" isLoading={busy} disabled={busy} onClick={save}>
        Save
      </Button>
    </div>
  );
}

/** The sketched field list on a form element (properties.fields), shape-tolerant. */
function sketchFields(properties: Record<string, unknown>): SketchField[] {
  const raw = properties.fields;
  if (!Array.isArray(raw)) return [];
  const out: SketchField[] = [];
  for (const row of raw) {
    const name = typeof (row as { name?: unknown })?.name === 'string' ? (row as { name: string }).name.trim() : '';
    if (name === '') continue;
    const type = typeof (row as { type?: unknown })?.type === 'string' ? (row as { type: string }).type : 'short_text';
    out.push({ name, type });
  }
  return out;
}

const NODE_TYPES = { blueprint: BlueprintNodeCard };

/** Elements → React Flow nodes/edges (edge elements become RF edges). */
function toCanvas(elements: BlueprintElement[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let autoIndex = 0;
  for (const element of elements) {
    if (element.elementType === 'edge') {
      const props = element.properties as {
        edgeType?: string; sourceId?: string; targetId?: string; cardinality?: string; fkField?: string;
      };
      const isRelation = props.edgeType === 'relation';
      edges.push({
        id: element.id,
        source: String(props.sourceId ?? ''),
        target: String(props.targetId ?? ''),
        // ER reading for relations: cardinality + the FK field that will hold the link.
        label: isRelation
          ? `${props.cardinality ?? '1:N'}${props.fkField ? ` · ${props.fkField}` : ''}`
          : String(props.edgeType ?? 'relation'),
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
        fields: sketchFields(element.properties),
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
      // §11A D2: connecting two FORM entities sketches an ER RELATION (1:N with a
      // suggested FK field named after the source entity); anything involving a flow
      // stays the 'triggers' wire. The materialiser (D3) turns relations into
      // linked_record fields.
      const typeOf = (id: string) => elements.find((element) => element.id === id)?.elementType;
      const isRelation = typeOf(connection.source) === 'form' && typeOf(connection.target) === 'form';
      const sourceTitle = String(
        (elements.find((element) => element.id === connection.source)?.properties as { title?: unknown } | undefined)?.title ?? 'parent',
      );
      const fkField = sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'parent';
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'edge',
            properties: isRelation
              ? { edgeType: 'relation', sourceId: connection.source, targetId: connection.target, cardinality: '1:N', fkField, state: 'concept' }
              : { edgeType: 'triggers', sourceId: connection.source, targetId: connection.target, state: 'concept' },
          },
        ],
        true,
      );
    },
    [commit, elements],
  );

  // §11A D2: double-click empty canvas = a fresh CONCEPT form entity (no resourceRef —
  // the materialiser creates the real form later). Zoom-on-double-click is disabled so
  // this gesture is unambiguous; double-clicks on nodes/edges don't land on the pane.
  const reactFlow = useReactFlow();
  const onPaneDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return;
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'form',
            properties: { title: 'New form', fields: [] },
            layout: { x: Math.round(position.x), y: Math.round(position.y) },
          },
        ],
        true,
      );
    },
    [commit, reactFlow],
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
  const selectedElement = selectedId !== null
    ? elements.find((element) => element.id === selectedId) ?? null
    : null;

  const saveSelectedProperties = useCallback(
    (properties: Record<string, unknown>) => {
      if (!selectedId) return;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.update',
            targetId: selectedId,
            properties,
          },
        ],
        true,
      );
    },
    [commit, selectedId],
  );

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
          Double-click the canvas for a new form entity; drag form→form for a relation, form→flow for a trigger.
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
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onDoubleClick={onPaneDoubleClick}
          zoomOnDoubleClick={false}
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
        {selectedElement && (
          <SelectionPanel
            key={selectedElement.id}
            element={selectedElement}
            busy={busy}
            onSave={saveSelectedProperties}
          />
        )}
      </div>
    </div>
  );
}
