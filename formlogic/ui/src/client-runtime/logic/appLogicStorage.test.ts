// ctx.storage: the trusted host passes its read-only snapshot of the app's logic storage
// (useCustomAppLogic's readLogicStorageSnapshot) into every script's ctx, so the shipped
// dedupe guards (`if (ctx.storage && ctx.storage[key]) return {}`) actually fire — and
// holds back a seen-marker whose record write failed, so a guard never skips a lost record.
// The engine is mocked for the ctx-shape and effect tests; the last test runs the script in
// the REAL ZIPP sandbox (zipp-host runEval, minus the Worker Vitest doesn't have).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runHook } from './appLogicHost';
import { runAppLogic } from '../../lib/formlogic';
import { runEval } from '../../lib/formlogic/zipp-host';
import type { CustomAppLogicBundle } from '../../types/customAppLogic';

vi.mock('../../lib/formlogic', () => ({
  runAppLogic: vi.fn(),
}));

const mockedRunAppLogic = vi.mocked(runAppLogic);

beforeEach(() => {
  mockedRunAppLogic.mockReset();
});

function bundleWith(scripts: CustomAppLogicBundle['scripts'], permissions: string[] = []): CustomAppLogicBundle {
  return {
    version: 1,
    runtime: 'quickjs',
    strictPermissions: true,
    scripts,
    permissions: permissions as CustomAppLogicBundle['permissions'],
  };
}

const script = (id: string, hook: CustomAppLogicBundle['scripts'][number]['hook'], source = 'function run(ctx) { return {}; }') => ({
  id,
  hook,
  runtime: 'quickjs' as const,
  source,
  enabled: true,
});

function ctxOfCall(n: number): Record<string, unknown> {
  return mockedRunAppLogic.mock.calls[n][1];
}

