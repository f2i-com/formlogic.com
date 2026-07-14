import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectRequiredPermission, isPermissionGranted } from './appLogicPermissions';
import { runHook } from './appLogicHost';
import { runAppLogic } from '../../lib/formlogic';
import type { CustomAppLogicBundle, CustomAppLogicEffect } from '../../types/customAppLogic';

// flow.run effect (docs/FORMLOGIC_FLOWS.md §5): required permission is 'flow.<slug>.run',
// covered by the exact grant, the 'flow.*.run' wildcard, or the bare grant-all 'flow.run'.
// The host defers flow.run like connector requests and chains a sync result back through
// onConnectorEvent. The QuickJS engine is mocked — the WASM worker can't run under node.

vi.mock('../../lib/formlogic', () => ({
  runAppLogic: vi.fn(),
}));

const mockedRunAppLogic = vi.mocked(runAppLogic);

const effect = (e: Record<string, unknown>): CustomAppLogicEffect => e as unknown as CustomAppLogicEffect;

beforeEach(() => {
  mockedRunAppLogic.mockReset();
});

describe('flow.run permission mapping', () => {
  it('maps the effect to flow.<slug>.run', () => {
    expect(effectRequiredPermission(effect({ type: 'flow.run', flow: 'caller-lookup' }))).toBe(
      'flow.caller-lookup.run'
    );
  });

  it('is denied without a grant and allowed with exact / wildcard / grant-all forms', () => {
    const required = 'flow.caller-lookup.run';
    expect(isPermissionGranted(required, [])).toBe(false);
    expect(isPermissionGranted(required, ['flow.other.run'])).toBe(false);
    expect(isPermissionGranted(required, ['flow.caller-lookup.run'])).toBe(true);
    expect(isPermissionGranted(required, ['flow.*.run'])).toBe(true);
    // Bare 'flow.run' acts as grant-all-flows.
    expect(isPermissionGranted(required, ['flow.run'])).toBe(true);
    expect(isPermissionGranted(required, ['*'])).toBe(true);
  });

  it('flow wildcards never leak onto non-flow permissions', () => {
    expect(isPermissionGranted('connector.aokie.sms.send', ['flow.run'])).toBe(false);
    expect(isPermissionGranted('connector.aokie.sms.send', ['flow.*.run'])).toBe(false);
    // The inner-segment wildcard matches exactly one segment.
    expect(isPermissionGranted('flow.a.b.run', ['flow.*.run'])).toBe(false);
  });
});

function bundleWith(permissions: string[]): CustomAppLogicBundle {
  return {
    version: 1,
    runtime: 'quickjs',
    scripts: [
      {
        id: 's1',
        hook: 'onButtonClick',
        runtime: 'quickjs',
        source: 'function run(ctx) { return {}; }',
        enabled: true,
      },
    ],
    permissions: permissions as CustomAppLogicBundle['permissions'],
  };
}

describe('runHook — flow.run effect gating', () => {
  it('denies flow.run without a grant (handler never called)', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'flow.run', flow: 'caller-lookup', mode: 'sync' }],
    });
    const flowRun = vi.fn(async () => ({ found: true }));

    const outcome = await runHook({
      bundle: bundleWith([]),
      hook: 'onButtonClick',
      input: {},
      handlers: { flowRun },
    });

    expect(flowRun).not.toHaveBeenCalled();
    expect(outcome.deniedPermissions).toContain('flow.caller-lookup.run');
  });

  it('runs a granted sync flow.run and chains the result into onConnectorEvent', async () => {
    const seenEvents: unknown[] = [];
    mockedRunAppLogic.mockImplementation(async (_src, ctx) => {
      const c = ctx as { hook?: string; event?: unknown };
      if (c.hook === 'onConnectorEvent') {
        seenEvents.push(c.event);
        return {};
      }
      return { effects: [{ type: 'flow.run', flow: 'caller-lookup', mode: 'sync', input: { x: 1 } }] };
    });
    const flowRun = vi.fn(async () => ({ found: true, record: { id: 'r1' } }));

    const bundle = bundleWith(['flow.*.run']);
    // Add an onConnectorEvent script so the chained hook actually runs.
    bundle.scripts.push({
      id: 's2',
      hook: 'onConnectorEvent',
      runtime: 'quickjs',
      source: 'function run(ctx) { return {}; }',
      enabled: true,
    });

    const outcome = await runHook({
      bundle,
      hook: 'onButtonClick',
      input: {},
      handlers: { flowRun },
    });

    expect(flowRun).toHaveBeenCalledWith('caller-lookup', { mode: 'sync', timeoutMs: undefined, input: { x: 1 } });
    expect(outcome.deniedPermissions).toHaveLength(0);
    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]).toEqual({ flow: 'caller-lookup', source: 'flow', result: { found: true, record: { id: 'r1' } } });
  });

  it('a failing sync flow.run degrades to a recorded error, never a throw', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'flow.run', flow: 'caller-lookup', mode: 'sync' }],
    });
    const flowRun = vi.fn(async () => {
      throw new Error('flow exploded');
    });

    const outcome = await runHook({
      bundle: bundleWith(['flow.run']),
      hook: 'onButtonClick',
      input: {},
      handlers: { flowRun },
    });

    expect(outcome.errors.some((e) => e.includes('flow exploded'))).toBe(true);
    expect(outcome.rejected).toBe(false);
  });
});
