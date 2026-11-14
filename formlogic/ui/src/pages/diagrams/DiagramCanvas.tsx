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
  useConnection,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './DiagramCanvas.css';
import {
  Boxes,
  Circle as CircleIcon,
  Diamond,
  FileText,
  ImagePlus,
  LayoutGrid,
  Loader2,
  Map as MapIcon,
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
import { BottomSheet } from '../../components/ui/BottomSheet';
import type { Blueprint, BlueprintElement, BlueprintOperation } from '../../types/blueprints';
import { SelectionPanel } from './SelectionPanel';
import { clearSelectionDraft } from './selectionDraft';
import { SKETCH_FIELD_WORDS, sketchFields, type SketchField } from './sketch';
import { facingSide, freeSpot, lineEnds, tidy, type Box, type Spot } from './placement';

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
const SKETCH_TOOLS: Array<{ elementType: string; label: string; title: string; /** One line of what it is, for the phone's list of tools. */ about: string; icon?: LucideIcon; extra?: Record<string, unknown> }> = [
  { elementType: 'form', label: 'Form', title: 'New form', about: 'Becomes a real form when the app is created' },
  { elementType: 'flow', label: 'Flow', title: 'New flow (concept)', about: 'An automation: what should happen, and when' },
  { elementType: 'actor', label: 'Actor', title: 'New actor / role', about: 'A person or a system that takes part' },
  { elementType: 'note', label: 'Note', title: 'New note', about: 'A sticky note; it is never built' },
  { elementType: 'text', label: 'Text', title: 'New text label', about: 'A label on the canvas' },
  { elementType: 'shape', label: 'Box', title: 'New box', about: 'An outline that other things can sit in', icon: Square, extra: { shape: 'rect' } },
  { elementType: 'shape', label: 'Circle', title: 'New circle', about: 'An outlined circle', icon: CircleIcon, extra: { shape: 'circle' } },
  { elementType: 'shape', label: 'Triangle', title: 'New triangle', about: 'An outlined triangle', icon: Triangle, extra: { shape: 'triangle' } },
];
/** The tools that stand for something the app will have come first; the drawing aids follow. */
const BUILT_TOOLS = 3;

/** One tool of the toolbar's strip: 32px for a mouse. */
const TOOL_BUTTON = 'flex h-8 min-w-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-600 hover:bg-primary-50 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:hover:bg-primary-500/10 dark:hover:text-primary-300';
/** A toolbar button that stands alone on a phone: a finger's 44px there. */
const TOUCH_TOOL = 'max-sm:h-11 max-sm:min-w-11';

/** Left target + right source connection dots — EVERYTHING connectable gets them
 *  (owner direction: notes, images, shapes and text link up too; ink stays a stroke). */
const CONNECTOR_DOT =
  '!h-2.5 !w-2.5 !border-2 !border-white !bg-primary-500 dark:!border-slate-900';

/** The handle that covers a whole card while a line is drawn to it (see CardTarget). */
const CARD_HANDLE = 'card';

/**
 * A dot on every side — start OR end a wire from any of them (ConnectionMode.Loose) — and, while
 * a line is being drawn from another card, the whole card to end it on.
 */
function Connectors({ id, ghost = false }: { id: string; ghost?: boolean }) {
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} className={CONNECTOR_DOT} />
      <Handle id="r" type="source" position={Position.Right} className={CONNECTOR_DOT} />
      <Handle id="b" type="source" position={Position.Bottom} className={CONNECTOR_DOT} />
      <Handle id="l" type="source" position={Position.Left} className={CONNECTOR_DOT} />
      {/* A card the AI only proposes is not there yet: nothing is linked to it. */}
      {!ghost && <CardTarget id={id} />}
    </>
  );
}

/**
 * While a line is drawn from another card, this card takes it anywhere on it: a dot is hard to
 * hit, with a finger above all. The line is then joined to the side that faces where it came
 * from (DiagramCanvas's link), so this handle is never an edge's end.
 */
function CardTarget({ id }: { id: string }) {
  const from = useConnection((connection) => (connection.inProgress ? connection.fromNode.id : null));
  if (from === null || from === id) return null;
  return <Handle id={CARD_HANDLE} type="target" position={Position.Left} isConnectableStart={false} className="sketch-card-target" />;
}

/** What a card is, in a word, under its title. */
const KIND_WORDS: Record<string, string> = {
  form: 'Form', flow: 'Flow', actor: 'Actor', app: 'App', screen: 'Screen', event: 'Event', intelligence: 'AI step',
  service: 'Service', decision: 'Decision', group: 'Group',
};

