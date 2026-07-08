// FormLogic Flows editor — custom React Flow edge.
//
// A smooth bezier connection with an arrow head, a WIDE invisible hit-path (BaseEdge's
// interactionWidth) so edges are easy to grab, a thicker stroke when selected, and — when
// selected — an inline "×" delete control at the edge midpoint (via EdgeLabelRenderer). Idle
// condition branches are tinted (True = emerald, False = red) so the routing reads at a glance.
// Native FormLogic tokens, light + dark.
//
// Live Wire run-beam: FlowCanvas injects `data.run` (an EdgeRunState from runStatus.ts's
// deriveEdgeRunStates) onto the presentation copy of each edge — never into the persisted graph.
// Once a hop has actually run, its run state takes over from the idle branch tint entirely:
// 'active' draws a dashed primary beam animating source→target (the .flow-beam keyframe, which
// prefers-reduced-motion turns static — see index.css), 'done' leaves the wire lit at 40% primary
// with a small mono duration chip at the midpoint, and 'failed' turns it red (the node's own
// error tooltip carries the message, so the wire gets no label). Selection always wins the
// stroke ladder, and the delete control and the duration chip never render at the same time.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { edgeLabelTransform } from './canvasOps';
import { formatDuration, type EdgeRunState } from '../runStatus';

export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  markerEnd,
  selected,
  data,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const run = (data as { run?: EdgeRunState } | undefined)?.run;

  // Idle tint by the condition branch the edge leaves from (true / false), else neutral. Only
  // applies before the hop has ever run — once it has, the run ladder below is the sole signal.
  const branch = sourceHandleId === 'true' ? 'true' : sourceHandleId === 'false' ? 'false' : 'default';
  const idleCls =
    branch === 'true'
      ? '!stroke-emerald-400/70 dark:!stroke-emerald-500/60'
      : branch === 'false'
        ? '!stroke-red-400/70 dark:!stroke-red-500/60'
        : '!stroke-gray-300 dark:!stroke-slate-600';

  // Stroke ladder: selected > run state > idle branch tint.
  const isBeam = !selected && run?.phase === 'active';
  const strokeCls =
    selected || run?.phase === 'active'
      ? '!stroke-primary-500 dark:!stroke-primary-400'
      : run?.phase === 'failed'
        ? '!stroke-red-500/70 dark:!stroke-red-400/70'
        : run?.phase === 'done'
          ? '!stroke-primary-500/40 dark:!stroke-primary-400/40'
          : idleCls;
  const strokeWidth = selected || run?.phase === 'active' ? 2.5 : run?.phase === 'failed' || run?.phase === 'done' ? 2 : 1.5;

  // The delete "×" and the duration chip share the midpoint — never both at once.
  const durationLabel =
    !selected && run?.phase === 'done' && run.showDuration && run.durationMs !== null ? formatDuration(run.durationMs) : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={20}
        className={cn('transition-[stroke] duration-150', strokeCls, isBeam && 'flow-beam')}
        style={{ strokeWidth }}
      />
      {(selected || durationLabel !== null) && (
        <EdgeLabelRenderer>
          {selected ? (
            <button
              type="button"
              className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-red-500/40 dark:hover:bg-red-500/10 dark:hover:text-red-300"
              style={{ transform: edgeLabelTransform(labelX, labelY) }}
              onClick={(e) => {
                e.stopPropagation();
                void deleteElements({ edges: [{ id }] });
              }}
              aria-label="Delete connection"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <span
              className="pointer-events-none absolute rounded-full bg-primary-50 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-primary-700 ring-1 ring-primary-500/30 dark:bg-primary-950 dark:text-primary-300"
              style={{ transform: edgeLabelTransform(labelX, labelY) }}
            >
              {durationLabel}
            </span>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}
