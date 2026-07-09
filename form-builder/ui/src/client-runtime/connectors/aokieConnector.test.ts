import { afterEach, describe, expect, it, vi } from 'vitest';
import { aokieConnector, mockAokieConnector, simulateIncomingCall } from './aokieConnector';
import {
  __resetDesktopDetectionForTests,
  __setDesktopInfoForTests,
} from '../desktop/desktopDetection';
import { clearDesktopToken, storeDesktopToken } from '../desktop/desktopPairing';
import { __resetDesktopEventsForTests, subscribeDesktopEvents } from '../desktop/desktopEvents';

// Aokie connector routing: desktop present+paired → the Desktop gateway; desktop
// absent/unpaired → the mock; REAL desktop errors (capability_denied, command_failed,
// desktop-returned connector_unavailable) surface and are never masked by the mock.

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
}

function setFetch(mock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

function desktopPairedAndDetected(): void {
  __setDesktopInfoForTests({ available: true, companion: 'formlogic-desktop', version: '1.0.0' });
  storeDesktopToken('tok_abc');
}

afterEach(() => {
  __resetDesktopDetectionForTests();
  __resetDesktopEventsForTests();
  clearDesktopToken();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('aokieConnector.request routing', () => {
  it('routes through the Desktop gateway when detected AND paired', async () => {
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true, data: { connected: true, deviceName: 'Pixel 9' } })));

    const result = await aokieConnector.request('phone.status');

    expect(result).toEqual({ connected: true, deviceName: 'Pixel 9' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:17872/api/connectors/aokie/request');
  });

  it('serves the mock when Desktop is absent (no fetch at all)', async () => {
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('should not be called'))));

    const result = (await aokieConnector.request('dongle.list')) as { dongles: unknown[] };

    expect(Array.isArray(result.dongles)).toBe(true);
    expect(result.dongles.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the mock when Desktop is detected but NOT paired', async () => {
    __setDesktopInfoForTests({ available: true, companion: 'formlogic-desktop' });
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('should not be called'))));

    const result = (await aokieConnector.request('sms.threads')) as { threads: unknown[] };

    expect(Array.isArray(result.threads)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEVER masks a desktop capability_denied with mock data', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'capability_denied', message: 'call.answer not declared' } }, 403)));

    await expect(aokieConnector.request('call.answer')).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'capability_denied',
    });
  });

  it('NEVER masks a desktop-returned connector_unavailable (plugin stopped) with mock data', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'connector_unavailable', message: 'aokie plugin is stopped' } }, 503)));

    await expect(aokieConnector.request('phone.status')).rejects.toMatchObject({ code: 'connector_unavailable' });
  });

  it('falls back to the mock on a NETWORK failure (Desktop effectively absent)', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const result = (await aokieConnector.request('dongle.list')) as { dongles: unknown[] };

    expect(Array.isArray(result.dongles)).toBe(true);
  });

  it('falls back to the mock on connector_missing (Desktop up, aokie plugin not installed)', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'connector_missing', message: 'no aokie plugin' } }, 404)));

    const result = (await aokieConnector.request('phone.status')) as { connected: boolean };

    expect(result.connected).toBe(true); // the mock's demo phone
  });

  it('falls back to the mock when the pairing token is rejected (auth_required → unpaired)', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ message: 'unauthorized' }, 401)));

    const result = (await aokieConnector.request('sms.threads')) as { threads: unknown[] };

    expect(Array.isArray(result.threads)).toBe(true);
  });
});

describe('aokieConnector.status', () => {
  it('reports the mock source when Desktop is absent', async () => {
    const status = await aokieConnector.status();
    expect(status).toMatchObject({ id: 'aokie', available: true, source: 'mock' });
  });

  it('reports the desktop route (local_http-style) when paired', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ id: 'aokie', available: true, detail: 'plugin running' })));

    const status = await aokieConnector.status();

    expect(status).toMatchObject({ id: 'aokie', available: true, source: 'local_http' });
  });

  it('surfaces a real desktop error as unavailable instead of masking with the mock', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'command_failed', message: 'probe failed' } }, 500)));

    const status = await aokieConnector.status();

    expect(status.available).toBe(false);
    expect(status.source).toBe('local_http');
    expect(status.detail).toBe('probe failed');
  });
});

