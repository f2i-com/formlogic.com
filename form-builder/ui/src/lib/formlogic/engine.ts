import { logger } from '../logger';
import type { EvalKind } from './quickjs-host';
import type { WorkerRequest, WorkerResponse } from './formlogic.worker';

// ---------------------------------------------------------------------------
// FormLogic evaluation engine (browser).
//
// User-authored expressions/formulas run inside a QuickJS WASM sandbox hosted in
// a dedicated Web Worker (see quickjs-host.ts / formlogic.worker.ts). This module
// is a thin, stable client: it owns the worker lifecycle and a hard wall-clock
// watchdog that terminates+respawns the worker if an evaluation overruns (the
// backstop for the rare expression QuickJS can't interrupt in-VM, e.g. a
// catastrophic regex). The exported function surface is unchanged from the
// previous WASM engine, so hooks and editors need no changes.
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 1000; // in-VM interrupt deadline
const WATCHDOG_GRACE_MS = 1500; // extra time before we hard-kill the worker

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function spawnWorker(): Worker {
  const w = new Worker(new URL('./formlogic.worker.ts', import.meta.url), {
    type: 'module',
  });
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (ok) {
      entry.resolve(result);
    } else {
      entry.reject(new Error(error || 'Expression evaluation failed'));
    }
  };
  w.onerror = (event) => {
    // A worker-level error invalidates all in-flight work; fail them and respawn
    // lazily on the next call.
    failAll(new Error(event.message || 'FormLogic worker crashed'));
    terminateWorker();
  };
  return w;
}

function getWorker(): Worker {
  if (!worker) {
    worker = spawnWorker();
  }
  return worker;
}

function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function failAll(reason: Error): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

function evaluate(
  kind: EvalKind,
  expression: string,
  context: Record<string, unknown>,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<unknown> {
  const w = getWorker();
  const id = nextId++;
  const request: WorkerRequest = { id, kind, expression, context, budgetMs };

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Hard backstop: the in-VM interrupt should have fired by now. If we're
      // here, the VM is wedged — kill the worker, fail every in-flight call, and
      // let the next call respawn a clean worker.
      pending.delete(id);
      reject(new Error('Expression evaluation timed out'));
      failAll(new Error('FormLogic worker terminated after timeout'));
      terminateWorker();
    }, budgetMs + WATCHDOG_GRACE_MS);

    pending.set(id, { resolve, reject, timer });
    w.postMessage(request);
  });
}

// ---------------------------------------------------------------------------
// Public API (signature-compatible with the previous engine)
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition expression with form data context.
 * Throws on error so the caller (useConditionalLogic) can distinguish
 * "condition is false" from "condition errored" and fail OPEN.
 *
 * `budgetMs` defaults to DEFAULT_BUDGET_MS, preserving the exact existing
 * behavior for useConditionalLogic (which never passes one). FormLogic Flows'
 * `condition` node (flowDispatcher.ts) passes its own clamped `data.timeoutMs`
 * so the sandbox's real interrupt deadline matches the node's declared budget
 * instead of always falling back to this default.
 */
export async function evaluateCondition(
  expression: string,
  formData: Record<string, unknown>,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<boolean> {
  try {
    const result = await evaluate('condition', expression, formData, budgetMs);
    return Boolean(result);
  } catch (error) {
    logger.error('Error evaluating condition:', error);
    throw error instanceof Error ? error : new Error('Condition evaluation failed');
  }
}

/**
 * Validate a field value with a custom expression.
 * Returns null if valid, or an error message string if invalid.
 */
export async function validateWithExpression(
  expression: string,
  value: unknown,
  formData: Record<string, unknown>
): Promise<string | null> {
  try {
    const context = { ...formData, value };
    const result = await evaluate('validate', expression, context);
    if (typeof result === 'string' && result.length > 0) {
      return result;
    }
    return null;
  } catch (error) {
    logger.error('Error in validation expression:', error);
    return 'Validation error';
  }
}

/**
 * Calculate a field value using an expression.
 *
 * Any error (syntax/runtime/budget overrun) is swallowed to `null` — a broken
 * calculated-field expression degrades to "no value" instead of breaking the
 * whole form. This is load-bearing for useFormLogic.ts's `useCalculatedField`
 * and must NOT change; FormLogic Flows' `logic_block` node needs the OPPOSITE
 * behavior (a timeout/error must fail the run loudly, matching `condition` and
 * the Rust runner) and uses `calculateValueForFlow` below instead of this.
 */
export async function calculateValue(
  expression: string,
  formData: Record<string, unknown>
): Promise<unknown> {
  try {
    return await evaluate('calc', expression, formData);
  } catch (error) {
    logger.error('Error calculating value:', error);
    return null;
  }
}

/**
 * Calculate a value exactly like `calculateValue()`, but for the Flows
 * `logic_block` node ONLY: does NOT catch-to-null. A budget overrun or a
 * guest script error propagates as a rejected promise so the flow run fails
 * loudly (matching `condition`'s existing throw-on-error behavior and the
 * Rust desktop runner), instead of silently degrading like the calculated
 * -field use case above. `budgetMs` defaults to DEFAULT_BUDGET_MS; flowDispatcher.ts
 * passes the node's own clamped `data.timeoutMs` so the sandbox's real
 * interrupt deadline matches the node's declared budget.
 *
 * Reserved for flowDispatcher.ts's FlowExecutorDeps.evaluateExpression — do
 * not use this for calculated fields (useFormLogic.ts must keep calling
 * calculateValue()).
 */
export async function calculateValueForFlow(
  expression: string,
  formData: Record<string, unknown>,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<unknown> {
  return evaluate('calc', expression, formData, budgetMs);
}

/**
 * Run a custom app-logic hook script inside the QuickJS sandbox.
 *
 * `source` is a full script that declares `function run(ctx) { ... }`. It runs in
 * the SAME empty-global sandbox as every other expression here: no window, no
 * fetch, no host bindings — it only receives the JSON `ctx` and returns a JSON
 * result (effects / ui patch / reject / warnings). The trusted host
 * (appLogicHost) is responsible for permission-checking and applying any effects.
 * Throws on guest error or budget overrun, exactly like the other evaluators.
 */
export async function runAppLogic(
  source: string,
  ctx: Record<string, unknown>,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<unknown> {
  return evaluate('applogic', source, ctx, budgetMs);
}

/**
 * Test an expression and return the result.
 */
export async function testExpression(
  expression: string,
  context: Record<string, unknown>
): Promise<{ valid: boolean; output?: unknown; error?: string }> {
  try {
    const result = await evaluate('test', expression, context);
    return { valid: true, output: result };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid expression',
    };
  }
}

/**
 * Test if an expression is syntactically valid (no execution).
 */
export async function validateExpression(expression: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    await evaluate('syntax', expression, {});
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid expression',
    };
  }
}
