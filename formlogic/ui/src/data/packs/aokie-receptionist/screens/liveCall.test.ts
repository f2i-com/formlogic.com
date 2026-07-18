// Behavioral tests for the pack-owned Live Call section screen (TSX edition): the
// screen's `files` are bundled with the REAL sandbox semantics (screenCompile vfs +
// embedded preact + automatic JSX via the native-esbuild test seam) and EXECUTED in a
// JSDOM document against a mocked window.FormLogic — the compiled artifact is what's
// under test, exactly what the iframe runs.
//
// Locks, in particular, the presence-branched STANDBY panel (commit 5c0615b — the
// "connected but shows Simulate" bug class): presence 'remote' shows the mirror note
// ONLY and never offers the scripted demo call.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AOKIE_LIVE_CALL_SCREEN } from './liveCallScreen';
import { flushScreen as flush, runScreen, setupScreenTestEsbuild, teardownScreenTestEsbuild } from '../../aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

/** A complete FormLogic mock covering every surface the console calls; override per test. */
function baseFL(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    presence: () => Promise.resolve({ kind: 'none' }),
    currentUser: () => Promise.resolve(null),
    can: () => Promise.resolve(false),
    connector: () => Promise.resolve({ status: 'done', result: {} }),
    records: () => Promise.resolve([]),
    queryRecords: () => Promise.resolve([]),
    openRecords: () => Promise.resolve(undefined),
    toast: { success: () => Promise.resolve(undefined), error: () => Promise.resolve(undefined) },
    host: {
      openScreen: () => Promise.resolve(undefined),
      openRecord: () => Promise.resolve(undefined),
      ceremony: () => Promise.resolve({ status: 'done' }),
    },
    events: { subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) }) },
    captions: {
      subscribe: () => Promise.resolve({
        unsubscribe: () => Promise.resolve(undefined),
        tombstone: () => Promise.resolve(undefined),
      }),
    },
    ...overrides,
  };
}

