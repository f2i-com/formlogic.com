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
  ConnectionMode,
  Controls,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
  applyEdgeChanges,
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
  RotateCcw,
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
  /** Injected per-node (images/shapes): persist a resize (properties w/h). */
  onResize?: (w: number, h: number) => void;
  /** §11A D4: live resource state for materialised elements. */
  sync?: { state: 'synced' | 'stale' | 'missing'; title?: string; fieldCount?: number };
  /** §12: part of a PROPOSED change set — rendered as a ghost until approved. */
  ghost?: boolean;
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
const CONNECTOR_DOT =
  '!h-2.5 !w-2.5 !border-2 !border-white !bg-primary-500 dark:!border-slate-900';

/** A dot on every side — start OR end a wire from any of them (ConnectionMode.Loose). */
function Connectors() {
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} className={CONNECTOR_DOT} />
      <Handle id="r" type="source" position={Position.Right} className={CONNECTOR_DOT} />
      <Handle id="b" type="source" position={Position.Bottom} className={CONNECTOR_DOT} />
      <Handle id="l" type="source" position={Position.Left} className={CONNECTOR_DOT} />
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
      <div className="relative h-full w-full">
        <NodeResizer
          isVisible={selected}
          keepAspectRatio
          minWidth={40}
          minHeight={40}
          onResizeEnd={(_event, params) => d.onResize?.(Math.round(params.width), Math.round(params.height))}
        />
        <img
          src={d.image.src}
          alt="Pasted concept sketch"
          draggable={false}
          className={cn('h-full w-full rounded-lg object-fill shadow-sm', selected && 'ring-2 ring-primary-500/50')}
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
      <div className="relative h-full w-full">
        <NodeResizer
          isVisible={selected}
          minWidth={24}
          minHeight={24}
          onResizeEnd={(_event, params) => d.onResize?.(Math.round(params.width), Math.round(params.height))}
        />
        <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`${kind} shape`}>
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
          'relative min-h-[6.5rem] w-44 rounded-lg border border-amber-200 bg-amber-100 px-2.5 py-2 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/15',
          selected && 'ring-2 ring-amber-400/60',
          d.ghost && 'border-dashed opacity-70',
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
        <Connectors />
      </div>
    );
  }
  return (
    <div
      className={cn(
        'relative min-w-[10rem] rounded-xl border bg-white px-3 py-2.5 shadow-sm dark:bg-slate-900',
        selected ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-gray-200 dark:border-slate-700',
        d.ghost && 'border-dashed border-primary-300 opacity-70 dark:border-primary-500/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="truncate text-sm font-medium text-gray-900 dark:text-white">{d.sync?.title ?? d.title}</span>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-slate-500">
        {d.elementType}
        {d.concept ? ' · concept' : ''}
        {d.sync?.state === 'missing' && (
          <span className="rounded bg-red-100 px-1 py-px font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">missing</span>
        )}
        {d.sync?.state === 'stale' && (
          <span className="rounded bg-amber-100 px-1 py-px font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">changed</span>
        )}
        {d.sync?.state === 'synced' && (
          <span className="rounded bg-emerald-100 px-1 py-px font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">linked</span>
        )}
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
      <Connectors />
    </div>
  );
}

const SKETCH_FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'email', 'phone', 'checkbox', 'dropdown'] as const;

/**
 * §11A D2: the selection editor — a right rail editing the selected element through the
 * gateway. Forms edit title + sketched fields; other concepts edit title + NOTES (saved
 * as a linked sticky post-it BESIDE the node, visible on the diagram); notes/text edit
 * their body; edges edit a relationship NAME (and, for form-form ER relations,
 * cardinality + FK). Everything can be deleted from here too.
 */
