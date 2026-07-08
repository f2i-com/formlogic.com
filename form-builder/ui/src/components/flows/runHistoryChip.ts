// Pure status→chip mapping for FlowRunHistory.tsx, split into its own module (matching
// runStatus.ts's pattern in this directory) so it's unit-testable without a DOM/React-
// rendering harness (this project has neither @testing-library/react nor a jsdom vitest
// environment set up yet — see vitest.config.ts) AND so FlowRunHistory.tsx can stay a
// components-only export (react-refresh/only-export-components).
import type { FlowRunLog } from '../../types/flows';

/** A 'done' run whose `result.outputActionErrors` is non-empty — the flow graph succeeded but
 * a downstream output action threw (docs/FORMLOGIC_FLOWS.md — see flowDispatcher.ts's
 * `executeRun`). Same terminal status as a clean success; the run-history chip is the one
 * place a user would otherwise have no visual cue that a side effect (e.g. speaking the reply
 * on a live call) silently failed. */
export function hasActionErrors(run: FlowRunLog): boolean {
  const errors = run.result?.outputActionErrors;
  return Array.isArray(errors) && errors.length > 0;
}

/**
 * Status→{class, label} mapping for the run-history chip. 'done' with action errors gets its
 * own amber/warning variant (consistent with the amber "sync binding" callout in
 * FormFlowBindings.tsx) instead of the plain emerald "done" chip, which would otherwise be
 * indistinguishable from a clean success.
 */
export function statusChipStyle(run: FlowRunLog): { cls: string; label: string } {
  const { status } = run;
  if (status === 'done' && hasActionErrors(run)) {
    return {
      cls: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-200/70 dark:border-amber-500/25',
      label: 'done (action failed)',
    };
  }
  if (status === 'done') {
    return {
      cls: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-200/70 dark:border-emerald-500/25',
      label: status,
    };
  }
  if (status === 'running' || status === 'queued') {
    return {
      cls: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200/70 dark:border-blue-500/25',
      label: status,
    };
  }
  return {
    cls: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 border-red-200/70 dark:border-red-500/25',
    label: status,
  };
}
