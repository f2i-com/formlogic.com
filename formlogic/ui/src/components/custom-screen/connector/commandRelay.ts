// Remote connector-command relay (docs/API.md §connector:relay, FORMLOGIC_FLOWS.md §14).
//
// When a connector's hardware runs headless in FormLogic Desktop on ANOTHER machine, the web
// runtime can't reach the local connector client. Instead it drives the command over the RELAY:
// enqueue a connector command (POST /app/{slug}/connector-commands) that the owner's desktop
// runtime long-polls, claims and completes, then poll the command back to a terminal status.
// This module is the pure, unit-tested enqueue→poll state machine behind that path; the screen
// bridge (screenBridge.ts) is its caller and names the target connector per app.
//
// The relay path is permission-identical to the local path: a control is offered only when the
// app holds the SAME connector.<id>.<command> grant AND the viewer's role can write the records.
import type { ConnectorCommand, ConnectorCommandStatus } from '../../../types/flows';
import { generateId } from '../../../lib/utils';

/** Poll cadence while a relayed command is in flight. */
export const RELAY_POLL_MS = 1200;
/** Client-side give-up window. Server-side commands expire ~60s after creation, so a little past that
 *  we surface "no desktop online" rather than spin forever. */
export const RELAY_TIMEOUT_MS = 65_000;

/** The terminal states a relayed command can settle into (mirrors ConnectorCommandStatus). */
export type RelayTerminalStatus = 'done' | 'failed' | 'expired';

export function isTerminalStatus(status: ConnectorCommandStatus): status is RelayTerminalStatus {
  return status === 'done' || status === 'failed' || status === 'expired';
}

/**
 * What the caller learns. `uncertain` (audit INT-005/C-14) is CLIENT-derived: the
 * command was CLAIMED by a desktop but hadn't reported back when we gave up — the
 * phone may well have acted, so the UI must say "outcome uncertain", never fake a
 * clean failure.
 */
export type RelayOutcomeStatus = RelayTerminalStatus | 'uncertain';

export interface RelayOutcome {
  status: RelayOutcomeStatus;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  commandId?: string;
  /** ROUTE-001: the machine that handled (or was routed) this command, when the
   *  server could name it — lets outcome copy say WHICH desktop acted. */
  handledBy?: string;
}

/** Structural shape of the two lib/api relay methods (the real `api` satisfies this). */
interface RelayApiResponse<T> {
  data?: T;
  error?: string;
}
export interface RelayApi {
  enqueueConnectorCommand(
    slug: string,
    payload: { connectorId: string; command: string; payload?: Record<string, unknown>; idempotencyKey?: string }
  ): Promise<RelayApiResponse<{ commandId: string; status: ConnectorCommandStatus; idempotent?: boolean }>>;
  getConnectorCommand(
    slug: string,
    commandId: string
  ): Promise<RelayApiResponse<{ command: ConnectorCommand }>>;
}

export interface RunRelayOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** Injectable delay (tests pass an immediate resolver). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests advance it to exercise the timeout branch). */
  now?: () => number;
  /** Which connector the enqueued command targets. Required — this module is
   *  connector-agnostic; every caller names its own connector. */
  connectorId: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Enqueue one connector command and poll it to a terminal status. Throws only on the enqueue call
 * itself failing (surfaced as a toast by the caller); a command that the desktop rejects or that
 * expires resolves normally with status 'failed' / 'expired'. If the client give-up window elapses
 * before the server marks it terminal we resolve 'expired' — for the operator that reads identically
 * ("no desktop online").
 */
export async function runRelayCommand(
  api: RelayApi,
  slug: string,
  command: string,
  payload: Record<string, unknown> | undefined,
  options: RunRelayOptions
): Promise<RelayOutcome> {
  const pollMs = options.pollMs ?? RELAY_POLL_MS;
  const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  // Client intent id (audit INT-005/C-14): ONE key per operator action, minted
  // here — any transport-level retry of this enqueue dedupes server-side
  // instead of creating a second command.
  // generateId, NOT bare crypto.randomUUID: randomUUID only exists in SECURE
  // contexts, and the app runs on http://formlogic.local — the relay path
  // crashed 'crypto.randomUUID is not a function' whenever Device Setup fell
  // back to the relay before the local desktop was detected (live report
  // 2026-07-14; a refresh 'fixed' it because the silent re-pair had finished
  // and the LOCAL connector path took over).
  const idempotencyKey = `ui-${command}-${generateId()}`;
  // PHP cannot represent an empty object: json_decode('{}', true) yields [],
  // and the relay parses the whole request body that way — so a `{}` payload
  // reaches the desktop (and the plugin) as an ARRAY, which the plugin's
  // connector payload validator rejects ("payload must be an object, got
  // array"). This broke every Device Setup pack-screen connector call (which
  // send `{}` for no-arg commands) whenever the browser used the relay instead
  // of a paired local desktop, e.g. right after a restart. Omit an empty
  // payload entirely so the relay carries no payload (== "no payload" → the
  // plugin's empty map) rather than a {} that round-trips to []. A non-empty
  // object round-trips faithfully, so only the empty case needs this.
  const wirePayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0
      ? undefined
      : payload;
  const enqueueBody = {
    connectorId: options.connectorId,
    command,
    payload: wirePayload,
    idempotencyKey,
  };
  let enq = await api.enqueueConnectorCommand(slug, enqueueBody);
  if (enq.error || !enq.data) {
    // ONE same-key retry (INT-005 truthfulness): api.request never throws, so
    // a POST that was DELIVERED but lost its response is indistinguishable
    // from one that never left — yet the command exists server-side and a
    // desktop will execute it. Re-sending the SAME idempotencyKey either
    // dedupes into that command (we then poll its real outcome instead of
    // reporting a false clean 'failed') or fails again identically (a real
    // refusal like demo read-only just repeats). This is what makes the
    // "any transport-level retry dedupes server-side" intent above true.
    enq = await api.enqueueConnectorCommand(slug, enqueueBody);
  }
  if (enq.error || !enq.data) {
    throw new Error(enq.error || 'Failed to reach the desktop runtime');
  }
  const { commandId } = enq.data;
  if (isTerminalStatus(enq.data.status)) {
    return { status: enq.data.status, commandId };
  }

  const startedAt = now();
  let lastStatus: ConnectorCommandStatus = enq.data.status;
  let handledBy: string | undefined;
  for (;;) {
    await sleep(pollMs);
    const res = await api.getConnectorCommand(slug, commandId);
    const cmd = res.data?.command;
    if (cmd) {
      lastStatus = cmd.status;
      // ROUTE-001: prefer the machine that actually claimed it; fall back to
      // the routed target so even an unclaimed command can be named.
      handledBy = cmd.claimedByDeviceName ?? cmd.targetDeviceName ?? handledBy;
      if (isTerminalStatus(cmd.status)) {
        return { status: cmd.status, result: cmd.result, error: cmd.error, commandId, handledBy };
      }
    }
    if (now() - startedAt >= timeoutMs) {
      // Give-up semantics must stay truthful: a command a desktop CLAIMED may
      // have executed on the phone — that is 'uncertain', not a failure.
      return { status: lastStatus === 'claimed' ? 'uncertain' : 'expired', commandId, handledBy };
    }
  }
}
