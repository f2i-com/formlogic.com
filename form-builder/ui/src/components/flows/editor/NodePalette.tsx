// FormLogic Flows editor — node palette.
//
// Ported from f2i-web's NodePalette: nodes grouped by category, searchable, drag-to-add onto the
// canvas (or click-to-add at the viewport centre). Desktop-service-backed nodes (browser_action /
// image_gen / stt_transcribe / tts_speak) are fully insertable and render a functional "Runs on
// FormLogic Desktop" badge — they execute against a local Desktop service at run time.
import { useMemo, useRef, useState } from 'react';
import { MonitorDown, Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  NODE_CATEGORIES,
  NODE_SPECS,
  EMPTY_FLOW_EDITOR_CONTEXT,
  isNodeAvailableInContext,
  type FlowEditorContext,
  type NodeSpec,
} from './nodeCatalog';

const HOVER_DELAY_MS = 450;

/** Compact "In / Out" handle summary for the hover popover. */
function handleSummary(handles: { label: string }[]): string {
  return handles.length === 0 ? '—' : handles.map((h) => h.label).join(' / ');
}

/** A delayed hover popover with a node's longer doc + a compact inputs/outputs summary (docs §4). */
function PaletteDoc({ spec, anchor }: { spec: NodeSpec; anchor: DOMRect }) {
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
        <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
          <MonitorDown className="h-2.5 w-2.5" /> Runs on the {spec.requiresDesktopService} service in FormLogic Desktop
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

const ACCENT_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  cyan: 'bg-cyan-500',
  indigo: 'bg-indigo-500',
  teal: 'bg-teal-500',
  rose: 'bg-rose-500',
  slate: 'bg-slate-400',
};

interface NodePaletteProps {
  /** Add a node at the viewport centre (click / keyboard). */
  onAddNode: (type: string) => void;
  /** App/connector context — hides connector-gated nodes (e.g. aokie_speak) when unavailable (docs §4). */
  context?: FlowEditorContext;
}

function PaletteItem({ spec, onAddNode }: { spec: NodeSpec; onAddNode: (type: string) => void }) {
  const Icon = spec.icon;
  const disabled = !spec.executable;
  const desktop = spec.requiresDesktopService;
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

  return (
    <>
    <button
      ref={btnRef}
      type="button"
      draggable={!disabled}
      onDragStart={(e) => {
        if (disabled) return;
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
        'group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
        'border-gray-200/80 dark:border-slate-700/60',
        disabled
          ? 'cursor-not-allowed opacity-55'
          : 'cursor-grab bg-white hover:border-primary-300 hover:bg-primary-50/50 dark:bg-slate-800/40 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
      )}
    >
      <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-md bg-gray-100 text-gray-600 dark:bg-slate-700/60 dark:text-slate-300">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 flex-none rounded-full', ACCENT_DOT[spec.accent] ?? ACCENT_DOT.slate)} />
          <span className="truncate text-xs font-medium text-gray-800 dark:text-slate-200">{spec.label}</span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-gray-400 dark:text-slate-500">
          {spec.description}
        </span>
        {desktop && (
          <span className="mt-1 inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <MonitorDown className="h-2.5 w-2.5" /> Runs on FormLogic Desktop
          </span>
        )}
      </span>
    </button>
    {docRect && <PaletteDoc spec={spec} anchor={docRect} />}
    </>
  );
}

export function NodePalette({ onAddNode, context = EMPTY_FLOW_EDITOR_CONTEXT }: NodePaletteProps) {
  const [query, setQuery] = useState('');

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

  return (
    <div className="flex h-full min-h-0 w-64 flex-none flex-col border-r border-gray-200/80 dark:border-slate-700/60 bg-gray-50/60 dark:bg-slate-900/40">
      <div className="border-b border-gray-200/80 dark:border-slate-700/60 p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search flow nodes"
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 space-y-4">
        {grouped.length === 0 && (
          <p className="px-1 text-xs text-gray-400 dark:text-slate-500">No nodes match "{query}".</p>
        )}
        {grouped.map(({ cat, specs }) => (
          <div key={cat.id}>
            <div className="mb-1.5 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">{cat.label}</p>
              {cat.hint && <p className="text-[10px] text-gray-400 dark:text-slate-600">{cat.hint}</p>}
            </div>
            <div className="space-y-1.5">
              {specs.map((spec) => (
                <PaletteItem key={spec.type} spec={spec} onAddNode={onAddNode} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
