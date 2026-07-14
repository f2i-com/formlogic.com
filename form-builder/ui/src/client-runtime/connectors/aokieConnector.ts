// Aokie connector — phone/dongle bridge (docs/AOKIE_PLUGIN_CONTRACT.md).
//
// Aokie's hardware lives in a FormLogic Desktop plugin (connector id 'aokie'); the
// browser reaches it through Desktop's gateway POST /api/connectors/aokie/request.
// This module registers ONE browser connector composed of two layers:
//
//   1. desktop-backed — when Desktop is detected AND paired, every request routes
//      through desktopClient.connectors.request('aokie', …). Real desktop errors
//      (capability_denied, command_failed, a genuine connector_unavailable from the
//      gateway) surface as typed ConnectorErrors and are NEVER masked with mock data
//      (the same FALLBACKABLE_CODES policy as the native bridge, spec §41).
//   2. explicit simulator (audit FL-CONN-001) — the demo-grade mock answers ONLY inside a
//      deliberate simulator session: the shared Demo account, the "Simulate incoming call"
//      buttons (which start a session), or the formlogic.aokieSimulator dev flag. It is
//      NEVER a fallback: with no simulator session, an absent/unpaired Desktop is a typed
//      connector_unavailable — and once a REAL desktop route was attempted, NOTHING falls
//      back to the mock (faking success for an answer/hangup/SMS that never reached the
//      phone is worse than failing). Simulator responses carry `simulated: true` and
//      simulator events stamp `data.simulated: true` for provenance.
//
// The composed connector registers in BROWSER_CONNECTORS, so the existing routing
// (native bridge → browser connector) and the connector.<id>.<command>
// permission model apply unchanged.
import type { BrowserConnector, ConnectorStatusInfo } from './connectorTypes';
import { ConnectorError, type ConnectorErrorCode } from './connectorTypes';
import { api } from '../../lib/api';
import { desktopClient } from '../desktop/desktopClient';
import { getDesktopInfo } from '../desktop/desktopDetection';
import { isDesktopPaired } from '../desktop/desktopPairing';
import { emitLocalDesktopEvent } from '../desktop/desktopEvents';
import type { DesktopEventEnvelope } from '../desktop/desktopTypes';

/** MVP command surface (AOKIE_PLUGIN_CONTRACT.md §2). */
const AOKIE_COMMANDS = [
  'dongle.list',
  'dongle.getPreferred',
  'dongle.setPreferred',
  'dongle.installDriver',
  'dongle.diagnostics',
  'phone.status',
  'phone.startPairing',
  'phone.stopPairing',
  'phone.listPaired',
  'phone.removePaired',
  'phone.disconnect',
  'phone.connect',
  'call.current',
  'call.answer',
  'call.reject',
  'call.hangup',
  'call.operatorSpeak',
  'call.configureAgent',
  'call.dial',
  'sms.threads',
  'sms.thread',
  'sms.send',
  'settings.get',
  'settings.set',
];

// ---------------------------------------------------------------------------
// Explicit simulator session (audit FL-CONN-001).
// ---------------------------------------------------------------------------

// Turned on by simulateIncomingCall() (the explicit "Simulate…" buttons) for the rest of
// this page session. The Demo account and the dev flag count as standing opt-ins.
let simulatorSession = false;

/** Start a deliberate simulator session (page-lifetime). */
export function enableAokieSimulator(): void {
  simulatorSession = true;
}

/** True only inside a deliberate simulator session — the ONLY state where the mock answers. */
export function isAokieSimulatorActive(): boolean {
  if (simulatorSession) return true;
  if (api.isDemoMode()) return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('formlogic.aokieSimulator') === '1';
  } catch {
    return false;
  }
}

/** Test-only. */
export function __resetAokieSimulatorForTests(): void {
  simulatorSession = false;
}

/** Provenance stamp for everything the simulator answers (audit FL-CONN-001). */
function markSimulated(data: unknown): unknown {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), simulated: true }
    : data;
}

// ---------------------------------------------------------------------------
// Mock layer (like mockVehicleConnector) — demo data, no hardware, no Desktop.
// ---------------------------------------------------------------------------

interface MockCall {
  callId: string;
  direction: 'incoming';
  from: string;
  callerName: string;
  state: 'ringing' | 'active' | 'ended';
  startedAt: string;
}

