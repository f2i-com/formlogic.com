// Run-status reducer (runStatus.ts): folds the executor's onNodeStatus event stream into the
// per-node status map (canvas pills) + the ordered run log (Test Run timeline). Pure — the
// canvas + drawer both derive their view from these, so the folding must be deterministic.
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RUN_LOG,
  deriveEdgeRunStates,
  formatDuration,
  nodeDurationMs,
  previewOutput,
  reduceNodeStatus,
  reduceRunLog,
  type NodeStatusMap,
  type RunnableEdge,
} from './runStatus';

describe('reduceNodeStatus', () => {
  it('seeds startedAt on running and marks running', () => {
    const m = reduceNodeStatus({}, 'a', 'running', undefined, 1000);
    expect(m.a).toEqual({ status: 'running', startedAt: 1000 });
  });

  it('running → done keeps startedAt, sets endedAt + output (duration derivable)', () => {
    let m: NodeStatusMap = {};
    m = reduceNodeStatus(m, 'a', 'running', undefined, 1000);
    m = reduceNodeStatus(m, 'a', 'done', { output: { ok: true } }, 1120);
    expect(m.a.status).toBe('done');
    expect(m.a.startedAt).toBe(1000);
    expect(m.a.endedAt).toBe(1120);
    expect(m.a.output).toEqual({ ok: true });
    expect(nodeDurationMs(m.a)).toBe(120);
  });

  it('running → error records the message and clears no prior timing', () => {
    let m: NodeStatusMap = {};
    m = reduceNodeStatus(m, 'boom', 'running', undefined, 5);
    m = reduceNodeStatus(m, 'boom', 'error', { error: 'no dongle' }, 25);
    expect(m.boom.status).toBe('error');
    expect(m.boom.error).toBe('no dongle');
    expect(nodeDurationMs(m.boom)).toBe(20);
  });

  it('is pure — does not mutate the input map', () => {
    const before: NodeStatusMap = { a: { status: 'done' } };
    const after = reduceNodeStatus(before, 'b', 'running', undefined, 1);
    expect(before).toEqual({ a: { status: 'done' } });
    expect(after).not.toBe(before);
    expect(after.a).toBe(before.a); // untouched entries are reused by reference
  });

  it('a settled node with no timing yields null duration', () => {
    const m = reduceNodeStatus({}, 'x', 'done', { output: 1 }, 10);
    expect(nodeDurationMs(m.x)).toBeNull(); // never saw 'running'
  });
});

describe('reduceRunLog', () => {
  it('records first-seen order once per node and tracks the map', () => {
    let log = EMPTY_RUN_LOG;
    log = reduceRunLog(log, 'in', 'running', undefined, 0);
    log = reduceRunLog(log, 'in', 'done', { output: 1 }, 10);
    log = reduceRunLog(log, 'mid', 'running', undefined, 10);
    log = reduceRunLog(log, 'mid', 'done', { output: 2 }, 30);
    log = reduceRunLog(log, 'out', 'running', undefined, 30);
    log = reduceRunLog(log, 'out', 'error', { error: 'boom' }, 33);
    expect(log.order).toEqual(['in', 'mid', 'out']);
    expect(log.map.in.status).toBe('done');
    expect(log.map.out.status).toBe('error');
    expect(nodeDurationMs(log.map.mid)).toBe(20);
  });

  it('is pure and starts from a shared empty log without leaking state', () => {
    const a = reduceRunLog(EMPTY_RUN_LOG, 'a', 'running', undefined, 1);
    expect(EMPTY_RUN_LOG).toEqual({ map: {}, order: [] });
    expect(a.order).toEqual(['a']);
  });
});