describe('runHook — ctx.storage', () => {
  it('passes the storage snapshot to the script as a JSON copy', async () => {
    mockedRunAppLogic.mockResolvedValue({});
    const storage = { 'seen-k1': 1, counters: { calls: 2 } };

    await runHook({
      bundle: bundleWith([script('s1', 'onConnectorEvent')]),
      hook: 'onConnectorEvent',
      input: { event: { name: 'x' }, storage },
    });

    expect(mockedRunAppLogic).toHaveBeenCalledTimes(1);
    const ctx = ctxOfCall(0);
    expect(ctx.storage).toEqual(storage);
    expect(ctx.storage).not.toBe(storage);
    expect((ctx.storage as typeof storage).counters).not.toBe(storage.counters);
  });

  it('gives an empty snapshot when the caller has none', async () => {
    mockedRunAppLogic.mockResolvedValue({});

    await runHook({
      bundle: bundleWith([script('s1', 'onBeforeSubmit')]),
      hook: 'onBeforeSubmit',
      input: { answers: { a: 1 } },
    });

    expect(ctxOfCall(0).storage).toEqual({});
  });

  it('carries the snapshot into the chained onConnectorEvent run', async () => {
    mockedRunAppLogic
      .mockResolvedValueOnce({ effects: [{ type: 'connector.request', connectorId: 'device', command: 'gps.read' }] })
      .mockResolvedValue({});
    const connectorRequest = vi.fn(async () => ({ lat: 1, lng: 2 }));

    const outcome = await runHook({
      bundle: bundleWith(
        [script('enter', 'onScreenEnter'), script('event', 'onConnectorEvent')],
        ['connector.device.gps.read']
      ),
      hook: 'onScreenEnter',
      input: { storage: { 'seen-k1': 1 } },
      handlers: { connectorRequest },
    });

    expect(outcome.errors).toEqual([]);
    expect(mockedRunAppLogic).toHaveBeenCalledTimes(2);
    expect(ctxOfCall(1).hook).toBe('onConnectorEvent');
    expect(ctxOfCall(1).storage).toEqual({ 'seen-k1': 1 });
  });

  // Now that scripts read their markers, a marker stored for a record that was never written
  // would lose that record for good: every redelivery would be skipped.
  describe('a seen-marker after a failed record write is held back', () => {
    const MARKER_AFTER_WRITE = [
      { type: 'formlogic.submitResponse', formKey: 'calls', answers: { call_id: 'c1' } },
      { type: 'storage.set', key: 'seen-k1', value: 1 },
      { type: 'ui.toast', level: 'info', message: 'Incoming call' },
    ];
    const GRANTS = ['formlogic.responses.write', 'storage.local', 'ui.toast'];

    it('when the write throws', async () => {
      mockedRunAppLogic.mockResolvedValue({ effects: MARKER_AFTER_WRITE });
      const submitResponse = vi.fn(async () => { throw new Error('422 validation failed'); });
      const storageSet = vi.fn();
      const toast = vi.fn();

      const outcome = await runHook({
        bundle: bundleWith([script('incoming', 'onConnectorEvent')], GRANTS),
        hook: 'onConnectorEvent',
        input: { event: { name: 'aokie.call.incoming' }, storage: {} },
        handlers: { submitResponse, storageSet, toast },
      });

      expect(submitResponse).toHaveBeenCalledTimes(1);
      expect(storageSet).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('Incoming call', 'info'); // only markers are held back
      expect(outcome.errors).toEqual([
        'submitResponse calls: 422 validation failed',
        "incoming: held back storage.set 'seen-k1' because a record write earlier in this script failed; the event will be handled again",
      ]);
    });

    it('when the write is malformed', async () => {
      mockedRunAppLogic.mockResolvedValue({
        effects: [
          { type: 'formlogic.updateResponse', formKey: '', answers: { status: 'answered' } },
          { type: 'storage.set', key: 'seen-k1', value: 1 },
        ],
      });
      const updateResponse = vi.fn(async () => ({}));
      const storageSet = vi.fn();

      const outcome = await runHook({
        bundle: bundleWith([script('answered', 'onConnectorEvent')], GRANTS),
        hook: 'onConnectorEvent',
        input: { event: {} },
        handlers: { updateResponse, storageSet },
      });

      expect(updateResponse).not.toHaveBeenCalled();
      expect(storageSet).not.toHaveBeenCalled();
      expect(outcome.errors[1]).toContain("held back storage.set 'seen-k1'");
    });

    it('when the write is denied', async () => {
      mockedRunAppLogic.mockResolvedValue({ effects: MARKER_AFTER_WRITE });
      const submitResponse = vi.fn(async () => ({}));
      const storageSet = vi.fn();

      const outcome = await runHook({
        bundle: bundleWith([script('incoming', 'onConnectorEvent')], ['storage.local', 'ui.toast']),
        hook: 'onConnectorEvent',
        input: { event: {} },
        handlers: { submitResponse, storageSet, toast: vi.fn() },
      });

      expect(outcome.deniedPermissions).toEqual(['formlogic.responses.write']);
      expect(submitResponse).not.toHaveBeenCalled();
      expect(storageSet).not.toHaveBeenCalled();
    });

    it('but not a marker before the failed write, after a successful one, or in another script', async () => {
      mockedRunAppLogic
        .mockResolvedValueOnce({
          effects: [
            { type: 'storage.set', key: 'before', value: 1 },
            { type: 'formlogic.submitResponse', formKey: 'calls', answers: { n: 1 } },
            { type: 'storage.set', key: 'after-failed', value: 1 },
          ],
        })
        .mockResolvedValueOnce({
          effects: [
            { type: 'formlogic.submitResponse', formKey: 'calls', answers: { n: 2 } },
            { type: 'storage.set', key: 'after-written', value: 1 },
          ],
        });
      const submitResponse = vi.fn(async (): Promise<unknown> => ({})).mockRejectedValueOnce(new Error('500'));
      const storageSet = vi.fn();

      const outcome = await runHook({
        bundle: bundleWith([script('first', 'onConnectorEvent'), script('second', 'onConnectorEvent')], GRANTS),
        hook: 'onConnectorEvent',
        input: { event: {} },
        handlers: { submitResponse, storageSet },
      });

      expect(submitResponse).toHaveBeenCalledTimes(2);
      expect(storageSet.mock.calls).toEqual([
        ['before', 1],
        ['after-written', 1],
      ]);
      expect(outcome.errors).toHaveLength(2);
      expect(outcome.errors[1]).toContain("first: held back storage.set 'after-failed'");
    });
  });

  it('stores true for a storage.set with no value, so the marker reads back as set', async () => {
    mockedRunAppLogic.mockResolvedValue({ effects: [{ type: 'storage.set', key: 'seen-k1' }] });
    const storageSet = vi.fn();

    await runHook({
      bundle: bundleWith([script('s1', 'onConnectorEvent')], ['storage.local']),
      hook: 'onConnectorEvent',
      input: { event: {} },
      handlers: { storageSet },
    });

    expect(storageSet).toHaveBeenCalledWith('seen-k1', true);
  });

  it('a dedupe guard on ctx.storage fires in the real ZIPP sandbox', async () => {
    mockedRunAppLogic.mockImplementation((source, ctx, budgetMs) =>
      runEval('applogic', source, ctx, { budgetMs })
    );
    // The shape every shipped aokie script uses: skip an event whose seen-marker is stored,
    // otherwise act and write the marker.
    const DEDUPE = `function run(ctx) {
  var ev = ctx.event || {};
  var key = 'seen-' + String(ev.idempotencyKey);
  if (ctx.storage && ctx.storage[key]) return {};
  return { effects: [
    { type: 'ui.toast', level: 'info', message: 'handled ' + ev.idempotencyKey },
    { type: 'storage.set', key: key, value: 1 }
  ] };
}`;
    const bundle = bundleWith([script('dedupe', 'onConnectorEvent', DEDUPE)], ['ui.toast', 'storage.local']);
    const event = { name: 'aokie.call.incoming', idempotencyKey: 'k1' };

    const toast = vi.fn();
    const storageSet = vi.fn();
    const first = await runHook({ bundle, hook: 'onConnectorEvent', input: { event, storage: {} }, handlers: { toast, storageSet } });
    expect(first.errors).toEqual([]);
    expect(toast).toHaveBeenCalledWith('handled k1', 'info');
    expect(storageSet).toHaveBeenCalledWith('seen-k1', 1);

    toast.mockClear();
    storageSet.mockClear();
    const redelivery = await runHook({
      bundle,
      hook: 'onConnectorEvent',
      input: { event, storage: { 'seen-k1': 1 } },
      handlers: { toast, storageSet },
    });
    expect(redelivery.errors).toEqual([]);
    expect(redelivery.ran).toBe(1);
    expect(toast).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });
});
