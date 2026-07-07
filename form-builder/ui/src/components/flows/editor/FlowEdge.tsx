// FormLogic Flows editor — custom React Flow edge.
//
// A smooth bezier connection with an arrow head, a WIDE invisible hit-path (BaseEdge's
// interactionWidth) so edges are easy to grab, a thicker stroke when selected, and — when
// selected — an inline "×" delete control at the edge midpoint (via EdgeLabelRenderer). Condition
// branches are tinted (True = emerald, False = red) so the routing reads at a glance. Native
// FormLogic tokens, light + dark.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { edgeLabelTransform } from './canvasOps';

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

  // Tint by the condition branch the edge leaves from (true / false), else neutral.
  const branch = sourceHandleId === 'true' ? 'true' : sourceHandleId === 'false' ? 'false' : 'default';
  const strokeCls = selected
    ? '!stroke-primary-500 dark:!stroke-primary-400'
    : branch === 'true'
      ? '!stroke-emerald-400/70 dark:!stroke-emerald-500/60'
      : branch === 'false'
        ? '!stroke-red-400/70 dark:!stroke-red-500/60'
        : '!stroke-gray-300 dark:!stroke-slate-600';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={20}
        className={cn('transition-[stroke] duration-150', strokeCls)}
        style={{ strokeWidth: selected ? 2.5 : 1.5 }}
      />
      {selected && (
        <EdgeLabelRenderer>
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
        </EdgeLabelRenderer>
      )}
    </>
  );
}
