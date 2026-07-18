// Typed wrappers over the two host lanes this screen drives. Bridge outcomes
// RESOLVE (never throw) with a status; these helpers convert a non-'done'
// status into a readable Error for the banner, exactly like the original
// embedded-JS cmd()/svc() helpers.
//
// NOTE: the live bridge resolves `error` as an OBJECT ({ code?, message? });
// the ambient SDK typings (formlogic-screen-sdk.d.ts) still declare `string`,
// so the error is inspected through an unknown-shaped view here.

import { asRecord } from './format';

function errorMessage(e: unknown): string | null {
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m !== '') return m;
  }
  return null;
}

function errorCode(e: unknown): string | null {
  if (e && typeof e === 'object') {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}

/** Connector command -> result object, or throw with a readable message. */
export function cmd(name: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return FormLogic.connector('aokie', name, payload || {}).then((out) => {
    if (out.status === 'done') return asRecord(out.result);
    const err = out.error as unknown;
    let m = errorMessage(err) || out.status;
    if (errorCode(err) === 'connector_unavailable') {
      m = 'FormLogic Desktop is not reachable right now - connect it above, then press Refresh.';
    }
    throw new Error(m);
  });
}

/** Typed service op -> result object, or throw with the server's message. */
export function svc(op: string, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return FormLogic.service(op, input || {}).then((out) => {
    if (out.status === 'done') return asRecord(out.result);
    throw new Error(errorMessage(out.error as unknown) || 'Service operation failed');
  });
}
