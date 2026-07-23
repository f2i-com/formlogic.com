// FormLogic Flows editor — node palette.
//
// Ported from f2i-web's NodePalette: nodes grouped by category, searchable, drag-to-add onto the
// canvas (or click-to-add at the viewport centre). Desktop-service-backed nodes (browser_action /
// image_gen / stt_transcribe / tts_speak) are fully insertable and render a functional "Runs on
// FormLogic Desktop" badge — they execute against a local Desktop service at run time.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, MonitorDown, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/Button';
import {
  NODE_CATEGORIES,
  NODE_SPECS,
  EMPTY_FLOW_EDITOR_CONTEXT,
  isNodeAvailableInContext,
  type FlowEditorContext,
  type NodeSpec,
} from './nodeCatalog';
import { ACCENT_CHIP } from './accents';
import { FlowDesktopPresenceContext } from './flowNodeContext';

// Tiles carry only icon + name now — the description lives in this hover popover, so it
// should appear promptly (but still late enough that drag-pickups don't flash it).
const HOVER_DELAY_MS = 300;
const DESKTOP_OFFLINE_NODE_TOOLTIP = 'FormLogic Desktop is offline — this node will fail at run time';

/** Compact "In / Out" handle summary for the hover popover. */
function handleSummary(handles: { label: string }[]): string {
  return handles.length === 0 ? '—' : handles.map((h) => h.label).join(' / ');
}

/** A delayed hover popover with a node's longer doc + a compact inputs/outputs summary (docs §4). */
function PaletteDoc({ spec, anchor, degraded }: { spec: NodeSpec; anchor: DOMRect; degraded: boolean }) {
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 220));
  const left = anchor.right + 8;
  return (
    <div
      role="tooltip"
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-64 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-xl"
    >
      <p className="text-xs font-semibold text-gray-900 dark:text-white">{spec.label}</p>
      <p className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-slate-400">{spec.doc ?? spec.description}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400 dark:text-slate-500">
        <span><span className="font-medium text-gray-500 dark:text-slate-400">In:</span> {handleSummary(spec.inputs)}</span>
        <span><span className="font-medium text-gray-500 dark:text-slate-400">Out:</span> {handleSummary(spec.outputs)}</span>
      </div>
      {spec.output && (
        <p className="mt-1.5 text-[10px] leading-snug text-gray-400 dark:text-slate-500">
          <span className="font-medium text-gray-500 dark:text-slate-400">Output:</span> {spec.output}
        </p>
      )}
      {spec.requiresDesktopService && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-primary-600 dark:text-primary-300">
          <MonitorDown className="h-2.5 w-2.5" /> Runs on the {spec.requiresDesktopService} service in FormLogic Desktop
        </p>
      )}
      {degraded && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-2.5 w-2.5" /> {DESKTOP_OFFLINE_NODE_TOOLTIP}
        </p>
      )}
      {spec.capability && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-300">Requires the {spec.capability} capability</p>
      )}
    </div>
  );
}

/** dataTransfer MIME the canvas reads on drop. */
export const PALETTE_DND_MIME = 'application/x-formlogic-flow-node';

interface NodePaletteProps {
  /** Add a node at the viewport centre (click / keyboard). */
  onAddNode: (type: string) => void;
  /** App/connector context — hides connector-gated nodes (e.g. aokie_speak) when unavailable (docs §4). */
  context?: FlowEditorContext;
  /** Collapsed to a narrow icon-only rail (space-reclaiming; never hides the panel's existence). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Mobile bottom sheets reuse the same palette without drag affordances or fixed rail width. */
  draggable?: boolean;
  className?: string;
}

