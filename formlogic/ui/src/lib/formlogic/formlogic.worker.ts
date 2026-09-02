// FormLogic evaluation worker.
//
// Keeps zipp evaluation off the main thread (heavy/looping expressions can't
// freeze the UI), and lets engine.ts enforce a hard worker.terminate() watchdog
// as a backstop to the in-VM instruction budget.
//
// The first thing this Worker does is load the engine and report READY (or the
// load error) on the reserved id 0. engine.ts holds every evaluation until then
// and only starts a call's watchdog once the engine exists, so a 5 MB download
// on a cold cache is never mistaken for a wedged evaluation.
/// <reference lib="webworker" />
import { runEval, warmUp, type EvalKind } from './zipp-host';

/** Reserved request id for the readiness handshake. Real requests start at 1. */
export const READY_ID = 0;

export interface WorkerRequest {
  id: number;
  kind: EvalKind;
  expression: string;
  context?: Record<string, unknown>;
  budgetMs?: number;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Set on the id-0 handshake message only. */
  ready?: true;
}

const post = (response: WorkerResponse): void => {
  (self as DedicatedWorkerGlobalScope).postMessage(response);
};

warmUp().then(
  () => post({ id: READY_ID, ok: true, ready: true }),
  (err: unknown) => post({ id: READY_ID, ok: false, ready: true, error: err instanceof Error ? err.message : String(err) })
);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, kind, expression, context, budgetMs } = event.data;
  try {
    const result = await runEval(kind, expression, context ?? {}, { budgetMs });
    const response: WorkerResponse = { id, ok: true, result };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
