// FormLogic evaluation worker.
//
// Keeps QuickJS evaluation off the main thread (heavy/looping expressions can't
// freeze the UI), and lets engine.ts enforce a hard worker.terminate() watchdog
// as a backstop to the in-VM interrupt deadline.
/// <reference lib="webworker" />
import { runEval, type EvalKind } from './quickjs-host';

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
}

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
