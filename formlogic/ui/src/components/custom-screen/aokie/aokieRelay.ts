// Aokie Receptionist — remote call-control relay (docs/API.md §connector:relay, FORMLOGIC_FLOWS.md §14).
//
// When the receptionist runs headless in FormLogic Desktop on ANOTHER machine, the web Live Call
// screen can't reach the local connector client. Instead it drives the call over the RELAY: enqueue
// a connector command (POST /app/{slug}/connector-commands) that the owner's desktop runtime long-polls,
// claims and completes, then poll the command back to a terminal status. This module is the pure,
// unit-tested state machine + gating + copy behind those controls — the React screen only wires state.
//
// The relay path is permission-identical to the local path: a control is offered only when the app
// holds the SAME connector.aokie.<command> grant AND the viewer's role can write Calls records.
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
  /** Which connector the enqueued command targets. Defaults to 'aokie' (this
   *  module's original caller); the generic screen bridge passes its own. */
  connectorId?: string;
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
  payload?: Record<string, unknown>,
  options: RunRelayOptions = {}
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
  const enqueueBody = {
    connectorId: options.connectorId ?? 'aokie',
    command,
    payload,
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

// ── Optimistic overlay ──────────────────────────────────────────────────────────────────

export interface CallOverlay {
  callId: string;
  state: 'ringing' | 'active' | 'ended';
}

/**
 * The optimistic call-state to show the instant an operator taps a control, before the relay
 * round-trips. Answer → live, reject/hangup → ended, operatorSpeak → no state change (null).
 */
export function optimisticOverlayFor(command: string, callId: string): CallOverlay | null {
  switch (command) {
    case 'call.answer':
      return { callId, state: 'active' };
    case 'call.reject':
    case 'call.hangup':
      return { callId, state: 'ended' };
    default:
      return null;
  }
}

export interface PerformRelayCallbacks {
  /** Apply (overlay) or clear (null) the optimistic call-state override. */
  onOptimistic?: (overlay: CallOverlay | null) => void;
  /** Called once on a successful command so the caller can re-fetch authoritative records. */
  onReload?: () => void;
  /** Injectable runner (tests substitute a deterministic outcome). */
  runner?: typeof runRelayCommand;
  runOptions?: RunRelayOptions;
}

/**
 * Full optimistic relay flow: paint the optimistic state, enqueue+poll, then on success reload the
 * authoritative records (and drop the overlay), or on failure/expiry REVERT the overlay. Returns the
 * terminal outcome so the caller can toast it. Enqueue errors reject after reverting the overlay.
 */
export async function performRelayCommand(
  api: RelayApi,
  slug: string,
  command: string,
  callId: string | undefined,
  payload: Record<string, unknown> | undefined,
  callbacks: PerformRelayCallbacks = {}
): Promise<RelayOutcome> {
  const runner = callbacks.runner ?? runRelayCommand;
  const overlay = callId ? optimisticOverlayFor(command, callId) : null;
  if (overlay) callbacks.onOptimistic?.(overlay);
  try {
    const outcome = await runner(api, slug, command, payload, callbacks.runOptions);
    if (outcome.status === 'done') {
      callbacks.onOptimistic?.(null);
      callbacks.onReload?.();
    } else {
      // failed / expired → revert the optimistic paint.
      callbacks.onOptimistic?.(null);
    }
    return outcome;
  } catch (err) {
    callbacks.onOptimistic?.(null);
    throw err;
  }
}

// ── Local / relay routing ────────────────────────────────────────────────────────────────

export interface LocalConnector {
  request: (command: string, payload?: unknown) => Promise<unknown>;
}

export type DispatchResult = { mode: 'local' } | { mode: 'relay'; outcome: RelayOutcome };

/**
 * Route one call control to the right transport. In LOCAL-bridge mode the command goes straight to
 * the connector client (the pre-existing, unchanged behaviour — the relay is never touched). In
 * REMOTE-runtime mode it goes through performRelayCommand (enqueue → poll → optimistic overlay).
 * Keeping the fork in one tested function guarantees local never accidentally hits the relay.
 */
export async function dispatchCallCommand(
  deps: { remote: boolean; connector: LocalConnector; relay?: { api: RelayApi; slug: string } },
  command: string,
  callId: string | undefined,
  payload?: Record<string, unknown>,
  callbacks?: PerformRelayCallbacks
): Promise<DispatchResult> {
  if (deps.remote) {
    if (!deps.relay) throw new Error('Remote dispatch requires a relay target');
    const outcome = await performRelayCommand(deps.relay.api, deps.relay.slug, command, callId, payload, callbacks);
    return { mode: 'relay', outcome };
  }
  await deps.connector.request(command, payload);
  return { mode: 'local' };
}

// ── Gating ───────────────────────────────────────────────────────────────────────────────

export interface CommandGate {
  /** Connector grant probe: `connector.aokie.<command>` (the SAME check the local path uses). */
  can: (command: string) => boolean;
  /** Role gate: the viewer can write Calls records (operate the phone), not just view. */
  roleAllowsOperating: boolean;
}

/** A control is actionable only with BOTH the connector grant and the operating role. */
export function canRunCommand(command: string, gate: CommandGate): boolean {
  return gate.roleAllowsOperating && gate.can(command);
}

// ── Outcome copy ───────────────────────────────────────────────────────────────────────────

const COMMAND_SUCCESS_LABEL: Record<string, string> = {
  'call.answer': 'Call answered',
  'call.reject': 'Call rejected',
  'call.hangup': 'Call ended',
  'call.operatorSpeak': 'Sent to the caller',
};

/** AOK-CTRL-001: the radio-backed plugin returns `{accepted, queued, operationId}` for call
 *  controls — the phone hasn't acted yet, so the toast must not claim the final verb. The
 *  authoritative state arrives via the call events (the record reload). Mock/dev results keep
 *  their synchronous final verbs (`answered`/`ended`/…) and take the confirmed copy above. */
const COMMAND_ACCEPTED_LABEL: Record<string, { title: string; message: string }> = {
  'call.answer': {
    title: 'Answer sent to the phone',
    message: 'The call view updates when the phone confirms it picked up.',
  },
  'call.reject': {
    title: 'Reject sent to the phone',
    message: 'The call record confirms once the phone declines the call.',
  },
  'call.hangup': {
    title: 'Hang-up sent to the phone',
    message: 'The call record confirms once the call actually ends.',
  },
  'call.operatorSpeak': {
    title: 'Speech queued to the caller',
    message: 'The transcript records it once it actually plays.',
  },
};

/** True when the result reports ACCEPTANCE only — no synchronous final verb to stand on. */
function isAcceptedOnly(result?: Record<string, unknown> | null): boolean {
  if (!result || result.accepted !== true) return false;
  return !('answered' in result || 'rejected' in result || 'ended' in result || 'spoken' in result);
}

export interface OutcomeToast {
  kind: 'success' | 'error';
  title: string;
  message?: string;
}

/**
 * Map a terminal relay outcome to the toast the operator sees. 'expired' is the load-bearing case:
 * it means no FormLogic Desktop claimed the command, so we say so plainly rather than "timed out".
 */
export function describeRelayOutcome(command: string, outcome: RelayOutcome, presenceDeviceName?: string): OutcomeToast {
  // ROUTE-001: the machine the SERVER says handled/targets this command beats a
  // presence-derived guess (the freshest sibling isn't necessarily the claimant).
  const deviceName = outcome.handledBy ?? presenceDeviceName;
  if (outcome.status === 'done') {
    // AOK-CTRL-001: an accepted-only result means the desktop QUEUED the action —
    // never toast "answered/ended/sent" before the phone confirms it.
    if (isAcceptedOnly(outcome.result)) {
      const accepted = COMMAND_ACCEPTED_LABEL[command];
      const parts = [accepted?.message, deviceName ? `Handled by ${deviceName}.` : undefined].filter(
        (p): p is string => Boolean(p)
      );
      return {
        kind: 'success',
        title: accepted?.title ?? 'Command accepted by the desktop',
        message: parts.length ? parts.join(' ') : undefined,
      };
    }
    return {
      kind: 'success',
      title: COMMAND_SUCCESS_LABEL[command] ?? 'Command sent',
      message: deviceName ? `Handled by ${deviceName}.` : undefined,
    };
  }
  if (outcome.status === 'uncertain') {
    // Audit INT-005: claimed but unreported when we gave up — the phone may
    // have acted. Say so plainly; the record view is the source of truth.
    return {
      kind: 'error',
      title: 'Outcome uncertain',
      message: deviceName
        ? `${deviceName} picked this up but has not reported back — check the call state before retrying.`
        : 'A desktop picked this up but has not reported back — check the call state before retrying.',
    };
  }
  if (outcome.status === 'expired') {
    return {
      kind: 'error',
      title: 'No FormLogic Desktop is currently online',
      message: deviceName
        ? `${deviceName} did not pick up the command in time. Check the receptionist is still running there.`
        : 'No desktop runtime picked up the command. Check the receptionist is still running.',
    };
  }
  // failed
  const errMessage = typeof outcome.error?.message === 'string' ? (outcome.error.message as string) : undefined;
  return {
    kind: 'error',
    title: 'Command failed on the desktop',
    message: errMessage ?? 'The receptionist could not complete that action.',
  };
}