// Simulator state shared between call.current and simulateIncomingCall().
let mockCurrentCall: MockCall | null = null;
let mockSmsCounter = 0;
// Operator-spoken demo turns need idempotency keys that can never collide
// with the scripted sequence's turn.0/turn.1 — start well above them.
let mockTurnCounter = 100;

/**
 * The mock twin of the plugin's callId guard (audit C-01): a supplied callId
 * that isn't the current call is the typed `stale_call` error, and state
 * requirements surface as `command_failed` — the demo bridge fails the same
 * way the real plugin does, so the Live Call screen can be exercised honestly.
 */
function requireMockCall(
  command: string,
  payload: unknown,
  allowed: ReadonlyArray<MockCall['state']>
): MockCall {
  const p = (payload ?? {}) as { callId?: unknown };
  if (typeof p.callId === 'string' && p.callId !== mockCurrentCall?.callId) {
    throw new ConnectorError(
      'stale_call',
      mockCurrentCall
        ? `callId ${p.callId} is not the current call (${mockCurrentCall.callId})`
        : `callId ${p.callId} is stale: there is no current call`
    );
  }
  if (!mockCurrentCall) throw new ConnectorError('command_failed', `${command}: no active call`);
  if (!allowed.includes(mockCurrentCall.state)) {
    throw new ConnectorError(
      'command_failed',
      `${command}: call ${mockCurrentCall.callId} is ${mockCurrentCall.state}, not ${allowed.join('/')}`
    );
  }
  return mockCurrentCall;
}

const MOCK_DONGLES = [
  {
    id: 'usb-0a12-0001',
    name: 'CSR 4.0 Bluetooth dongle',
    vendorId: '0a12',
    productId: '0001',
    driverInstalled: true,
    preferred: true,
  },
  {
    id: 'usb-0b05-190e',
    name: 'ASUS USB-BT400',
    vendorId: '0b05',
    productId: '190e',
    driverInstalled: false,
    preferred: false,
  },
];

const MOCK_THREADS = [
  {
    threadId: 'thr_demo_1',
    address: '+61400111222',
    displayName: 'Riley Chen',
    lastMessage: 'Thanks, see you at 2pm.',
    lastAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    unread: 0,
  },
  {
    threadId: 'thr_demo_2',
    address: '+61400333444',
    displayName: 'Jordan Blake',
    lastMessage: 'Can I move my booking to Friday?',
    lastAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    unread: 1,
  },
];

/**
 * Mock Aokie connector (demo). Answers the MVP read commands with catalog-flavoured
 * fake data and acknowledges sms.send. Used ONLY when FormLogic Desktop is
 * absent/unpaired — never to mask a real desktop error.
 */
