import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import aokieReceptionistPack from '../pack';
import {
  __resetPackConnectorsForTests,
  __setDriverEvaluatorForTests,
  registerPackConnector,
  runConnectorCeremony,
} from '../../../../client-runtime/connectors/packConnectorDriver';
import {
  __resetSimulatorSessionsForTests,
  enableSimulator,
} from '../../../../client-runtime/connectors/connectorSimulator';
import { getConnectorClient } from '../../../../client-runtime/connectors/nativeConnectorClient';
import {
  __resetDesktopDetectionForTests,
  __setDesktopInfoForTests,
} from '../../../../client-runtime/desktop/desktopDetection';
import {
  clearDesktopToken,
  storeDesktopToken,
} from '../../../../client-runtime/desktop/desktopPairing';
import {
  __resetDesktopEventsForTests,
  subscribeDesktopEvents,
} from '../../../../client-runtime/desktop/desktopEvents';
import type { DesktopEventEnvelope } from '../../../../client-runtime/desktop/desktopTypes';
import { setConnectorCapabilityContext } from '../../../../client-runtime/desktop/desktopClient';
import { runEval } from '../../../../lib/formlogic/zipp-host';
import { api } from '../../../../lib/api';

// The pack-embedded aokie DEMO driver (connector/driver.js), ported from the retired
// browser mock (client-runtime/connectors/aokieConnector.ts) and driven through the
// REAL machinery: registerPackConnector (grant-gated) → the composed desktop-backed
// connector → the QuickJS sandbox (runEval — the exact production semantics, minus
// the Worker Vitest doesn't have).
//
// Routing (FL-CONN-001): desktop present+paired → the Desktop gateway; desktop
// absent/unpaired → the simulator ONLY inside an explicit simulator session,
// otherwise a typed connector_unavailable; and once a real desktop route was
// attempted, NOTHING falls back to the demo — every failure surfaces typed.

const bundle = aokieReceptionistPack.apps[0].customLogic!.connector!;

const aokie = {
  request: (command: string, payload?: unknown) =>
    getConnectorClient().request('aokie', command, payload),
  status: () => getConnectorClient().status('aokie'),
};

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

beforeEach(() => {
  __setDriverEvaluatorForTests((src, ctx, budget) => runEval('applogic', src, ctx, { budgetMs: budget }));
  // The install grant that activates the pack's demo driver (the APP-502 strip point).
  expect(registerPackConnector(bundle, new Set(['connector.aokie.driver.demo']))).toBeNull();
});

