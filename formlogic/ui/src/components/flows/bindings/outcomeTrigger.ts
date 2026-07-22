// FormLogic Flows - "Another Flow" outcome-trigger helpers (extensible-flows plan §9.1).
//
// Outcome bindings (flow.succeeded/failed/timed_out/cancelled) filter to one source flow
// via an ordinary binding condition over the event payload. The trigger editor manages
// that condition through these helpers so authors pick a flow instead of hand-writing the
// expression; the expression itself stays the enforcement surface (evaluated fail-safe at
// claim time by whichever runtime claims the handler run — it never runs server-side).
export const FLOW_OUTCOME_EVENTS = ['flow.succeeded', 'flow.failed', 'flow.timed_out', 'flow.cancelled'] as const;

export type FlowOutcomeEvent = (typeof FLOW_OUTCOME_EVENTS)[number];

export function isFlowOutcomeEvent(event: string): event is FlowOutcomeEvent {
  return (FLOW_OUTCOME_EVENTS as readonly string[]).includes(event);
}

// Flow ids are server-minted UUIDs; the charset gate keeps the generated expression
// injection-proof and makes the parser refuse anything it could not have written.
const FLOW_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MANAGED_CONDITION_PATTERN = /^event\.data\.flowId\s*===\s*'([A-Za-z0-9-]{1,64})'$/;

/** The managed source-flow filter expression, or null when the id is not expression-safe. */
export function sourceFlowCondition(flowId: string): string | null {
  if (!FLOW_ID_PATTERN.test(flowId)) return null;
  return `event.data.flowId === '${flowId}'`;
}

/**
 * Parse a condition the picker manages. Returns the source flow id when the expression is
 * exactly the managed shape, null otherwise (empty = "any flow", anything else = custom —
 * the picker must leave custom conditions alone).
 */
export function sourceFlowFromCondition(expr: string): string | null {
  const match = MANAGED_CONDITION_PATTERN.exec(expr.trim());
  return match ? match[1] : null;
}