export const mockAokieConnector: BrowserConnector = {
  id: 'aokie',
  kind: 'aokie_phone',
  label: 'Aokie phone bridge (demo)',
  commands: AOKIE_COMMANDS,
  status(): ConnectorStatusInfo {
    return {
      id: 'aokie',
      kind: 'aokie_phone',
      available: true,
      source: 'mock',
      label: 'Aokie phone bridge (demo)',
      detail: 'Simulated phone bridge — FormLogic Desktop not connected.',
    };
  },
  async request(command: string, payload?: unknown): Promise<unknown> {
    switch (command) {
      case 'dongle.list':
        return { dongles: MOCK_DONGLES };
      case 'phone.status':
        // Canonical shape (audit C-02): the device is NESTED under `device`
        // exactly like the real plugin's radio response — never a root-level
        // deviceName the real path doesn't have.
        return {
          paired: true,
          connected: true,
          device: {
            address: '00:11:22:33:44:55',
            name: 'Demo Phone',
            pairedAt: new Date(Date.now() - 86_400_000).toISOString(),
          },
          battery: 82,
          signal: 4,
          source: 'mock',
        };
      case 'call.current':
        return { call: mockCurrentCall };
      case 'call.answer': {
        const call = requireMockCall('call.answer', payload, ['ringing']);
        mockCurrentCall = { ...call, state: 'active' };
        emitLocalDesktopEvent(
          aokieEnvelope(call.callId, 'aokie.call.answered', `aokie:${call.callId}:answered:v1`, {
            callId: call.callId,
            answeredBy: 'operator',
          })
        );
        return { answered: true };
      }
      case 'call.dial': {
        // Phase 2 mock parity: validates like the plugin (number shape +
        // required opening line) and emits the outbound.dialing envelope so
        // demo flows can bind to it. No simulated conversation follows —
        // the demo has no remote party to answer.
        const p = (payload ?? {}) as { number?: unknown; openingLine?: unknown; purpose?: unknown };
        const number = typeof p.number === 'string' ? p.number.trim() : '';
        const openingLine = typeof p.openingLine === 'string' ? p.openingLine.trim() : '';
        const purpose = typeof p.purpose === 'string' ? p.purpose : undefined;
        if (!/^\+?[0-9][0-9 ()\-.]{4,}$/.test(number)) {
          throw new ConnectorError('command_failed', 'call.dial requires a phone-format {number}.');
        }
        if (!openingLine) {
          throw new ConnectorError(
            'command_failed',
            'call.dial requires {openingLine} — the exact first words spoken when they answer.'
          );
        }
        if (mockCurrentCall && mockCurrentCall.state !== 'ended') {
          throw new ConnectorError(
            'command_failed',
            'a call is already in progress — outbound dialing needs an idle line.'
          );
        }
        const callId = `call_demo_${Date.now().toString(36)}`;
        emitLocalDesktopEvent(
          aokieEnvelope(callId, 'aokie.call.outbound.dialing', `aokie:${callId}:outbound.dialing:v1`, {
            callId,
            to: number,
            purpose: purpose ?? null,
          })
        );
        return { accepted: true, queued: true, callId, to: number };
      }
      case 'call.reject': {
        const call = requireMockCall('call.reject', payload, ['ringing']);
        mockCurrentCall = { ...call, state: 'ended' };
        emitLocalDesktopEvent(
          aokieEnvelope(call.callId, 'aokie.call.rejected', `aokie:${call.callId}:rejected:v1`, {
            callId: call.callId,
            reason: 'operator_reject',
          })
        );
        return { rejected: true };
      }
      case 'call.hangup': {
        const call = requireMockCall('call.hangup', payload, ['ringing', 'active']);
        mockCurrentCall = { ...call, state: 'ended' };
        const durationSeconds = Math.max(
          0,
          Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000)
        );
        emitLocalDesktopEvent(
          aokieEnvelope(call.callId, 'aokie.call.ended', `aokie:${call.callId}:ended:v1`, {
            callId: call.callId,
            from: call.from,
            callerPhone: call.from,
            reason: 'operator_hangup',
            durationSeconds,
            outcome: 'completed',
          })
        );
        return { ended: true };
      }
      case 'call.operatorSpeak': {
        // §9.2 parity: inResponseTo (the caller turn number the speech
        // answers) is type-checked like the plugin does; the mock never
        // simulates caller turns, so staleness itself isn't simulated.
        const p = (payload ?? {}) as { text?: unknown; inResponseTo?: unknown };
        if (typeof p.text !== 'string' || !p.text.trim()) {
          throw new ConnectorError('command_failed', 'call.operatorSpeak requires {text}.');
        }
        if (
          p.inResponseTo !== undefined &&
          p.inResponseTo !== null &&
          typeof p.inResponseTo !== 'number'
        ) {
          throw new ConnectorError(
            'command_failed',
            'call.operatorSpeak inResponseTo must be the caller turn NUMBER the speech answers.'
          );
        }
        const call = requireMockCall('call.operatorSpeak', payload, ['active']);
        mockTurnCounter += 1;
        emitLocalDesktopEvent(
          aokieEnvelope(
            call.callId,
            'aokie.call.turn.final',
            `aokie:${call.callId}:turn.${mockTurnCounter}.final:v1`,
            { callId: call.callId, turn: mockTurnCounter, speaker: 'operator', text: p.text }
          )
        );
        return { spoken: true, mock: true };
      }
      case 'call.configureAgent': {
        // Phase 0 / §9.3 parity with the plugin: call-scoped persona/greeting.
        // callId is REQUIRED (no legacy window on a new surface) and must be
        // the current call; empty config is refused, not silently accepted.
        const p = (payload ?? {}) as { callId?: unknown; persona?: unknown; greeting?: unknown };
        if (typeof p.callId !== 'string' || !p.callId) {
          throw new ConnectorError('command_failed', 'call.configureAgent requires {callId}.');
        }
        const persona = typeof p.persona === 'string' ? p.persona.trim() : '';
        const greeting = typeof p.greeting === 'string' ? p.greeting.trim() : '';
        if (!persona && !greeting) {
          throw new ConnectorError(
            'command_failed',
            'call.configureAgent needs a persona and/or greeting to apply.'
          );
        }
        const call = requireMockCall('call.configureAgent', payload, ['ringing', 'active']);
        return { accepted: true, mock: true, callId: call.callId };
      }
      case 'sms.threads':
        return { threads: MOCK_THREADS };
      case 'sms.send': {
        const p = (payload ?? {}) as { to?: unknown; body?: unknown };
        if (typeof p.to !== 'string' || !p.to || typeof p.body !== 'string' || !p.body) {
          throw new ConnectorError('command_failed', 'sms.send requires {to, body}.');
        }
        mockSmsCounter += 1;
        const messageId = `msg_demo_${mockSmsCounter}`;
        emitLocalDesktopEvent(
          aokieEnvelope(messageId, 'aokie.sms.sent', `aokie:${messageId}:sent:v1`, {
            messageId,
            to: p.to,
            status: 'sent',
          })
        );
        return { messageId, status: 'queued' };
      }
      default:
        throw new ConnectorError('command_failed', `Aokie demo mode does not support "${command}".`);
    }
  },
};

