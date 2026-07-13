// Aokie Receptionist — runtime presence resolution (docs/FORMLOGIC_FLOWS.md §14).
//
// The receptionist can live in three places relative to THIS browser:
//   'local'  — FormLogic Desktop is running on this machine and this browser is paired
//              to it (the existing live bridge: hub events, connector commands).
//   'remote' — no local Desktop, but the owner's receptionist is running elsewhere:
//              a desktop_connections row with a fresh last_seen_at (< 90s, stamped by
//              the Desktop heartbeat re-upsert), or — the member-visible fallback —
//              a flow_run_logs row recently claimed with runtime 'desktop'. The web
//              screens become read-only viewers that poll stored records.
//   'none'   — neither: the install/demo state (mock bridge + simulate button).
//
// Presence lookups are best-effort and DEGRADE SILENTLY: a 401/403/404/network failure
// on either signal simply reads as "no remote runtime" (state 'none') — non-owner
// members without run visibility just keep the current behaviour.
//
// Pure resolution functions live here (unit-tested in aokiePresence.test.ts); the React
// hook that polls them is useAokiePresence.ts.
import { api } from '../../../lib/api';
import type { FlowRunLog } from '../../../types/flows';

/** desktop_connections.last_seen_at freshness window (Desktop heartbeats via re-upsert). */
export const CONNECTION_FRESH_MS = 90_000;
/** Fallback signal: a flow run claimed with runtime 'desktop' this recently ⇒ Desktop is alive. */
export const RUN_SIGNAL_FRESH_MS = 5 * 60_000;
/** How often the screens re-resolve presence while visible. */
export const PRESENCE_POLL_MS = 30_000;
/** Remote mode: how often the screens re-fetch stored Calls/Transcript records. */
export const REMOTE_RECORDS_POLL_MS = 10_000;
/** A non-terminal Calls row older than this no longer reads as a live call. */
export const REMOTE_CALL_LIVE_WINDOW_MS = 30 * 60_000;

export interface RemoteRuntimeInfo {
  deviceName: string;
  /** Raw server timestamp of the freshest signal (connection last_seen_at / run started_at). */
  lastSeenAt: string | null;
}

export type AokiePresence =
  | { kind: 'local' }
  | { kind: 'remote'; deviceName: string; lastSeenAt: string | null }
  | { kind: 'none' };