describe('mock event simulation', () => {
  it('simulateIncomingCall pushes the scripted contract sequence into the event hub', async () => {
    // Detection probe fetches are irrelevant here — no desktop, hub stays local-only.
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    const names: string[] = [];
    const unsub = subscribeDesktopEvents((e) => names.push(e.name));

    const callId = await simulateIncomingCall({ stepDelayMs: 0 });

    expect(callId).toMatch(/^call_demo_/);
    expect(names).toEqual([
      'aokie.dongle.detected',
      'aokie.dongle.ready',
      'aokie.call.incoming',
      'aokie.call.answered',
      'aokie.call.turn.final',
      'aokie.call.turn.final',
      'aokie.call.ended',
      'aokie.sms.received',
    ]);
    unsub();
  });

  it('mock sms.send acknowledges queued and emits aokie.sms.sent locally', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    const names: string[] = [];
    const unsub = subscribeDesktopEvents((e) => names.push(e.name));

    const result = (await mockAokieConnector.request('sms.send', { to: '+61400000000', body: 'hello' })) as {
      messageId: string;
      status: string;
    };

    expect(result.status).toBe('queued');
    expect(result.messageId).toMatch(/^msg_demo_/);
    expect(names).toEqual(['aokie.sms.sent']);
    unsub();
  });

  it('mock rejects an unsupported command with a typed ConnectorError', async () => {
    await expect(mockAokieConnector.request('sms.thread', { threadId: 'x' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'command_failed',
    });
  });
});

/** Poll until the predicate passes (the demo script advances on real timers). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Canonical contract shapes (audit C-01/C-02): the mock answers with the SAME
// schema as the real plugin, and its call controls enforce the same callId
// guard — demo parity means the Live Call screen exercises real behaviour.
describe('mock contract parity', () => {
  it('phone.status nests the device like the real plugin (no root deviceName)', async () => {
    const res = (await mockAokieConnector.request('phone.status')) as Record<string, unknown>;
    expect(res.paired).toBe(true);
    expect(res.connected).toBe(true);
    expect((res.device as Record<string, unknown>).name).toBe('Demo Phone');
    expect((res.device as Record<string, unknown>).address).toBeTruthy();
    expect('deviceName' in res).toBe(false);
  });

  it('call controls honour callId: stale ids are refused, the current id operates the call', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    const names: string[] = [];
    const unsub = subscribeDesktopEvents((e) => names.push(e.name));

    // No live call yet — a callId is stale, not "unsupported".
    await expect(mockAokieConnector.request('call.answer', { callId: 'call_gone' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'stale_call',
    });

    const scriptDone = simulateIncomingCall({ stepDelayMs: 150 });
    await waitUntil(() => names.includes('aokie.call.incoming'));

    const current = (await mockAokieConnector.request('call.current')) as {
      call: { callId: string; state: string; from: string; startedAt: string };
    };
    expect(current.call.callId).toMatch(/^call_demo_/);
    expect(current.call.state).toBe('ringing');
    expect(current.call.startedAt).toBeTruthy();

    // A stale id must not touch the call.
    await expect(mockAokieConnector.request('call.hangup', { callId: 'call_other' })).rejects.toMatchObject({
      code: 'stale_call',
    });

    // The exact payload the Live Call screen sends (audit C-01's broken case).
    const answered = await mockAokieConnector.request('call.answer', { callId: current.call.callId });
    expect(answered).toMatchObject({ answered: true });
    const active = (await mockAokieConnector.request('call.current')) as { call: { state: string } };
    expect(active.call.state).toBe('active');

    const spoken = await mockAokieConnector.request('call.operatorSpeak', {
      text: 'One moment please.',
      callId: current.call.callId,
    });
    expect(spoken).toMatchObject({ spoken: true });

    const ended = await mockAokieConnector.request('call.hangup', { callId: current.call.callId });
    expect(ended).toMatchObject({ ended: true });

    // The demo script must NOT resurrect the ended call.
    await scriptDone;
    const final = (await mockAokieConnector.request('call.current')) as { call: { state: string } | null };
    expect(final.call?.state ?? 'ended').toBe('ended');
    expect(names).not.toContain('aokie.sms.received');
    unsub();
  });
});