describe('deriveEdgeRunStates', () => {
  const notCondition = () => undefined;
  const edge = (id: string, source: string, target: string, sourceHandle?: string | null): RunnableEdge => ({
    id,
    source,
    target,
    sourceHandle,
  });

  it('a linear chain: the executed hop is done, the currently-running hop is active', () => {
    const status: NodeStatusMap = {
      a: { status: 'done', startedAt: 0, endedAt: 10 },
      b: { status: 'done', startedAt: 10, endedAt: 30 },
      c: { status: 'running', startedAt: 30 },
    };
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')];
    const states = deriveEdgeRunStates(edges, notCondition, status);
    expect(states.e1).toEqual({ phase: 'done', durationMs: 20, showDuration: true });
    expect(states.e2).toEqual({ phase: 'active', durationMs: null, showDuration: false });
  });

  it('leaves an edge out entirely when its source has not settled, or its target never ran', () => {
    const status: NodeStatusMap = { a: { status: 'running', startedAt: 0 } };
    const edges = [edge('e1', 'a', 'b')];
    expect(deriveEdgeRunStates(edges, notCondition, status)).toEqual({});
  });

  it('condition routing: only the branch matching the source output branch lights up, even when the un-taken branch\'s target ran via another edge', () => {
    const isCondition = (id: string) => (id === 'cond' ? 'condition' : undefined);
    const status: NodeStatusMap = {
      cond: { status: 'done', startedAt: 0, endedAt: 5, output: true },
      t: { status: 'done', startedAt: 5, endedAt: 15 },
      f: { status: 'done', startedAt: 5, endedAt: 15 }, // settled via some other route
    };
    const edges = [edge('e-true', 'cond', 't', 'true'), edge('e-false', 'cond', 'f', 'false')];
    const states = deriveEdgeRunStates(edges, isCondition, status);
    expect(states['e-true'].phase).toBe('done');
    expect(states['e-false']).toBeUndefined(); // un-taken branch stays dark
  });

  it('a handle-less condition edge follows the truthy branch (matches the executor default)', () => {
    const isCondition = () => 'condition';
    const trueOut: NodeStatusMap = {
      cond: { status: 'done', startedAt: 0, endedAt: 5, output: true },
      next: { status: 'done', startedAt: 5, endedAt: 10 },
    };
    const falseOut: NodeStatusMap = {
      cond: { status: 'done', startedAt: 0, endedAt: 5, output: false },
      next: { status: 'done', startedAt: 5, endedAt: 10 },
    };
    const edges = [edge('e1', 'cond', 'next')]; // no sourceHandle
    expect(deriveEdgeRunStates(edges, isCondition, trueOut).e1.phase).toBe('done');
    expect(deriveEdgeRunStates(edges, isCondition, falseOut).e1).toBeUndefined();
  });

  it('dedupes a multi-input join: only the first qualifying done-edge shows the duration', () => {
    const status: NodeStatusMap = {
      a1: { status: 'done', startedAt: 0, endedAt: 5 },
      a2: { status: 'done', startedAt: 0, endedAt: 5 },
      join: { status: 'done', startedAt: 5, endedAt: 20 },
    };
    const edges = [edge('e1', 'a1', 'join'), edge('e2', 'a2', 'join')];
    const states = deriveEdgeRunStates(edges, notCondition, status);
    expect(states.e1).toEqual({ phase: 'done', durationMs: 15, showDuration: true });
    expect(states.e2).toEqual({ phase: 'done', durationMs: 15, showDuration: false });
  });

  it('a failed hop is "failed" and never shows a duration label', () => {
    const status: NodeStatusMap = {
      a: { status: 'done', startedAt: 0, endedAt: 5 },
      b: { status: 'error', startedAt: 5, endedAt: 12, error: 'boom' },
    };
    const edges = [edge('e1', 'a', 'b')];
    const states = deriveEdgeRunStates(edges, notCondition, status);
    expect(states.e1).toEqual({ phase: 'failed', durationMs: 7, showDuration: false });
  });
});

describe('formatDuration / previewOutput', () => {
  it('formats sub-second in ms and seconds with one decimal', () => {
    expect(formatDuration(12)).toBe('12ms');
    expect(formatDuration(950)).toBe('950ms');
    expect(formatDuration(1400)).toBe('1.4s');
    expect(formatDuration(12000)).toBe('12s');
  });

  it('previews scalars, objects and caps length', () => {
    expect(previewOutput(undefined)).toBe('—');
    expect(previewOutput('hi')).toBe('hi');
    expect(previewOutput({ a: 1 })).toBe('{"a":1}');
    expect(previewOutput('x'.repeat(200)).length).toBeLessThanOrEqual(120);
    expect(previewOutput('a\n\n  b')).toBe('a b');
  });
});
