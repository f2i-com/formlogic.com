// FormLogic evaluation worker.
//
// Keeps zipp evaluation off the main thread (heavy/looping expressions can't
// freeze the UI), and lets engine.ts enforce a hard worker.terminate() watchdog
// as a backstop to the in-VM instruction budget.
//
// The host supplies verified engine bytes once; this Worker instantiates its
// own module and reports READY (or the load error) on reserved id 0. engine.ts
// holds every evaluation until then
// and only starts a call's watchdog once the engine exists, so a 5 MB download
// on a cold cache is never mistaken for a wedged evaluation.
/// <reference lib="webworker" />
import { runEval, warmUp, instanceUsage, type EvalKind, type InstanceUsage } from './zipp-host';

/** Reserved request id for the readiness handshake. Real requests start at 1. */
export const READY_ID = 0;

export interface WorkerRequest {
  id: number;
  kind: EvalKind;
  expression: string;
  context?: Record<string, unknown>;
  budgetMs?: number;
}

export interface WorkerInit {
  type: 'init';
  zippWasm: ArrayBuffer;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Set on the id-0 handshake message only. */
  ready?: true;
  /**
   * What this Worker's WASM instance has retained across disposed engines
   * (audit ZP-01). engine.ts recycles the Worker when it exceeds the budget;
   * dispose() alone cannot give this memory back.
   */
  usage?: InstanceUsage;
}

const post = (response: WorkerResponse): void => {
  (self as DedicatedWorkerGlobalScope).postMessage(response);
};

let initialization: Promise<void> | undefined;
self.onmessage = async (event: MessageEvent<WorkerRequest | WorkerInit>) => {
  if ('type' in event.data && event.data.type === 'init') {
    if (initialization) return;
    if (!(event.data.zippWasm instanceof ArrayBuffer)) {
      post({ id: READY_ID, ok: false, ready: true, error: 'The app engine bytes are missing.' });
      return;
    }
    initialization = warmUp(event.data.zippWasm);
    initialization.then(
      () => post({ id: READY_ID, ok: true, ready: true }),
      (err: unknown) => post({ id: READY_ID, ok: false, ready: true, error: err instanceof Error ? err.message : String(err) })
    );
    return;
  }
  if (!('id' in event.data)) return;
  const { id, kind, expression, context, budgetMs } = event.data;
  try {
    if (!initialization) throw new Error('The app engine has not been initialized.');
    await initialization;
    const result = await runEval(kind, expression, context ?? {}, { budgetMs });
    const response: WorkerResponse = { id, ok: true, result, usage: instanceUsage() };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      usage: instanceUsage(),
    };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
