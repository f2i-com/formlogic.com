// The desktop → app-logic bridge under the single-writer rule, split by script language
// (formlogic-python/1). A fresh Desktop runs the onConnectorEvent scripts it can: a legacy
// Desktop (no capability tokens) JavaScript always; a ZIPP-era Desktop (any 'logic-language:*'
// token) the languages it names, and only while it also sends 'logic-engine:zipp' (GET
// /api/v1/app-logic hands it Python scripts only when it advertises 'logic-language:python').
// The browser runs the rest, so a script is never stranded and none runs in both places.
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
    // A legacy Desktop (no capability tokens).
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [[]] })).toEqual(['py']);
    // An older probe that only answers "fresh" is the same Desktop.
    expect(await deliver(ENVELOPE, true)).toEqual(['py']);
    // A healthy ZIPP-era Desktop that names JavaScript only.
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['logic-language:javascript', 'logic-engine:zipp']] })).toEqual(['py']);
  });

  it('a fresh Desktop advertising Python with a healthy engine takes every script', async () => {
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['logic-language:python', 'logic-engine:zipp']] })).toEqual([]);
  });

  // Before PR-A the python token alone took every script ([]): a language token marks a ZIPP-era
  // Desktop, and without 'logic-engine:zipp' its engine is down, so every script runs here.
  it('a ZIPP-era Desktop whose engine is down takes no script at all', async () => {
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['logic-language:python']] })).toEqual(['js', 'py']);
    expect(await deliver(ENVELOPE, { fresh: true, freshCapabilities: [['logic-language:javascript']] })).toEqual(['js', 'py']);
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
