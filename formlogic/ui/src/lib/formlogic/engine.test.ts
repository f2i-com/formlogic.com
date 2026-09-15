import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './formlogic.worker';

vi.mock('./zipp-bytes', () => ({
  getZippWasmBytes: vi.fn(async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer),
}));

// engine.ts spawns a real browser Worker (formlogic.worker.ts -> zipp-host.ts, a real WASM
// ZIPP VM) — we can't and shouldn't run that under Vitest. This fake simulates the SAME
// postMessage/onmessage protocol so the budget plumbing this suite exists to pin down
// (docs/FORMLOGIC_FLOWS.md §4: a node's declared `timeoutMs` must size the Worker watchdog,
// the sandbox's only wall-clock limit) is tested deterministically via fake timers, with no
// real WASM/timing flakiness. The real-engine behaviour of each kind is covered by
// flowEval.test.ts and corpusParity.test.ts.
type FakeBehavior =
  | { kind: 'reply'; delayMs: number; response: Omit<WorkerResponse, 'id'> }
  | { kind: 'hang' }; // never replies — exercises engine.ts's hard-backstop watchdog

let behavior: FakeBehavior = { kind: 'reply', delayMs: 0, response: { ok: true, result: null } };
let lastRequest: WorkerRequest | null = null;

class FakeWorker {
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private terminated = false;

  postMessage(msg: WorkerRequest | WorkerInit): void {
    if ('type' in msg) {
      // The real worker becomes ready only after the page supplies its bytes.
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data: { id: 0, ok: true, ready: true } });
      });
      return;
    }
    lastRequest = msg;
    const b = behavior;
    if (b.kind === 'hang') return;
    setTimeout(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: { id: msg.id, ...b.response } });
    }, b.delayMs);
  }

  terminate(): void {
    this.terminated = true;
  }
}

vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

// engine.ts's watchdog constants (kept in sync manually — there is no export for them; a
// drift here would just make these tests fail loudly, which is the point).
const DEFAULT_BUDGET_MS = 1000;
const WATCHDOG_GRACE_MS = 1500;

