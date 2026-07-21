// FormLogic Flows — "Run on" execution location (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md
// §5.7, Phase 5): per-flow Auto / Desktop / Cloud selection helpers.
//
// The backend exposes `executionLocation` on flow read/update ('auto' | 'desktop' |
// 'cloud', default 'auto') and records the as-executed location on every run row
// ('browser' | 'desktop' | 'cloud'). The shared types/flows.ts interfaces predate the
// column, so the field is read structurally here until those interfaces catch up.
import type { FlowExecutionLocation, FlowRunExecutedLocation } from '../../../lib/api';

export type { FlowExecutionLocation, FlowRunExecutedLocation };

/** The as-configured location of a flow; anything absent/unknown reads as 'auto' (zero-change default). */
export function flowExecutionLocation(flow: { executionLocation?: unknown } | null | undefined): FlowExecutionLocation {
  const value = flow?.executionLocation;
  return value === 'desktop' || value === 'cloud' ? value : 'auto';
}

/** One-line option copy (plan §5.7). */
export const EXECUTION_LOCATION_DESCRIPTIONS: Record<FlowExecutionLocation, string> = {
  auto: 'Let FormLogic decide (browser or your desktop)',
  desktop: 'Your FormLogic Desktop (private, unmetered)',
  cloud: 'FormLogic Cloud (uses plan credits)',
};

/** Run-history Location cell: the as-executed location, '—' when the row predates the column. */
export function runLocationLabel(executionLocation: unknown): string {
  return executionLocation === 'browser' || executionLocation === 'desktop' || executionLocation === 'cloud'
    ? executionLocation
    : '—';
}

/**
 * Feedback from an attempted cloud run, surfaced back to the editor chrome:
 *  - 'unsupported': the cloud runner refused specific nodes (cloud_unsupported_node) —
 *    the editor warns inline but the Cloud selection stays saveable (plan §5.7);
 *  - 'unavailable': the server has no cloud-run concept at all (typed refusal / missing
 *    route) — the editor disables the Cloud option with this reason;
 *  - 'ok': a cloud run went through — clears any earlier warning.
 */
export type CloudRunFeedback =
  | { kind: 'unsupported'; nodes: string[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ok' };