afterEach(() => {
  __setDriverEvaluatorForTests(null);
  __resetPackConnectorsForTests();
  __resetSimulatorSessionsForTests();
  __resetDesktopDetectionForTests();
  __resetDesktopEventsForTests();
  clearDesktopToken();
  setConnectorCapabilityContext(null);
  api.setDemoMode(false);
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('aokie pack connector — request routing', () => {
  it('routes through the Desktop gateway when detected AND paired', async () => {
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true, data: { connected: true, deviceName: 'Pixel 9' } })));

    const result = await aokie.request('phone.status');

    expect(result).toEqual({ connected: true, deviceName: 'Pixel 9' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:17872/api/connectors/aokie/request');
  });

  it('supplies a durable requestId for physical mutations but not read commands', async () => {
    desktopPairedAndDetected();
    const fetchMock = setFetch(
      vi.fn(() => jsonResponse({ ok: true, data: { accepted: true } }))
    );

    await aokie.request('phone.connect', { address: '00:11:22:33:44:55' });
    await aokie.request('phone.status');

    const requestBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/connectors/aokie/request'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      connectorId: 'aokie',
      command: 'phone.connect',
      payload: { address: '00:11:22:33:44:55' },
    });
    expect(requestBodies[0].requestId).toMatch(/^ui-phone\.connect-[0-9a-f-]{36}$/);
    expect(requestBodies[1]).toMatchObject({ connectorId: 'aokie', command: 'phone.status' });
    expect(requestBodies[1]).not.toHaveProperty('requestId');
  });

  it('gives each phone.connect action a plugin-safe durable requestId', async () => {
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => jsonResponse({ ok: true, data: { accepted: true } })));

    await aokie.request('phone.connect', { address: '00:11:22:33:44:55' });
    await aokie.request('phone.connect', { address: '00:11:22:33:44:55' });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
      requestId?: string;
    });
    expect(bodies[0].requestId).toMatch(/^ui-phone\.connect-[A-Za-z0-9_.:-]+$/);
    expect(bodies[0].requestId?.length).toBeLessThanOrEqual(128);
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });

  it('reuses phone.connect requestId when capability refresh retries the same action', async () => {
    desktopPairedAndDetected();
    setConnectorCapabilityContext('aokie-app');
    let capabilityMint = 0;
    const gatewayBodies: Array<{ requestId?: string }> = [];
    setFetch(vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/app/')) {
        capabilityMint += 1;
        return jsonResponse({ token: `cap-${capabilityMint}`, expiresInSeconds: 300 });
      }
      gatewayBodies.push(JSON.parse(String(init?.body)) as { requestId?: string });
      return gatewayBodies.length === 1
        ? jsonResponse({ ok: false, error: { code: 'capability_denied', message: 'refresh' } }, 403)
        : jsonResponse({ ok: true, data: { accepted: true } });
    }));

    await aokie.request('phone.connect', { address: '00:11:22:33:44:55' });

    expect(capabilityMint).toBe(2);
    expect(gatewayBodies).toHaveLength(2);
    expect(gatewayBodies[0].requestId).toBeTruthy();
    expect(gatewayBodies[1].requestId).toBe(gatewayBodies[0].requestId);
  });

  it('Desktop absent WITHOUT a simulator session: typed connector_unavailable, never the demo', async () => {
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('should not be called'))));

    await expect(aokie.request('sms.send', { to: '+61400000000', body: 'hi' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'connector_unavailable',
    });
    await expect(aokie.request('dongle.list')).rejects.toMatchObject({ code: 'connector_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the simulator when Desktop is absent AND a simulator session is active, stamped simulated', async () => {
    enableSimulator('aokie');
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('should not be called'))));

    const result = (await aokie.request('dongle.list')) as { dongles: unknown[]; simulated?: boolean };

    expect(Array.isArray(result.dongles)).toBe(true);
    expect(result.simulated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Desktop detected but NOT paired behaves like absent (simulator session required)', async () => {
    __setDesktopInfoForTests({ available: true, companion: 'formlogic-desktop' });
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('should not be called'))));

    await expect(aokie.request('sms.threads')).rejects.toMatchObject({ code: 'connector_unavailable' });

    enableSimulator('aokie');
    const result = (await aokie.request('sms.threads')) as { threads: unknown[] };
    expect(Array.isArray(result.threads)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEVER masks a desktop capability_denied with demo data', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'capability_denied', message: 'call.answer not declared' } }, 403)));

    await expect(aokie.request('call.answer')).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'capability_denied',
    });
  });

  it('NEVER masks a desktop-returned connector_unavailable (plugin stopped) with demo data', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'connector_unavailable', message: 'aokie plugin is stopped' } }, 503)));

    await expect(aokie.request('phone.status')).rejects.toMatchObject({ code: 'connector_unavailable' });
  });

  it('a NETWORK failure on a real attempt is a typed failure — even mid simulator session', async () => {
    desktopPairedAndDetected();
    enableSimulator('aokie'); // the session must NOT let a real mutation fall into the demo
    setFetch(vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    await expect(aokie.request('call.hangup', { callId: 'call_1' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'connector_unavailable',
    });
  });

  it('connector_missing (Desktop up, aokie plugin not installed) surfaces typed, never mocked', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'connector_missing', message: 'no aokie plugin' } }, 404)));

    await expect(aokie.request('phone.status')).rejects.toMatchObject({ code: 'connector_missing' });
  });

  it('a rejected pairing token (auth_required) surfaces typed, never mocked', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ message: 'unauthorized' }, 401)));

    await expect(aokie.request('sms.threads')).rejects.toMatchObject({
      name: 'ConnectorError',
    });
  });
});

