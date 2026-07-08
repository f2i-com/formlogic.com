import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './formlogic.worker';

// engine.ts spawns a real browser Worker (formlogic.worker.ts -> quickjs-host.ts, a real WASM
// QuickJS VM) — we can't and shouldn't run that under Vitest. This fake simulates the SAME
// postMessage/onmessage protocol so the budget plumbing this suite exists to pin down
// (docs/FORMLOGIC_FLOWS.md §4: a node's declared `timeoutMs` must become the sandbox's REAL
// interrupt deadline) is tested deterministically via fake timers, with no real WASM/timing
// flakiness.
type FakeBehavior =
  | { kind: 'reply'; delayMs: number; response: Omit<WorkerResponse, 'id'> }
  | { kind: 'hang' }; // never replies — exercises engine.ts's hard-backstop watchdog

let behavior: FakeBehavior = { kind: 'reply', delayMs: 0, response: { ok: true, result: null } };
let lastRequest: WorkerRequest | null = null;

class FakeWorker {
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private terminated = false;

  postMessage(msg: WorkerRequest): void {
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
});