function aokieEnvelope(
  correlationId: string,
  name: string,
  idempotencyKey: string,
  data: unknown
): DesktopEventEnvelope {
  return {
    schemaVersion: 1,
    source: 'aokie',
    name,
    correlationId,
    idempotencyKey,
    occurredAt: new Date().toISOString(),
    // Simulator provenance (FL-CONN-001): every event this module fabricates says so, so a
    // record written from it can never masquerade as a real call/SMS.
    data: markSimulated(data),
    pluginId: 'aokie',
    connectorId: 'aokie',
  };
}

export interface SimulateIncomingCallOptions {
  /** Delay between scripted steps, default 1200ms (0 for tests). */
  stepDelayMs?: number;
  from?: string;
  callerName?: string;
}

/**
 * MOCK-ONLY demo helper: pushes the contract's scripted call lifecycle
 * (dongle.detected → dongle.ready → call.incoming → call.answered → 2× call.turn.final
 * → call.ended → sms.received; AOKIE_PLUGIN_CONTRACT.md §4) into the LOCAL desktop
 * event hub, with contract-shaped idempotencyKeys (`aokie:<correlationId>:<step>:v1`).
 * Never call this when a real Desktop is paired — real events come over SSE.
 * Resolves with the correlationId once the whole sequence has been emitted.
 */
export async function simulateIncomingCall(options: SimulateIncomingCallOptions = {}): Promise<string> {
  // The explicit opt-in: from here on this page session may use the simulated bridge.
  enableAokieSimulator();
  const stepDelayMs = options.stepDelayMs ?? 1200;
  const from = options.from ?? '+61400555666';
  const callerName = options.callerName ?? 'Alex Morgan (demo)';
  const callId = `call_demo_${Date.now().toString(36)}`;
  const key = (step: string) => `aokie:${callId}:${step}:v1`;
  const wait = () => (stepDelayMs > 0 ? new Promise((r) => setTimeout(r, stepDelayMs)) : Promise.resolve());
  // The operator can reject/hang up mid-script through the mock call controls;
  // a dead call must stay dead — the script stops instead of resurrecting it.
  const callStillLive = () => mockCurrentCall?.callId === callId && mockCurrentCall.state !== 'ended';

  emitLocalDesktopEvent(aokieEnvelope(callId, 'aokie.dongle.detected', key('dongle.detected'), { dongleId: MOCK_DONGLES[0].id }));
  emitLocalDesktopEvent(aokieEnvelope(callId, 'aokie.dongle.ready', key('dongle.ready'), { dongleId: MOCK_DONGLES[0].id }));

  mockCurrentCall = {
    callId,
    direction: 'incoming',
    from,
    callerName,
    state: 'ringing',
    startedAt: new Date().toISOString(),
  };
  emitLocalDesktopEvent(aokieEnvelope(callId, 'aokie.call.incoming', key('incoming'), { callId, from, callerName }));
  await wait();
  if (!callStillLive()) return callId;

  // The operator may have ANSWERED already (mock call.answer) — don't double-emit.
  if (mockCurrentCall?.state !== 'active') {
    mockCurrentCall = { ...mockCurrentCall!, state: 'active' };
    emitLocalDesktopEvent(aokieEnvelope(callId, 'aokie.call.answered', key('answered'), { callId, answeredBy: 'bot' }));
  }
  await wait();
  if (!callStillLive()) return callId;

  emitLocalDesktopEvent(
    aokieEnvelope(callId, 'aokie.call.turn.final', key('turn.0.final'), {
      callId,
      turn: 0,
      speaker: 'caller',
      text: 'Hi, I would like to book an appointment for tomorrow morning.',
    })
  );
  await wait();
  if (!callStillLive()) return callId;
  emitLocalDesktopEvent(
    aokieEnvelope(callId, 'aokie.call.turn.final', key('turn.1.final'), {
      callId,
      turn: 1,
      speaker: 'bot',
      text: 'Sure — I have 9:30am available. I will text you a confirmation.',
    })
  );
  await wait();
  if (!callStillLive()) return callId;

  mockCurrentCall = null;
  emitLocalDesktopEvent(
    aokieEnvelope(callId, 'aokie.call.ended', key('ended'), { callId, durationSeconds: 42, outcome: 'completed' })
  );
  emitLocalDesktopEvent(
    aokieEnvelope(callId, 'aokie.sms.received', key('sms.received'), {
      from,
      body: 'Perfect, 9:30am works. Thanks!',
      receivedAt: new Date().toISOString(),
    })
  );
  return callId;
}

