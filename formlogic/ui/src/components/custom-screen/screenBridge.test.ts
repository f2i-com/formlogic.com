// Bridge v1 for pack-owned code screens: grant gating, transparent
// local→relay routing (fallback ONLY on the typed connector_unavailable),
// resolve-not-throw outcome semantics, and the bounded record update.
import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from '../../client-runtime/connectors/connectorTypes';
import type { GrantSource } from '../../client-runtime/connectors/connectorGrants';
import { createScreenBridge, type ScreenBridgeDeps } from './screenBridge';

const CONFIG = {
  app: { customLogic: { permissions: ['connector.aokie.settings.get', 'connector.aokie.settings.set'] } },
  forms: [
    { formId: 'form-1', customLogic: { permissions: ['connector.aokie.call.hangup'] } },
    { formId: 'form-2', customLogic: { permissions: ['connector.aokie.sms.send'] } },
  ],
} as unknown as GrantSource;

/** Relay api whose enqueue immediately reports a terminal 'done' with a result on first poll. */
function relayApiDone(captured: { enqueue?: Record<string, unknown> }) {
  return {
    enqueueConnectorCommand: vi.fn(async (_slug: string, payload: Record<string, unknown>) => {
      captured.enqueue = payload;
      return { data: { commandId: 'cmd-1', status: 'queued' as const } };
    }),
    getConnectorCommand: vi.fn(async () => ({
      data: {
        command: {
          status: 'done' as const,
          result: { ok: true },
          error: null,
          claimedByDeviceName: 'DESKTOP-HOME',
        } as never,
      },
    })),
  };
}

/** Immediate sleep + a clock that only exceeds the timeout after `ticks` now() calls. */
const fastRelay = { sleep: async () => {}, pollMs: 1, timeoutMs: 65_000 };

function deps(over: Partial<ScreenBridgeDeps> = {}): ScreenBridgeDeps {
  return {
    appSlug: 'my-app',
    formId: 'form-1',
    config: CONFIG,
    localRequest: vi.fn(async () => ({ ok: true })),
    localBridgeAvailable: () => false,
    relayApi: relayApiDone({}),
    updateResponse: vi.fn(async (_f, id, data) => ({
      id,
      answers: data.answers,
      submittedAt: '2026-07-17T00:00:00Z',
      status: 'submitted',
      tags: [],
      secretServerField: 'never',
    })),
    deleteResponse: vi.fn(async () => ({ ok: true })),
    resolvePresence: vi.fn(async () => ({ kind: 'local' as const })),
    demoMode: () => false,
    relayOptions: fastRelay,
    ...over,
  };
}

describe('connectorInvoke — grant gate', () => {
  it('rejects an ungranted command BEFORE any transport', async () => {
    const d = deps();
    const bridge = createScreenBridge(d);
    await expect(bridge.connectorInvoke('aokie', 'phone.startPairing')).rejects.toThrow(
      'connector.aokie.phone.startPairing',
    );
    expect(d.localRequest).not.toHaveBeenCalled();
  });

  it('accepts app-level and THIS form-level grants; other forms do not lend theirs', async () => {
    const bridge = createScreenBridge(deps());
    await expect(bridge.connectorInvoke('aokie', 'settings.get')).resolves.toMatchObject({ status: 'done' });
    await expect(bridge.connectorInvoke('aokie', 'call.hangup')).resolves.toMatchObject({ status: 'done' });
    // form-2's sms.send grant is out of scope for a form-1 screen.
    await expect(bridge.connectorInvoke('aokie', 'sms.send')).rejects.toThrow('connector.aokie.sms.send');
  });

  it('rejects missing ids and oversized payloads before the gate', async () => {
    const d = deps();
    const bridge = createScreenBridge(d);
    await expect(bridge.connectorInvoke('', 'settings.get')).rejects.toThrow('connectorId');
    await expect(
      bridge.connectorInvoke('aokie', 'settings.set', { blob: 'x'.repeat(70_000) }),
    ).rejects.toThrow('too large');
    expect(d.localRequest).not.toHaveBeenCalled();
  });
});

