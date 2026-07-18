import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPackConnectorsForTests,
  __setDriverEvaluatorForTests,
  registerPackConnector,
  runConnectorCeremony,
  validateConnectorManifest,
} from './packConnectorDriver';
import { __resetSimulatorSessionsForTests, enableSimulator } from './connectorSimulator';
import { getConnectorClient } from './nativeConnectorClient';
import { __resetDesktopDetectionForTests } from '../desktop/desktopDetection';
import { __resetDesktopEventsForTests, subscribeDesktopEvents } from '../desktop/desktopEvents';
import type { DesktopEventEnvelope } from '../desktop/desktopTypes';
import type { ConnectorDriverManifest } from '../../types/customAppLogic';
import { runEval } from '../../lib/formlogic/quickjs-host';
import { api } from '../../lib/api';

// Broker rules for pack-embedded connector drivers (packConnectorDriver.ts):
// the demo driver is grant-gated, its events are allowlisted + host-stamped,
// its error codes fold to a demo-safe set, and its state threads between runs.
// Exercised with a MINIMAL synthetic driver against the REAL QuickJS sandbox
// (quickjs-host runEval — same PRELUDE/JSON-ctx/budget semantics as production,
// minus the Worker Vitest doesn't have).

const MANIFEST: ConnectorDriverManifest = {
  connectorId: 'demopack',
  kind: 'demo_kind',
  label: 'Demo Pack Bridge',
  commands: ['echo', 'emit', 'emitArray', 'badcode'],
  demoEvents: ['demo.ok'],
  demoCeremonies: ['loop'],
};

// Classic-JS synthetic driver (runs inside the sandbox, so it follows the same
// conventions as real pack drivers: function run(ctx), pure state threading).
const DRIVER = `
function run(ctx) {
  var state = ctx.state || { count: 0 };
  if (ctx.fn === 'request') {
    if (ctx.command === 'echo') {
      return { result: { seen: state.count }, state: { count: state.count + 1 } };
    }
    if (ctx.command === 'emit') {
      return {
        result: { emitted: true },
        events: [
          { name: 'demo.ok', correlationId: 'c1', idempotencyKey: 'demo:c1:ok:v1', data: { note: 'hi' } },
          { name: 'demo.evil', correlationId: 'c1', idempotencyKey: 'demo:c1:evil:v1', data: { note: 'nope' } }
        ]
      };
    }
    if (ctx.command === 'emitArray') {
      // A driver trying to dodge the provenance stamp with a non-object data payload.
      return {
        result: { emitted: true },
        events: [{ name: 'demo.ok', correlationId: 'c2', idempotencyKey: 'demo:c2:arr:v1', data: [1, 2, 3] }]
      };
    }
    if (ctx.command === 'badcode') {
      return { error: { code: 'origin_denied', message: 'driver tried a host-level trust code' } };
    }
    return { error: { code: 'command_failed', message: 'unknown command' } };
  }
  if (ctx.fn === 'ceremonyStep') {
    return {};
  }
  return {};
}
`;

const GRANT = 'connector.demopack.driver.demo';