function SelectionPanel({
  element,
  busy,
  linkedNoteText,
  onSave,
  onDelete,
}: {
  element: BlueprintElement;
  busy: boolean;
  /** The text of the sticky note attached to this concept (null = none yet). */
  linkedNoteText: string | null;
  onSave: (properties: Record<string, unknown>, noteText?: string) => void;
  onDelete: () => void;
}) {
  const isEdge = element.elementType === 'edge';
  const edgeProps = element.properties as { edgeType?: string; cardinality?: string; fkField?: string; label?: string };
  const isErRelation = isEdge && edgeProps.edgeType === 'relation' && typeof edgeProps.cardinality === 'string';
  const isForm = element.elementType === 'form';
  const isTexty = element.elementType === 'note' || element.elementType === 'text';
  const isDrawing = element.elementType === 'ink' || element.elementType === 'image' || element.elementType === 'shape';
  const [title, setTitle] = useState(String((element.properties as { title?: unknown }).title ?? ''));
  const [notes, setNotes] = useState(linkedNoteText ?? '');
  const [bodyText, setBodyText] = useState(String((element.properties as { text?: unknown }).text ?? ''));
  const [fields, setFields] = useState<SketchField[]>(() => sketchFields(element.properties));
  const [cardinality, setCardinality] = useState(String(edgeProps.cardinality ?? '1:N'));
  const [fkField, setFkField] = useState(String(edgeProps.fkField ?? ''));
  const [edgeLabel, setEdgeLabel] = useState(String(edgeProps.label ?? ''));

  const save = () => {
    if (isEdge) {
      const next: Record<string, unknown> = { ...element.properties };
      if (edgeLabel.trim() === '') delete next.label;
      else next.label = edgeLabel.trim();
      if (isErRelation) {
        next.cardinality = cardinality;
        next.fkField = fkField.trim();
      }
      onSave(next);
      return;
    }
    if (isTexty) {
      const next: Record<string, unknown> = { ...element.properties, text: bodyText };
      delete next.title;
      onSave(next);
      return;
    }
    const next: Record<string, unknown> = {
      ...element.properties,
      title: title.trim() === '' ? 'Untitled' : title.trim(),
    };
    delete next.description; // superseded by the attached sticky note
    if (isForm) {
      next.fields = fields.filter((field) => field.name.trim() !== '').map((field) => ({ name: field.name.trim(), type: field.type }));
      onSave(next);
      return;
    }
    onSave(next, notes);
  };

  return (
    <div className="scrollbar-thin w-64 flex-none overflow-y-auto border-l border-gray-200 bg-white p-3 dark:border-slate-700/60 dark:bg-slate-900">
      {isEdge ? (
        <>
          <p className="mb-2 text-xs font-medium text-gray-500 dark:text-slate-400">
            {isErRelation ? 'Relation' : 'Connector'}
          </p>
          <label className="mb-1 block text-[11px] text-gray-400 dark:text-slate-500">
            Relationship name (shown on the wire)
          </label>
          <input
            value={edgeLabel}
            onChange={(e) => setEdgeLabel(e.target.value)}
            placeholder={isErRelation ? 'places / belongs to…' : 'relates to…'}
            aria-label="Relationship name"
            className={INPUT_CLS + ' w-full'}
          />
          {isErRelation && (
            <>
              <label className="mt-3 mb-1 block text-[11px] text-gray-400 dark:text-slate-500">Cardinality</label>
              <select value={cardinality} onChange={(e) => setCardinality(e.target.value)} aria-label="Relation cardinality" className={INPUT_CLS + ' w-full cursor-pointer'}>
                <option value="1:N">1:N — one source, many targets</option>
                <option value="1:1">1:1 — one to one</option>
                <option value="N:M">N:M — many to many (junction form)</option>
              </select>
              {cardinality !== 'N:M' && (
                <>
                  <label className="mt-3 mb-1 block text-[11px] text-gray-400 dark:text-slate-500">FK field (created on the target form)</label>
                  <input value={fkField} onChange={(e) => setFkField(e.target.value)} placeholder="customer" aria-label="Relation FK field" className={INPUT_CLS + ' w-full font-mono text-xs'} />
                </>
              )}
              {cardinality === 'N:M' && (
                <p className="mt-2 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
                  Materialises as a junction form linking both sides.
                </p>
              )}
            </>
          )}
        </>
      ) : isDrawing ? (
        <p className="text-xs text-gray-400 dark:text-slate-500">
          {element.elementType === 'ink' ? 'An ink stroke.' : element.elementType === 'image' ? 'An attached image.' : 'A shape.'} Delete it below, or press Delete.
        </p>
      ) : isTexty ? (
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
      ) : (
        <>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">
            {isForm ? 'Form title' : 'Title'}
          </label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Entity title" className={INPUT_CLS + ' w-full'} />
          {!isForm && (
            <>
              <label className="mt-3 mb-1 block text-xs font-medium text-gray-500 dark:text-slate-400">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={5}
                placeholder={element.elementType === 'flow'
                  ? 'When a booking arrives, check availability, then confirm by SMS…'
                  : 'Describe this concept…'}
                aria-label="Concept notes"
                className={INPUT_CLS + ' w-full resize-y text-xs leading-snug'}
              />
              <p className="mt-1 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
                Saves as a sticky note linked beside this node — visible right on the diagram.
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
      )}
      {!isDrawing && (
        <Button size="sm" className="mt-3 w-full" isLoading={busy} disabled={busy} onClick={save}>
          Save
        </Button>
      )}
      <Button variant="outline" size="sm" className="mt-2 w-full" disabled={busy} onClick={onDelete}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5 text-red-500" />
        Delete {isEdge ? 'connector' : 'element'}
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
  // Containment (§11.3 parentId): React Flow needs parents BEFORE children, so order
  // by nesting depth (cycle-tolerant: a broken chain caps out and renders flat).
  const byId = new Map(elements.map((element) => [element.id, element]));
  const depthOf = (element: BlueprintElement): number => {
    let depth = 0;
    let cursor: BlueprintElement | undefined = element;
    while (depth < 8) {
      const parentId = (cursor?.properties as { parentId?: unknown } | undefined)?.parentId;
      if (typeof parentId !== 'string' || !byId.has(parentId)) break;
      cursor = byId.get(parentId);
      depth++;
    }
    return depth;
  };
  const ordered = [...elements].sort((a, b) => depthOf(a) - depthOf(b));
  for (const element of ordered) {
    if (element.elementType === 'edge') {
      const props = element.properties as {
        edgeType?: string; sourceId?: string; targetId?: string; cardinality?: string; fkField?: string;
      };
      const isRelation = props.edgeType === 'relation';
      const anchors = element.properties as { sourceHandle?: unknown; targetHandle?: unknown };
      edges.push({
        id: element.id,
        source: String(props.sourceId ?? ''),
        target: String(props.targetId ?? ''),
        ...(typeof anchors.sourceHandle === 'string' ? { sourceHandle: anchors.sourceHandle } : {}),
        ...(typeof anchors.targetHandle === 'string' ? { targetHandle: anchors.targetHandle } : {}),
        // ER reading for relations: cardinality + the FK field that will hold the link.
        // Form→form relations read as ER (cardinality + FK); generic associations
        // (notes/images/shapes/text linked up) read as a plain line.
        label: typeof (element.properties as { label?: unknown }).label === 'string'
          ? (element.properties as { label: string }).label
          : isRelation
            ? (props.cardinality ? `${props.cardinality}${props.fkField ? ` · ${props.fkField}` : ''}` : undefined)
            : String(props.edgeType ?? 'relation'),
        animated: props.edgeType === 'triggers',
        interactionWidth: 24,
      });
      continue;
    }
    const layout = element.layout as { x?: number; y?: number } | null;
    const position =
      layout && typeof layout.x === 'number' && typeof layout.y === 'number'
        ? { x: layout.x, y: layout.y }
        : { x: 80 + (autoIndex % 4) * 260, y: 80 + Math.floor(autoIndex / 4) * 180 };
    autoIndex++;
    const nodeSize = element.elementType === 'image'
      ? imageProps(element.properties)
      : element.elementType === 'shape'
        ? {
            w: Math.max(24, Number((element.properties as { w?: unknown }).w) || 160),
            h: Math.max(24, Number((element.properties as { h?: unknown }).h) || 110),
          }
        : undefined;
    const parentId = (element.properties as { parentId?: unknown }).parentId;
    nodes.push({
      id: element.id,
      type: 'blueprint',
      position,
      ...(typeof parentId === 'string' && byId.has(parentId)
        ? { parentId, extent: 'parent' as const }
        : {}),
      ...(nodeSize ? { width: nodeSize.w, height: nodeSize.h } : {}),
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
        sync: element.sync,
      } satisfies BlueprintNodeData,
    });
  }
  return { nodes, edges };
}

export function DiagramCanvas({
  blueprint,
  onEnsureId,
  onReload,
  onRevisions,
}: {
  blueprint: Blueprint;
  /** Deferred drafts: creates the blueprint row on the first change (id '' until then). */
  onEnsureId?: () => Promise<string | null>;
  onReload: () => Promise<void>;
  onRevisions: (semantic: number, layout: number) => void;
}) {
  const elements = useMemo(() => blueprint.elements ?? [], [blueprint.elements]);
  const initial = useMemo(() => toCanvas(elements), [elements]);
  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [rfEdges, setRfEdges] = useState<Edge[]>(initial.edges);
  useEffect(() => {
    setRfEdges(initial.edges);
  }, [initial]);
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) => setRfEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );
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
  const resizeRef = useRef<(elementId: string, w: number, h: number) => void>(() => undefined);

  useEffect(() => {
    setNodes(
      initial.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onAddField: (name: string) => addFieldRef.current(node.id, name),
          onSetText: (text: string) => setTextRef.current(node.id, text),
          onResize: (w: number, h: number) => resizeRef.current(node.id, w, h),
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
        // Deferred drafts (/diagrams/new): the row is created on the FIRST real
        // change — an untouched canvas never persists (owner direction).
        let blueprintId = blueprint.id;
        if (blueprintId === '') {
          blueprintId = (await onEnsureId?.()) ?? '';
          if (blueprintId === '') return false;
        }
        const res = await api.commitBlueprintOperations(blueprintId, {
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
    [blueprint.id, onEnsureId, onReload, onRevisions],
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

  // Persist an image/shape resize (properties w/h — the node box follows on reload).
  const resizeElement = useCallback(
    (elementId: string, w: number, h: number) => {
      const element = elements.find((candidate) => candidate.id === elementId);
      if (!element) return;
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.update',
            targetId: elementId,
            properties: { ...element.properties, w, h },
          },
        ],
        true,
      );
    },
    [commit, elements],
  );
  useEffect(() => {
    resizeRef.current = resizeElement;
  }, [resizeElement]);

  // §11A: quick-sketch — drop a fresh CONCEPT element of any §11.4 kind at a spawn
  // point. This is the design-tool half of the canvas; "place existing" is the other.
  const sketchElement = useCallback(
    (elementType: string, title: string, extra?: Record<string, unknown>, position?: { x: number; y: number }) => {
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
            layout: position
              ? { x: Math.round(position.x), y: Math.round(position.y) }
              : { x: 120 + Math.round(Math.random() * 260), y: 120 + Math.round(Math.random() * 180) },
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
      if (connection.sourceHandle) properties.sourceHandle = connection.sourceHandle;
      if (connection.targetHandle) properties.targetHandle = connection.targetHandle;
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

  // Types that can live INSIDE a box (owner direction: shapes nest, text/images/notes
  // drop in; forms and flows stay top-level).
  const CONTAINABLE = useMemo(() => new Set(['shape', 'text', 'image', 'note']), []);

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      const element = elements.find((candidate) => candidate.id === node.id);
      const abs = reactFlow.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
      const currentParent = (element?.properties as { parentId?: unknown } | undefined)?.parentId;
      const isDescendantOf = (candidateId: string, ancestorId: string): boolean => {
        let cursor = candidateId;
        for (let hop = 0; hop < 8; hop++) {
          const parent = (elements.find((e) => e.id === cursor)?.properties as { parentId?: unknown } | undefined)?.parentId;
          if (typeof parent !== 'string') return false;
          if (parent === ancestorId) return true;
          cursor = parent;
        }
        return false;
      };

      // Innermost rect box under the dragged node's centre becomes its container.
      let container: { id: string; x: number; y: number; area: number } | null = null;
      if (element && CONTAINABLE.has(element.elementType)) {
        const centerX = abs.x + (node.measured?.width ?? 0) / 2;
        const centerY = abs.y + (node.measured?.height ?? 0) / 2;
        for (const candidate of elements) {
          if (candidate.id === node.id || candidate.elementType !== 'shape') continue;
          if (String((candidate.properties as { shape?: unknown }).shape ?? 'rect') !== 'rect') continue;
          if (isDescendantOf(candidate.id, node.id)) continue; // never nest into your own child
          const candidateAbs = reactFlow.getInternalNode(candidate.id)?.internals.positionAbsolute;
          if (!candidateAbs) continue;
          const w = Math.max(24, Number((candidate.properties as { w?: unknown }).w) || 160);
          const h = Math.max(24, Number((candidate.properties as { h?: unknown }).h) || 110);
          const inside = centerX > candidateAbs.x && centerX < candidateAbs.x + w
            && centerY > candidateAbs.y && centerY < candidateAbs.y + h;
          if (inside && (container === null || w * h < container.area)) {
            container = { id: candidate.id, x: candidateAbs.x, y: candidateAbs.y, area: w * h };
          }
        }
      }

      if (element && container && container.id !== currentParent) {
        // Entered a box: parentage is semantic; position becomes parent-relative.
        void commit(
          [
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.update',
              targetId: node.id,
              properties: { ...element.properties, parentId: container.id },
            },
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.layout.set',
              targetId: node.id,
              layout: { x: Math.round(abs.x - container.x), y: Math.round(abs.y - container.y) },
            },
          ],
          true,
        );
        return;
      }
      if (element && !container && typeof currentParent === 'string') {
        // Left its box: back to top level at the absolute spot it was dropped.
        const released: Record<string, unknown> = { ...element.properties };
        delete released.parentId;
        void commit(
          [
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.update',
              targetId: node.id,
              properties: released,
            },
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.layout.set',
              targetId: node.id,
              layout: { x: Math.round(abs.x), y: Math.round(abs.y) },
            },
          ],
          true,
        );
        return;
      }
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
    [CONTAINABLE, commit, elements, reactFlow],
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

  const selectedElement = selectedId !== null
    ? elements.find((element) => element.id === selectedId) ?? null
    : null;

  // The sticky note attached to the selected concept (note.properties.attachedTo).
  const linkedNote = selectedElement
    ? elements.find(
        (candidate) => candidate.elementType === 'note'
          && (candidate.properties as { attachedTo?: unknown }).attachedTo === selectedElement.id,
      ) ?? null
    : null;
  const linkedNoteText = linkedNote
    ? String((linkedNote.properties as { text?: unknown }).text ?? '')
    : null;

  // §12: proposed change sets render as GHOSTS with an approval bar — the Copilot's
  // preview loop. Refetched whenever the semantic revision moves.
  const [proposals, setProposals] = useState<Array<{ id: string; summary: string | null; operations: BlueprintOperation[] }>>([]);
  useEffect(() => {
    let cancelled = false;
    if (blueprint.id === '') return;
    const fetchProposals = () => {
      void api.listBlueprintChangeSets(blueprint.id).then((res) => {
        if (cancelled) return;
        const next = res.data?.changeSets ?? [];
        setProposals((previous) => {
          // A proposal that vanished was resolved elsewhere (approved in chat →
          // committed): reload so the canvas shows the applied elements.
          if (previous.some((p) => !next.some((n) => n.id === p.id))) void onReload();
          return next;
        });
      });
    };
    fetchProposals();
    // The AI can park a proposal from the chat at any moment — poll so the user
    // SEES the ghosts appear without reloading (owner direction: visible AI work).
    const timer = window.setInterval(fetchProposals, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [blueprint.id, blueprint.semanticRevision, onReload]);

  const ghost = useMemo(() => {
    const pseudo: BlueprintElement[] = [];
    for (const proposal of proposals) {
      for (const op of proposal.operations) {
        if (op?.type !== 'blueprint.element.create' || typeof op.targetId !== 'string' || !op.elementType) continue;
        pseudo.push({
          id: op.targetId,
          elementType: op.elementType,
          resourceRef: (op.resourceRef as Record<string, unknown> | null | undefined) ?? null,
          properties: (op.properties as Record<string, unknown> | undefined) ?? {},
          layout: (op.layout as Record<string, unknown> | undefined) ?? null,
        });
      }
    }
    const rendered = toCanvas(pseudo);
    return {
      nodes: rendered.nodes.map((node) => ({
        ...node,
        selectable: false,
        draggable: false,
        connectable: false,
        data: { ...node.data, ghost: true },
      })),
      edges: rendered.edges.map((edge) => ({
        ...edge,
        selectable: false,
        style: { strokeDasharray: '6 4', opacity: 0.5 },
      })),
    };
  }, [proposals]);

  const resolveProposal = useCallback(
    (changeSetId: string, approve: boolean) => {
      setBusy(true);
      const call = approve
        ? api.approveBlueprintChangeSet(blueprint.id, changeSetId)
        : api.discardBlueprintChangeSet(blueprint.id, changeSetId);
      void call.then((res) => {
        setBusy(false);
        setProposals((current) => current.filter((candidate) => candidate.id !== changeSetId));
        if (res.error) {
          toast.error(approve ? 'Could not apply the proposal' : 'Could not discard', typeof res.error === 'string' ? res.error : undefined);
        } else if (approve) {
          toast.success('Proposal applied');
        }
        void onReload();
      });
    },
    [blueprint.id, onReload],
  );

  const saveSelectedProperties = useCallback(
    (properties: Record<string, unknown>, noteText?: string) => {
      if (!selectedId) return;
      const operations: BlueprintOperation[] = [
        {
          operationId: `op-${generateId()}`,
          type: 'blueprint.element.update',
          targetId: selectedId,
          properties,
        },
      ];
      // The concept's sticky note rides the SAME batch (two sequential commits raced:
      // the second carried a stale baseSemanticRevision and 409'd).
      if (noteText !== undefined) {
        if (linkedNote && noteText !== (linkedNoteText ?? '')) {
          operations.push({
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.update',
            targetId: linkedNote.id,
            properties: { ...linkedNote.properties, text: noteText },
          });
        } else if (!linkedNote && noteText.trim() !== '') {
          const anchor = elements.find((candidate) => candidate.id === selectedId);
          const at = (anchor?.layout ?? {}) as { x?: number; y?: number };
          const noteId = `el-${generateId()}`;
          operations.push(
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.create',
              targetId: noteId,
              elementType: 'note',
              properties: { text: noteText, attachedTo: selectedId },
              layout: { x: Math.round((at.x ?? 200) + 240), y: Math.round((at.y ?? 200) - 30) },
            },
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.create',
              targetId: `el-${generateId()}`,
              elementType: 'edge',
              properties: { edgeType: 'relation', sourceId: selectedId, targetId: noteId, state: 'concept' },
            },
          );
        }
      }
      void commit(operations, true);
    },
    [commit, elements, linkedNote, linkedNoteText, selectedId],
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
                title={`${tool.title} — click, or drag onto the canvas`}
                aria-label={tool.title}
                disabled={busy}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    'application/formlogic-diagram-tool',
                    JSON.stringify({ elementType: tool.elementType, label: tool.label, extra: tool.extra ?? null }),
                  );
                  event.dataTransfer.effectAllowed = 'copy';
                }}
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
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label="Undo last change"
            title="Undo the last change"
            onClick={() => {
              if (blueprint.id === '') return;
              void api.undoBlueprint(blueprint.id).then((res) => {
                if (res.error) {
                  toast.info('Nothing to undo', typeof res.error === 'string' ? res.error : undefined);
                  return;
                }
                void onReload();
              });
            }}
          >
            <RotateCcw className="h-4 w-4 text-gray-400 hover:text-gray-700 dark:hover:text-slate-200" />
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || selectedId === null} onClick={deleteSelected} aria-label="Delete selected element">
            <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
          </Button>
          {/* §11A D3/D5: the sketch becomes real — and once linked, later sketching
              applies as DELTAS onto the same app. */}
          {blueprint.appId !== null ? (
            <>
              <Button
                variant="outline"
                size="sm"
                isLoading={materializing}
                disabled={busy || materializing}
                onClick={() => {
                  if (blueprint.id === '') return;
                  setMaterializing(true);
                  void api.materializeBlueprint(blueprint.id).then((res) => {
                    setMaterializing(false);
                    if (res.error || !res.data) {
                      toast.info('Nothing applied', typeof res.error === 'string' ? res.error : undefined);
                      void onReload();
                      return;
                    }
                    toast.success('Changes applied to your app', `${res.data.createdFormIds.length} form(s), ${res.data.relations} relation(s), ${res.data.createdFlowIds.length} flow(s), ${res.data.bindings} trigger(s), ${res.data.roles} role(s)`);
                    void onReload();
                  });
                }}
              >
                Apply changes
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate(`/apps/${blueprint.appId}/records`)}>
                Open app
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              isLoading={materializing}
              disabled={busy || materializing}
              onClick={() => {
                if (blueprint.id === '') return;
                setMaterializing(true);
                void api.materializeBlueprint(blueprint.id).then((res) => {
                  setMaterializing(false);
                  if (res.error || !res.data) {
                    toast.error('Could not create the app', typeof res.error === 'string' ? res.error : undefined);
                    void onReload();
                    return;
                  }
                  toast.success('App created from your diagram', `${res.data.createdFormIds.length} form(s), ${res.data.relations} relation(s), ${res.data.createdFlowIds.length} flow(s), ${res.data.bindings} trigger(s), ${res.data.roles} role(s)`);
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
        <div
          className="relative min-h-0 min-w-0 flex-1"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('application/formlogic-diagram-tool')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(event) => {
            const raw = event.dataTransfer.getData('application/formlogic-diagram-tool');
            if (raw === '') return;
            event.preventDefault();
            try {
              const tool = JSON.parse(raw) as { elementType: string; label: string; extra: Record<string, unknown> | null };
              const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
              sketchElement(tool.elementType, `New ${tool.label.toLowerCase()}`, tool.extra ?? undefined, position);
            } catch {
              /* not our payload */
            }
          }}
        >
          <ReactFlow
          nodes={[...nodes, ...ghost.nodes]}
          edges={[...rfEdges, ...ghost.edges]}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onDoubleClick={onPaneDoubleClick}
          onNodeDoubleClick={(_event, node) => {
            const element = elements.find((candidate) => candidate.id === node.id);
            const ref = element?.resourceRef as { kind?: unknown; id?: unknown } | null | undefined;
            if (element?.elementType === 'form' && ref?.kind === 'form' && typeof ref.id === 'string') {
              navigate(`/builder/${ref.id}`);
            }
          }}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          connectionMode={ConnectionMode.Loose}
          onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) =>
            setSelectedId(selectedNodes[0]?.id ?? selectedEdges[0]?.id ?? null)
          }
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {/* §12: the first pending AI proposal's approval bar — ghosts show above. */}
        {proposals.length > 0 && (
          <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-primary-200 bg-white/95 px-3 py-2 shadow-lg dark:border-primary-500/30 dark:bg-slate-900/95">
            <Sparkles className="h-4 w-4 flex-none text-primary-600 dark:text-primary-300" />
            <span className="min-w-0 truncate text-xs text-gray-700 dark:text-slate-200">
              {proposals[0].summary ?? 'AI proposal'}
              {proposals.length > 1 ? ` (+${proposals.length - 1} more)` : ''}
            </span>
            <Button size="sm" disabled={busy} onClick={() => resolveProposal(proposals[0].id, true)}>
              Apply
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => resolveProposal(proposals[0].id, false)}>
              Discard
            </Button>
          </div>
        )}
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
            linkedNoteText={linkedNoteText}
            onSave={saveSelectedProperties}
            onDelete={deleteSelected}
          />
        )}
      </div>
    </div>
  );
}