describe('live-call section screen (TSX)', () => {
  it("presence 'remote' standby shows the mirror note and NEVER the demo Simulate button", async () => {
    const ceremony = vi.fn(() => Promise.resolve({ status: 'done' }));
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HESQH3A' }),
      host: {
        openScreen: () => Promise.resolve(undefined),
        openRecord: () => Promise.resolve(undefined),
        ceremony,
      },
    }));
    await flush();
    // The mirror note, verbatim — a real desktop answers this line via the relay.
    expect(root.textContent).toContain(
      'The receptionist runs on DESKTOP-HESQH3A. This console mirrors its calls and relays your controls.'
    );
    // The scripted demo must never be offered when real hardware is live.
    expect(root.querySelector('[data-act="simulate"]')).toBeNull();
    expect(root.textContent).not.toContain('Simulate incoming call');
    expect(ceremony).not.toHaveBeenCalled();
    // Presence pill + the remote standby line.
    expect(root.querySelector('#presence')?.textContent).toContain('Listening on DESKTOP-HESQH3A - relay');
    expect(root.textContent).toContain('Updates every 10s');
  });

  it("presence 'none' offers the demo call; Simulate runs host.ceremony('simulate-call')", async () => {
    let resolveCeremony: (v: { status: string }) => void = () => undefined;
    const ceremony = vi.fn(() => new Promise<{ status: string }>((r) => { resolveCeremony = r; }));
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      host: {
        openScreen: () => Promise.resolve(undefined),
        openRecord: () => Promise.resolve(undefined),
        ceremony,
      },
    }));
    await flush();
    expect(root.textContent).toContain('Install FormLogic Desktop (Device Setup) to take real calls.');
    const btn = root.querySelector<HTMLButtonElement>('[data-act="simulate"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Simulate incoming call');
    expect(btn!.disabled).toBe(false);
    btn!.click();
    await flush();
    expect(ceremony).toHaveBeenCalledTimes(1);
    expect(ceremony).toHaveBeenCalledWith('simulate-call');
    // While the ceremony runs, the button reads Simulating... and is disabled.
    const busy = root.querySelector<HTMLButtonElement>('[data-act="simulate"]');
    expect(busy?.textContent).toBe('Simulating...');
    expect(busy?.disabled).toBe(true);
    resolveCeremony({ status: 'done' });
    await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-act="simulate"]')?.textContent).toBe('Simulate incoming call');
  });

  it('a ringing call renders identity (known-customer match) and wires Answer/Reject/Hang up', async () => {
    const connector = vi.fn((_id: string, cmd: string) => {
      if (cmd === 'call.current') {
        return Promise.resolve({
          status: 'done',
          result: { call: { callId: 'call-1', from: '+61 400 111 222', state: 'ringing', startedAt: '2026-07-18T00:00:00Z' } },
        });
      }
      return Promise.resolve({ status: 'done', result: {} });
    });
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      can: () => Promise.resolve(true),
      connector,
      queryRecords: (target: string) => Promise.resolve(target === 'customers'
        ? [{ id: 'cust-1', answers: { name: 'Lance', phone: '0400 111 222' } }]
        : []),
    }));
    await flush();
    // Known-caller name via the customers last-9-digit suffix match + the badge.
    expect(root.querySelector('.cname')?.textContent).toBe('Lance');
    expect(root.querySelector('.known')?.textContent).toBe('Known customer');
    expect(root.querySelector('.eyebrow')?.textContent).toBe('Incoming call');
    expect(root.querySelector('.cphone')?.textContent).toContain('+61 400 111 222');

    const answer = root.querySelector<HTMLButtonElement>('.btn.answer');
    expect(answer).not.toBeNull();
    expect(answer!.disabled).toBe(false);
    answer!.click();
    await flush();
    expect(connector).toHaveBeenCalledWith('aokie', 'call.answer', { callId: 'call-1' });

    const reject = root.querySelector<HTMLButtonElement>('.btn.reject');
    expect(reject).not.toBeNull();
    reject!.click();
    await flush();
    expect(connector).toHaveBeenCalledWith('aokie', 'call.reject', { callId: 'call-1' });

    const hangup = root.querySelector<HTMLButtonElement>('.btn.hangup');
    expect(hangup).not.toBeNull();
    hangup!.click();
    await flush();
    expect(connector).toHaveBeenCalledWith('aokie', 'call.hangup', { callId: 'call-1' });
  });

  it('the composer sends operatorSpeak with the callId + text on an active call', async () => {
    const connector = vi.fn((_id: string, cmd: string) => Promise.resolve(cmd === 'call.current'
      ? { status: 'done', result: { call: { callId: 'call-3', from: '0400 111 222', state: 'active', startedAt: '2026-07-18T00:00:00Z' } } }
      : { status: 'done', result: {} }));
    const { root, dom } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      can: () => Promise.resolve(true),
      connector,
    }));
    await flush();
    const input = root.querySelector<HTMLInputElement>('#speak');
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);
    input!.value = 'One moment please';
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush();
    input!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(connector).toHaveBeenCalledWith('aokie', 'call.operatorSpeak', { callId: 'call-3', text: 'One moment please' });
  });

  it('a turn.corrected event patches the MATCHING bubble and marks it corrected', async () => {
    let onEvent: ((frame: { kind: string; seq: number; data: unknown }) => void) | null = null;
    const events = {
      subscribe: (_filter: unknown, handler: (frame: { kind: string; seq: number; data: unknown }) => void) => {
        onEvent = handler;
        return Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) });
      },
    };
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      presence: () => Promise.resolve({ kind: 'local' }),
      can: () => Promise.resolve(true),
      events,
    }));
    await flush();
    expect(onEvent).not.toBeNull();
    onEvent!({ kind: 'event', seq: 1, data: { name: 'aokie.call.incoming', correlationId: 'c9', data: { callId: 'c9', from: '0400 222 333' } } });
    onEvent!({ kind: 'event', seq: 2, data: { name: 'aokie.call.turn.final', occurredAt: '2026-07-18T00:00:01Z', idempotencyKey: 'k1', data: { callId: 'c9', turn: 1, speaker: 'caller', text: 'Book me for Tuseday' } } });
    await flush();
    const bubble = () => root.querySelector('.turn.caller .ttext');
    expect(bubble()?.textContent).toBe('Book me for Tuseday');
    expect(bubble()?.getAttribute('title')).toBeNull();

    onEvent!({ kind: 'event', seq: 3, data: { name: 'aokie.call.turn.corrected', data: { callId: 'c9', turn: 1, text: 'Book me for Tuesday' } } });
    await flush();
    expect(bubble()?.textContent).toBe('Book me for Tuesday');
    expect(bubble()?.getAttribute('title')).toBe('Corrected by the audio model');

    // A correction for a DIFFERENT turn leaves the bubble alone.
    onEvent!({ kind: 'event', seq: 4, data: { name: 'aokie.call.turn.corrected', data: { callId: 'c9', turn: 2, text: 'unrelated' } } });
    await flush();
    expect(bubble()?.textContent).toBe('Book me for Tuesday');
  });

  it('recent-call rows open their record; View all opens the records table', async () => {
    const openRecord = vi.fn(() => Promise.resolve(undefined));
    const openRecords = vi.fn(() => Promise.resolve(undefined));
    const { root, dom } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      records: () => Promise.resolve([
        { id: 'row-1', answers: { caller_name: 'Gail', caller_phone: '0491 570 156', status: 'completed' }, submittedAt: '2026-07-18 01:00:00' },
        { id: 'row-2', answers: { caller_phone: '0491 570 157', status: 'missed' }, submittedAt: '2026-07-18 00:40:00' },
      ]),
      openRecords,
      host: {
        openScreen: () => Promise.resolve(undefined),
        openRecord,
        ceremony: () => Promise.resolve({ status: 'done' }),
      },
    }));
    await flush();
    const rows = root.querySelectorAll<HTMLElement>('li[data-act="open"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Gail');
    expect(rows[0].querySelector('.cstat')?.className).toBe('cstat ok');
    expect(rows[1].textContent).toContain('0491 570 157');
    expect(rows[1].querySelector('.cstat')?.className).toBe('cstat bad');

    rows[0].click();
    await flush();
    expect(openRecord).toHaveBeenCalledWith('calls', 'row-1');

    // Keyboard: Enter on a focused row opens it too.
    rows[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(openRecord).toHaveBeenCalledWith('calls', 'row-2');

    (root.querySelector('[data-act="viewall"]') as HTMLElement).click();
    await flush();
    expect(openRecords).toHaveBeenCalledTimes(1);
  });

  it('can()=false leaves the call controls disabled and never reaches the connector', async () => {
    const connector = vi.fn((_id: string, cmd: string) => Promise.resolve(cmd === 'call.current'
      ? { status: 'done', result: { call: { callId: 'call-2', from: '0400 000 000', state: 'ringing', startedAt: '2026-07-18T00:00:00Z' } } }
      : { status: 'done', result: {} }));
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      // Only the call.current read is granted — every control stays locked.
      can: (perm: string) => Promise.resolve(perm === 'connector.aokie.call.current'),
      connector,
    }));
    await flush();
    const answer = root.querySelector<HTMLButtonElement>('.btn.answer');
    const hangup = root.querySelector<HTMLButtonElement>('.btn.hangup');
    expect(answer?.disabled).toBe(true);
    expect(hangup?.disabled).toBe(true);
    // Reject is not even rendered without its grant.
    expect(root.querySelector('.btn.reject')).toBeNull();
    // The composer is gated too (ringing call: answer-first).
    expect(root.querySelector<HTMLInputElement>('#speak')?.disabled).toBe(true);
    answer!.click();
    hangup!.click();
    await flush();
    // Only the call.current poll ever went to the connector — never a control command.
    for (const call of connector.mock.calls) expect(call[1]).toBe('call.current');
  });
});
