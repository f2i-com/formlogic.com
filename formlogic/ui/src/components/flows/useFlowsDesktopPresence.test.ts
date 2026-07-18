// Flows desktop presence resolution.
//
// Pins the /flows-specific contract: local paired Desktop wins; otherwise only a fresh
// desktop_connections row is presence, using the shared connector timestamp/freshness helpers.
// Any registry failure flattens to no signal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DesktopConnection } from '../../lib/api';
import { CONNECTION_FRESH_MS } from '../custom-screen/connector/runtimePresence';
import {
  deriveFlowsDesktopPresence,
  describeFlowsLastSeen,
  fetchFlowsDesktopConnections,
  resolveFlowsDesktopPresence,
} from './useFlowsDesktopPresence';

const NOW = Date.parse('2026-07-07T12:00:00');

/** UTC MySQL 'YYYY-MM-DD HH:MM:SS' for an epoch-ms instant — the real wire format
 *  (backend MySQL session pinned to +00:00; parseDbTimestamp reads it as UTC). */
function mysqlTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function connection(overrides: Partial<DesktopConnection> = {}): DesktopConnection {
  return {
    id: 'c1',
    deviceName: 'Studio PC',
    desktopInstanceId: 'desktop-1',
    apiKeyId: null,
    capabilities: [],
    trustedOrigins: [],
    lastSeenAt: mysqlTs(NOW - 30_000),
    createdAt: mysqlTs(NOW - 3_600_000),
    updatedAt: mysqlTs(NOW - 30_000),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveFlowsDesktopPresence', () => {
  it('local paired Desktop wins over any registry row', () => {
    expect(deriveFlowsDesktopPresence({ localBridge: true, connections: [connection()] }, NOW)).toEqual({ kind: 'local' });
  });

  it('fresh desktop_connections row resolves to remote with label and parsed lastSeenMs', () => {
    expect(deriveFlowsDesktopPresence({ localBridge: false, connections: [connection()] }, NOW)).toEqual({
      kind: 'remote',
      label: 'Studio PC',
      lastSeenMs: NOW - 30_000,
    });
  });

  it('stale or malformed registry data resolves to none', () => {
    expect(
      deriveFlowsDesktopPresence(
        { localBridge: false, connections: [connection({ lastSeenAt: mysqlTs(NOW - CONNECTION_FRESH_MS) })] },
        NOW
      )
    ).toEqual({ kind: 'none' });
    expect(deriveFlowsDesktopPresence({ localBridge: false, connections: null }, NOW)).toEqual({ kind: 'none' });
    expect(deriveFlowsDesktopPresence({ localBridge: false, connections: [{ lastSeenAt: 'not a date' }] }, NOW)).toEqual({ kind: 'none' });
  });

  it('uses the freshest fresh row and falls back to the shared generic label', () => {
    expect(
      deriveFlowsDesktopPresence(
        {
          localBridge: false,
          connections: [
            connection({ deviceName: 'Older PC', lastSeenAt: mysqlTs(NOW - 80_000) }),
            connection({ deviceName: '  ', lastSeenAt: mysqlTs(NOW - 5_000) }),
          ],
        },
        NOW
      )
    ).toEqual({ kind: 'remote', label: 'FormLogic Desktop', lastSeenMs: NOW - 5_000 });
  });
});

describe('fetchFlowsDesktopConnections', () => {
  it('returns the API connections array on success', async () => {
    vi.spyOn(api, 'getDesktopConnections').mockResolvedValue({ data: { connections: [connection()] } });
    await expect(fetchFlowsDesktopConnections()).resolves.toHaveLength(1);
  });

  it('flattens API errors and thrown failures to null', async () => {
    vi.spyOn(api, 'getDesktopConnections').mockResolvedValueOnce({ error: 'Forbidden' });
    await expect(fetchFlowsDesktopConnections()).resolves.toBeNull();

    vi.spyOn(api, 'getDesktopConnections').mockRejectedValueOnce(new Error('offline'));
    await expect(fetchFlowsDesktopConnections()).resolves.toBeNull();
  });
});

describe('resolveFlowsDesktopPresence', () => {
  it('does not probe the registry when a local bridge is present', async () => {
    const fetchConnections = vi.fn();
    await expect(resolveFlowsDesktopPresence({ localBridge: true, fetchConnections, now: NOW })).resolves.toEqual({ kind: 'local' });
    expect(fetchConnections).not.toHaveBeenCalled();
  });

  it('maps a fresh registry probe to remote presence', async () => {
    const fetchConnections = vi.fn(async () => [connection()]);
    await expect(resolveFlowsDesktopPresence({ localBridge: false, fetchConnections, now: NOW })).resolves.toEqual({
      kind: 'remote',
      label: 'Studio PC',
      lastSeenMs: NOW - 30_000,
    });
  });

  it('treats probe failures as no signal', async () => {
    const fetchConnections = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(resolveFlowsDesktopPresence({ localBridge: false, fetchConnections, now: NOW })).resolves.toEqual({ kind: 'none' });
  });
});

describe('describeFlowsLastSeen', () => {
  it('renders compact relative labels from the parsed millisecond timestamp', () => {
    expect(describeFlowsLastSeen(NOW - 3_000, NOW)).toBe('just now');
    expect(describeFlowsLastSeen(NOW - 42_000, NOW)).toBe('42s ago');
    expect(describeFlowsLastSeen(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(describeFlowsLastSeen(undefined, NOW)).toBeNull();
  });
});
