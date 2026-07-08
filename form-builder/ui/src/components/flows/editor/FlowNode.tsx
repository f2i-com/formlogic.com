// FormLogic Flows editor — custom React Flow node.
//
// Renders one graph node from its catalog spec: an accent icon chip, title, a one-line
// plain-language summary, and the spec's handles (condition nodes expose True / False source
// handles that the executor routes on). Desktop-service-backed nodes render a functional
// "Runs on FormLogic Desktop" badge. Styling is native FormLogic Tailwind tokens, light + dark.
//
// Live Wire pass: brand color (primary-*) is reserved for "selected" and "executed" — the only
// two things this canvas is allowed to say in brand color. The rainbow accent survives only on
// the icon chip (ACCENT_CHIP, shared with NodePalette via ./accents). A run (from the current
// Test Run's onNodeStatus, via FlowNodeSignalsContext) draws a slim primary rail down the card's
// left edge and demotes the status pill to an icon-only glyph — the wire delivering into this
// node (FlowEdge) now carries the duration, so the card doesn't need to repeat it.
import { memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, HelpCircle, Loader2, MonitorDown, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Tooltip } from '../../ui/Tooltip';
import { getNodeSpec } from './nodeCatalog';
import { describeNode, declaredInputNames } from './nodeSummary';
import { FlowFormsContext, FlowNodeSignalsContext } from './flowNodeContext';
import { ACCENT_CHIP } from './accents';
import { formatDuration, nodeDurationMs, type NodeRunStatus } from '../runStatus';

const HANDLE_CLS = '!h-2.5 !w-2.5 !border-2 !border-white dark:!border-slate-900';
const HANDLE_TONE: Record<string, string> = {
  default: '!bg-gray-400 dark:!bg-slate-500',
  true: '!bg-emerald-500',
  false: '!bg-red-500',
};

/**
 * The run-status glyph (idle = nothing). Running/done are icon-only now — the run rail down the
 * card's left edge and the beam on the incoming wire already say "running" / "executed", and the
 * wire also carries the duration, so the pill would just be repeating the signal. An sr-only
 * label keeps the state announced to assistive tech. Error keeps its full tooltip pill — the
 * hover message is the only place that error surfaces.
 */
function StatusPill({ run }: { run: NodeRunStatus | undefined }) {
  if (!run) return null;
  if (run.status === 'running') {
    return (
      <span className="inline-flex items-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-500 motion-reduce:animate-none" />
        <span className="sr-only">Running</span>
      </span>
    );
  }
  if (run.status === 'done') {
    const ms = nodeDurationMs(run);
    return (
      <span className="inline-flex items-center">
        <Check className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400" />
        <span className="sr-only">{ms !== null ? `Completed in ${formatDuration(ms)}` : 'Completed'}</span>
      </span>
    );
  }
  return (
    <Tooltip content={run.error || 'Failed'} position="top">
      <span className="inline-flex cursor-default items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-red-700 dark:bg-red-500/15 dark:text-red-300">
        <X className="h-2.5 w-2.5" /> Error
      </span>
    </Tooltip>
  );
}

/** Amber lint badge listing this node's authoring issues on hover/focus. */
function LintBadge({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <Tooltip
      position="top"
      content={
        <span className="block max-w-[220px] space-y-0.5 text-left">
          {issues.map((issue, i) => (
            <span key={i} className="block whitespace-normal">• {issue}</span>
          ))}
        </span>
      }
    >
      <span
        className="nodrag inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300"
        aria-label={`${issues.length} issue${issues.length === 1 ? '' : 's'}: ${issues.join('; ')}`}
      >
        <AlertTriangle className="h-2.5 w-2.5" />
      </span>
    </Tooltip>
  );
}