function PaletteItem({ spec, onAddNode, draggable = true }: { spec: NodeSpec; onAddNode: (type: string) => void; draggable?: boolean }) {
  const Icon = spec.icon;
  const disabled = !spec.executable;
  const desktop = spec.requiresDesktopService;
  const desktopPresence = useContext(FlowDesktopPresenceContext);
  const degraded = desktopPresence.kind === 'none' && (spec.category === 'desktop' || !!spec.requiresConnector);
  const btnRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [docRect, setDocRect] = useState<DOMRect | null>(null);

  const openDoc = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setDocRect(rect);
    }, HOVER_DELAY_MS);
  };
  const closeDoc = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setDocRect(null);
  };

  // Icon-first tile: big icon + name only; the description (and the desktop-service /
  // capability notes) live in the delayed hover/focus popover.
  return (
    <>
    <button
      ref={btnRef}
      type="button"
      draggable={draggable && !disabled}
      onDragStart={(e) => {
        if (disabled || !draggable) return;
        closeDoc();
        e.dataTransfer.setData(PALETTE_DND_MIME, spec.type);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => { if (!disabled) onAddNode(spec.type); }}
      onMouseEnter={openDoc}
      onMouseLeave={closeDoc}
      onFocus={openDoc}
      onBlur={closeDoc}
      disabled={disabled}
      aria-label={disabled ? `${spec.label} (not available)` : `Add ${spec.label} node`}
      className={cn(
        'group relative flex w-full flex-col items-center gap-1.5 rounded-xl border border-transparent px-1.5 py-2.5 text-center transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-55'
          : cn(
              draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
              'bg-white hover:border-primary-300 hover:bg-primary-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-800/40 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10',
            ),
        degraded && !disabled && 'opacity-60',
      )}
    >
      {desktop && (
        <span
          className={cn(
            'absolute right-1.5 top-1.5',
            degraded ? 'text-amber-500 dark:text-amber-400' : 'text-primary-400 dark:text-primary-300',
          )}
          aria-hidden="true"
        >
          <MonitorDown className="h-3 w-3" />
        </span>
      )}
      <span className={cn('flex h-10 w-10 flex-none items-center justify-center rounded-xl', ACCENT_CHIP[spec.accent] ?? ACCENT_CHIP.slate)}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="line-clamp-2 block w-full text-[11px] font-medium leading-tight text-gray-800 dark:text-slate-200">
        {spec.label}
      </span>
    </button>
    {docRect && <PaletteDoc spec={spec} anchor={docRect} degraded={degraded && !disabled} />}
    </>
  );
}

export function NodePalette({ onAddNode, context = EMPTY_FLOW_EDITOR_CONTEXT, collapsed = false, onToggleCollapsed, draggable = true, className }: NodePaletteProps) {
  const [query, setQuery] = useState('');

  // Collapsing swaps in a whole different (icon-rail) subtree, which unmounts the results list —
  // restore its scroll offset on re-expand rather than snapping back to the top every time.
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const resultsScrollTop = useRef(0);
  useEffect(() => {
    if (!collapsed && resultsRef.current) resultsRef.current.scrollTop = resultsScrollTop.current;
  }, [collapsed]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: NodeSpec) =>
      q === '' ||
      s.label.toLowerCase().includes(q) ||
      s.type.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q);
    return NODE_CATEGORIES.map((cat) => ({
      cat,
      specs: NODE_SPECS.filter((s) => s.category === cat.id && match(s) && isNodeAvailableInContext(s, context)),
    })).filter((g) => g.specs.length > 0);
  }, [query, context]);

  if (collapsed) {
    return (
      <div className={cn('flex h-full min-h-0 w-14 flex-none flex-col items-center gap-2 bg-gray-100/50 py-2.5 dark:bg-slate-900/50', className)}>
        <Button
          variant="ghost"
          size="iconOnly"
          onClick={onToggleCollapsed}
          aria-label="Expand node palette"
          title="Expand node palette"
          className="h-8 w-8"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 w-64 flex-none flex-col bg-gray-100/50 dark:bg-slate-900/50', className)}>
      <div className="flex items-center gap-1.5 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search flow nodes"
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="iconOnly"
            onClick={onToggleCollapsed}
            aria-label="Collapse node palette"
            title="Collapse node palette"
            className="h-8 w-8 flex-none"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div
        ref={resultsRef}
        onScroll={(e) => { resultsScrollTop.current = e.currentTarget.scrollTop; }}
        className={cn(
          'scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-2.5',
          // The docked rail sits behind the floating Desktop-connection chip (fixed
          // bottom-left) — leave clearance so the last tiles stay reachable.
          draggable && 'pb-16',
        )}
      >
        {grouped.length === 0 && (
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">No nodes match "{query}".</p>
        )}
        {grouped.map(({ cat, specs }) => (
          <div key={cat.id}>
            <div className="mb-1.5 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">{cat.label}</p>
              {cat.hint && <p className="text-[10px] text-gray-400 dark:text-slate-600">{cat.hint}</p>}
            </div>
            {/* Icon tiles — auto-fill so the same palette works in the w-64 rail (2-up)
                and the full-width mobile sheet (3+-up). */}
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(6.25rem,1fr))]">
              {specs.map((spec) => (
                <PaletteItem key={spec.type} spec={spec} onAddNode={onAddNode} draggable={draggable} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