describe('demo mode never routes to a real desktop (live report 2026-07-14)', () => {
  // The local gateway bypasses the server's demo_readonly guard entirely, so a demo
  // session on a machine running a paired FormLogic Desktop could otherwise DRIVE the
  // operator's actual phone bridge (and Device Setup showed the real dongle while
  // "Calls" read Listening off the real radio). Demo = the simulator, unconditionally.
  it('request: demo + desktop detected AND paired still answers from the simulator', async () => {
    api.setDemoMode(true);
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('the real desktop must never be called'))));

    const result = (await aokie.request('phone.status')) as {
      device?: { name?: string };
      simulated?: boolean;
    };

    expect(result.simulated).toBe(true);
    expect(result.device?.name).toBe('Demo Phone');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status: demo + paired desktop reports the demo bridge, never the desktop', async () => {
    api.setDemoMode(true);
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('the real desktop must never be called'))));

    const status = await aokie.status();

    expect(status.source).toBe('mock');
    expect(status.available).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a demo mutation (call.dial) stays inside the simulator — provenance stamped', async () => {
    api.setDemoMode(true);
    desktopPairedAndDetected();
    const fetchMock = setFetch(vi.fn(() => Promise.reject(new Error('the real desktop must never be called'))));

    const result = (await aokie.request('call.dial', {
      number: '+61491570156',
      openingLine: 'Hi, this is a demo call.',
    })) as { accepted?: boolean; simulated?: boolean };

    expect(result.accepted).toBe(true);
    expect(result.simulated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('aokie pack connector — status', () => {
  it('Desktop absent without a simulator session: honestly unavailable', async () => {
    const status = await aokie.status();
    expect(status).toMatchObject({ id: 'aokie', available: false, source: 'mock' });
    // Honest, actionable detail: no local runtime is connected, connect + pair one.
    expect(status.detail).toMatch(/no local runtime is connected/i);
    expect(status.detail).toMatch(/connect and pair/i);
  });

  it('reports the simulator status inside an explicit simulator session', async () => {
    enableSimulator('aokie');
    const status = await aokie.status();
    expect(status).toMatchObject({ id: 'aokie', available: true, source: 'mock' });
    expect(status.label).toBe('Aokie phone bridge (demo)');
  });

  it('reports the desktop route (local_http-style) when paired', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ id: 'aokie', available: true, detail: 'plugin running' })));

    const status = await aokie.status();

    expect(status).toMatchObject({ id: 'aokie', available: true, source: 'local_http' });
  });

  it('surfaces a real desktop error as unavailable instead of masking with the demo', async () => {
    desktopPairedAndDetected();
    setFetch(vi.fn(() => jsonResponse({ ok: false, error: { code: 'command_failed', message: 'probe failed' } }, 500)));

    const status = await aokie.status();

    expect(status.available).toBe(false);
    expect(status.source).toBe('local_http');
    expect(status.detail).toBe('probe failed');
  });
});

describe('demo event simulation (the simulate-call ceremony)', () => {
  it('runs the scripted contract sequence into the event hub, in order', async () => {
    // Detection probe fetches are irrelevant here — no desktop, hub stays local-only.
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    const seen: DesktopEventEnvelope[] = [];
    const unsub = subscribeDesktopEvents((e) => seen.push(e));

    const outcome = await runConnectorCeremony('simulate-call', { sleep: async () => {} });

    expect(outcome).toEqual({ status: 'done' });
    expect(seen.map((e) => e.name)).toEqual([
      'aokie.dongle.detected',
      'aokie.dongle.ready',
      'aokie.call.incoming',
      'aokie.call.answered',
      'aokie.call.turn.final',
      'aokie.call.turn.final',
      'aokie.call.ended',
      'aokie.call.transcript.settled',
      'aokie.sms.received',
    ]);
    // Contract-shaped correlation + host-forced provenance (FL-CONN-001). The host
    // namespaces the driver's idempotency key with `sim:` so it can never collide
    // with (and suppress) a real plugin event of the same name.
    const incoming = seen.find((e) => e.name === 'aokie.call.incoming')!;
    expect(incoming.correlationId).toMatch(/^call_demo_/);
    expect(incoming.idempotencyKey).toBe(`sim:aokie:${incoming.correlationId}:incoming:v1`);
    expect((incoming.data as Record<string, unknown>).simulated).toBe(true);
    unsub();
  });

  it('demo sms.send acknowledges queued and emits aokie.sms.sent locally', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    enableSimulator('aokie');
    const names: string[] = [];
    const unsub = subscribeDesktopEvents((e) => names.push(e.name));

    const result = (await aokie.request('sms.send', { to: '+61400000000', body: 'hello' })) as {
      messageId: string;
      status: string;
    };

    expect(result.status).toBe('queued');
    expect(result.messageId).toMatch(/^msg_demo_/);
    expect(names).toEqual(['aokie.sms.sent']);
    unsub();
  });

  it('the demo rejects an unsupported command with a typed ConnectorError', async () => {
    enableSimulator('aokie');
    await expect(aokie.request('sms.thread', { threadId: 'x' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'command_failed',
    });
  });
});