/** Row shape shared with the SDK's useResponses (kept structural — no sdk import here). */
export interface ResponseRowLike {
  id: string;
  answers: Record<string, unknown>;
  submittedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Parse a server timestamp. Zone-less MySQL 'YYYY-MM-DD HH:MM:SS' strings from the API
 * are UTC — the backend pins its MySQL session to +00:00 (MySQLConnection) and PHP runs
 * with a UTC default timezone — so they get an explicit Z. Parsing them as LOCAL (the
 * old behaviour) shifted every instant by the viewer's UTC offset, which silently broke
 * the 90s remote-presence freshness window (10h skew in Brisbane) exactly like the flow
 * dispatcher's heartbeat probe (2026-07-13). ISO strings (event occurredAt) parse as-is.
 */
export function parseDbTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The freshest paired-desktop registry row (< CONNECTION_FRESH_MS old), or null. Input is
 * the raw `connections` array from GET /api/desktop-connections (owner-scoped) — parsed
 * defensively since this module never trusts wire shapes.
 */
export function pickFreshConnection(connections: unknown, now: number = Date.now()): RemoteRuntimeInfo | null {
  if (!Array.isArray(connections)) return null;
  let best: { info: RemoteRuntimeInfo; seen: number } | null = null;
  for (const raw of connections) {
    const c = asRecord(raw);
    const seen = parseDbTimestamp(c.lastSeenAt);
    if (seen === null || now - seen >= CONNECTION_FRESH_MS) continue;
    if (best && seen <= best.seen) continue;
    best = {
      seen,
      info: {
        deviceName: typeof c.deviceName === 'string' && c.deviceName.trim() !== '' ? c.deviceName : 'FormLogic Desktop',
        lastSeenAt: typeof c.lastSeenAt === 'string' ? c.lastSeenAt : null,
      },
    };
  }
  return best ? best.info : null;
}

/**
 * Member-visible fallback: the freshest run claimed with runtime 'desktop' (< RUN_SIGNAL_FRESH_MS)
 * proves a Desktop runtime is alive even when the registry row is stale/unreadable. The claimer
 * instanceId (claimed_by) doubles as the device label when present.
 */
export function pickFreshDesktopRun(runs: FlowRunLog[] | null | undefined, now: number = Date.now()): RemoteRuntimeInfo | null {
  if (!Array.isArray(runs)) return null;
  let best: { info: RemoteRuntimeInfo; seen: number } | null = null;
  for (const run of runs) {
    if (run.runtime !== 'desktop') continue;
    const stamp = run.startedAt ?? run.createdAt;
    const seen = parseDbTimestamp(stamp);
    if (seen === null || now - seen >= RUN_SIGNAL_FRESH_MS) continue;
    if (best && seen <= best.seen) continue;
    best = {
      seen,
      info: {
        deviceName: typeof run.claimedBy === 'string' && run.claimedBy.trim() !== '' ? run.claimedBy : 'FormLogic Desktop',
        lastSeenAt: typeof stamp === 'string' ? stamp : null,
      },
    };
  }
  return best ? best.info : null;
}

/** Three-state resolution: local bridge wins, then registry, then the run-recency fallback. */
export function resolvePresence(
  input: { localBridge: boolean; connections: unknown | null; runs: FlowRunLog[] | null },
  now: number = Date.now()
): AokiePresence {
  if (input.localBridge) return { kind: 'local' };
  const remote = pickFreshConnection(input.connections, now) ?? pickFreshDesktopRun(input.runs, now);
  return remote ? { kind: 'remote', ...remote } : { kind: 'none' };
}

/**
 * Render gate for the "Install FormLogic Desktop / Simulate incoming call" setup card:
 * only the 'none' state shows it — in remote mode the receptionist IS running (elsewhere),
 * so simulating a mock call here would only fork the record trail.
 */
export function showSimulateSetup(presence: AokiePresence): boolean {
  return presence.kind === 'none';
}

/** Compact "last seen" label for the device status card ('just now' / '42s ago' / '3m ago'). */
export function describeLastSeen(lastSeenAt: string | null, now: number = Date.now()): string | null {
  const seen = parseDbTimestamp(lastSeenAt);
  if (seen === null) return null;
  const seconds = Math.max(0, Math.round((now - seen) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// ── Remote-mode record derivation (stored rows replace the local hub feed) ─────────────

export interface RemoteCallSnapshot {
  callId: string;
  from?: string;
  callerName?: string;
  state: 'ringing' | 'active' | 'ended';
  /** Parsed started_at (falling back to submittedAt), for the Live Call stage's mm:ss timer. Null when neither parses. */
  startedAtMs: number | null;
}

/**
 * The newest stored Calls row as a live-call snapshot ('incoming' → ringing, 'answered' →
 * active, terminal → ended). Rows arrive newest-first from useResponses. A non-terminal row
 * older than REMOTE_CALL_LIVE_WINDOW_MS reads as ended — a stuck row must not look live forever.
 */
export function deriveRemoteCall(rows: ResponseRowLike[], now: number = Date.now()): RemoteCallSnapshot | null {
  const row = rows[0];
  if (!row) return null;
  const a = row.answers ?? {};
  const status = String(a.status ?? '');
  let state: RemoteCallSnapshot['state'] = status === 'incoming' ? 'ringing' : status === 'answered' ? 'active' : 'ended';
  const startedAtMs = parseDbTimestamp(a.started_at) ?? parseDbTimestamp(row.submittedAt);
  if (state !== 'ended' && startedAtMs !== null && now - startedAtMs > REMOTE_CALL_LIVE_WINDOW_MS) {
    state = 'ended';
  }
  return {
    callId: String(a.call_id || row.id),
    from: typeof a.caller_phone === 'string' && a.caller_phone !== '' ? a.caller_phone : undefined,
    callerName: typeof a.caller_name === 'string' && a.caller_name !== '' ? a.caller_name : undefined,
    state,
    startedAtMs,
  };
}

export interface RemoteTurn {
  key: string;
  speaker: string;
  text: string;
  occurredAt: string;
}

/** Stored Transcript Turns rows for one call, oldest turn first (turn_index order). */
export function selectTurnsForCall(rows: ResponseRowLike[], callId: string | undefined): RemoteTurn[] {
  if (!callId) return [];
  return rows
    .filter((r) => String(r.answers?.call_id ?? '') === callId)
    .map((r) => ({
      index: Number(r.answers?.turn_index ?? 0),
      turn: {
        key: r.id,
        speaker: String(r.answers?.speaker || 'caller'),
        text: String(r.answers?.text || ''),
        occurredAt: String(r.answers?.timestamp || r.submittedAt || ''),
      },
    }))
    .sort((a, b) => a.index - b.index)
    .map((x) => x.turn);
}

// ── Wire fetchers (injectable so the resolution stays unit-testable) ────────────────────

// Mirrors lib/api's base URL (that client keeps request() private and this endpoint has no
// public method — the api.ts surface is frozen for this feature).
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

/**
 * GET /api/desktop-connections (session cookie; owner's registry). null on ANY failure —
 * unauthenticated viewers and non-owner members degrade to the run-recency fallback.
 */
export async function fetchDesktopConnections(): Promise<unknown[] | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/desktop-connections`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { connections?: unknown } | null;
    return Array.isArray(body?.connections) ? body.connections : null;
  } catch {
    return null;
  }
}

/** Recent runs across the caller's flows, narrowed to this app when known. null on failure. */
export async function fetchRecentFlowRuns(appId?: string): Promise<FlowRunLog[] | null> {
  try {
    const res = await api.listMyFlowRuns({ appId, limit: 20 });
    return res.data ? res.data.runs : null;
  } catch {
    return null;
  }
}

export interface PresenceFetchers {
  connections: () => Promise<unknown[] | null>;
  runs: (appId?: string) => Promise<FlowRunLog[] | null>;
}

export const defaultPresenceFetchers: PresenceFetchers = {
  connections: fetchDesktopConnections,
  runs: fetchRecentFlowRuns,
};

/** One remote-presence probe: registry first, then the desktop-claimed-run fallback. */
export async function resolveRemoteRuntime(
  appId?: string,
  fetchers: PresenceFetchers = defaultPresenceFetchers,
  now: number = Date.now()
): Promise<RemoteRuntimeInfo | null> {
  const fresh = pickFreshConnection(await fetchers.connections(), now);
  if (fresh) return fresh;
  return pickFreshDesktopRun(await fetchers.runs(appId), now);
}