function FlowNodeInner({ id, type, data, selected }: NodeProps) {
  const typeStr = String(type);
  const spec = getNodeSpec(typeStr);
  const nodeData = (data ?? {}) as Record<string, unknown>;
  const forms = useContext(FlowFormsContext);
  const signals = useContext(FlowNodeSignalsContext);
  const run = signals.status[id];
  const issues = signals.issues[id] ?? [];
  const accentChip = ACCENT_CHIP[spec?.accent ?? 'slate'] ?? ACCENT_CHIP.slate;
  const Icon = spec?.icon ?? HelpCircle;
  const disabled = spec ? !spec.executable : false;
  const isTrigger = typeStr === 'input';
  const triggerInputs = isTrigger ? declaredInputNames(nodeData) : [];
  const summary = spec && !isTrigger ? describeNode(typeStr, nodeData, forms ?? undefined) : null;
  const inputs = spec?.inputs ?? [{ id: 'in', label: 'In' }];
  const outputs = spec?.outputs ?? [{ id: 'out', label: 'Out' }];

  // Run-status ring wins over the selection ring so the live/failed node is unmistakable. Running
  // and selected now both speak in the primary token — the run rail + spinner (below) tell them
  // apart, not the ring color.
  const ringCls =
    run?.status === 'error'
      ? 'ring-2 ring-red-500/70 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
      : run?.status === 'running'
        ? 'ring-2 ring-primary-500/70 dark:ring-primary-400/70 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
        : selected
          ? 'ring-2 ring-primary-500/50 dark:ring-primary-400/50 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
          : undefined;

  // The run rail — a slim primary conductor down the card's left edge while it's live/executed.
  // motion-safe: only the running pulse animates; done/error are static (also fine under
  // prefers-reduced-motion, which motion-safe: already respects).
  const railCls =
    run?.status === 'error'
      ? 'bg-red-500'
      : run?.status === 'running'
        ? 'bg-primary-500 motion-safe:animate-pulse'
        : run?.status === 'done'
          ? 'bg-primary-500 dark:bg-primary-400'
          : null;

  return (
    <div
      className={cn(
        'relative w-56 rounded-xl border bg-white dark:bg-slate-900 shadow-sm transition-shadow',
        'border-gray-200 dark:border-slate-700',
        disabled && 'border-dashed opacity-70',
        ringCls,
      )}
    >
      {railCls && <span aria-hidden="true" className={cn('absolute left-0 top-2 bottom-2 w-[3px] rounded-full', railCls)} />}
      {/* Target handles (left) */}
      {inputs.map((h, i) => (
        <Handle
          key={`t-${h.id}`}
          type="target"
          position={Position.Left}
          id={h.id}
          className={cn(HANDLE_CLS, HANDLE_TONE.default)}
          style={inputs.length > 1 ? { top: `${((i + 1) / (inputs.length + 1)) * 100}%` } : undefined}
        />
      ))}

      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className={cn('flex h-8 w-8 flex-none items-center justify-center rounded-lg', accentChip)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{spec?.label ?? typeStr}</p>
        </div>
        {(issues.length > 0 || run) && (
          <div className="flex flex-none items-center gap-1">
            <LintBadge issues={issues} />
            <StatusPill run={run} />
          </div>
        )}
      </div>

      {isTrigger && (
        <div className="border-t border-gray-100 dark:border-slate-800 px-3 py-2">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Provides</p>
          {triggerInputs.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {triggerInputs.map((name) => (
                <span
                  key={name}
                  className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-gray-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[10px] italic text-gray-400 dark:text-slate-500">No inputs declared yet</p>
          )}
        </div>
      )}

      {/* Always shown for a configurable node (not the trigger, which has its own Provides
          section) so an empty config reads as visible state — "Not configured yet" — instead of
          the card silently shrinking. Keeps card heights stable as fields fill in. Suppressed
          when disabled AND unconfigured: the "Not available in this runtime" note below already
          covers that empty state, so the two gray lines wouldn't say anything new together. A
          disabled node that IS configured still shows its real summary. */}
      {spec && !isTrigger && (summary || !disabled) && (
        <p
          className={cn(
            'border-t border-gray-100 dark:border-slate-800 px-3 py-1.5 text-[11px] leading-snug line-clamp-2',
            summary ? 'text-gray-600 dark:text-slate-400' : 'italic text-gray-400 dark:text-slate-500',
          )}
        >
          {summary ?? 'Not configured yet'}
        </p>
      )}

      {spec?.requiresDesktopService && !disabled && (
        <p className="flex items-center gap-1 border-t border-gray-100 dark:border-slate-800 px-3 py-1 text-[10px] font-medium text-primary-600 dark:text-primary-300">
          <MonitorDown className="h-2.5 w-2.5 flex-none" /> Runs on FormLogic Desktop
        </p>
      )}
      {disabled && (
        <p className="border-t border-dashed border-gray-200 dark:border-slate-700 px-3 py-1 text-[10px] font-medium text-gray-400 dark:text-slate-500">
          Not available in this runtime
        </p>
      )}

      {/* Source handles (right); condition exposes labelled True / False */}
      {outputs.map((h, i) => (
        <div key={`s-${h.id}`}>
          {outputs.length > 1 && (
            <span
              className={cn(
                'pointer-events-none absolute right-3 -translate-y-1/2 text-[9px] font-semibold uppercase tracking-wide',
                h.tone === 'true'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : h.tone === 'false'
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-gray-400 dark:text-slate-500',
              )}
              style={{ top: `${((i + 1) / (outputs.length + 1)) * 100}%` }}
            >
              {h.label}
            </span>
          )}
          <Handle
            type="source"
            position={Position.Right}
            id={h.id}
            className={cn(HANDLE_CLS, HANDLE_TONE[h.tone ?? 'default'])}
            style={outputs.length > 1 ? { top: `${((i + 1) / (outputs.length + 1)) * 100}%` } : undefined}
          />
        </div>
      ))}
      {/* An id anchor so a11y/tests can target the node by its flow id. */}
      <span className="sr-only" data-flow-node-id={id} />
    </div>
  );
}

export const FlowNode = memo(FlowNodeInner);
