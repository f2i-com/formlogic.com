// formlogic.updateResponse effect (Aokie Receptionist raw-record updates): permission
// mapping, host application (responseId / match / upsert passthrough), and fail-safe
// error capture. The QuickJS engine is mocked — the WASM worker can't run under node.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectRequiredPermission, isPermissionGranted } from './appLogicPermissions';
import { runHook } from './appLogicHost';
import { runAppLogic } from '../../lib/formlogic';
import type { CustomAppLogicBundle, CustomAppLogicEffect } from '../../types/customAppLogic';

vi.mock('../../lib/formlogic', () => ({
  runAppLogic: vi.fn(),
}));

const mockedRunAppLogic = vi.mocked(runAppLogic);

const effect = (e: Record<string, unknown>): CustomAppLogicEffect => e as unknown as CustomAppLogicEffect;

beforeEach(() => {
  mockedRunAppLogic.mockReset();
});

function bundleWith(permissions: string[]): CustomAppLogicBundle {
  return {
    version: 1,
    runtime: 'quickjs',
    scripts: [
      {
        id: 's1',
        hook: 'onConnectorEvent',
        runtime: 'quickjs',
        source: 'function run(ctx) { return {}; }',
        enabled: true,
      },
    ],
    permissions: permissions as CustomAppLogicBundle['permissions'],
  };
}

describe('formlogic.updateResponse permission mapping', () => {
  it('requires formlogic.responses.write (same grant as submits)', () => {
    const required = effectRequiredPermission(
      effect({ type: 'formlogic.updateResponse', formKey: 'Calls', answers: {} })
    );
    expect(required).toBe('formlogic.responses.write');
    expect(isPermissionGranted(required!, [])).toBe(false);
    expect(isPermissionGranted(required!, ['formlogic.responses.write'])).toBe(true);
    expect(isPermissionGranted(required!, ['formlogic.*'])).toBe(true);
  });
});

describe('runHook — formlogic.updateResponse', () => {
  it('passes responseId / match / upsert through to the trusted handler', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [
        {
          type: 'formlogic.updateResponse',
          formKey: 'Calls',
          match: { field: 'call_id', value: 'call_abc' },
          answers: { status: 'answered' },
          upsert: true,
        },
      ],
    });
    const updateResponse = vi.fn(async () => ({ id: 'r1' }));

    const outcome = await runHook({
      bundle: bundleWith(['formlogic.responses.write']),
      hook: 'onConnectorEvent',
      input: {},
      handlers: { updateResponse },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.deniedPermissions).toEqual([]);
    expect(updateResponse).toHaveBeenCalledWith(
      'Calls',
      { responseId: undefined, match: { field: 'call_id', value: 'call_abc' } },
      { status: 'answered' },
      { upsert: true }
    );
  });

  it('is denied without the write grant (handler never called)', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'formlogic.updateResponse', formKey: 'Calls', answers: { status: 'answered' } }],
    });
    const updateResponse = vi.fn(async () => ({}));

    const outcome = await runHook({
      bundle: bundleWith(['ui.toast']),
      hook: 'onConnectorEvent',
      input: {},
      handlers: { updateResponse },
    });

    expect(updateResponse).not.toHaveBeenCalled();
    expect(outcome.deniedPermissions).toContain('formlogic.responses.write');
  });

  it('match lookup retries until the row becomes server-visible (queue-lag absorption)', async () => {
    const { findResponseIdByMatch } = await import('./useCustomAppLogic');
    const fetchRows = vi
      .fn<() => Promise<Array<{ id?: unknown; answers?: Record<string, unknown> }>>>()
      .mockResolvedValueOnce([]) // call.incoming still in the offline queue
      .mockResolvedValueOnce([]) // …still flushing
      .mockResolvedValue([{ id: 'r9', answers: { call_id: 'call_abc' } }]);

    const id = await findResponseIdByMatch(fetchRows, { field: 'call_id', value: 'call_abc' }, [0, 0, 0, 0]);
    expect(id).toBe('r9');
    expect(fetchRows).toHaveBeenCalledTimes(3);
  });

  it('match lookup gives up (null) after the schedule is exhausted', async () => {
    const { findResponseIdByMatch } = await import('./useCustomAppLogic');
    const fetchRows = vi.fn(async () => [] as Array<{ id?: unknown; answers?: Record<string, unknown> }>);
    const id = await findResponseIdByMatch(fetchRows, { field: 'call_id', value: 'nope' }, [0, 0]);
    expect(id).toBeNull();
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-string formKey before touching the handler (host guard parity)', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'formlogic.updateResponse', formKey: 123, answers: { status: 'answered' } }],
    });
    const updateResponse = vi.fn(async () => ({}));

    const outcome = await runHook({
      bundle: bundleWith(['formlogic.responses.write']),
      hook: 'onConnectorEvent',
      input: {},
      handlers: { updateResponse },
    });

    expect(updateResponse).not.toHaveBeenCalled();
    expect(outcome.errors.some((e) => e.includes('string formKey and object answers'))).toBe(true);
  });

  it('rejects non-object answers before touching the handler (host guard parity)', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'formlogic.updateResponse', formKey: 'Calls', answers: 'not-an-object' }],
    });
    const updateResponse = vi.fn(async () => ({}));

    const outcome = await runHook({
      bundle: bundleWith(['formlogic.responses.write']),
      hook: 'onConnectorEvent',
      input: {},
      handlers: { updateResponse },
    });

    expect(updateResponse).not.toHaveBeenCalled();
    expect(outcome.errors.some((e) => e.includes('string formKey and object answers'))).toBe(true);
  });

  it('captures a handler failure as a script error, never throwing', async () => {
    mockedRunAppLogic.mockResolvedValue({
      effects: [{ type: 'formlogic.updateResponse', formKey: 'Calls', answers: { status: 'answered' } }],
    });
    const updateResponse = vi.fn(async () => {
      throw new Error('no matching response to update');
    });

    const outcome = await runHook({
      bundle: bundleWith(['formlogic.responses.write']),
      hook: 'onConnectorEvent',
      input: {},
      handlers: { updateResponse },
    });

    expect(outcome.errors.some((e) => e.includes('no matching response'))).toBe(true);
    expect(outcome.rejected).toBe(false);
  });
});
