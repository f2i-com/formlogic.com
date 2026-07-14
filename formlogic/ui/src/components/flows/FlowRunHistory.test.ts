// FlowRunHistory's run-status chip: a 'done' run whose only reply-carrying output action
// threw (docs/FORMLOGIC_FLOWS.md, flowDispatcher.ts's `executeRun`) must read visually
// distinct from a clean success — otherwise the run-history UI shows a plain green "done"
// chip even when e.g. a live-call binding's "speak the reply" action silently failed.
//
// `statusChipStyle`/`hasActionErrors` live in runHistoryChip.ts (pure, no JSX/DOM) so this
// can run without a rendering harness (this project has neither @testing-library/react nor a
// jsdom vitest environment configured yet — see vitest.config.ts) and so FlowRunHistory.tsx
// stays a components-only export (react-refresh/only-export-components).
import { describe, expect, it } from 'vitest';
import { hasActionErrors, statusChipStyle } from './runHistoryChip';
import type { FlowRunLog } from '../../types/flows';

function run(overrides: Partial<FlowRunLog> = {}): FlowRunLog {
  return {
    runId: 'run-1',
    appId: null,
    formId: null,
    responseId: null,
    bindingId: 'b1',
    flowDefinitionId: null,
    flow: 'echo',
    triggerEvent: 'form.submitted',
    correlationId: 'c1',
    idempotencyKey: 'k1',
    status: 'done',
    runtime: null,
    claimedBy: null,
    inputSnapshot: null,
    result: null,
    outputActions: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-07-09T00:00:00Z',
    ...overrides,
  };
}

describe('hasActionErrors', () => {
  it('false when result is null (the common case)', () => {
    expect(hasActionErrors(run({ result: null }))).toBe(false);
  });

  it('false when result has no outputActionErrors key', () => {
    expect(hasActionErrors(run({ result: { value: 'ok' } }))).toBe(false);
  });

  it('false when outputActionErrors is present but empty', () => {
    expect(hasActionErrors(run({ result: { outputActionErrors: [] } }))).toBe(false);
  });

  it('true when outputActionErrors has at least one entry', () => {
    expect(hasActionErrors(run({ result: { outputActionErrors: ['call.speak: plugin busy'] } }))).toBe(true);
  });
});

describe('statusChipStyle', () => {
  it('a plain done run (no action errors) gets the emerald "done" chip — unchanged from before this fix', () => {
    const style = statusChipStyle(run({ status: 'done', result: { value: 'ok' } }));
    expect(style.label).toBe('done');
    expect(style.cls).toContain('emerald');
    expect(style.cls).not.toContain('amber');
  });

  it('a done run WITH action errors gets a distinct amber "done (action failed)" chip', () => {
    const style = statusChipStyle(run({ status: 'done', result: { outputActionErrors: ['call.speak: plugin busy'] } }));
    expect(style.label).toBe('done (action failed)');
    expect(style.cls).toContain('amber');
    expect(style.cls).not.toContain('emerald');
  });

  it('error/timeout/cancelled runs stay red regardless of result content', () => {
    for (const status of ['error', 'timeout', 'cancelled'] as const) {
      const style = statusChipStyle(run({ status, result: { outputActionErrors: ['x'] } }));
      expect(style.cls).toContain('red');
      expect(style.label).toBe(status);
    }
  });

  it('running/queued stay blue', () => {
    for (const status of ['running', 'queued'] as const) {
      const style = statusChipStyle(run({ status }));
      expect(style.cls).toContain('blue');
    }
  });
});