// ---------------------------------------------------------------------------
// Composed connector: desktop first; the simulator ONLY in an explicit session.
// ---------------------------------------------------------------------------

/** Desktop is a candidate route only when detected AND this origin holds a pairing token. */
function desktopRouteAvailable(): boolean {
  return getDesktopInfo().available && isDesktopPaired();
}

export const aokieConnector: BrowserConnector = {
  id: 'aokie',
  kind: 'aokie_phone',
  label: 'Aokie phone bridge',
  commands: AOKIE_COMMANDS,

  async status(): Promise<ConnectorStatusInfo> {
    if (!desktopRouteAvailable()) {
      if (isAokieSimulatorActive()) return mockAokieConnector.status();
      return {
        id: 'aokie',
        kind: 'aokie_phone',
        available: false,
        source: 'mock',
        label: 'Aokie phone bridge',
        detail: 'FormLogic Desktop is not connected — connect and pair it to use the phone bridge.',
      };
    }
    const res = await desktopClient.connectors.status('aokie');
    if (res.ok) {
      const s = res.data;
      return {
        id: 'aokie',
        kind: 'aokie_phone',
        available: s?.available === true,
        // Desktop is a loopback HTTP bridge — surfaced like the local_http source class.
        source: 'local_http',
        label: 'Aokie phone bridge (FormLogic Desktop)',
        detail: s?.detail ?? 'Served by FormLogic Desktop.',
      };
    }
    // FL-CONN-001: a desktop that WAS routable and now fails is reported unavailable —
    // never re-painted with the simulator's healthy-looking status.
    return {
      id: 'aokie',
      kind: 'aokie_phone',
      available: false,
      source: 'local_http',
      label: 'Aokie phone bridge (FormLogic Desktop)',
      detail: res.error.message,
    };
  },

  async request(command: string, payload?: unknown): Promise<unknown> {
    if (!desktopRouteAvailable()) {
      // FL-CONN-001: the simulator answers ONLY inside an explicit session. Otherwise an
      // absent/unpaired Desktop is a typed failure — a call/SMS command must never
      // pretend to succeed against hardware that isn't there.
      if (isAokieSimulatorActive()) {
        return markSimulated(await mockAokieConnector.request(command, payload));
      }
      throw new ConnectorError(
        'connector_unavailable',
        `FormLogic Desktop is not connected — "${command}" was not performed. Connect and pair FormLogic Desktop to use the phone bridge.`
      );
    }

    const res = await desktopClient.connectors.request('aokie', command, payload);
    if (res.ok) return res.data;

    // FL-CONN-001: once a REAL desktop route was attempted, NOTHING falls back to the
    // simulator — not on transport failure, not on auth_required, not on the old
    // "fallbackable" absent-ish codes. Faking success for a mutation (answer/hangup/
    // operatorSpeak/sms.send) that never reached the phone is strictly worse than a
    // typed, actionable failure.
    if (res.transportFailure) {
      throw new ConnectorError(
        'connector_unavailable',
        `FormLogic Desktop did not respond — "${command}" was not performed. ${res.error?.message ?? ''}`.trim()
      );
    }
    throw new ConnectorError(res.error.code as ConnectorErrorCode, res.error.message);
  },
};
