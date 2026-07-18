// Aokie remote-viewer presence resolution (docs/FORMLOGIC_FLOWS.md §14).
//
// Pins the three-state banner logic the Live Call / Device Setup screens hang off:
//   local  — this browser is paired to a local FormLogic Desktop (always wins),
//   remote — fresh desktop_connections row (< 90s) OR, as the member-visible fallback,
//            a flow run recently claimed with runtime 'desktop',
//   none   — neither (install/demo state; the ONLY state that shows simulate/setup).
// Every wire failure (403/404/network/malformed) must degrade silently to 'none'.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowRunLog } from '../../../types/flows';
import {
  CONNECTION_FRESH_MS,
  RUN_SIGNAL_FRESH_MS,
  REMOTE_CALL_LIVE_WINDOW_MS,
  deriveRemoteCall,
  describeLastSeen,
  fetchDesktopConnections,
  parseDbTimestamp,
  pickFreshConnection,
  pickFreshDesktopRun,
  resolvePresence,
  resolveRemoteRuntime,
  selectTurnsForCall,
  showSimulateSetup,
} from './aokiePresence';

// Fixed "now" (an opaque instant; the zone-less parse below is local, which is fine here).
const NOW = Date.parse('2026-07-07T12:00:00');

/**
 * UTC MySQL 'YYYY-MM-DD HH:MM:SS' for an epoch-ms instant — the REAL wire format:
 * the backend serves TIMESTAMPs through a session pinned to +00:00, and
 * parseDbTimestamp now reads the zone-less form as UTC (2026-07-13: the old
 * local-time reading made every heartbeat look hours stale off-UTC).
 */
function mysqlTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'c1', deviceName: 'Home Office PC', desktopInstanceId: 'inst-1', lastSeenAt: mysqlTs(NOW - 30_000), ...overrides };
}

function run(overrides: Partial<FlowRunLog> = {}): FlowRunLog {
  return {
    runId: 'r1',
    appId: 'app-1',
    formId: null,
    responseId: null,
    bindingId: null,
    flowDefinitionId: 'f1',
    flow: 'call-summary-follow-up',
    triggerEvent: 'aokie.call.ended',
    correlationId: 'corr',
    idempotencyKey: 'idem',
    status: 'done',
    runtime: 'desktop',
    claimedBy: 'DESKTOP-HOME',
    inputSnapshot: null,
    result: null,
    outputActions: null,
    error: null,
    startedAt: mysqlTs(NOW - 60_000),
    finishedAt: null,
    createdAt: mysqlTs(NOW - 90_000),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseDbTimestamp', () => {
  it('parses zone-less MySQL DATETIME strings as UTC (the API wire format)', () => {
    expect(parseDbTimestamp(mysqlTs(NOW))).toBe(NOW);
    // The regression that hid a live desktop from every non-UTC browser:
    // a concrete UTC string must round-trip to its UTC instant, not local.
    expect(parseDbTimestamp('2026-07-13 05:45:50')).toBe(Date.parse('2026-07-13T05:45:50Z'));
  });
  it('parses ISO strings and rejects garbage/non-strings', () => {
    expect(parseDbTimestamp('2026-07-07T12:00:00')).toBe(NOW);
    expect(parseDbTimestamp('not a date')).toBeNull();
    expect(parseDbTimestamp('')).toBeNull();
    expect(parseDbTimestamp(null)).toBeNull();
    expect(parseDbTimestamp(12345)).toBeNull();
  });
});

describe('pickFreshConnection (desktop_connections registry)', () => {
  it('fresh last_seen_at (< 90s) resolves to the device', () => {
    const info = pickFreshConnection([connection()], NOW);
    expect(info).toEqual({ deviceName: 'Home Office PC', lastSeenAt: mysqlTs(NOW - 30_000) });
  });

  it('a STALE row (>= 90s) is not presence', () => {
    expect(pickFreshConnection([connection({ lastSeenAt: mysqlTs(NOW - CONNECTION_FRESH_MS) })], NOW)).toBeNull();
    expect(pickFreshConnection([connection({ lastSeenAt: mysqlTs(NOW - 10 * 60_000) })], NOW)).toBeNull();
  });

  it('absent/malformed registry rows are not presence', () => {
    expect(pickFreshConnection([], NOW)).toBeNull();
    expect(pickFreshConnection(null, NOW)).toBeNull();
    expect(pickFreshConnection('nope', NOW)).toBeNull();
    expect(pickFreshConnection([connection({ lastSeenAt: null })], NOW)).toBeNull();
    expect(pickFreshConnection([connection({ lastSeenAt: 'garbage' })], NOW)).toBeNull();
  });

  it('picks the freshest row and defaults a blank device name', () => {
    const info = pickFreshConnection(
      [
        connection({ deviceName: 'Older', lastSeenAt: mysqlTs(NOW - 80_000) }),
        connection({ deviceName: '  ', lastSeenAt: mysqlTs(NOW - 5_000) }),
      ],
      NOW
    );
    expect(info?.deviceName).toBe('FormLogic Desktop');
    expect(info?.lastSeenAt).toBe(mysqlTs(NOW - 5_000));
  });
});

