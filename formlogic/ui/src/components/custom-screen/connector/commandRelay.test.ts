// Remote connector-command relay (docs/API.md §connector:relay, FORMLOGIC_FLOWS.md §14).
//
// Covers the pure enqueue → poll → terminal state machine the screen bridge relays through:
//   - terminal transitions (done / failed / expired) + client-timeout expiry,
//   - truthful 'uncertain' when a CLAIMED command never reports back,
//   - ONE client intent idempotencyKey per operator action (+ same-key enqueue retry),
//   - caller-named connectorId on the enqueue body (the module has no default connector),
//   - empty-object payload elision (PHP would round-trip {} to []).
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCommand, ConnectorCommandStatus } from '../../../types/flows';
import { runRelayCommand, type RelayApi } from './commandRelay';

const immediateSleep = () => Promise.resolve();

/** A ConnectorCommand at a given status (only the fields the state machine reads matter). */
function command(status: ConnectorCommandStatus, extra: Partial<ConnectorCommand> = {}): ConnectorCommand {
  return {
    commandId: 'cmd-1',
    appId: 'app-1',
    connectorId: 'aokie',
    command: 'call.answer',
    payload: null,
    idempotencyKey: 'k',
    status,
    result: null,
    error: null,
    requestedByUserId: 'u1',
    claimedBy: null,
    createdAt: '2026-07-07 12:00:00',
    claimedAt: null,
    finishedAt: null,
    expiresAt: '2026-07-07 12:01:00',
    ...extra,
  };
}

/**
 * A scripted RelayApi: enqueue resolves to `enqueueStatus`, then getConnectorCommand walks the
 * supplied status script one poll at a time (repeating the last entry).
 */
function scriptedApi(opts: {
  enqueueStatus?: ConnectorCommandStatus;
  enqueueError?: string;
  poll?: ConnectorCommand[];
}): { api: RelayApi; enqueue: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const script = opts.poll ?? [];
  let i = 0;
  const enqueue = vi.fn(async () =>
    opts.enqueueError
      ? { error: opts.enqueueError }
      : { data: { commandId: 'cmd-1', status: opts.enqueueStatus ?? ('pending' as ConnectorCommandStatus) } }
  );
  const get = vi.fn(async () => {
    const cmd = script[Math.min(i, script.length - 1)];
    i += 1;
    return { data: { command: cmd } };
  });
  return { api: { enqueueConnectorCommand: enqueue, getConnectorCommand: get } as RelayApi, enqueue, get };
}

const opts = (extra: Record<string, unknown> = {}) => ({
  connectorId: 'aokie',
  sleep: immediateSleep,
  ...extra,
});

describe('runRelayCommand — enqueue → poll → terminal', () => {
  it('polls a pending command through to done', async () => {
    const { api, get } = scriptedApi({ poll: [command('claimed'), command('done', { result: { ok: true } })] });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, opts());
    expect(outcome).toMatchObject({ status: 'done', commandId: 'cmd-1' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed command with its error record', async () => {
    const { api } = scriptedApi({ poll: [command('failed', { error: { message: 'dongle offline' } })] });
    const outcome = await runRelayCommand(api, 'slug', 'call.hangup', undefined, opts());
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toEqual({ message: 'dongle offline' });
  });

  it('reports an expired command', async () => {
    const { api } = scriptedApi({ poll: [command('expired')] });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, opts());
    expect(outcome.status).toBe('expired');
  });

  it('returns immediately when enqueue is already terminal (idempotent replay)', async () => {
    const { api, get } = scriptedApi({ enqueueStatus: 'done' });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, opts());
    expect(outcome.status).toBe('done');
    expect(get).not.toHaveBeenCalled();
  });

  it('gives up as expired once the client timeout elapses', async () => {
    const { api } = scriptedApi({ poll: [command('pending')] }); // never settles
    let clock = 0;
    const outcome = await runRelayCommand(
      api,
      'slug',
      'call.answer',
      undefined,
      opts({ now: () => (clock += 1000), timeoutMs: 3000 })
    );
    expect(outcome.status).toBe('expired');
  });

  // Audit INT-005/C-14: a CLAIMED command may have executed on the phone —
  // giving up must read 'uncertain', never a clean failure/expiry.
  it("gives up as 'uncertain' when the command was claimed but never reported back", async () => {
    const { api } = scriptedApi({ poll: [command('claimed')] }); // claimed, never completes
    let clock = 0;
    const outcome = await runRelayCommand(
      api,
      'slug',
      'call.hangup',
      undefined,
      opts({ now: () => (clock += 1000), timeoutMs: 3000 })
    );
    expect(outcome.status).toBe('uncertain');
  });

  // Audit INT-005: ONE client intent id per operator action, minted at enqueue —
  // a transport retry of the same action dedupes server-side.
  it('sends a client intent idempotencyKey with the enqueue', async () => {
    const { api, enqueue } = scriptedApi({ enqueueStatus: 'done' });
    await runRelayCommand(api, 'slug', 'call.answer', { callId: 'call_1' }, opts());
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0][1] as { idempotencyKey?: string };
    expect(arg.idempotencyKey).toMatch(/^ui-call\.answer-/);
  });

  // The module is connector-agnostic: the enqueue body carries EXACTLY the
  // connector the caller named — there is no built-in default connector.
  it('targets the enqueue at the caller-named connectorId', async () => {
    const { api, enqueue } = scriptedApi({ enqueueStatus: 'done' });
    await runRelayCommand(api, 'slug', 'probe.read', undefined, opts({ connectorId: 'weatherstation' }));
    const body = enqueue.mock.calls[0][1] as { connectorId?: string };
    expect(body.connectorId).toBe('weatherstation');
  });

  it('throws when the enqueue call itself fails', async () => {
    const { api } = scriptedApi({ enqueueError: 'forbidden' });
    await expect(runRelayCommand(api, 'slug', 'call.answer', undefined, opts())).rejects.toThrow('forbidden');
  });

  // An empty-object payload must NOT reach the relay as {} — PHP round-trips
  // {} to [] (json_decode assoc), and the plugin rejects an array payload
  // ("payload must be an object, got array"). It breaks no-arg Device Setup
  // connector calls whenever the browser uses the relay. Send no payload.
  it('omits an empty-object payload so PHP never turns {} into []', async () => {
    const { api, enqueue } = scriptedApi({ enqueueStatus: 'done' });
    await runRelayCommand(api, 'slug', 'phone.status', {}, opts());
    const body = enqueue.mock.calls[0][1] as { payload?: unknown };
    expect(body.payload).toBeUndefined();
  });

  it('passes a non-empty payload through unchanged (it round-trips faithfully)', async () => {
    const { api, enqueue } = scriptedApi({ enqueueStatus: 'done' });
    await runRelayCommand(api, 'slug', 'phone.confirmPairing', { address: 'AA:BB', accept: true }, opts());
    const body = enqueue.mock.calls[0][1] as { payload?: unknown };
    expect(body.payload).toEqual({ address: 'AA:BB', accept: true });
  });
});