/** Poll until the predicate passes (the ceremony advances between our releases). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Canonical contract shapes (audit C-01/C-02): the demo driver answers with the SAME
// schema as the real plugin, and its call controls enforce the same callId guard —
// demo parity means the Live Call screen exercises real behaviour.
describe('demo contract parity', () => {
  it('phone.status nests the device like the real plugin (no root deviceName)', async () => {
    enableSimulator('aokie');
    const res = (await aokie.request('phone.status')) as Record<string, unknown>;
    expect(res.paired).toBe(true);
    expect(res.connected).toBe(true);
    expect((res.device as Record<string, unknown>).name).toBe('Demo Phone');
    expect((res.device as Record<string, unknown>).address).toBeTruthy();
    expect('deviceName' in res).toBe(false);
  });

  it('settings.get whole-object carries the ttsVoiceCatalog side key; settings.set round-trips', async () => {
    enableSimulator('aokie');
    const res = (await aokie.request('settings.get')) as {
      settings: Record<string, unknown>;
      configVersion: number;
      managerPinSet: boolean;
      ttsVoiceCatalog: { engines: Array<Record<string, unknown>> };
    };
    expect(res.settings).toMatchObject({ aiReceptionist: true });
    expect(res.managerPinSet).toBe(false);
    // Engine-first console parity: pocket voices + one sherpa bundle.
    const ids = res.ttsVoiceCatalog.engines.map((e) => e.id);
    expect(ids).toEqual(['pocket', 'sherpa']);
    expect(res.ttsVoiceCatalog.engines[0].voices).toContain('alba');
    const bundles = res.ttsVoiceCatalog.engines[1].bundles as Array<Record<string, unknown>>;
    expect(bundles[0]).toMatchObject({ name: 'vits-piper-en_US-lessac-medium', kind: 'vits' });

    const set = (await aokie.request('settings.set', {
      ttsEngine: 'sherpa',
      ttsModelDir: 'C:/aokie/models/tts/vits-piper-en_US-lessac-medium',
    })) as { configVersion: number };
    expect(set.configVersion).toBe(res.configVersion + 1);
    const after = (await aokie.request('settings.get')) as { settings: Record<string, unknown> };
    expect(after.settings.ttsEngine).toBe('sherpa');

    // managerPin stays write-only — reflected only as managerPinSet.
    await aokie.request('settings.set', { managerPin: '123456' });
    const pinned = (await aokie.request('settings.get')) as {
      settings: Record<string, unknown>;
      managerPinSet: boolean;
    };
    expect(pinned.managerPinSet).toBe(true);
    expect('managerPin' in pinned.settings).toBe(false);
  });

  it('call controls honour callId: stale ids are refused, the current id operates the call', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    const names: string[] = [];
    const unsub = subscribeDesktopEvents((e) => names.push(e.name));
    enableSimulator('aokie');

    // No live call yet — a callId is stale, not "unsupported".
    await expect(aokie.request('call.answer', { callId: 'call_gone' })).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'stale_call',
    });

    // Controllable pacing: every ceremony delay parks on a resolver the test
    // releases, so the call controls interleave deterministically mid-script
    // (no real timers).
    const releases: Array<() => void> = [];
    const sleep = () => new Promise<void>((resolve) => { releases.push(resolve); });
    const scriptDone = runConnectorCeremony('simulate-call', { sleep });
    await waitUntil(() => names.includes('aokie.call.incoming'));

    const current = (await aokie.request('call.current')) as {
      call: { callId: string; state: string; from: string; startedAt: string };
    };
    expect(current.call.callId).toMatch(/^call_demo_/);
    expect(current.call.state).toBe('ringing');
    expect(current.call.startedAt).toBeTruthy();

    // A stale id must not touch the call.
    await expect(aokie.request('call.hangup', { callId: 'call_other' })).rejects.toMatchObject({
      code: 'stale_call',
    });

    // The exact payload the Live Call screen sends (audit C-01's broken case).
    const answered = await aokie.request('call.answer', { callId: current.call.callId });
    expect(answered).toMatchObject({ answered: true });
    const active = (await aokie.request('call.current')) as { call: { state: string } };
    expect(active.call.state).toBe('active');

    const spoken = await aokie.request('call.operatorSpeak', {
      text: 'One moment please.',
      callId: current.call.callId,
    });
    expect(spoken).toMatchObject({ spoken: true });

    const ended = await aokie.request('call.hangup', { callId: current.call.callId });
    expect(ended).toMatchObject({ ended: true });

    // Release the parked script — it must observe the dead call and stop, NOT
    // resurrect it (callStillLive guard).
    releases.splice(0).forEach((release) => release());
    const outcome = await scriptDone;
    expect(outcome).toEqual({ status: 'done' });
    const final = (await aokie.request('call.current')) as { call: { state: string } | null };
    expect(final.call?.state ?? 'ended').toBe('ended');
    expect(names).not.toContain('aokie.sms.received');
    unsub();
  });
});