describe('pickFreshDesktopRun (member-visible fallback)', () => {
  it("a recently claimed runtime='desktop' run is presence, labelled by claimed_by", () => {
    const info = pickFreshDesktopRun([run()], NOW);
    expect(info).toEqual({ deviceName: 'DESKTOP-HOME', lastSeenAt: mysqlTs(NOW - 60_000) });
  });

  it('browser-claimed and unclaimed runs are ignored', () => {
    expect(pickFreshDesktopRun([run({ runtime: 'browser' })], NOW)).toBeNull();
    expect(pickFreshDesktopRun([run({ runtime: null, claimedBy: null })], NOW)).toBeNull();
  });

  it('an old desktop run is not presence; absent lists are not presence', () => {
    expect(pickFreshDesktopRun([run({ startedAt: mysqlTs(NOW - RUN_SIGNAL_FRESH_MS) })], NOW)).toBeNull();
    expect(pickFreshDesktopRun([], NOW)).toBeNull();
    expect(pickFreshDesktopRun(null, NOW)).toBeNull();
  });

  it('falls back to createdAt when startedAt is null, and to a generic label', () => {
    const info = pickFreshDesktopRun([run({ startedAt: null, claimedBy: null, createdAt: mysqlTs(NOW - 30_000) })], NOW);
    expect(info).toEqual({ deviceName: 'FormLogic Desktop', lastSeenAt: mysqlTs(NOW - 30_000) });
  });
});

describe('resolvePresence (three-state banner)', () => {
  it('a local paired bridge always wins', () => {
    const p = resolvePresence({ localBridge: true, connections: [connection()], runs: [run()] }, NOW);
    expect(p).toEqual({ kind: 'local' });
  });

  it('fresh registry row → remote', () => {
    const p = resolvePresence({ localBridge: false, connections: [connection()], runs: null }, NOW);
    expect(p).toEqual({ kind: 'remote', deviceName: 'Home Office PC', lastSeenAt: mysqlTs(NOW - 30_000) });
  });

  it('member fallback: registry unreadable (403/404 → null) but a fresh desktop run → remote', () => {
    const p = resolvePresence({ localBridge: false, connections: null, runs: [run()] }, NOW);
    expect(p).toEqual({ kind: 'remote', deviceName: 'DESKTOP-HOME', lastSeenAt: mysqlTs(NOW - 60_000) });
  });

  it('stale registry + stale runs → none (install/demo state)', () => {
    const p = resolvePresence(
      {
        localBridge: false,
        connections: [connection({ lastSeenAt: mysqlTs(NOW - 10 * 60_000) })],
        runs: [run({ startedAt: mysqlTs(NOW - 60 * 60_000) })],
      },
      NOW
    );
    expect(p).toEqual({ kind: 'none' });
  });
});

describe('remote-mode render gating', () => {
  it('the simulate/setup card shows ONLY in the none state', () => {
    expect(showSimulateSetup({ kind: 'none' })).toBe(true);
    expect(showSimulateSetup({ kind: 'remote', deviceName: 'Home Office PC', lastSeenAt: null })).toBe(false);
    expect(showSimulateSetup({ kind: 'local' })).toBe(false);
  });

  // The compiled AokieLiveCallScreen (and its source-scan lock that lived here) was RETIRED with
  // the pack-owned TSX console: the same gating — simulate only in the 'none' state, unified
  // local/relay control dispatch, grant-gated controls — is now behaviorally locked by
  // data/packs/aokie-receptionist/screens/liveCall.test.ts against the COMPILED sandbox screen.
});

describe('describeLastSeen', () => {
  it('renders compact ago labels and null for unparseable stamps', () => {
    expect(describeLastSeen(mysqlTs(NOW - 3_000), NOW)).toBe('just now');
    expect(describeLastSeen(mysqlTs(NOW - 42_000), NOW)).toBe('42s ago');
    expect(describeLastSeen(mysqlTs(NOW - 5 * 60_000), NOW)).toBe('5m ago');
    expect(describeLastSeen(mysqlTs(NOW - 3 * 60 * 60_000), NOW)).toBe('3h ago');
    expect(describeLastSeen(null, NOW)).toBeNull();
    expect(describeLastSeen('garbage', NOW)).toBeNull();
  });
});

