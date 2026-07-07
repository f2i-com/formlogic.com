// FormLogic Flows editor — custom React Flow node.
//
// Renders one graph node from its catalog spec: an accent icon chip, title, type slug, a
// one-line data preview, and the spec's handles (condition nodes expose True / False source
// handles that the executor routes on). Desktop-service-backed nodes render a functional
// "Runs on FormLogic Desktop" badge. Styling is native FormLogic Tailwind tokens, light + dark.
import { memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, HelpCircle, Loader2, MonitorDown, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Tooltip } from '../../ui/Tooltip';
import { getNodeSpec } from './nodeCatalog';
import { describeNode, declaredInputNames } from './nodeSummary';
import { FlowFormsContext, FlowNodeSignalsContext } from './flowNodeContext';
import { formatDuration, nodeDurationMs, type NodeRunStatus } from '../runStatus';

/** Static accent class lookup (Tailwind can't see dynamically-built class names). */
const ACCENT: Record<string, { chip: string; ring: string }> = {
  emerald: { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', ring: 'ring-emerald-400/60' },
  amber: { chip: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', ring: 'ring-amber-400/60' },
  sky: { chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300', ring: 'ring-sky-400/60' },
  violet: { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', ring: 'ring-violet-400/60' },
  cyan: { chip: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300', ring: 'ring-cyan-400/60' },
  indigo: { chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300', ring: 'ring-indigo-400/60' },
  teal: { chip: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300', ring: 'ring-teal-400/60' },
  rose: { chip: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300', ring: 'ring-rose-400/60' },
  slate: { chip: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300', ring: 'ring-slate-400/60' },
};

const HANDLE_CLS = '!h-2.5 !w-2.5 !border-2 !border-white dark:!border-slate-900';
const HANDLE_TONE: Record<string, string> = {
  default: '!bg-gray-400 dark:!bg-slate-500',
  true: '!bg-emerald-500',
  false: '!bg-red-500',
};

/** The coloured run-status pill (idle = nothing). Error pill surfaces the message on hover. */
function StatusPill({ run }: { run: NodeRunStatus | undefined }) {
  if (!run) return null;
  const base = 'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none';
  if (run.status === 'running') {
    return (
      <span className={cn(base, 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300')}>
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Running
      </span>
    );
  }
  if (run.status === 'done') {
    const ms = nodeDurationMs(run);
    return (
      <span className={cn(base, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300')}>
        <Check className="h-2.5 w-2.5" /> {ms !== null ? formatDuration(ms) : 'Done'}
      </span>
    );
  }
  return (
    <Tooltip content={run.error || 'Failed'} position="top">
      <span className={cn(base, 'cursor-default bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300')}>
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
  const accent = ACCENT[spec?.accent ?? 'slate'] ?? ACCENT.slate;
  const Icon = spec?.icon ?? HelpCircle;
  const disabled = spec ? !spec.executable : false;
  const isTrigger = typeStr === 'input';
  const triggerInputs = isTrigger ? declaredInputNames(nodeData) : [];
  const summary = spec && !isTrigger ? describeNode(typeStr, nodeData, forms ?? undefined) : null;
  const inputs = spec?.inputs ?? [{ id: 'in', label: 'In' }];
  const outputs = spec?.outputs ?? [{ id: 'out', label: 'Out' }];

  // Run-status ring wins over the selection ring so the live/failed node is unmistakable.
  const ringCls =
    run?.status === 'error'
      ? 'ring-2 ring-red-500/70 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
      : run?.status === 'running'
        ? 'ring-2 ring-amber-400/70 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
        : selected
          ? cn('ring-2 ring-offset-1 ring-offset-white dark:ring-offset-slate-950', accent.ring)
          : undefined;

  return (
    <div
      className={cn(
        'w-56 rounded-xl border bg-white dark:bg-slate-900 shadow-sm transition-shadow',
        'border-gray-200 dark:border-slate-700',
        disabled && 'border-dashed opacity-70',
        ringCls,
      )}
    >
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
        <span className={cn('flex h-8 w-8 flex-none items-center justify-center rounded-lg', accent.chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{spec?.label ?? typeStr}</p>
          <p className="truncate text-[10px] text-gray-400 dark:text-slate-500">
            {isTrigger ? 'When this runs' : typeStr}
          </p>
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
                  className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
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

      {summary && (
        <p className="border-t border-gray-100 dark:border-slate-800 px-3 py-1.5 text-[11px] leading-snug text-gray-600 dark:text-slate-400 line-clamp-2">
          {summary}
        </p>
      )}

      {spec?.requiresDesktopService && !disabled && (
        <p className="flex items-center gap-1 border-t border-gray-100 dark:border-slate-800 px-3 py-1 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
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
