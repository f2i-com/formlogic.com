// The desktop → app-logic bridge under the single-writer rule, split by script language
// (formlogic-python/1). A fresh Desktop runs the onConnectorEvent scripts it can: JavaScript
// always, Python only when its heartbeat advertises 'logic-language:python' (GET
// /api/v1/app-logic hands it Python scripts only then). The browser runs the rest, so a Python
// script is never stranded and no script runs in both places.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverDesktopEnvelope } from './useDesktopConnectorEvents';
import { __resetFlowDispatcherForTests, __setFlowDispatcherDepsForTests, type DesktopRuntimeStatus } from '../flows/flowDispatcher';
import { runHook } from '../logic/appLogicHost';
import { runAppLogic } from '../../lib/formlogic';
import type { DesktopEventEnvelope } from './desktopTypes';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

vi.mock('../../lib/formlogic', () => ({
  runAppLogic: vi.fn(async () => ({})),
}));

const mockedRunAppLogic = vi.mocked(runAppLogic);

afterEach(() => {
  __resetFlowDispatcherForTests();
  mockedRunAppLogic.mockClear();
});

const ENVELOPE: DesktopEventEnvelope = {
  schemaVersion: 1,
  name: 'aokie.call.incoming',
  connectorId: 'aokie',
  source: 'aokie',
  correlationId: 'call-1',
  idempotencyKey: 'evt-1',
  occurredAt: '2026-09-16T00:00:00Z',
  data: { from: '+61491570156' },
};

const BUNDLE: CustomAppLogicBundle = {
  version: 1,
  runtime: 'quickjs',
  scripts: [
    { id: 'js', hook: 'onConnectorEvent', runtime: 'quickjs', source: 'function run(ctx) { return {}; }' },
    { id: 'py', hook: 'onConnectorEvent', runtime: 'quickjs', source: 'def run(ctx):\n    return {}', language: 'python' },
  ],
};

/** The bridge over the real host: which scripts' sources reached the engine, per delivery. */
async function deliver(envelope: DesktopEventEnvelope, status: DesktopRuntimeStatus | boolean): Promise<string[]> {
  __setFlowDispatcherDepsForTests({ desktopRuntimeFresh: async () => status });
  mockedRunAppLogic.mockClear();
  await deliverDesktopEnvelope(envelope, (event, options) =>
    runHook({ bundle: BUNDLE, hook: 'onConnectorEvent', input: { event }, languages: options?.languages })
  );
  return mockedRunAppLogic.mock.calls.map((call) => (call[3] === 'python' ? 'py' : 'js'));
}

describe('deliverDesktopEnvelope — the single-writer rule per script language', () => {
  it('a fresh Desktop without Python takes the JavaScript scripts; the Python ones run here', async () => {
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['desktop-capabilities:1']] })).toEqual(['py']);
    // An older probe that only answers "fresh" is the same Desktop.
    expect(await deliver(ENVELOPE, true)).toEqual(['py']);
  });

  it('a fresh Desktop advertising Python takes every script', async () => {
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['logic-language:python']] })).toEqual([]);
  });

  it('no fresh Desktop, or an event that is not desktop-first: every script runs here', async () => {
    expect(await deliver(ENVELOPE, { fresh: false, freshCapabilities: [] })).toEqual(['js', 'py']);
    expect(await deliver({ ...ENVELOPE, name: 'vehicle.status.changed' }, true)).toEqual(['js', 'py']);
  });

  it('hands the scripts the envelope as onConnectorEvent sees it', async () => {
    const run = vi.fn(async () => ({ ran: 0, rejected: false, warnings: [], values: {}, deniedPermissions: [], errors: [] }));
    __setFlowDispatcherDepsForTests({ desktopRuntimeFresh: async () => true });
    await deliverDesktopEnvelope(ENVELOPE, run);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'aokie.call.incoming', connectorId: 'aokie', idempotencyKey: 'evt-1', result: ENVELOPE.data }),
      { languages: ['python'] }
    );
  });
});