describe('connectorInvoke — routing', () => {
  it('local success resolves done/via local with the result', async () => {
    const d = deps({ localRequest: vi.fn(async () => ({ settings: { greeting: 'hi' } })) });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'settings.get');
    expect(out).toEqual({ status: 'done', result: { settings: { greeting: 'hi' } }, via: 'local' });
  });

  it('a typed LOCAL refusal resolves failed and NEVER retries via the relay', async () => {
    const capture: { enqueue?: Record<string, unknown> } = {};
    const relayApi = relayApiDone(capture);
    const d = deps({
      localRequest: vi.fn(async () => {
        throw new ConnectorError('stale_call', 'that call already ended');
      }),
      relayApi,
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'call.hangup', { callId: 'c1' });
    expect(out).toMatchObject({
      status: 'failed',
      via: 'local',
      error: { code: 'stale_call', message: 'that call already ended' },
    });
    expect(relayApi.enqueueConnectorCommand).not.toHaveBeenCalled();
  });

  it('with a LOCAL bridge present, even connector_unavailable never retries via the relay', async () => {
    // A transport failure on an attempted desktop route throws the SAME typed
    // connector_unavailable ("did not respond") — the command may have
    // executed, so re-running it remotely would be a double-execution.
    const capture: { enqueue?: Record<string, unknown> } = {};
    const relayApi = relayApiDone(capture);
    const d = deps({
      localBridgeAvailable: () => true,
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_unavailable', 'FormLogic Desktop did not respond');
      }),
      relayApi,
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'call.hangup', { callId: 'c1' });
    expect(out).toMatchObject({ status: 'failed', via: 'local', error: { code: 'connector_unavailable' } });
    expect(relayApi.enqueueConnectorCommand).not.toHaveBeenCalled();
  });

  it('connector_unavailable falls back to the relay with the SAME connector/command/payload', async () => {
    const capture: { enqueue?: Record<string, unknown> } = {};
    const d = deps({
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_unavailable', 'FormLogic Desktop is not connected');
      }),
      relayApi: relayApiDone(capture),
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'settings.set', { greeting: 'ahoy' });
    expect(out).toMatchObject({ status: 'done', via: 'relay', handledBy: 'DESKTOP-HOME', result: { ok: true } });
    expect(capture.enqueue).toMatchObject({
      connectorId: 'aokie',
      command: 'settings.set',
      payload: { greeting: 'ahoy' },
    });
    expect(String(capture.enqueue?.idempotencyKey)).toContain('settings.set');
  });

  it('connector_missing (no local implementation at all) also falls back to the relay', async () => {
    // A plugin-owned connector that only exists on the owner's desktop: the
    // local client refuses pre-transport with the typed connector_missing —
    // the generic relay path must service it (review 2026-07-17).
    const capture: { enqueue?: Record<string, unknown> } = {};
    const d = deps({
      config: {
        app: { customLogic: { permissions: ['connector.echo.status'] } },
        forms: [],
      } as unknown as GrantSource,
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_missing', 'Connector "echo" is not available in this environment.');
      }),
      relayApi: relayApiDone(capture),
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('echo', 'status', {});
    expect(out).toMatchObject({ status: 'done', via: 'relay' });
    expect(capture.enqueue).toMatchObject({ connectorId: 'echo', command: 'status' });
  });

  it('an enqueue whose response was lost retries ONCE with the SAME idempotency key', async () => {
    // INT-005 truthfulness: a delivered-but-response-lost POST dedupes into
    // the existing command on the same-key retry, so the bridge reports the
    // command's REAL outcome instead of a false clean 'failed'.
    const keys: string[] = [];
    let first = true;
    const d = deps({
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_unavailable', 'not connected');
      }),
      relayApi: {
        enqueueConnectorCommand: vi.fn(async (_slug: string, payload: { idempotencyKey?: string }) => {
          keys.push(String(payload.idempotencyKey));
          if (first) {
            first = false;
            return { error: 'Invalid response from server' };
          }
          return { data: { commandId: 'cmd-2', status: 'done' as const, idempotent: true } };
        }),
        getConnectorCommand: vi.fn(async () => ({})),
      },
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'settings.set', { greeting: 'hi' });
    expect(out).toMatchObject({ status: 'done', via: 'relay' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a claimed-but-unreported relay give-up resolves UNCERTAIN (never a clean failure)', async () => {
    let t = 0;
    const d = deps({
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_unavailable', 'not connected');
      }),
      relayApi: {
        enqueueConnectorCommand: vi.fn(async () => ({ data: { commandId: 'cmd-9', status: 'queued' as const } })),
        getConnectorCommand: vi.fn(async () => ({ data: { command: { status: 'claimed' as const } as never } })),
      },
      relayOptions: { sleep: async () => {}, pollMs: 1, timeoutMs: 65_000, now: () => (t += 100_000) },
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'settings.set', {});
    expect(out).toMatchObject({ status: 'uncertain', via: 'relay' });
  });

  it('an enqueue failure resolves failed/via relay (never an exception into pack code)', async () => {
    const d = deps({
      localRequest: vi.fn(async () => {
        throw new ConnectorError('connector_unavailable', 'not connected');
      }),
      relayApi: {
        enqueueConnectorCommand: vi.fn(async () => ({ error: 'demo accounts are read-only' })),
        getConnectorCommand: vi.fn(async () => ({})),
      },
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.connectorInvoke('aokie', 'settings.get');
    expect(out).toMatchObject({ status: 'failed', via: 'relay', error: { message: 'demo accounts are read-only' } });
  });
});