describe('resolveRemoteRuntime (probe order)', () => {
  it('a fresh registry hit never touches the runs fallback', async () => {
    const runs = vi.fn();
    const info = await resolveRemoteRuntime('app-1', { connections: async () => [connection()], runs }, NOW);
    expect(info?.deviceName).toBe('Home Office PC');
    expect(runs).not.toHaveBeenCalled();
  });

  it('registry miss falls back to desktop-claimed run recency (appId passed through)', async () => {
    const runs = vi.fn(async (appId?: string) => {
      expect(appId).toBe('app-1');
      return [run()];
    });
    const info = await resolveRemoteRuntime('app-1', { connections: async () => null, runs }, NOW);
    expect(info?.deviceName).toBe('DESKTOP-HOME');
  });

  it('both signals empty → null (state none)', async () => {
    const info = await resolveRemoteRuntime(undefined, { connections: async () => [], runs: async () => null }, NOW);
    expect(info).toBeNull();
  });
});

describe('fetchDesktopConnections (owner registry, degrade-silently wire contract)', () => {
  it('returns the connections array from a 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ connections: [connection()] }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const list = await fetchDesktopConnections();
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown[]).length).toBe(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/desktop-connections');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('401/403/404 and network failures flatten to null (never throw)', async () => {
    for (const status of [401, 403, 404]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve({}) } as unknown as Response));
      expect(await fetchDesktopConnections()).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchDesktopConnections()).toBeNull();
  });

  it('a 200 without a connections array flattens to null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ nope: 1 }) } as unknown as Response));
    expect(await fetchDesktopConnections()).toBeNull();
  });
});

describe('remote record derivation (stored rows replace the hub feed)', () => {
  const callsRow = (answers: Record<string, unknown>, submittedAt = mysqlTs(NOW - 20_000)) => ({
    id: 'resp-1',
    answers,
    submittedAt,
  });

  it('newest Calls row maps incoming/answered to a live snapshot', () => {
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', caller_phone: '+61 4', caller_name: 'Ada', status: 'incoming', started_at: mysqlTs(NOW - 10_000) })], NOW))
      .toEqual({ callId: 'c-9', from: '+61 4', callerName: 'Ada', state: 'ringing', startedAtMs: NOW - 10_000 });
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'answered', started_at: mysqlTs(NOW - 10_000) })], NOW)?.state).toBe('active');
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'completed' })], NOW)?.state).toBe('ended');
    expect(deriveRemoteCall([], NOW)).toBeNull();
  });

  it('startedAtMs carries the parsed started_at (or submittedAt fallback) for the Live Call stage timer', () => {
    // started_at present → used directly.
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'answered', started_at: mysqlTs(NOW - 45_000) })], NOW)?.startedAtMs).toBe(NOW - 45_000);
    // No started_at recorded — falls back to submittedAt so the timer still has something to anchor on.
    const submittedAt = mysqlTs(NOW - 5_000);
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'answered' }, submittedAt)], NOW)?.startedAtMs).toBe(NOW - 5_000);
    // Neither timestamp parses — startedAtMs is null so the UI can hide the timer rather than show garbage.
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'answered' }, 'not-a-date')], NOW)?.startedAtMs).toBeNull();
  });

  it('a stuck non-terminal row past the live window reads as ended', () => {
    const stale = callsRow(
      { call_id: 'c-9', status: 'answered', started_at: mysqlTs(NOW - REMOTE_CALL_LIVE_WINDOW_MS - 60_000) },
      mysqlTs(NOW - REMOTE_CALL_LIVE_WINDOW_MS - 60_000)
    );
    expect(deriveRemoteCall([stale], NOW)?.state).toBe('ended');
  });

  it('selectTurnsForCall filters to the call and orders by turn_index', () => {
    const rows = [
      { id: 't3', answers: { call_id: 'c-9', turn_index: 2, speaker: 'aokie', text: 'How can I help?', timestamp: 'ts3' }, submittedAt: 's3' },
      { id: 'tX', answers: { call_id: 'OTHER', turn_index: 0, speaker: 'caller', text: 'wrong call' }, submittedAt: 'sX' },
      { id: 't1', answers: { call_id: 'c-9', turn_index: 0, speaker: 'caller', text: 'Hi', timestamp: 'ts1' }, submittedAt: 's1' },
      { id: 't2', answers: { call_id: 'c-9', turn_index: 1, speaker: 'caller', text: 'Booking please', timestamp: 'ts2' }, submittedAt: 's2' },
    ];
    expect(selectTurnsForCall(rows, 'c-9')).toEqual([
      { key: 't1', speaker: 'caller', text: 'Hi', occurredAt: 'ts1', corrected: false },
      { key: 't2', speaker: 'caller', text: 'Booking please', occurredAt: 'ts2', corrected: false },
      { key: 't3', speaker: 'aokie', text: 'How can I help?', occurredAt: 'ts3', corrected: false },
    ]);
    expect(selectTurnsForCall(rows, undefined)).toEqual([]);
  });
});
