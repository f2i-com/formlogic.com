// Diagram canvas (extensible-flows plan §11/§11A): ONE diagram's design surface. A
// CREATION tool by design (owner direction): sketch form entities (typed fields on the
// card), concept flows, actors and post-it notes; wire meanings (form→form relation,
// →flow trigger, actor→ uses); then "Create app" materialises the sketch (D3). It
// deliberately does NOT place existing cross-app forms — referencing live forms from a
// sketch got confusing fast. EVERY mutation rides the §14.3 operation-commit gateway
// (semantic batches carry baseSemanticRevision and reconcile on 409; drags are
// layout-only batches that can never conflict).
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
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
import {
  Boxes,
  Circle as CircleIcon,
  Diamond,
  FileText,
  ImagePlus,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Plug,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Triangle,
  Type,
  User,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { cn, generateId } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import type { Blueprint, BlueprintElement, BlueprintOperation } from '../../types/blueprints';

export const DIAGRAM_INPUT_CLS =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
const INPUT_CLS = DIAGRAM_INPUT_CLS;


type SketchField = { name: string; type: string };
type BlueprintNodeData = {
  title: string;
  elementType: string;
  concept: boolean;
  fields: SketchField[];
  /** Note post-its: the note's body text (properties.text). */
  text?: string;
  /** Concept cards (flows especially): the "how it works" write-up (properties.description). */
  description?: string;
  /** Ink strokes (§11A.1b): an SVG path in node-local coordinates + its drawn size. */
  ink?: { path: string; w: number; h: number };
  /** Pasted images (§11A.1b): a client-downscaled data URI + natural size. */
  image?: { src: string; w: number; h: number };
  /** Outlined shapes (§11A.1b): rect | circle | triangle. */
  shape?: { kind: string; w: number; h: number };
  /** Injected per-node: quick-add a field typed DIRECTLY on the card (short_text default). */
  onAddField?: (name: string) => void;
  /** Injected per-node (notes): save the post-it's text on blur. */
  onSetText?: (text: string) => void;
};

/** §11.4 node vocabulary → icon (also the canvas tool palette's source of truth). */
const ELEMENT_ICONS: Record<string, LucideIcon> = {
  app: Boxes,
  form: FileText,
  screen: Monitor,
  event: Zap,
  flow: Workflow,
  intelligence: Sparkles,
  service: Plug,
  actor: User,
  decision: Diamond,
  group: Square,
  note: StickyNote,
  ink: Pencil,
  image: ImagePlus,
  shape: Square,
  text: Type,
};

/**
 * The quick-sketch tools — each earns its place by meaning something (§11A):
 *   Form  → materialises into a real form (D3);
 *   Flow  → a concept automation ("what should happen") — placeable before it's built;
 *   Actor → a human/system role (maps onto app roles in a later slice);
 *   Note  → annotation, never materialises.
 * Deliberately absent: Screen (returns as an image/paint concept node later), Decision
 * (branching belongs to flows), Group (needs REAL containment semantics first — a frame
 * that doesn't contain is a lie). Existing elements of those kinds still render.
 */
const SKETCH_TOOLS: Array<{ elementType: string; label: string; title: string; icon?: LucideIcon; extra?: Record<string, unknown> }> = [
  { elementType: 'form', label: 'Form', title: 'New form' },
  { elementType: 'flow', label: 'Flow', title: 'New flow (concept)' },
  { elementType: 'actor', label: 'Actor', title: 'New actor / role' },
  { elementType: 'note', label: 'Note', title: 'New note' },
  { elementType: 'text', label: 'Text', title: 'New text label' },
  { elementType: 'shape', label: 'Box', title: 'New box', icon: Square, extra: { shape: 'rect' } },
  { elementType: 'shape', label: 'Circle', title: 'New circle', icon: CircleIcon, extra: { shape: 'circle' } },
  { elementType: 'shape', label: 'Triangle', title: 'New triangle', icon: Triangle, extra: { shape: 'triangle' } },
];

/** Left target + right source connection dots — EVERYTHING connectable gets them
 *  (owner direction: notes, images, shapes and text link up too; ink stays a stroke). */
function Connectors() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-gray-400 dark:!border-slate-900 dark:!bg-slate-500" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-primary-500 dark:!border-slate-900" />
    </>
  );
}