describe('updateRecord / presence', () => {
  it('updates through the store and projects the row (no server metadata leaks)', async () => {
    const d = deps();
    const bridge = createScreenBridge(d);
    const row = (await bridge.updateRecord('resp-1', { greeting: 'hello' })) as Record<string, unknown>;
    expect(d.updateResponse).toHaveBeenCalledWith('form-1', 'resp-1', { answers: { greeting: 'hello' } });
    expect(row).toEqual({
      id: 'resp-1',
      answers: { greeting: 'hello' },
      submittedAt: '2026-07-17T00:00:00Z',
      status: 'submitted',
      tags: [],
    });
    expect('secretServerField' in row).toBe(false);
  });

  it('bounds the update and requires a responseId', async () => {
    const d = deps();
    const bridge = createScreenBridge(d);
    await expect(bridge.updateRecord('', { a: 1 })).rejects.toThrow('responseId');
    await expect(bridge.updateRecord('resp-1', { blob: 'x'.repeat(300_000) })).rejects.toThrow('too large');
    expect(d.updateResponse).not.toHaveBeenCalled();
  });

  it('deleteRecords: explicit ids only, deduped, small bounded batch', async () => {
    const d = deps();
    const bridge = createScreenBridge(d);
    await expect(bridge.deleteRecords([])).rejects.toThrow('at least one');
    await expect(
      bridge.deleteRecords(Array.from({ length: 26 }, (_, i) => `r${i}`)),
    ).rejects.toThrow('bounded to 25');
    const out = await bridge.deleteRecords(['a', 'b', 'a', '', 'b']);
    expect(out).toEqual({ deleted: ['a', 'b'], failed: [] });
    expect(d.deleteResponse).toHaveBeenCalledTimes(2);
    expect(d.deleteResponse).toHaveBeenCalledWith('form-1', 'a');
  });

  it('deleteRecords: a refused or throwing row reports itself and never aborts the rest', async () => {
    const d = deps({
      deleteResponse: vi.fn(async (_f: string, id: string) => {
        if (id === 'nope') return { ok: false, error: 'You do not have permission to delete this response.' };
        if (id === 'boom') throw new Error('network reset');
        return { ok: true };
      }),
    });
    const bridge = createScreenBridge(d);
    const out = await bridge.deleteRecords(['ok1', 'nope', 'boom', 'ok2']);
    expect(out.deleted).toEqual(['ok1', 'ok2']);
    expect(out.failed).toEqual([
      { id: 'nope', error: 'You do not have permission to delete this response.' },
      { id: 'boom', error: 'network reset' },
    ]);
  });

  it('canObserveConnector: any grant TARGETING the connector opens the observe gate', () => {
    const bridge = createScreenBridge(deps());
    // CONFIG grants aokie commands (app level) — observing aokie is allowed.
    expect(bridge.canObserveConnector('aokie')).toBe(true);
    expect(bridge.canObserveConnector('echo')).toBe(false);
    expect(bridge.canObserveConnector('')).toBe(false);
    // A grant PREFIX must never leak across ids ('aok' ⊄ 'aokie').
    expect(bridge.canObserveConnector('aok')).toBe(false);
    const cases: Array<[string, string, boolean]> = [
      ['connector.*', 'echo', true],
      ['connector.*.status', 'echo', true], // inner wildcard covers any connector
      ['connector.echo.*', 'echo', true],
      ['connector.echo', 'echo', true],
      ['connector.echoing.status', 'echo', false],
      ['flow.run', 'echo', false],
      ['*', 'echo', true],
    ];
    for (const [grant, cid, expected] of cases) {
      const b = createScreenBridge(
        deps({ config: { app: { customLogic: { permissions: [grant] } }, forms: [] } as unknown as GrantSource })
      );
      expect(b.canObserveConnector(cid), `${grant} → ${cid}`).toBe(expected);
    }
  });

  it('liveFeedsAllowed follows the demo rule (the demo never attaches to a real desktop)', () => {
    expect(createScreenBridge(deps()).liveFeedsAllowed()).toBe(true);
    expect(createScreenBridge(deps({ demoMode: () => true })).liveFeedsAllowed()).toBe(false);
  });

  it('localBridgeAvailable is exposed for the captions subscribe-time gate', () => {
    expect(createScreenBridge(deps()).localBridgeAvailable()).toBe(false);
    expect(createScreenBridge(deps({ localBridgeAvailable: () => true })).localBridgeAvailable()).toBe(true);
  });

  it('presence passes the one-shot snapshot through', async () => {
    const d = deps({
      resolvePresence: vi.fn(async () => ({
        kind: 'remote' as const,
        deviceName: 'DESKTOP-HOME',
        lastSeenAt: '2026-07-17 00:00:00',
      })),
    });
    const bridge = createScreenBridge(d);
    await expect(bridge.presence()).resolves.toEqual({
      kind: 'remote',
      deviceName: 'DESKTOP-HOME',
      lastSeenAt: '2026-07-17 00:00:00',
    });
  });
});
