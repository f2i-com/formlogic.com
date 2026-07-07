// Aokie remote-viewer presence resolution (docs/FORMLOGIC_FLOWS.md §14).
//
// Pins the three-state banner logic the Live Call / Device Setup screens hang off:
//   local  — this browser is paired to a local FormLogic Desktop (always wins),
//   remote — fresh desktop_connections row (< 90s) OR, as the member-visible fallback,
//            a flow run recently claimed with runtime 'desktop',
//   none   — neither (install/demo state; the ONLY state that shows simulate/setup).
// Every wire failure (403/404/network/malformed) must degrade silently to 'none'.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// Fixed "now" (parsed as local time, matching how MySQL timestamps are interpreted).
const NOW = Date.parse('2026-07-07T12:00:00');

/** Local-time MySQL 'YYYY-MM-DD HH:MM:SS' for an epoch-ms instant (round-trips via parse). */
function mysqlTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  it('parses MySQL DATETIME strings as local time', () => {
    expect(parseDbTimestamp(mysqlTs(NOW))).toBe(NOW);
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

  it('AokieLiveCallScreen gates the setup card via showSimulateSetup and drives remote controls via the relay', () => {
    // No DOM runner in this suite (vitest env: node) — pin the gating at source level, the
    // same technique the pack test uses for registerSdkScreen ids.
    const source = readFileSync(join(__dirname, 'AokieLiveCallScreen.tsx'), 'utf8');
    expect(source).toContain('showSimulateSetup(presence) && (');
    // The old always-on gate must not have crept back in front of the setup card.
    expect(source).not.toMatch(/\{mockOnly && \(/);
    // Remote mode now renders live controls that go through the relay (not the local connector).
    expect(source).toContain('remoteMode ? (');
    expect(source).toContain("runRelay('call.answer'");
    expect(source).toContain("runRelay('call.hangup'");
    expect(source).toContain('Commands run on');
    // Every remote control stays gated on the SAME connector grant + operating role as the local path.
    expect(source).toContain("canRunCommand('call.answer', { can, roleAllowsOperating })");
  });
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
      .toEqual({ callId: 'c-9', from: '+61 4', callerName: 'Ada', state: 'ringing' });
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'answered', started_at: mysqlTs(NOW - 10_000) })], NOW)?.state).toBe('active');
    expect(deriveRemoteCall([callsRow({ call_id: 'c-9', status: 'completed' })], NOW)?.state).toBe('ended');
    expect(deriveRemoteCall([], NOW)).toBeNull();
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
      { key: 't1', speaker: 'caller', text: 'Hi', occurredAt: 'ts1' },
      { key: 't2', speaker: 'caller', text: 'Booking please', occurredAt: 'ts2' },
      { key: 't3', speaker: 'aokie', text: 'How can I help?', occurredAt: 'ts3' },
    ]);
    expect(selectTurnsForCall(rows, undefined)).toEqual([]);
  });
});
