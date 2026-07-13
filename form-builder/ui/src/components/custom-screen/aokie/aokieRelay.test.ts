// Aokie remote call-control relay (docs/API.md §connector:relay, FORMLOGIC_FLOWS.md §14).
//
// Covers the pure state machine + routing + gating + copy the Live Call screen hangs off:
//   - permission/role gating (present / absent / role-only),
//   - enqueue → poll → terminal transitions (done / failed / expired) + client-timeout expiry,
//   - optimistic overlay paint + revert-on-failure,
//   - local mode uses the direct connector and NEVER the relay.
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCommand, ConnectorCommandStatus } from '../../../types/flows';
import {
  canRunCommand,
  describeRelayOutcome,
  dispatchCallCommand,
  optimisticOverlayFor,
  performRelayCommand,
  runRelayCommand,
  type CallOverlay,
  type RelayApi,
  type RelayOutcome,
} from './aokieRelay';

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

describe('canRunCommand — gating', () => {
  it('allows a granted command when the role can operate', () => {
    expect(canRunCommand('call.answer', { can: () => true, roleAllowsOperating: true })).toBe(true);
  });
  it('blocks when the connector grant is missing (even with the role)', () => {
    expect(canRunCommand('call.answer', { can: () => false, roleAllowsOperating: true })).toBe(false);
  });
  it('blocks when the role cannot operate (even with the grant)', () => {
    expect(canRunCommand('call.answer', { can: () => true, roleAllowsOperating: false })).toBe(false);
  });
  it('threads the exact command through to the grant probe', () => {
    const can = vi.fn((c: string) => c === 'call.hangup');
    expect(canRunCommand('call.hangup', { can, roleAllowsOperating: true })).toBe(true);
    expect(canRunCommand('call.answer', { can, roleAllowsOperating: true })).toBe(false);
  });
});

describe('optimisticOverlayFor', () => {
  it('answers go live, reject/hangup end, speak is neutral', () => {
    expect(optimisticOverlayFor('call.answer', 'c1')).toEqual({ callId: 'c1', state: 'active' });
    expect(optimisticOverlayFor('call.reject', 'c1')).toEqual({ callId: 'c1', state: 'ended' });
    expect(optimisticOverlayFor('call.hangup', 'c1')).toEqual({ callId: 'c1', state: 'ended' });
    expect(optimisticOverlayFor('call.operatorSpeak', 'c1')).toBeNull();
  });
});

describe('runRelayCommand — enqueue → poll → terminal', () => {
  it('polls a pending command through to done', async () => {
    const { api, get } = scriptedApi({ poll: [command('claimed'), command('done', { result: { ok: true } })] });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, { sleep: immediateSleep });
    expect(outcome).toMatchObject({ status: 'done', commandId: 'cmd-1' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed command with its error record', async () => {
    const { api } = scriptedApi({ poll: [command('failed', { error: { message: 'dongle offline' } })] });
    const outcome = await runRelayCommand(api, 'slug', 'call.hangup', undefined, { sleep: immediateSleep });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toEqual({ message: 'dongle offline' });
  });

  it('reports an expired command', async () => {
    const { api } = scriptedApi({ poll: [command('expired')] });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, { sleep: immediateSleep });
    expect(outcome.status).toBe('expired');
  });

  it('returns immediately when enqueue is already terminal (idempotent replay)', async () => {
    const { api, get } = scriptedApi({ enqueueStatus: 'done' });
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, { sleep: immediateSleep });
    expect(outcome.status).toBe('done');
    expect(get).not.toHaveBeenCalled();
  });

  it('gives up as expired once the client timeout elapses', async () => {
    const { api } = scriptedApi({ poll: [command('pending')] }); // never settles
    let clock = 0;
    const outcome = await runRelayCommand(api, 'slug', 'call.answer', undefined, {
      sleep: immediateSleep,
      now: () => (clock += 1000),
      timeoutMs: 3000,
    });
    expect(outcome.status).toBe('expired');
  });

  // Audit INT-005/C-14: a CLAIMED command may have executed on the phone —
  // giving up must read 'uncertain', never a clean failure/expiry.
  it("gives up as 'uncertain' when the command was claimed but never reported back", async () => {
    const { api } = scriptedApi({ poll: [command('claimed')] }); // claimed, never completes
    let clock = 0;
    const outcome = await runRelayCommand(api, 'slug', 'call.hangup', undefined, {
      sleep: immediateSleep,
      now: () => (clock += 1000),
      timeoutMs: 3000,
    });
    expect(outcome.status).toBe('uncertain');
    const t = describeRelayOutcome('call.hangup', outcome, 'Office PC');
    expect(t.kind).toBe('error');
    expect(t.title).toBe('Outcome uncertain');
    expect(t.message).toContain('Office PC');
  });

  // Audit INT-005: ONE client intent id per operator action, minted at enqueue —
  // a transport retry of the same action dedupes server-side.
  it('sends a client intent idempotencyKey with the enqueue', async () => {
    const { api, enqueue } = scriptedApi({ enqueueStatus: 'done' });
    await runRelayCommand(api, 'slug', 'call.answer', { callId: 'call_1' }, { sleep: immediateSleep });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0][1] as { idempotencyKey?: string };
    expect(arg.idempotencyKey).toMatch(/^ui-call\.answer-/);
  });

  it('throws when the enqueue call itself fails', async () => {
    const { api } = scriptedApi({ enqueueError: 'forbidden' });
    await expect(runRelayCommand(api, 'slug', 'call.answer', undefined, { sleep: immediateSleep })).rejects.toThrow('forbidden');
  });
});