describe('engine.ts — Flows timeout-budget plumbing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    behavior = { kind: 'reply', delayMs: 0, response: { ok: true, result: null } };
    lastRequest = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('calculateValue (useFormLogic.ts calculated fields) — UNCHANGED contract', () => {
    it('defaults to DEFAULT_BUDGET_MS and swallows a budget overrun to null (no 3rd arg passed)', async () => {
      const { calculateValue } = await import('./engine');
      behavior = { kind: 'hang' };
      const promise = calculateValue('slow()', { a: 1 });
      let settled: { ok: boolean; value?: unknown } | null = null;
      promise.then((v) => (settled = { ok: true, value: v }));

      // Just under the default backstop (budget + grace) — must not have settled yet.
      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + WATCHDOG_GRACE_MS - 50);
      expect(settled).toBeNull();

      // Past the default backstop — resolves to null (swallowed), never rejects.
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toEqual({ ok: true, value: null });
      // Confirms the request actually used the DEFAULT budget (no override was ever sent).
      expect(lastRequest?.budgetMs).toBe(DEFAULT_BUDGET_MS);
    });

    it('swallows a guest runtime error to null, same as before', async () => {
      const { calculateValue } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 0, response: { ok: false, error: 'ReferenceError: x is not defined' } };
      const promise = calculateValue('x + 1', {});
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeNull();
    });

    it('resolves the real value on a normal (fast) evaluation', async () => {
      const { calculateValue } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 5, response: { ok: true, result: 42 } };
      const p = calculateValue('40 + 2', {});
      await vi.advanceTimersByTimeAsync(5);
      await expect(p).resolves.toBe(42);
    });
  });

  describe('evaluateCondition (useFormLogic.ts conditional fields) — UNCHANGED default, NEW optional budgetMs', () => {
    it('defaults to DEFAULT_BUDGET_MS and THROWS on a budget overrun when no budgetMs is passed (useConditionalLogic call shape)', async () => {
      const { evaluateCondition } = await import('./engine');
      behavior = { kind: 'hang' };
      const promise = evaluateCondition('slow()', {});
      const caught = vi.fn();
      promise.catch(caught);

      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + WATCHDOG_GRACE_MS - 50);
      expect(caught).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).rejects.toThrow();
      expect(lastRequest?.budgetMs).toBe(DEFAULT_BUDGET_MS);
    });

    it('honors an explicit longer budgetMs — a slow-but-legitimate evaluation now succeeds where the default would have timed out', async () => {
      const { evaluateCondition } = await import('./engine');
      // Reply arrives at 3000ms: past the DEFAULT backstop (2500ms) but well inside a
      // node-declared 6000ms budget.
      behavior = { kind: 'reply', delayMs: 3000, response: { ok: true, result: true } };
      const promise = evaluateCondition('slowButLegit()', {}, 6000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(promise).resolves.toBe(true);
      expect(lastRequest?.budgetMs).toBe(6000);
    });

    it('control: the SAME slow evaluation against the DEFAULT budget times out (proves the fix is real, not a no-op)', async () => {
      const { evaluateCondition } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 3000, response: { ok: true, result: true } };
      const promise = evaluateCondition('slowButLegit()', {}); // no override -> DEFAULT_BUDGET_MS
      const caught = vi.fn();
      promise.catch(caught);
      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGET_MS + WATCHDOG_GRACE_MS);
      await expect(promise).rejects.toThrow();
    });

    it('still THROWS (never swallows) on a guest runtime error, with a custom budgetMs', async () => {
      const { evaluateCondition } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 0, response: { ok: false, error: 'boom' } };
      const promise = evaluateCondition('x.y.z', {}, 4000);
      // Attach the assertion (which internally handles the rejection) BEFORE advancing
      // fake timers, so the promise is never "unhandled" even for a tick.
      const assertion = expect(promise).rejects.toThrow(/boom/);
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      expect(lastRequest?.budgetMs).toBe(4000);
    });
  });

  describe('calculateValueForFlow (Flows logic_block ONLY) — NEW non-swallowing variant', () => {
    it('rejects (does NOT resolve to null) on a budget overrun — logic_block must fail the run loudly', async () => {
      const { calculateValueForFlow } = await import('./engine');
      behavior = { kind: 'hang' };
      const promise = calculateValueForFlow('slow()', {}, 6000);
      const caught = vi.fn();
      promise.catch(caught);

      await vi.advanceTimersByTimeAsync(6000 + WATCHDOG_GRACE_MS - 50);
      expect(caught).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).rejects.toThrow();
      expect(lastRequest?.budgetMs).toBe(6000);
    });

    it('honors an explicit longer budgetMs — succeeds where the hardcoded default would have silently produced null', async () => {
      const { calculateValueForFlow } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 3000, response: { ok: true, result: { total: 7 } } };
      const promise = calculateValueForFlow('slowButLegit()', {}, 6000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(promise).resolves.toEqual({ total: 7 });
    });

    it('rejects (does NOT swallow) on a guest runtime error', async () => {
      const { calculateValueForFlow } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 0, response: { ok: false, error: 'TypeError: cannot read x' } };
      const promise = calculateValueForFlow('x.y', {});
      const assertion = expect(promise).rejects.toThrow(/cannot read x/);
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
    });

    it('defaults to DEFAULT_BUDGET_MS when no budgetMs is given', async () => {
      const { calculateValueForFlow } = await import('./engine');
      behavior = { kind: 'reply', delayMs: 1, response: { ok: true, result: 1 } };
      const promise = calculateValueForFlow('1', {});
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(lastRequest?.budgetMs).toBe(DEFAULT_BUDGET_MS);
    });
  });

  describe('evaluation kind per entry point — only the Flows logic_block evaluator uses the flow kind', () => {
    it.each([
      ['calculateValue', 'calc'],
      ['evaluateCondition', 'condition'],
      ['calculateValueForFlow', 'flow'],
    ] as const)('%s sends kind %s', async (name, kind) => {
      const engine = await import('./engine');
      behavior = { kind: 'reply', delayMs: 0, response: { ok: true, result: true } };
      const promise = engine[name]('1', {});
      await vi.advanceTimersByTimeAsync(0);
      await promise;
      expect(lastRequest?.kind).toBe(kind);
    });
  });
});