function setFetch(mock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

beforeEach(() => {
  __setDriverEvaluatorForTests((src, ctx, budget) => runEval('applogic', src, ctx, { budgetMs: budget }));
});

afterEach(() => {
  __setDriverEvaluatorForTests(null);
  __resetPackConnectorsForTests();
  __resetSimulatorSessionsForTests();
  __resetDesktopDetectionForTests();
  __resetDesktopEventsForTests();
  api.setDemoMode(false);
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('validateConnectorManifest', () => {
  it('rejects a dotted connectorId (grants are segment-based; a dot would forge them)', () => {
    expect(validateConnectorManifest({ ...MANIFEST, connectorId: 'demo.pack' })).toContain('connectorId');
  });

  it('rejects an uppercase connectorId', () => {
    expect(validateConnectorManifest({ ...MANIFEST, connectorId: 'DemoPack' })).toContain('connectorId');
  });

  it('rejects a manifest without commands', () => {
    const rest: Record<string, unknown> = { ...MANIFEST };
    delete rest.commands;
    expect(validateConnectorManifest(rest)).toContain('commands');
  });

  it('rejects oversized lists', () => {
    const demoEvents = Array.from({ length: 33 }, (_v, i) => `demo.ev${i}`);
    expect(validateConnectorManifest({ ...MANIFEST, demoEvents })).toContain('demoEvents');
  });

  it('accepts the synthetic manifest', () => {
    expect(validateConnectorManifest(MANIFEST)).toBeNull();
  });

  it('rejects a reserved built-in id (a pack must not shadow device/vehicle/local_http)', () => {
    for (const id of ['device', 'vehicle', 'local_http']) {
      expect(validateConnectorManifest({ ...MANIFEST, connectorId: id })).toContain('reserved');
    }
  });
});

describe('reserved-id registration guard (never clobber a built-in connector)', () => {
  it('registerPackConnector refuses a reserved id and leaves the built-in intact', async () => {
    // Registering id 'device' must NOT overwrite the WebView's own geolocation/camera
    // connector — the pack path returns an error, and 'device' still resolves.
    const err = registerPackConnector({ manifest: { ...MANIFEST, connectorId: 'device' }, demoDriver: DRIVER }, new Set());
    expect(err).toContain('reserved');
    const status = await getConnectorClient().status('device');
    expect(status.id).toBe('device');
  });
});

describe('grant gating (connector.<id>.driver.demo is the install-review strip point)', () => {
  it('without the grant the demo facade is inert: transport-only connector_unavailable', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set())).toBeNull();
    enableSimulator('demopack');

    await expect(getConnectorClient().request('demopack', 'echo')).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'connector_unavailable',
    });
  });

  it('without the grant a declared ceremony reports unavailable, never runs', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set())).toBeNull();

    const outcome = await runConnectorCeremony('loop', { sleep: async () => {} });

    expect(outcome).toMatchObject({ status: 'unavailable' });
  });

  it('with the grant + a simulator session the driver answers, host-stamped simulated', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();
    enableSimulator('demopack');

    const result = (await getConnectorClient().request('demopack', 'echo')) as {
      seen: number;
      simulated?: boolean;
    };

    expect(result.seen).toBe(0);
    expect(result.simulated).toBe(true);
  });
});

describe('event allowlist + provenance', () => {
  it('only manifest.demoEvents names leave the sandbox, and data.simulated is host-forced', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();
    enableSimulator('demopack');
    const seen: DesktopEventEnvelope[] = [];
    const unsub = subscribeDesktopEvents((e) => seen.push(e));

    await getConnectorClient().request('demopack', 'emit');

    expect(seen.map((e) => e.name)).toEqual(['demo.ok']);
    // The driver set no `simulated` flag — the trusted host stamped it.
    expect((seen[0].data as Record<string, unknown>).simulated).toBe(true);
    expect((seen[0].data as Record<string, unknown>).note).toBe('hi');
    // …and the host namespaces the key `sim:` so it can't suppress a real event.
    expect(seen[0].idempotencyKey).toBe('sim:demo:c1:ok:v1');
    unsub();
  });

  it('provenance is TOTAL: a non-object event data payload is still stamped simulated', async () => {
    setFetch(vi.fn(() => Promise.reject(new Error('offline'))));
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();
    enableSimulator('demopack');
    const seen: DesktopEventEnvelope[] = [];
    const unsub = subscribeDesktopEvents((e) => seen.push(e));

    await getConnectorClient().request('demopack', 'emitArray');

    // An array data payload can't carry the flag directly — the host wraps it.
    const data = seen[0].data as Record<string, unknown>;
    expect(data.simulated).toBe(true);
    expect(data.value).toEqual([1, 2, 3]);
    unsub();
  });
});

describe('error-code folding', () => {
  it("a driver cannot fabricate host-level trust codes — origin_denied folds to command_failed", async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();
    enableSimulator('demopack');

    await expect(getConnectorClient().request('demopack', 'badcode')).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'command_failed',
    });
  });
});

describe('state threading', () => {
  it('two sequential requests see the prior request\'s returned state', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();
    enableSimulator('demopack');

    const first = (await getConnectorClient().request('demopack', 'echo')) as { seen: number };
    const second = (await getConnectorClient().request('demopack', 'echo')) as { seen: number };

    expect(first.seen).toBe(0);
    expect(second.seen).toBe(1);
  });
});

describe('ceremonies', () => {
  it('an undeclared ceremony name resolves null (unknown to every registered connector)', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();

    expect(await runConnectorCeremony('nope', { sleep: async () => {} })).toBeNull();
  });

  it('a driver that never says done hits the host step cap — truthful failure', async () => {
    expect(registerPackConnector({ manifest: MANIFEST, demoDriver: DRIVER }, new Set([GRANT]))).toBeNull();

    const outcome = await runConnectorCeremony('loop', { sleep: async () => {} });

    expect(outcome).toEqual({ status: 'failed', message: 'The demo sequence never completed.' });
  });
});