describe('performRelayCommand — optimistic overlay', () => {
  it('paints then clears the overlay and reloads on success', async () => {
    const overlays: (CallOverlay | null)[] = [];
    const onReload = vi.fn();
    const runner = vi.fn(async () => ({ status: 'done' } as RelayOutcome));
    const outcome = await performRelayCommand({} as RelayApi, 'slug', 'call.answer', 'c1', undefined, {
      onOptimistic: (o) => overlays.push(o),
      onReload,
      runner,
    });
    expect(outcome.status).toBe('done');
    expect(overlays).toEqual([{ callId: 'c1', state: 'active' }, null]);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('reverts the overlay and does NOT reload on failure', async () => {
    const overlays: (CallOverlay | null)[] = [];
    const onReload = vi.fn();
    const runner = vi.fn(async () => ({ status: 'failed', error: { message: 'x' } } as RelayOutcome));
    const outcome = await performRelayCommand({} as RelayApi, 'slug', 'call.hangup', 'c1', undefined, {
      onOptimistic: (o) => overlays.push(o),
      onReload,
      runner,
    });
    expect(outcome.status).toBe('failed');
    expect(overlays).toEqual([{ callId: 'c1', state: 'ended' }, null]); // painted 'ended', then reverted
    expect(onReload).not.toHaveBeenCalled();
  });

  it('reverts the overlay when enqueue rejects', async () => {
    const overlays: (CallOverlay | null)[] = [];
    const runner = vi.fn(async () => { throw new Error('boom'); });
    await expect(
      performRelayCommand({} as RelayApi, 'slug', 'call.answer', 'c1', undefined, {
        onOptimistic: (o) => overlays.push(o),
        runner,
      })
    ).rejects.toThrow('boom');
    expect(overlays).toEqual([{ callId: 'c1', state: 'active' }, null]);
  });

  it('operatorSpeak paints no overlay but still reloads on success', async () => {
    const overlays: (CallOverlay | null)[] = [];
    const onReload = vi.fn();
    const runner = vi.fn(async () => ({ status: 'done' } as RelayOutcome));
    await performRelayCommand({} as RelayApi, 'slug', 'call.operatorSpeak', 'c1', { text: 'hi' }, {
      onOptimistic: (o) => overlays.push(o),
      onReload,
      runner,
    });
    expect(overlays).toEqual([null]); // no pre-paint; cleared once on success
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchCallCommand — local vs relay routing', () => {
  it('local mode calls the connector directly and never the relay', async () => {
    const connector = { request: vi.fn(async () => ({})) };
    const { api, enqueue } = scriptedApi({});
    const result = await dispatchCallCommand(
      { remote: false, connector, relay: { api, slug: 'slug' } },
      'call.answer',
      'c1',
      { callId: 'c1' }
    );
    expect(result).toEqual({ mode: 'local' });
    expect(connector.request).toHaveBeenCalledWith('call.answer', { callId: 'c1' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('remote mode goes through the relay and never the connector', async () => {
    const connector = { request: vi.fn(async () => ({})) };
    const { api, enqueue } = scriptedApi({ poll: [command('done')] });
    const result = await dispatchCallCommand(
      { remote: true, connector, relay: { api, slug: 'slug' } },
      'call.answer',
      'c1',
      { callId: 'c1' },
      { runOptions: { sleep: immediateSleep } }
    );
    expect(result.mode).toBe('relay');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(connector.request).not.toHaveBeenCalled();
  });
});

describe('describeRelayOutcome — operator copy', () => {
  it('done → success toast with the command label', () => {
    expect(describeRelayOutcome('call.answer', { status: 'done' })).toEqual({ kind: 'success', title: 'Call answered' });
  });
  // AOK-CTRL-001: a radio-backed plugin result is ACCEPTANCE only ({accepted, queued,
  // operationId}) — the toast must never claim the final verb before the phone confirms
  // (the authoritative state lands via the call events / record reload).
  it('done with an accepted-only result → "sent to the phone" copy, never the final verb', () => {
    const outcome: RelayOutcome = {
      status: 'done',
      result: { accepted: true, queued: true, operationId: 'op_1', via: 'radio' },
      handledBy: 'Office PC',
    };
    const t = describeRelayOutcome('call.answer', outcome);
    expect(t.kind).toBe('success');
    expect(t.title).toBe('Answer sent to the phone');
    expect(t.message).toContain('Handled by Office PC.');

    expect(
      describeRelayOutcome('call.hangup', { status: 'done', result: { accepted: true, queued: true } }).title
    ).toBe('Hang-up sent to the phone');
    expect(
      describeRelayOutcome('call.reject', { status: 'done', result: { accepted: true, queued: true } }).title
    ).toBe('Reject sent to the phone');
    expect(
      describeRelayOutcome('call.operatorSpeak', { status: 'done', result: { accepted: true, queued: true } }).title
    ).toBe('Speech queued to the caller');
  });
  it('done with a synchronous mock result (final verb present) keeps the confirmed copy', () => {
    const t = describeRelayOutcome('call.answer', {
      status: 'done',
      result: { accepted: true, answered: true, call: { state: 'active' } },
    });
    expect(t.title).toBe('Call answered');
  });
  it('expired → the "no desktop online" error', () => {
    const t = describeRelayOutcome('call.hangup', { status: 'expired' }, 'Home Office PC');
    expect(t.kind).toBe('error');
    expect(t.title).toBe('No FormLogic Desktop is currently online');
    expect(t.message).toContain('Home Office PC');
  });
  it('failed → error toast carrying the desktop error message', () => {
    const t = describeRelayOutcome('call.hangup', { status: 'failed', error: { message: 'dongle offline' } });
    expect(t.kind).toBe('error');
    expect(t.message).toBe('dongle offline');
  });
});