function BlueprintNodeCard({ id, data, selected }: NodeProps) {
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
        <Connectors id={id} ghost={d.ghost} />
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
        <Connectors id={id} ghost={d.ghost} />
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
        <Connectors id={id} ghost={d.ghost} />
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
        <Connectors id={id} ghost={d.ghost} />
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
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
        {KIND_WORDS[d.elementType] ?? d.elementType}
        {d.elementType === 'form' && d.fields.length > 0 ? ` · ${d.fields.length} field${d.fields.length === 1 ? '' : 's'}` : ''}
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
              <span className="flex-none text-gray-500 dark:text-slate-400">{SKETCH_FIELD_WORDS[field.type]?.short ?? field.type}</span>
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
      <Connectors id={id} ghost={d.ghost} />
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

const NODE_TYPES = { blueprint: BlueprintNodeCard };

/** The ends of the lines, drawn pointing at the card: a crow's foot (many), a bar (one), an arrow. */
function LineEnds() {
  const line = { stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' };
  return (
    <svg width="0" height="0" className="absolute text-slate-400 dark:text-slate-500" aria-hidden="true">
      <defs>
        <marker id="sketch-many" viewBox="0 0 16 16" refX="16" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M2 8 L16 1 M2 8 L16 8 M2 8 L16 15" {...line} />
        </marker>
        <marker id="sketch-one" viewBox="0 0 16 16" refX="16" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M9 1 L9 15 M13 1 L13 15" {...line} />
        </marker>
        <marker id="sketch-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M1 1 L11 6 L1 11 Z" fill="currentColor" stroke="none" />
        </marker>
      </defs>
    </svg>
  );
}

/** A new card's size, before it is drawn and measured: room is found for it by this. */
function sizeOf(elementType: string, extra?: Record<string, unknown>): { w: number; h: number } {
  if (elementType === 'shape') return { w: Number(extra?.w) || 160, h: Number(extra?.h) || 110 };
  if (elementType === 'note') return { w: 176, h: 104 };
  if (elementType === 'text') return { w: 140, h: 40 };
  if (elementType === 'form') return { w: 200, h: 64 };
  return { w: 180, h: 64 };
}

/** A card in a few words, for a list of what to link to. */
function summaryOf(element: BlueprintElement): string {
  const properties = element.properties as { title?: unknown; text?: unknown };
  const kind = KIND_WORDS[element.elementType] ?? (element.elementType === 'note' ? 'Note' : element.elementType === 'text' ? 'Text' : element.elementType === 'image' ? 'Image' : element.elementType === 'shape' ? 'Shape' : element.elementType);
  const words = typeof properties.title === 'string' && properties.title.trim() ? properties.title.trim()
    : typeof properties.text === 'string' && properties.text.trim() ? properties.text.trim().replace(/\s+/g, ' ') : '';
  return words ? `${kind}: ${words.length > 40 ? `${words.slice(0, 39)}…` : words}` : kind;
}

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
      const anchors = element.properties as { sourceHandle?: unknown; targetHandle?: unknown };
      // A line's own name, where it has one; else what it means, in words, and ends to say so.
      const ends = lineEnds(props.edgeType, props.cardinality);
      const named = (element.properties as { label?: unknown }).label;
      edges.push({
        id: element.id,
        source: String(props.sourceId ?? ''),
        target: String(props.targetId ?? ''),
        ...(typeof anchors.sourceHandle === 'string' && anchors.sourceHandle !== CARD_HANDLE ? { sourceHandle: anchors.sourceHandle } : {}),
        ...(typeof anchors.targetHandle === 'string' && anchors.targetHandle !== CARD_HANDLE ? { targetHandle: anchors.targetHandle } : {}),
        label: typeof named === 'string' && named.trim() ? named : ends.label,
        ...(ends.start ? { markerStart: ends.start } : {}),
        ...(ends.end ? { markerEnd: ends.end } : {}),
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
  sidePanelOpen = false,
  onSelect,
}: {
  blueprint: Blueprint;
  /** Deferred drafts: creates the blueprint row on the first change (id '' until then). */
  onEnsureId?: () => Promise<string | null>;
  onReload: () => Promise<void>;
  onRevisions: (semantic: number, layout: number) => void;
  /** The page's own side panel (its timeline) is open. Only one side panel stands beside the
      canvas at a time, so when it opens the selection, and with it this canvas's panel, is let go. */
  sidePanelOpen?: boolean;
  /** Something was selected and its panel opened: the page closes its own. */
  onSelect?: () => void;
}) {
  const elements = useMemo(() => blueprint.elements ?? [], [blueprint.elements]);
  const initial = useMemo(() => toCanvas(elements), [elements]);
  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [rfEdges, setRfEdges] = useState<Edge[]>(initial.edges);
  const [canvasSource, setCanvasSource] = useState<typeof initial | null>(null);
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) => setRfEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  // The phone's list of sketch tools (a sheet): the toolbar has no room for ten of them there.
  const [toolsOpen, setToolsOpen] = useState(false);
  const navigate = useNavigate();
  const reactFlow = useReactFlow();
  // The canvas's own box on the screen: what is in view, and its middle, where a new card goes.
  const paneRef = useRef<HTMLDivElement | null>(null);
  // Everything selected (a shift-click or a drag round several selects more than one), one per
  // line: a string, so the same selection said again changes nothing.
  const [selectedKey, setSelectedKey] = useState('');
  const selectedIds = useMemo(() => (selectedKey === '' ? [] : selectedKey.split('\n')), [selectedKey]);

  // Lets go of the selection: its panel closes (what was typed in it is kept as a draft).
  const deselect = useCallback(() => {
    setNodes((current) => (current.some((node) => node.selected) ? current.map((node) => (node.selected ? { ...node, selected: false } : node)) : current));
    setRfEdges((current) => (current.some((edge) => edge.selected) ? current.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)) : current));
    setSelectedId(null);
    setSelectedKey('');
  }, []);

  // Each card's box on the canvas, where it is drawn (a card in a box: where that is on the canvas).
  const boxOf = useCallback((id: string): Box | null => {
    const node = reactFlow.getNode(id);
    if (!node) return null;
    const at = reactFlow.getInternalNode(id)?.internals.positionAbsolute ?? node.position;
    return { x: at.x, y: at.y, w: node.measured?.width ?? node.width ?? 180, h: node.measured?.height ?? node.height ?? 64 };
  }, [reactFlow]);

  /**
   * Where a new card of this size goes: near where it was wanted (else the middle of what is in
   * view), never over another card; and if that is out of view, the view goes to it.
   */
  const placeFor = useCallback((size: { w: number; h: number }, want?: Spot): Spot => {
    const pane = paneRef.current?.getBoundingClientRect();
    const middle = pane && pane.width > 0 ? reactFlow.screenToFlowPosition({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }) : { x: 240, y: 180 };
    const taken = reactFlow.getNodes().map((node) => boxOf(node.id)).filter((box): box is Box => box !== null);
    // A phone's canvas is narrow: the next card goes below the last, not off the side of the screen.
    const lean = pane && pane.width < 640 ? { x: 3, y: 1 } : { x: 1, y: 1 };
    const spot = freeSpot(want ?? { x: middle.x - size.w / 2, y: middle.y - size.h / 2 }, size, taken, lean);
    if (pane && pane.width > 0) {
      const topLeft = reactFlow.screenToFlowPosition({ x: pane.left, y: pane.top });
      const bottomRight = reactFlow.screenToFlowPosition({ x: pane.right, y: pane.bottom });
      if (spot.x < topLeft.x || spot.y < topLeft.y || spot.x + size.w > bottomRight.x || spot.y + size.h > bottomRight.y) {
        void reactFlow.setCenter(spot.x + size.w / 2, spot.y + size.h / 2, { zoom: reactFlow.getZoom(), duration: 300 });
      }
    }
    return spot;
  }, [boxOf, reactFlow]);
  // The selection the page was last told of (see onSelectionChange).
  const announcedSelectionRef = useRef<string | null>(null);
  // The page's side panel opened: one side panel at a time (state derived during render, the
  // sanctioned pattern, so the two never show together for a frame).
  const [pagePanelWasOpen, setPagePanelWasOpen] = useState(sidePanelOpen);
  if (pagePanelWasOpen !== sidePanelOpen) {
    setPagePanelWasOpen(sidePanelOpen);
    if (sidePanelOpen && selectedId !== null) deselect();
  }
  // The CURRENT semantic revision (updated by every commit) — held in a ref so callbacks
  // never carry a stale precondition after a sibling commit in the same session.
  const semanticRef = useRef(blueprint.semanticRevision);

  // Card-level editing callbacks ride refs so node data stays stable even though
  // `commit` is declared further down.
  const addFieldRef = useRef<(elementId: string, name: string) => void>(() => undefined);
  const setTextRef = useRef<(elementId: string, text: string) => void>(() => undefined);
  const resizeRef = useRef<(elementId: string, w: number, h: number) => void>(() => undefined);

  if (canvasSource !== initial) {
    setCanvasSource(initial);
    // What was selected stays selected when the diagram comes back after a change (a Save, a
    // line from "Link to"): its panel stays open.
    const kept = new Set(selectedKey === '' ? [] : selectedKey.split('\n'));
    setRfEdges(initial.edges.map((edge) => (kept.has(edge.id) ? { ...edge, selected: true } : edge)));
    setNodes(
      initial.nodes.map((node) => ({
        ...node,
        ...(kept.has(node.id) ? { selected: true } : {}),
        data: {
          ...node.data,
          onAddField: (name: string) => addFieldRef.current(node.id, name),
          onSetText: (text: string) => setTextRef.current(node.id, text),
          onResize: (w: number, h: number) => resizeRef.current(node.id, w, h),
        },
      })),
    );
  }
  useEffect(() => {
    semanticRef.current = blueprint.semanticRevision;
  }, [blueprint.semanticRevision]);

  // FIFO mutation queue (audit FL-14): callers fire `void commit(...)` from many
  // handlers, so without serialization two same-tick semantic commits both read
  // semanticRef BEFORE either response lands — the loser 409s, reloads, and the
  // user's intended operation is dropped. Each queued commit therefore waits for
  // its predecessor and picks up the revision that predecessor returned.
  const commitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const commitPendingRef = useRef(0);

  const performCommit = useCallback(
    async (operations: BlueprintOperation[], semantic: boolean): Promise<boolean> => {
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
    },
    [blueprint.id, onEnsureId, onReload, onRevisions],
  );

  const commit = useCallback(
    (operations: BlueprintOperation[], semantic: boolean): Promise<boolean> => {
      commitPendingRef.current += 1;
      setBusy(true);
      const task = commitQueueRef.current.then(() => performCommit(operations, semantic));
      commitQueueRef.current = task
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          commitPendingRef.current -= 1;
          if (commitPendingRef.current === 0) setBusy(false);
        });
      return task;
    },
    [performCommit],
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
  // Without a point it goes in the middle of what is in view; either way, never over another card.
  const sketchElement = useCallback(
    (elementType: string, title: string, extra?: Record<string, unknown>, position?: { x: number; y: number }) => {
      const base: Record<string, unknown> = elementType === 'form'
        ? { title, fields: [] }
        : elementType === 'shape'
          ? { w: 160, h: 110 }
          : elementType === 'text'
            ? {}
            : { title };
      const size = sizeOf(elementType, extra);
      const at = placeFor(size, position ? { x: position.x - size.w / 2, y: position.y - size.h / 2 } : undefined);
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: elementType as BlueprintOperation['elementType'],
            properties: { ...base, ...extra },
            layout: { x: at.x, y: at.y },
          },
        ],
        true,
      );
    },
    [commit, placeFor],
  );

  /**
   * A line from one card to another. Its MEANING comes from what it connects (§11.5); it joins
   * each card at the dot it was drawn from or to, or else at the side that faces the other card
   * (a line ended anywhere on a card, or made from the panel's "Link to").
   */
  const link = useCallback(
    (source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null) => {
      // Both ends must be on the diagram (not a card the AI only proposes, which is not there yet).
      if (source === target || !elements.some((element) => element.id === source) || !elements.some((element) => element.id === target)) return;
      // §11A D2: form→form is an ER RELATION (1:N, FK suggested from the source title; the D3
      // materialiser turns it into a linked_record field), anything→flow is a TRIGGER, and
      // actor→anything is USES ("this role works with that").
      const typeOf = (id: string) => elements.find((element) => element.id === id)?.elementType;
      const sourceType = typeOf(source);
      const targetType = typeOf(target);
      let properties: Record<string, unknown> | null = null;
      if (sourceType === 'form' && targetType === 'form') {
        const sourceTitle = String(
          (elements.find((element) => element.id === source)?.properties as { title?: unknown } | undefined)?.title ?? 'parent',
        );
        const fkField = sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'parent';
        properties = { edgeType: 'relation', sourceId: source, targetId: target, cardinality: '1:N', fkField, state: 'concept' };
      } else if (targetType === 'flow') {
        properties = { edgeType: 'triggers', sourceId: source, targetId: target, state: 'concept' };
      } else if (sourceType === 'flow' && targetType === 'form') {
        // The flow PRODUCES records into that form (§11.5 sends-data).
        properties = { edgeType: 'sends-data', sourceId: source, targetId: target, state: 'concept' };
      } else if (sourceType === 'actor') {
        properties = { edgeType: 'uses', sourceId: source, targetId: target, state: 'concept' };
      }
      if (sourceType === 'ink' || targetType === 'ink') {
        return; // strokes are drawings, not connectors
      }
      if (properties === null) {
        // Anything else links generically (owner direction: notes, images, shapes and
        // text connect too) — a plain association with no cardinality or FK.
        properties = { edgeType: 'relation', sourceId: source, targetId: target, state: 'concept' };
      }
      const from = boxOf(source);
      const to = boxOf(target);
      const fromSide = sourceHandle && sourceHandle !== CARD_HANDLE ? sourceHandle : from && to ? facingSide(to, from) : null;
      const toSide = targetHandle && targetHandle !== CARD_HANDLE ? targetHandle : from && to ? facingSide(from, to) : null;
      if (fromSide) properties.sourceHandle = fromSide;
      if (toSide) properties.targetHandle = toSide;
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
    [boxOf, commit, elements],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) link(connection.source, connection.target, connection.sourceHandle, connection.targetHandle);
    },
    [link],
  );

  // §11A D2: double-click empty canvas = a fresh CONCEPT form entity (no resourceRef —
  // the materialiser creates the real form later), centred where it was clicked unless that
  // would cover another card. Zoom-on-double-click is disabled so this gesture is
  // unambiguous; double-clicks on nodes/edges don't land on the pane.
  const onPaneDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return;
      sketchElement('form', 'New form', undefined, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [reactFlow, sketchElement],
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
      const at = placeFor({ w: props.w, h: props.h });
      void commit(
        [
          {
            operationId: `op-${generateId()}`,
            type: 'blueprint.element.create',
            targetId: `el-${generateId()}`,
            elementType: 'image' as BlueprintOperation['elementType'],
            properties: props,
            layout: { x: at.x, y: at.y },
          },
        ],
        true,
      );
    },
    [commit, placeFor],
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
        const at = placeFor({ w: props.w, h: props.h });
        void commit(
          [
            {
              operationId: `op-${generateId()}`,
              type: 'blueprint.element.create',
              targetId: `el-${generateId()}`,
              elementType: 'image' as BlueprintOperation['elementType'],
              properties: props,
              layout: { x: at.x, y: at.y },
            },
          ],
          true,
        );
      });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [commit, placeFor]);

  // Removes everything selected, in one batch (one undo): a card's lines go with it first (the
  // gateway refuses a line to nothing), and what sat in a box that goes stays where it was, on
  // the canvas itself.
  const deleteSelected = useCallback(() => {
    const chosen = new Set([...selectedIds, ...(selectedId ? [selectedId] : [])].filter((id) => elements.some((element) => element.id === id)));
    if (chosen.size === 0) return;
    // A deleted element's unsaved panel draft must not linger and reappear if an id is
    // ever reused (and it is simply dead weight otherwise).
    for (const id of chosen) clearSelectionDraft(id);
    const lines = elements
      .filter((element) => element.elementType === 'edge')
      .filter((element) => {
        const props = element.properties as { sourceId?: string; targetId?: string };
        return chosen.has(element.id) || chosen.has(String(props.sourceId)) || chosen.has(String(props.targetId));
      })
      .map((element) => element.id);
    const released = elements.filter((element) => {
      const parentId = (element.properties as { parentId?: unknown }).parentId;
      return element.elementType !== 'edge' && !chosen.has(element.id) && typeof parentId === 'string' && chosen.has(parentId);
    });
    const operations: BlueprintOperation[] = [
      ...released.flatMap((element): BlueprintOperation[] => {
        const at = reactFlow.getInternalNode(element.id)?.internals.positionAbsolute;
        const properties: Record<string, unknown> = { ...element.properties };
        delete properties.parentId;
        return [
          { operationId: `op-${generateId()}`, type: 'blueprint.element.update', targetId: element.id, properties },
          ...(at ? [{ operationId: `op-${generateId()}`, type: 'blueprint.layout.set' as const, targetId: element.id, layout: { x: Math.round(at.x), y: Math.round(at.y) } }] : []),
        ];
      }),
      ...lines.map((targetId) => ({ operationId: `op-${generateId()}`, type: 'blueprint.element.delete' as const, targetId })),
      ...[...chosen].filter((id) => !lines.includes(id)).map((targetId) => ({ operationId: `op-${generateId()}`, type: 'blueprint.element.delete' as const, targetId })),
    ];
    setSelectedId(null);
    setSelectedKey('');
    void commit(operations, true);
  }, [commit, elements, reactFlow, selectedId, selectedIds]);

  // Delete/Backspace removes what is selected (same edges-first gateway batch as the
  // toolbar button) and Escape lets go of it — unless the user is typing in an input.
  // React Flow's own delete handling stays OFF so nothing bypasses the operation log.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace' && event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (selectedId === null && selectedIds.length === 0) return;
      event.preventDefault();
      if (event.key === 'Escape') deselect();
      else deleteSelected();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [deleteSelected, deselect, selectedId, selectedIds]);

  // On a phone the panel is a sheet over the foot of the canvas: the card it is for is moved into
  // the room above it (and in from the side), so what is being changed stays in sight.
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => {
      const sheet = document.querySelector('[data-selection-panel]')?.getBoundingClientRect();
      const pane = paneRef.current?.getBoundingClientRect();
      const card = paneRef.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(selectedId)}"]`)?.getBoundingClientRect();
      // Only where the panel lies over the canvas, not beside it.
      if (!sheet || !pane || !card || sheet.top >= pane.bottom || sheet.left > pane.left + 8) return;
      const roomTop = pane.top + 56;
      const roomBottom = sheet.top - 16;
      const down = card.top >= roomTop && card.bottom <= roomBottom ? 0 : (roomTop + roomBottom) / 2 - (card.top + card.bottom) / 2;
      const across = card.left < pane.left + 8 ? pane.left + 8 - card.left : card.right > pane.right - 8 ? Math.max(pane.left + 8 - card.left, pane.right - 8 - card.right) : 0;
      if (down === 0 && across === 0) return;
      const viewport = reactFlow.getViewport();
      void reactFlow.setViewport({ ...viewport, x: viewport.x + across, y: viewport.y + down }, { duration: 250 });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [reactFlow, selectedId]);

  // Each line joins its two cards at the sides that face each other, wherever the cards are moved
  // to: a line held to the dot it was drawn from looped round a card moved past the other.
  const shownEdges = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const boxOfNode = (id: string): Box | null => {
      const node = byId.get(id);
      if (!node) return null;
      let x = node.position.x;
      let y = node.position.y;
      let parent = node.parentId ? byId.get(node.parentId) : undefined;
      for (let hop = 0; parent && hop < 8; hop += 1) {
        x += parent.position.x;
        y += parent.position.y;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return { x, y, w: node.measured?.width ?? node.width ?? 180, h: node.measured?.height ?? node.height ?? 64 };
    };
    return rfEdges.map((edge) => {
      const from = boxOfNode(edge.source);
      const to = boxOfNode(edge.target);
      return from && to ? { ...edge, sourceHandle: facingSide(to, from), targetHandle: facingSide(from, to) } : edge;
    });
  }, [nodes, rfEdges]);

  // Tidy up: the sketch laid out left to right along its lines, where it was. Ink strokes stay
  // where they were drawn, and what sits in a box moves with its box. One layout batch (no
  // conflict, one undo); the cards move at once, before the server has answered.
  const tidyUp = useCallback(() => {
    const cards = nodes
      .filter((node) => !node.parentId && (node.data as BlueprintNodeData).elementType !== 'ink')
      .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, w: node.measured?.width ?? node.width ?? 180, h: node.measured?.height ?? node.height ?? 64 }));
    if (cards.length < 2) return;
    const placed = tidy(cards, rfEdges.map((edge) => ({ from: edge.source, to: edge.target })));
    const moved = cards.filter((card) => {
      const spot = placed.get(card.id)!;
      return spot.x !== Math.round(card.x) || spot.y !== Math.round(card.y);
    });
    if (moved.length === 0) return;
    setNodes((current) => current.map((node) => (placed.has(node.id) ? { ...node, position: placed.get(node.id)! } : node)));
    void commit(
      moved.map((card) => ({ operationId: `op-${generateId()}`, type: 'blueprint.layout.set' as const, targetId: card.id, layout: { ...placed.get(card.id)! } })),
      false,
    );
    window.setTimeout(() => { void reactFlow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }); }, 60);
  }, [commit, nodes, reactFlow, rfEdges]);

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
    let timer: number | undefined;
    // The AI can park a proposal from the chat at any moment — poll so the user
    // SEES the ghosts appear without reloading (owner direction: visible AI work).
    // Single-flight recursive timeout (audit FL-20): the next poll is scheduled only
    // after the current one settles, so slow responses can never complete out of
    // order and restore stale proposals or trigger a wrong reload.
    const fetchProposals = () => {
      api.listBlueprintChangeSets(blueprint.id).then(
        (res) => {
          if (cancelled) return;
          timer = window.setTimeout(fetchProposals, 8000);
          if (res.error || !res.data) {
            // A transient API error is NOT "every proposal vanished" (audit FL-20):
            // keep the last successful ghost state and try again next tick.
            return;
          }
          const next = res.data.changeSets ?? [];
          setProposals((previous) => {
            // A proposal that vanished (on a SUCCESSFUL response) was resolved
            // elsewhere (approved in chat → committed): reload so the canvas shows
            // the applied elements.
            if (previous.some((p) => !next.some((n) => n.id === p.id))) void onReload();
            return next;
          });
        },
        () => {
          if (!cancelled) timer = window.setTimeout(fetchProposals, 8000);
        },
      );
    };
    fetchProposals();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
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
      {/* The toolbar is one row. It sizes itself by its own width (@container/tools), which the
          sidebar and a docked chat take their share of: with room every tool says its name;
          with less they are icons; and where ten icons do not fit (a phone) they are a list
          behind "Add", so no tool is ever dropped. */}
      <div className="@container/tools flex-none border-b border-gray-200 bg-white px-2 py-1.5 dark:border-slate-700/60 dark:bg-slate-900 sm:px-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* Narrow: the sketch tools as a list in a sheet, each with its name. */}
        <button
          type="button"
          onClick={() => setToolsOpen(true)}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={toolsOpen}
          title="Add to the diagram"
          className={cn(TOOL_BUTTON, TOUCH_TOOL, 'border border-gray-200 px-2.5 dark:border-slate-700 @xl/tools:hidden')}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add
        </button>
        {/* Sketch tools (§11A): draw the app's shape before anything exists. First what the
            app will have (form, flow, actor), then the drawing aids. */}
        <div role="group" aria-label="Sketch tools" className="hidden items-center gap-0.5 rounded-lg border border-gray-200 p-0.5 dark:border-slate-700 @xl/tools:flex">
          {SKETCH_TOOLS.map((tool, index) => {
            const Icon = tool.icon ?? ELEMENT_ICONS[tool.elementType] ?? Workflow;
            return (
              <span key={tool.title} className="contents">
                {index === BUILT_TOOLS && <span className="mx-0.5 h-5 w-px flex-none bg-gray-200 dark:bg-slate-700" aria-hidden="true" />}
                <button
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
                  className={TOOL_BUTTON}
                >
                  <Icon className="h-4 w-4 flex-none" aria-hidden="true" />
                  <span className="hidden @5xl/tools:inline">{tool.label}</span>
                </button>
              </span>
            );
          })}
          {/* Attach an image from disk (paste works anywhere too). */}
          <button
            type="button"
            title="Attach image"
            aria-label="Attach image"
            disabled={busy}
            onClick={() => imageInputRef.current?.click()}
            className={TOOL_BUTTON}
          >
            <ImagePlus className="h-4 w-4 flex-none" aria-hidden="true" />
            <span className="hidden @5xl/tools:inline">Image</span>
          </button>
        </div>
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
        {/* Pen: freehand ink over the top of everything. Toggle off to pan/select. It is a
            mode, so it stands in the toolbar at every width: what turns it on turns it off. */}
        <button
          type="button"
          title="Draw (freehand ink)"
          aria-label="Draw freehand ink"
          aria-pressed={penMode}
          disabled={busy}
          onClick={() => setPenMode((mode) => !mode)}
          className={cn(
            TOOL_BUTTON,
            TOUCH_TOOL,
            'border border-gray-200 dark:border-slate-700',
            penMode && 'border-primary-600 bg-primary-600 text-primary-foreground hover:bg-primary-600 hover:text-primary-foreground dark:border-primary-600 dark:text-primary-foreground dark:hover:bg-primary-600 dark:hover:text-primary-foreground',
          )}
        >
          <Pencil className="h-4 w-4 flex-none" aria-hidden="true" />
          <span className="hidden @5xl/tools:inline">{penMode ? 'Drawing' : 'Draw'}</span>
        </button>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-gray-400" aria-label="Saving" />}
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:min-w-11"
            disabled={busy || nodes.filter((node) => !node.parentId).length < 2}
            aria-label="Tidy up the diagram"
            title="Lay the diagram out neatly along its lines"
            onClick={tidyUp}
          >
            <LayoutGrid className="h-4 w-4 text-gray-500 dark:text-slate-400" aria-hidden="true" />
            <span className="ml-1.5 hidden @5xl/tools:inline">Tidy up</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:min-w-11"
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
          <Button variant="ghost" size="sm" className="max-sm:min-w-11" disabled={busy || selectedId === null} onClick={deleteSelected} aria-label="Delete selected element" title="Delete what is selected">
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
                  // The App Studio, not an empty Records table: the app has just been
                  // created from a sketch, so the next step is building it out, and a
                  // table with no records in it reads like nothing happened.
                  navigate(`/apps/${res.data.appId}/studio`);
                });
              }}
            >
              Create app
            </Button>
          )}
        </div>
        </div>
      </div>
      {/* The sketch tools as a list (narrow toolbars): the name of each and one line of what it
          is. Choosing one puts it on the canvas, as its button in the wide toolbar does. */}
      <BottomSheet title="Add to the diagram" open={toolsOpen} onClose={() => setToolsOpen(false)}>
        <div className="overflow-y-auto p-2">
          <ul>
            {SKETCH_TOOLS.map((tool) => {
              const Icon = tool.icon ?? ELEMENT_ICONS[tool.elementType] ?? Workflow;
              return (
                <li key={tool.title}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setToolsOpen(false);
                      sketchElement(tool.elementType, `New ${tool.label.toLowerCase()}`, tool.extra);
                    }}
                    className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-white/[0.04]"
                  >
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 dark:text-white">{tool.label}</span>
                      <span className="block text-xs leading-4 text-gray-500 dark:text-slate-400">{tool.about}</span>
                    </span>
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setToolsOpen(false);
                  imageInputRef.current?.click();
                }}
                className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:opacity-50 dark:hover:bg-white/[0.04]"
              >
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300">
                  <ImagePlus className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">Image</span>
                  <span className="block text-xs leading-4 text-gray-500 dark:text-slate-400">A picture from this device</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      </BottomSheet>
      <div className="flex min-h-0 flex-1">
        <div
          ref={paneRef}
          className="sketch-canvas relative min-h-0 min-w-0 flex-1"
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
          {nodes.length === 0 && ghost.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-sm rounded-2xl border border-gray-200/80 bg-white/95 p-5 text-center shadow-sm dark:border-slate-700/60 dark:bg-slate-900/95">
                <MapIcon className="mx-auto h-7 w-7 text-primary-500" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-gray-900 dark:text-white">Sketch the shape of your app</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
                  The forms you sketch become real forms, and the lines between them become links and
                  automations. Nothing is built until you choose to create the app.
                </p>
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => sketchElement('form', 'New form')}
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                >
                  Add your first form
                </Button>
              </div>
            </div>
          )}
          <ReactFlow
          nodes={[...nodes, ...ghost.nodes]}
          edges={[...shownEdges, ...ghost.edges]}
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
          // A card's dot is easy to find, and the line snaps to one when it comes near.
          connectionRadius={36}
          onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
            const id = selectedNodes[0]?.id ?? selectedEdges[0]?.id ?? null;
            setSelectedId(id);
            setSelectedKey([...selectedNodes, ...selectedEdges].map((item) => item.id).join('\n'));
            // The canvas repeats the selection it already has on every render (this handler is
            // new each time): the page is told only when something else becomes selected.
            if (id !== announcedSelectionRef.current) {
              announcedSelectionRef.current = id;
              if (id !== null) onSelect?.();
            }
          }}
          // A sketch of a few cards is shown at its own size, not blown up to fill the screen.
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          {/* At the top left, as in the flow editor: the bottom corners belong to the desktop
              chip and the chat button, which would sit over the zoom buttons. */}
          <Controls position="top-left" orientation="horizontal" showInteractive={false} />
        </ReactFlow>
        {/* How to sketch, as a quiet line over the canvas beside the zoom buttons: in the toolbar
            it took a row of its own wherever the window was not wide, and three on a phone. */}
        <LineEnds />
        {!penMode && (
          <p className="pointer-events-none absolute left-[6.5rem] right-3 top-[15px] z-[5] flex">
            <span className="rounded-md bg-white/85 px-2 py-1 text-[11px] leading-4 text-gray-500 backdrop-blur-sm dark:bg-slate-950/70 dark:text-slate-400">
              <span className="sketch-hint-mouse">Double-click to add a form. To link two things, drag from a dot on one onto the other.</span>
              <span className="sketch-hint-touch">Tap Add to put something here. To link two things, drag from a dot on one onto the other.</span>
            </span>
          </p>
        )}
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
            onClose={deselect}
            // A line to another card without drawing it: on a phone, or from the keyboard.
            linkTargets={selectedElement.elementType === 'edge' || selectedElement.elementType === 'ink'
              ? []
              : elements
                .filter((element) => element.id !== selectedElement.id && element.elementType !== 'edge' && element.elementType !== 'ink')
                .map((element) => ({ id: element.id, label: summaryOf(element) }))}
            onLink={(targetId) => link(selectedElement.id, targetId)}
          />
        )}
      </div>
    </div>
  );
}
