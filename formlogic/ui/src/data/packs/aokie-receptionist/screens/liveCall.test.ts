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

  it('shows a loading spinner (not the Simulate card) while presence is still resolving', async () => {
    // Desktop detection is demand-driven and warms after mount, so the first presence
    // reads 'none' transiently. With a real grace window active, the standby must show a
    // loading spinner + "Connecting..." rather than flashing the demo Simulate card.
    const { root } = await runScreen(
      AOKIE_LIVE_CALL_SCREEN,
      baseFL({ presence: () => Promise.resolve({ kind: 'none' }) }),
      { windowGlobals: { __flPresenceGraceMs: 10000 } }
    );
    await flush();
    expect(root.querySelector('.spinner')).not.toBeNull();
    expect(root.textContent).toContain('Connecting...');
    expect(root.querySelector('[data-act="simulate"]')).toBeNull();
    expect(root.textContent).not.toContain('Simulate incoming call');
    // The presence pill also reads Connecting while unsettled.
    expect(root.querySelector('#presence')?.textContent).toContain('Connecting...');
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

  it('a stuck active call self-heals from the authoritative call.current poll (live report 2026-07-18)', async () => {
    // Remote mode: there is NO event lane, so a missed/never-delivered
    // aokie.call.ended used to leave the stage stuck on the hangup button
    // forever — the poll's `call: null` could not clear a non-ended call.
    // Now two consecutive null polls end it (one is forgiven as a race).
    let nulls = 0;
    const connector = vi.fn((_id: string, cmd: string) => {
      if (cmd !== 'call.current') return Promise.resolve({ status: 'done', result: {} });
      if (connector.mock.calls.filter((c) => c[1] === 'call.current').length <= 1) {
        return Promise.resolve({
          status: 'done',
          result: { call: { callId: 'call-9', from: '0400 111 222', state: 'active', startedAt: '2026-07-18T00:00:00Z' } },
        });
      }
      nulls += 1;
      return Promise.resolve({ status: 'done', result: { call: null } });
    });
    const { root } = await runScreen(
      AOKIE_LIVE_CALL_SCREEN,
      baseFL({
        presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HESQH3A' }),
        can: () => Promise.resolve(true),
        connector,
      }),
      { windowGlobals: { __flPollMs: 40 } }
    );
    await flush();
    // The active stage is up (poll #1 returned the call).
    expect(root.querySelector('.btn.hangup')).not.toBeNull();
    // Let several poll cycles run; every further call.current reports null.
    await flush(400);
    expect(nulls).toBeGreaterThanOrEqual(2);
    // The stage cleared without any ended event — back to the remote standby.
    expect(root.querySelector('.btn.hangup')).toBeNull();
    expect(root.textContent).toContain('mirrors its calls');
  });

  it("remote mode reads the LATEST stored call's transcript when no call is in progress (live report 2026-08-01)", async () => {
    // On real hardware call.current goes null the instant a call ends, so keying
    // the stored-turns poll on the CURRENT call alone made every finished call
    // unreadable: open the console with no call up and the turns were written,
    // stored and permitted, but never queried. The card promised 'Latest call'
    // and said "No transcript recorded for the latest call yet" forever.
    const connector = vi.fn((_id: string, cmd: string) => (cmd === 'call.current'
      ? Promise.resolve({ status: 'done', result: { call: null } })
      : Promise.resolve({ status: 'done', result: {} })));
    const queryRecords = vi.fn((target: string) => Promise.resolve(target === 'transcript-turns'
      ? [
        // Newest-first, and deliberately mixed with an OLDER call's turns.
        { id: 't-2', answers: { call_id: 'call_bbb', turn_index: 2, speaker: 'aokie', text: 'Have a good day.', timestamp: '2026-08-01T04:55:43.000Z' } },
        { id: 't-1', answers: { call_id: 'call_bbb', turn_index: 1, speaker: 'caller', text: 'What services do you offer?', timestamp: '2026-08-01T04:55:29.000Z' } },
        { id: 'old', answers: { call_id: 'call_aaa', turn_index: 1, speaker: 'caller', text: 'A much older call.', timestamp: '2026-07-27T21:53:41.000Z' } },
      ]
      : []));
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HESQH3A' }),
      can: () => Promise.resolve(true),
      connector,
      // The Calls rows the recent-calls poll returns, newest first.
      records: () => Promise.resolve([
        { id: 'rec-2', answers: { call_id: 'call_bbb', status: 'completed' }, submittedAt: '2026-08-01T04:55:13.000Z' },
        { id: 'rec-1', answers: { call_id: 'call_aaa', status: 'completed' }, submittedAt: '2026-07-27T21:53:00.000Z' },
      ]),
      queryRecords,
    }));
    await flush();

    // The newest stored call's turns render, oldest-first within the call.
    expect(queryRecords).toHaveBeenCalledWith('transcript-turns', { limit: 60 });
    expect(root.textContent).not.toContain('none belong to the latest call');
    expect(root.textContent).not.toContain('No call to show a transcript for yet.');
    const texts = Array.from(root.querySelectorAll('.ttext')).map((n) => n.textContent);
    expect(texts).toEqual(['What services do you offer?', 'Have a good day.']);
    // Strictly the latest call — an earlier call's turns must not bleed in.
    expect(root.textContent).not.toContain('A much older call.');
    // No call is up, so the card reads 'Latest call' and offers no composer.
    expect(root.querySelector('.thead h2')?.textContent).toBe('Latest call');
    expect(root.querySelector('#speak')).toBeNull();
  });

  it('hanging up a call that already ended explains itself instead of leaking the plugin refusal', async () => {
    // Live report 2026-08-01: the call ended at :42, the operator pressed Hang
    // up at :46 — inside the window where remote mode has not yet noticed — and
    // got the plugin's raw typed refusal thrown at them.
    let live = true;
    const toastError = vi.fn(() => Promise.resolve(undefined));
    const connector = vi.fn((_id: string, cmd: string) => {
      if (cmd === 'call.current') {
        return Promise.resolve({
          status: 'done',
          result: live
            ? { call: { callId: 'call_39bc', from: '0421285243', state: 'active', startedAt: '2026-08-01T06:01:22Z' } }
            : { call: null },
        });
      }
      if (cmd === 'call.hangup') {
        // The plugin is right: the call is gone. This is what it says.
        live = false;
        return Promise.resolve({
          status: 'failed',
          error: { message: 'callId "call_39bc" is stale: there is no current call', typed: 'stale_call' },
        });
      }
      return Promise.resolve({ status: 'done', result: {} });
    });
    const { root } = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HESQH3A' }),
      can: () => Promise.resolve(true),
      connector,
      toast: { success: () => Promise.resolve(undefined), error: toastError },
    }));
    await flush();

    const hangup = root.querySelector<HTMLButtonElement>('.btn.hangup');
    expect(hangup).not.toBeNull();
    hangup!.click();
    await flush();

    const said = toastError.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(said).toContain('That call had already ended.');
    // The operator must never be shown the plugin's internals.
    expect(said).not.toContain('stale');
    expect(said).not.toContain('callId');
    expect(said).not.toContain('-32000');
    // And the stage clears, rather than keeping a dead call on screen.
    expect(root.querySelector('.btn.hangup')).toBeNull();
  });

  it('an empty transcript says WHICH of its causes it is, rather than one sentence for three', async () => {
    // The old copy read the same whether no call was identified, the call had
    // nothing stored, or the poll never ran. Telling those apart from the
    // outside cost days; the card now names what it looked for.
    const connector = vi.fn((_id: string, cmd: string) => (cmd === 'call.current'
      ? Promise.resolve({ status: 'done', result: { call: null } })
      : Promise.resolve({ status: 'done', result: {} })));
    const remote = {
      presence: () => Promise.resolve({ kind: 'remote', deviceName: 'DESKTOP-HESQH3A' }),
      can: () => Promise.resolve(true),
      connector,
    };

    // (a) Nothing to show at all — no call anywhere.
    const bare = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({ ...remote, records: () => Promise.resolve([]) }));
    await flush();
    expect(bare.root.textContent).toContain('No call to show a transcript for yet.');
    expect(bare.root.querySelectorAll('.ttext').length).toBe(0);

    const recentCall = [
      { id: 'rec-1', answers: { call_id: 'call_abc123def456' }, submittedAt: '2026-08-01T06:01:20.000Z' },
    ];

    // (b) A call is identified and NOTHING is visible to read.
    const empty = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      ...remote,
      records: () => Promise.resolve(recentCall),
      queryRecords: () => Promise.resolve([]),
    }));
    await flush();
    expect(empty.root.textContent).toContain('No stored turns are visible to this console');
    expect(empty.root.textContent).toContain('def456');

    // (c) Turns ARE readable and none belong to this call — a different fault
    // again, and the one that distinguishes "not written" from "not matching".
    const mismatched = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      ...remote,
      records: () => Promise.resolve(recentCall),
      queryRecords: (target: string) => Promise.resolve(target === 'transcript-turns'
        ? [
          { id: 't-1', answers: { call_id: 'call_SOMEONE_ELSE', turn_index: 1, speaker: 'caller', text: 'hi' } },
          { id: 't-2', answers: { call_id: 'call_SOMEONE_ELSE', turn_index: 2, speaker: 'aokie', text: 'hello' } },
        ]
        : []),
    }));
    await flush();
    expect(mismatched.root.textContent).toContain('Read 2 stored turns');
    expect(mismatched.root.textContent).toContain('none belong to the latest call');
    expect(mismatched.root.textContent).toContain('def456');

    // (d) The read FAILED. Previously swallowed, and indistinguishable from
    // "nothing recorded" — which is most of why this took so long.
    const broken = await runScreen(AOKIE_LIVE_CALL_SCREEN, baseFL({
      ...remote,
      records: () => Promise.resolve(recentCall),
      queryRecords: (target: string) => (target === 'transcript-turns'
        ? Promise.reject(new Error('permission denied'))
        : Promise.resolve([])),
    }));
    await flush();
    expect(broken.root.textContent).toContain('could not be read');
    expect(broken.root.textContent).toContain('permission denied');
  });
});
