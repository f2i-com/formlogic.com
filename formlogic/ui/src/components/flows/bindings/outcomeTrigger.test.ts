// §9.1 "Another Flow" outcome-trigger helpers: the managed source-flow condition must
// round-trip exactly, and anything the picker could not have written must parse as null
// (custom conditions are the author's — the picker never rewrites them).
import { describe, expect, it } from 'vitest';
import {
  FLOW_OUTCOME_EVENTS,
  isFlowOutcomeEvent,
  sourceFlowCondition,
  sourceFlowFromCondition,
} from './outcomeTrigger';

describe('isFlowOutcomeEvent', () => {
  it('accepts exactly the four canonical outcome events', () => {
    expect(FLOW_OUTCOME_EVENTS).toEqual(['flow.succeeded', 'flow.failed', 'flow.timed_out', 'flow.cancelled']);
    for (const event of FLOW_OUTCOME_EVENTS) expect(isFlowOutcomeEvent(event)).toBe(true);
    expect(isFlowOutcomeEvent('form.submitted')).toBe(false);
    expect(isFlowOutcomeEvent('flow.call')).toBe(false);
    expect(isFlowOutcomeEvent('flow.succeeded ')).toBe(false);
  });
});

describe('sourceFlowCondition', () => {
  it('writes the managed expression for a UUID-shaped id', () => {
    expect(sourceFlowCondition('e2e19da6-dbb4-47e0-9250-7280f8f60ed2'))
      .toBe("event.data.flowId === 'e2e19da6-dbb4-47e0-9250-7280f8f60ed2'");
  });

  it('refuses ids outside the expression-safe charset', () => {
    expect(sourceFlowCondition("x' || true || '")).toBeNull();
    expect(sourceFlowCondition('')).toBeNull();
    expect(sourceFlowCondition('a'.repeat(65))).toBeNull();
  });
});

describe('sourceFlowFromCondition', () => {
  it('round-trips what sourceFlowCondition writes', () => {
    const id = 'e2e19da6-dbb4-47e0-9250-7280f8f60ed2';
    expect(sourceFlowFromCondition(sourceFlowCondition(id) ?? '')).toBe(id);
  });

  it('tolerates surrounding whitespace and spacing around ===', () => {
    expect(sourceFlowFromCondition("  event.data.flowId === 'abc-123'  ")).toBe('abc-123');
    expect(sourceFlowFromCondition("event.data.flowId==='abc-123'")).toBe('abc-123');
  });

  it('treats anything else as a custom condition (null)', () => {
    expect(sourceFlowFromCondition('')).toBeNull();
    expect(sourceFlowFromCondition("event.data.flowId === 'abc' && event.data.depth > 1")).toBeNull();
    expect(sourceFlowFromCondition('event.data.flowId === "abc"')).toBeNull();
    expect(sourceFlowFromCondition("event.data.flowSlug === 'abc'")).toBeNull();
    expect(sourceFlowFromCondition("event.data.flowId !== 'abc'")).toBeNull();
  });
});