// ---------------------------------------------------------------------------
// Audit ZP-01: the Worker (and its WASM instance) is recycled on MEASURED
// retention or after a lifetime evaluation count, only when nothing is in flight.
// ---------------------------------------------------------------------------
describe('engine.ts — instance recycling (ZP-01)', () => {
  let spawned = 0;
  let usageToReport: WorkerResponse['usage'] | undefined;
  class CountingWorker {
    onmessage: ((e: { data: WorkerResponse }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    terminated = false;
    constructor() { spawned += 1; }
    postMessage(msg: WorkerRequest | WorkerInit): void {
      if ('type' in msg) { queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: { id: 0, ok: true, ready: true } }); }); return; }
      setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: { id: msg.id, ok: true, result: 1, usage: usageToReport } }); }, 5);
    }
    terminate(): void { this.terminated = true; }
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    spawned = 0;
    usageToReport = { enginesCreated: 1, enginesDisposed: 1, retainedBytes: 0, dynamicCodeCalls: 2 };
    vi.stubGlobal('Worker', CountingWorker as unknown as typeof Worker);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function evaluateOnce(engine: typeof import('./engine')) {
    const promise = engine.calculateValue('1', {});
    await vi.advanceTimersByTimeAsync(10);
    return promise;
  }

  it('keeps one Worker while the instance stays within budget', async () => {
    const engine = await import('./engine');
    for (let i = 0; i < 5; i++) await evaluateOnce(engine);
    expect(spawned).toBe(1);
    const status = engine.getEngineInstanceStatus();
    expect(status.currentWorkerEvaluations).toBe(5);
    expect(status.workersRecycled).toBe(0);
    expect(status.lastUsage?.retainedBytes).toBe(0);
  });

  it('recycles the Worker once the reported retention exceeds the budget, after the call completes', async () => {
    const engine = await import('./engine');
    await evaluateOnce(engine);
    expect(spawned).toBe(1);
    usageToReport = { enginesCreated: 400, enginesDisposed: 400, retainedBytes: engine.INSTANCE_RETAINED_BUDGET_BYTES, dynamicCodeCalls: 800 };
    await expect(evaluateOnce(engine)).resolves.toBe(1); // the triggering call still succeeds
    expect(engine.getEngineInstanceStatus().workersRecycled).toBe(1);
    // The next call gets a FRESH instance, whose counters start again.
    usageToReport = { enginesCreated: 1, enginesDisposed: 1, retainedBytes: 100, dynamicCodeCalls: 2 };
    await evaluateOnce(engine);
    expect(spawned).toBe(2);
    expect(engine.getEngineInstanceStatus().currentWorkerEvaluations).toBe(1);
  });

  it('never recycles while another evaluation is in flight', async () => {
    const engine = await import('./engine');
    usageToReport = { enginesCreated: 1, enginesDisposed: 1, retainedBytes: engine.INSTANCE_RETAINED_BUDGET_BYTES, dynamicCodeCalls: 1 };
    const first = engine.calculateValue('1', {});
    const second = engine.calculateValue('2', {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    // Both replies arrived on the same Worker; recycling waited for the last one.
    expect(spawned).toBe(1);
    expect(engine.getEngineInstanceStatus().workersRecycled).toBe(1);
    await evaluateOnce(engine);
    expect(spawned).toBe(2);
  });

  it('recycles after the lifetime evaluation count even when retention is not reported', async () => {
    const engine = await import('./engine');
    usageToReport = undefined;
    for (let i = 0; i < engine.INSTANCE_MAX_EVALUATIONS; i++) await evaluateOnce(engine);
    expect(engine.getEngineInstanceStatus().workersRecycled).toBe(1);
    await evaluateOnce(engine);
    expect(spawned).toBe(2);
  });
});
