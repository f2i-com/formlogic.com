// FormLogic Flows editor — the "Run on" dropdown (plan §5.7: Auto / Desktop / Cloud)
// plus the inline notices that belong with it (cloud unsupported-node warning, cloud
// unavailable reason). Pure presentation: the workspace owns persistence and the
// feedback state; the editor toolbar owns placement.
import { AlertTriangle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { EXECUTION_LOCATION_DESCRIPTIONS, type FlowExecutionLocation } from './executionLocation';

const SELECT_CLS =
  'min-h-9 min-w-[5.75rem] max-w-full flex-none cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1 sm:text-xs';

export function ExecutionLocationSelect({
  value,
  onChange,
  cloudDisabledReason = null,
  compact = false,
}: {
  value: FlowExecutionLocation;
  onChange: (location: FlowExecutionLocation) => void;
  /** When set, the Cloud option is disabled and this reason explains why (title/aria). */
  cloudDisabledReason?: string | null;
  /** Tiny toolbars drop the visible "Run on" label (the select keeps its aria-label). */
  compact?: boolean;
}) {
  const cloudTitle = cloudDisabledReason ?? EXECUTION_LOCATION_DESCRIPTIONS.cloud;
  return (
    <div className="flex flex-none items-center gap-1.5">
      <label
        htmlFor="flow-execution-location"
        className={cn('text-xs text-gray-500 dark:text-slate-400', compact && 'sr-only')}
      >
        Run on
      </label>
      <select
        id="flow-execution-location"
        aria-label="Run on"
        value={value}
        onChange={(e) => onChange(e.target.value as FlowExecutionLocation)}
        title={EXECUTION_LOCATION_DESCRIPTIONS[value]}
        className={SELECT_CLS}
      >
        <option value="auto" title={EXECUTION_LOCATION_DESCRIPTIONS.auto}>
          Auto
        </option>
        <option value="desktop" title={EXECUTION_LOCATION_DESCRIPTIONS.desktop}>
          Desktop
        </option>
        <option value="cloud" disabled={!!cloudDisabledReason} title={cloudTitle}>
          Cloud
        </option>
      </select>
    </div>
  );
}

/**
 * The inline warning strip under the editor toolbar:
 *  - cloud_unsupported_node: name the offending nodes; the Cloud selection STAYS
 *    saveable (the run refuses until the graph changes — run-time honesty, plan §5.7);
 *  - cloud unavailable: a saved Cloud selection that can no longer execute here.
 * Renders nothing for Auto/Desktop with no feedback.
 */
export function ExecutionLocationNotice({
  value,
  cloudDisabledReason = null,
  cloudUnsupportedNodes = null,
}: {
  value: FlowExecutionLocation;
  cloudDisabledReason?: string | null;
  cloudUnsupportedNodes?: string[] | null;
}) {
  if (value === 'cloud' && cloudDisabledReason) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <p>
          Cloud runs are unavailable here: {cloudDisabledReason} Switch Run on to Auto or Desktop, or pick Cloud again later.
        </p>
      </div>
    );
  }
  if (value === 'cloud' && cloudUnsupportedNodes && cloudUnsupportedNodes.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <p>
          FormLogic Cloud can't run this flow yet — unsupported node{cloudUnsupportedNodes.length === 1 ? '' : 's'}:{' '}
          <span className="font-medium">{cloudUnsupportedNodes.join(', ')}</span>. The setting stays saved; cloud runs will
          refuse until those nodes change. Switch to Auto or Desktop to run it now.
        </p>
      </div>
    );
  }
  return null;
}