function BlueprintNodeCard({ data, selected }: NodeProps) {
  const d = data as BlueprintNodeData;
  const Icon = ELEMENT_ICONS[d.elementType] ?? Workflow;
  // Drawing layer (§11A.1b): ink strokes and pasted images render raw — no card chrome.
  if (d.elementType === 'ink' && d.ink) {
    return (
      <svg
        width={d.ink.w}
        height={d.ink.h}
        viewBox={`0 0 ${d.ink.w} ${d.ink.h}`}
        className="overflow-visible"
        aria-label="Ink stroke"
      >
        <path
          d={d.ink.path}
          fill="none"
          stroke={selected ? '#6366f1' : '#64748b'}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (d.elementType === 'image' && d.image) {
    return (
      <div className="relative">
        <img
          src={d.image.src}
          width={d.image.w}
          height={d.image.h}
          alt="Pasted concept sketch"
          draggable={false}
          className={cn('rounded-lg shadow-sm', selected && 'ring-2 ring-primary-500/50')}
        />
        <Connectors />
      </div>
    );
  }
  // Outlined shapes: an empty box/circle/triangle to nut out concepts in — draw inside
  // it with the pen, connect it like anything else.
  if (d.elementType === 'shape' && d.shape) {
    const { kind, w, h } = d.shape;
    const stroke = selected ? '#6366f1' : '#94a3b8';
    return (
      <div className="relative">
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label={`${kind} shape`}>
          {kind === 'circle' ? (
            <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 2} ry={h / 2 - 2} fill="none" stroke={stroke} strokeWidth={2} />
          ) : kind === 'triangle' ? (
            <polygon points={`${w / 2},2 ${w - 2},${h - 2} 2,${h - 2}`} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
          ) : (
            <rect x={2} y={2} width={w - 4} height={h - 4} rx={8} fill="none" stroke={stroke} strokeWidth={2} />
          )}
        </svg>
        <Connectors />
      </div>
    );
  }
  // Freestanding text: write directly (no card chrome) — select and type, saves on blur.
  if (d.elementType === 'text') {
    return (
      <div className={cn('relative min-w-[6rem] max-w-[18rem] px-1 py-0.5', selected && 'rounded ring-1 ring-primary-400/50')}>
        {selected && d.onSetText ? (
          <textarea
            key={d.text ?? ''}
            defaultValue={d.text ?? ''}
            rows={2}
            placeholder="Write…"
            aria-label="Text label"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => d.onSetText?.(e.currentTarget.value)}
            className="nodrag w-full resize-none bg-transparent text-sm font-medium leading-snug text-gray-800 placeholder:text-gray-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />
        ) : (
          <p className="whitespace-pre-wrap text-sm font-medium leading-snug text-gray-800 dark:text-slate-100">
            {d.text?.trim() ? d.text : 'Select to write…'}
          </p>
        )}
        <Connectors />
      </div>
    );
  }
  // Notes are sticky post-its you WRITE IN: select one and type; the text saves on blur.
  if (d.elementType === 'note') {
    return (
      <div
        className={cn(
          'min-h-[6.5rem] w-44 rounded-lg border border-amber-200 bg-amber-100 px-2.5 py-2 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/15',
          selected && 'ring-2 ring-amber-400/60',
        )}
      >
        {selected && d.onSetText ? (
          <textarea
            key={d.text ?? ''}
            defaultValue={d.text ?? ''}
            rows={4}
            placeholder="Write a note…"
            aria-label="Note text"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => d.onSetText?.(e.currentTarget.value)}
            className="nodrag w-full resize-none bg-transparent text-[12px] leading-snug text-amber-900 placeholder:text-amber-700/50 focus:outline-none dark:text-amber-100 dark:placeholder:text-amber-200/40"
          />
        ) : (
          <p className="whitespace-pre-wrap text-[12px] leading-snug text-amber-900 dark:text-amber-100">
            {d.text?.trim() ? d.text : 'Select to write…'}
          </p>
        )}
      </div>
    );
  }
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
      {d.elementType !== 'form' && d.description?.trim() ? (
        <p className="mt-1 line-clamp-3 max-w-[13rem] text-[11px] leading-snug text-gray-500 dark:text-slate-400">
          {d.description}
        </p>
      ) : null}
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
      {/* Type a field name straight onto the SELECTED card — Enter adds it as short_text
          (refine the type in the side panel). 'nodrag' keeps typing from moving the node. */}
      {d.elementType === 'form' && selected && d.onAddField && (
        <input
          type="text"
          placeholder="+ add field…"
          aria-label="Quick-add field"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== 'Enter') return;
            const input = e.currentTarget;
            const name = input.value.trim();
            if (name === '') return;
            d.onAddField?.(name);
            input.value = '';
          }}
          className="nodrag mt-1.5 w-full rounded-md border border-dashed border-gray-300 bg-transparent px-1.5 py-1 font-mono text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none dark:border-slate-700 dark:text-slate-200 dark:placeholder:text-slate-500"
        />
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
  const isEdge = element.elementType === 'edge';
  const isRelation = isEdge && (element.properties as { edgeType?: string }).edgeType === 'relation';
  const isForm = element.elementType === 'form';
  const isTexty = element.elementType === 'note' || element.elementType === 'text';
  const [title, setTitle] = useState(String((element.properties as { title?: unknown }).title ?? ''));
  const [description, setDescription] = useState(String((element.properties as { description?: unknown }).description ?? ''));
  const [bodyText, setBodyText] = useState(String((element.properties as { text?: unknown }).text ?? ''));
  const [fields, setFields] = useState<SketchField[]>(() => sketchFields(element.properties));
  const [cardinality, setCardinality] = useState(String((element.properties as { cardinality?: unknown }).cardinality ?? '1:N'));
  const [fkField, setFkField] = useState(String((element.properties as { fkField?: unknown }).fkField ?? ''));

  // Every non-edge element edits its title; forms add the field sketch; relation
  // edges edit cardinality + FK. Other edges (triggers, …) and the drawing layer
  // (ink strokes, pasted images) have nothing to edit.
  if (isEdge && !isRelation) return null;
  if (element.elementType === 'ink' || element.elementType === 'image') return null;

  const save = () => {
    if (isRelation) {
      onSave({ ...element.properties, cardinality, fkField: fkField.trim() });
      return;
    }
    const next: Record<string, unknown> = {
      ...element.properties,
      title: title.trim() === '' ? 'Untitled' : title.trim(),
    };
    if (isForm) {
      next.fields = fields.filter((field) => field.name.trim() !== '').map((field) => ({ name: field.name.trim(), type: field.type }));
    } else if (isTexty) {
      // Notes/text edit their BODY here too — same property the on-card editor saves,
      // so the two stay in step (the card re-renders from the committed snapshot).
      next.text = bodyText;
      delete next.title;
    } else {
      // Concept cards (flows especially) carry a "how it works" write-up (§11A.1b).
      next.description = description.trim();
    }
    onSave(next);
  };

  return (
    <div className="scrollbar-thin w-64 flex-none overflow-y-auto border-l border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900">
      {!isRelation ? (
        <>
          {!isTexty && (
            <>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
                {isForm ? 'Form title' : 'Title'}
              </label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Entity title" className={INPUT_CLS + ' w-full'} />
            </>
          )}
          {isTexty && (
            <>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
                {element.elementType === 'note' ? 'Note text' : 'Text'}
              </label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={6}
                placeholder="Write…"
                aria-label="Body text"
                className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
              />
            </>
          )}
          {!isForm && !isTexty && (
            <>
              <label className="mt-3 mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
                How it works
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder={element.elementType === 'flow'
                  ? 'When a booking arrives, check availability, then confirm by SMS…'
                  : 'Describe this concept…'}
                aria-label="Concept description"
                className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
              />
              <p className="mt-1 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
                Sketch the shape too: draw with the pen or paste an image right next to it.
              </p>
            </>
          )}
          {isForm && (
          <>
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
          )}
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

function inkProps(properties: Record<string, unknown>): { path: string; w: number; h: number } | undefined {
  const p = properties as { path?: unknown; w?: unknown; h?: unknown };
  if (typeof p.path !== 'string' || p.path === '') return undefined;
  return { path: p.path, w: Math.max(4, Number(p.w) || 4), h: Math.max(4, Number(p.h) || 4) };
}

function imageProps(properties: Record<string, unknown>): { src: string; w: number; h: number } | undefined {
  const p = properties as { src?: unknown; w?: unknown; h?: unknown };
  if (typeof p.src !== 'string' || !p.src.startsWith('data:image/')) return undefined;
  return { src: p.src, w: Math.max(8, Number(p.w) || 8), h: Math.max(8, Number(p.h) || 8) };
}

/** Downscale a pasted image to ≤800px and re-encode — it stores INLINE in the element. */
async function pastedImageProps(file: File): Promise<{ src: string; w: number; h: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('unreadable image'));
      image.src = url;
    });
    const scale = Math.min(1, 800 / Math.max(img.width, img.height, 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
    const src = canvas.toDataURL('image/jpeg', 0.85);
    // The element cap is 512 KiB server-side; refuse client-side with headroom.
    if (src.length > 480_000) return null;
    return { src, w, h };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
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
        // Form→form relations read as ER (cardinality + FK); generic associations
        // (notes/images/shapes/text linked up) read as a plain line.
        label: isRelation
          ? (props.cardinality ? `${props.cardinality}${props.fkField ? ` · ${props.fkField}` : ''}` : undefined)
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
        text: typeof (element.properties as { text?: unknown }).text === 'string'
          ? (element.properties as { text: string }).text
          : undefined,
        ink: element.elementType === 'ink' ? inkProps(element.properties) : undefined,
        image: element.elementType === 'image' ? imageProps(element.properties) : undefined,
        shape: element.elementType === 'shape'
          ? {
              kind: String((element.properties as { shape?: unknown }).shape ?? 'rect'),
              w: Math.max(24, Number((element.properties as { w?: unknown }).w) || 160),
              h: Math.max(24, Number((element.properties as { h?: unknown }).h) || 110),
            }
          : undefined,
        description: typeof (element.properties as { description?: unknown }).description === 'string'
          ? (element.properties as { description: string }).description
          : undefined,
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
  const [busy, setBusy] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const navigate = useNavigate();
  // The CURRENT semantic revision (updated by every commit) — held in a ref so callbacks
  // never carry a stale precondition after a sibling commit in the same session.
  const semanticRef = useRef(blueprint.semanticRevision);

  // Card-level editing callbacks ride refs so node data stays stable even though
  // `commit` is declared further down.
  const addFieldRef = useRef<(elementId: string, name: string) => void>(() => undefined);
  const setTextRef = useRef<(elementId: string, text: string) => void>(() => undefined);

  useEffect(() => {
    setNodes(
      initial.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onAddField: (name: string) => addFieldRef.current(node.id, name),
          onSetText: (text: string) => setTextRef.current(node.id, text),
        },
      })),
    );
  }, [initial]);
  useEffect(() => {
    semanticRef.current = blueprint.semanticRevision;
  }, [blueprint.semanticRevision]);

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

  // Append a field typed on a card as short_text (refine in the panel) — one element.update.
  const addFieldToElement = useCallback(
    (elementId: string, name: string) => {
      const element = elements.find((candidate) => candidate.id === elementId);
      if (!element) return;
      const existing = sketchFields(element.properties);
      if (existing.some((field) => field.name === name)) return;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.update',
            targetId: elementId,
            properties: { ...element.properties, fields: [...existing, { name, type: 'short_text' }] },
          },
        ],
        true,
      );
    },
    [commit, elements],
  );
  useEffect(() => {
    addFieldRef.current = addFieldToElement;
  }, [addFieldToElement]);

  // Post-it text saves on blur — skip no-op saves so clicking away never dirties.
  const setNoteText = useCallback(
    (elementId: string, text: string) => {
      const element = elements.find((candidate) => candidate.id === elementId);
      if (!element) return;
      const current = typeof (element.properties as { text?: unknown }).text === 'string'
        ? (element.properties as { text: string }).text
        : '';
      if (current === text) return;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.update',
            targetId: elementId,
            properties: { ...element.properties, text },
          },
        ],
        true,
      );
    },
    [commit, elements],
  );
  useEffect(() => {
    setTextRef.current = setNoteText;
  }, [setNoteText]);

  // §11A: quick-sketch — drop a fresh CONCEPT element of any §11.4 kind at a spawn
  // point. This is the design-tool half of the canvas; "place existing" is the other.
  const sketchElement = useCallback(
    (elementType: string, title: string, extra?: Record<string, unknown>) => {
      const base: Record<string, unknown> = elementType === 'form'
        ? { title, fields: [] }
        : elementType === 'shape'
          ? { w: 160, h: 110 }
          : elementType === 'text'
            ? {}
            : { title };
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: elementType as BlueprintOperation['elementType'],
            properties: { ...base, ...extra },
            layout: { x: 120 + Math.round(Math.random() * 260), y: 120 + Math.round(Math.random() * 180) },
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
      // §11A D2: the wire's MEANING comes from what it connects (§11.5) — form→form is
      // an ER RELATION (1:N, FK suggested from the source title; the D3 materialiser
      // turns it into a linked_record field), anything→flow is a TRIGGER, and
      // actor→anything is USES ("this role works with that"). Combinations with no
      // meaning yet refuse honestly instead of drawing a decorative line.
      const typeOf = (id: string) => elements.find((element) => element.id === id)?.elementType;
      const sourceType = typeOf(connection.source);
      const targetType = typeOf(connection.target);
      let properties: Record<string, unknown> | null = null;
      if (sourceType === 'form' && targetType === 'form') {
        const sourceTitle = String(
          (elements.find((element) => element.id === connection.source)?.properties as { title?: unknown } | undefined)?.title ?? 'parent',
        );
        const fkField = sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'parent';
        properties = { edgeType: 'relation', sourceId: connection.source, targetId: connection.target, cardinality: '1:N', fkField, state: 'concept' };
      } else if (targetType === 'flow') {
        properties = { edgeType: 'triggers', sourceId: connection.source, targetId: connection.target, state: 'concept' };
      } else if (sourceType === 'flow' && targetType === 'form') {
        // The flow PRODUCES records into that form (§11.5 sends-data).
        properties = { edgeType: 'sends-data', sourceId: connection.source, targetId: connection.target, state: 'concept' };
      } else if (sourceType === 'actor') {
        properties = { edgeType: 'uses', sourceId: connection.source, targetId: connection.target, state: 'concept' };
      }
      if (properties === null && sourceType === 'ink') {
        return; // strokes are drawings, not connectors
      }
      if (properties === null) {
        // Anything else links generically (owner direction: notes, images, shapes and
        // text connect too) — a plain association with no cardinality or FK.
        properties = { edgeType: 'relation', sourceId: connection.source, targetId: connection.target, state: 'concept' };
      }
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'edge',
            properties,
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

  // ── Drawing layer (§11A.1b): freehand pen + pasted images ─────────────────────────
  const [penMode, setPenMode] = useState(false);
  const strokeRef = useRef<Array<{ x: number; y: number }> | null>(null);
  const [strokePreview, setStrokePreview] = useState<string>('');

  const finishStroke = useCallback(() => {
    const screenPoints = strokeRef.current;
    strokeRef.current = null;
    setStrokePreview('');
    if (!screenPoints || screenPoints.length < 2) return;
    const flowPoints = screenPoints.map((point) => reactFlow.screenToFlowPosition(point));
    const xs = flowPoints.map((point) => point.x);
    const ys = flowPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const path = flowPoints
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${Math.round(point.x - minX)} ${Math.round(point.y - minY)}`)
      .join(' ');
    if (path.length > 60_000) {
      toast.error('Stroke too long', 'Break big drawings into a few strokes.');
      return;
    }
    void commit(
      [
        {
          operationId: `op-${generateId()}`,
          type: 'blueprint.element.create',
          targetId: `el-${generateId()}`,
          elementType: 'ink' as BlueprintOperation['elementType'],
          properties: {
            path,
            w: Math.max(4, Math.round(Math.max(...xs) - minX)),
            h: Math.max(4, Math.round(Math.max(...ys) - minY)),
          },
          layout: { x: Math.round(minX), y: Math.round(minY) },
        },
      ],
      true,
    );
  }, [commit, reactFlow]);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const attachImage = useCallback(
    async (file: File) => {
      const props = await pastedImageProps(file);
      if (!props) {
        toast.error('Image too large', 'It stores inline on the diagram — attach something smaller.');
        return;
      }
      const center = reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'image' as BlueprintOperation['elementType'],
            properties: props,
            layout: { x: Math.round(center.x - props.w / 2), y: Math.round(center.y - props.h / 2) },
          },
        ],
        true,
      );
    },
    [commit, reactFlow],
  );

  // Paste an image anywhere on the page while the canvas is open → an image element at
  // the viewport centre (downscaled client-side; the server caps the element at 512 KiB).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((candidate) => candidate.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void pastedImageProps(file).then((props) => {
        if (!props) {
          toast.error('Image too large', 'It stores inline on the diagram — paste something smaller.');
          return;
        }
        const center = reactFlow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        void commit(
          [
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.create',
              targetId: `el-${generateId()}`,
              elementType: 'image' as BlueprintOperation['elementType'],
              properties: props,
              layout: { x: Math.round(center.x - props.w / 2), y: Math.round(center.y - props.h / 2) },
            },
          ],
          true,
        );
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [commit, reactFlow]);

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

  // Delete/Backspace removes the selected element (same edges-first gateway batch as
  // the toolbar button) — unless the user is typing in an input. React Flow's own
  // delete handling stays OFF so nothing bypasses the operation log.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (selectedId === null) return;
      event.preventDefault();
      deleteSelected();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [deleteSelected, selectedId]);

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
        {/* Sketch tools (§11A): draw the app's shape before anything exists. */}
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-slate-700">
          {SKETCH_TOOLS.map((tool) => {
            const Icon = tool.icon ?? ELEMENT_ICONS[tool.elementType] ?? Workflow;
            return (
              <button
                key={tool.title}
                type="button"
                title={tool.title}
                aria-label={tool.title}
                disabled={busy}
                onClick={() => sketchElement(tool.elementType, `New ${tool.label.toLowerCase()}`, tool.extra)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-primary-500/10 dark:hover:text-primary-300"
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
          {/* Pen: freehand ink over the top of everything. Toggle off to pan/select. */}
          <button
            type="button"
            title="Draw (freehand ink)"
            aria-label="Draw freehand ink"
            aria-pressed={penMode}
            disabled={busy}
            onClick={() => setPenMode((mode) => !mode)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-50',
              penMode
                ? 'bg-primary-600 text-primary-foreground'
                : 'text-gray-500 hover:bg-primary-50 hover:text-primary-700 dark:text-slate-400 dark:hover:bg-primary-500/10 dark:hover:text-primary-300',
            )}
          >
            <Pencil className="h-4 w-4" />
          </button>
          {/* Attach an image from disk (paste works anywhere too). */}
          <button
            type="button"
            title="Attach image"
            aria-label="Attach image"
            disabled={busy}
            onClick={() => imageInputRef.current?.click()}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-primary-500/10 dark:hover:text-primary-300"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void attachImage(file);
            }}
          />
        </div>
        <span className="h-6 w-px bg-gray-200 dark:bg-slate-700" />
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
          {/* §11A D3: the sketch becomes real — or, once linked, jumps to its app. */}
          {blueprint.appId !== null ? (
            <Button variant="outline" size="sm" onClick={() => navigate(`/apps/${blueprint.appId}/records`)}>
              Open app
            </Button>
          ) : (
            <Button
              size="sm"
              isLoading={materializing}
              disabled={busy || materializing}
              onClick={() => {
                setMaterializing(true);
                void api.materializeBlueprint(blueprint.id).then((res) => {
                  setMaterializing(false);
                  if (res.error || !res.data) {
                    toast.error('Could not create the app', typeof res.error === 'string' ? res.error : undefined);
                    void onReload();
                    return;
                  }
                  toast.success('App created from your diagram', `${res.data.createdFormIds.length} form(s), ${res.data.relations} relation(s)`);
                  navigate(`/apps/${res.data.appId}/records`);
                });
              }}
            >
              Create app
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onDoubleClick={onPaneDoubleClick}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) =>
            setSelectedId(selectedNodes[0]?.id ?? selectedEdges[0]?.id ?? null)
          }
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {/* Pen overlay: captures the stroke in screen coords (live preview), converts to
            flow coords on release and commits ONE ink element. Covers the canvas, so
            pan/select pause while drawing — toggle the pen off to interact again. */}
        {penMode && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair touch-none"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              strokeRef.current = [{ x: event.clientX, y: event.clientY }];
            }}
            onPointerMove={(event) => {
              const stroke = strokeRef.current;
              if (!stroke) return;
              const last = stroke[stroke.length - 1];
              if (Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y) < 3) return;
              stroke.push({ x: event.clientX, y: event.clientY });
              const host = event.currentTarget.getBoundingClientRect();
              setStrokePreview(
                stroke
                  .map((point, index) => `${index === 0 ? 'M' : 'L'}${Math.round(point.x - host.left)} ${Math.round(point.y - host.top)}`)
                  .join(' '),
              );
            }}
            onPointerUp={finishStroke}
            onPointerCancel={() => {
              strokeRef.current = null;
              setStrokePreview('');
            }}
          >
            {strokePreview !== '' && (
              <svg className="h-full w-full">
                <path d={strokePreview} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
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
