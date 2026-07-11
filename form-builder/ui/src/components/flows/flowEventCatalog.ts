// FormLogic Flows - trigger event and connector command catalog.
//
// This is the UI-side mirror of the Aokie Desktop plugin manifest. The manifest itself is the
// source of truth (pinned by flowEventCatalog.test.ts); this typed catalog adds the labels,
// descriptions and payload chips the authoring UI needs without inventing extra event names.

export type FlowEventGroupId = 'aokie.calls' | 'aokie.sms' | 'aokie.device' | 'formlogic';

export interface FlowEventGroupMeta {
  id: FlowEventGroupId;
  label: string;
  requiresConnector?: string;
}

interface FlowEventEntryBase {
  id: string;
  group: FlowEventGroupId;
  label: string;
  description: string;
  /** The event name written to a binding. Teach entries intentionally share a real event. */
  event: string;
  /** Authoring chips for selectors under the event envelope's data payload. */
  payloadHints: readonly string[];
}

export interface FlowTriggerEventEntry extends FlowEventEntryBase {
  kind: 'event';
}

export interface FlowTeachEventEntry extends FlowEventEntryBase {
  kind: 'teach';
  presetCondition: string;
}

export type FlowEventCatalogEntry = FlowTriggerEventEntry | FlowTeachEventEntry;

export const FLOW_EVENT_GROUPS: readonly FlowEventGroupMeta[] = [
  { id: 'aokie.calls', label: 'Aokie · Calls', requiresConnector: 'aokie' },
  { id: 'aokie.sms', label: 'Aokie · SMS', requiresConnector: 'aokie' },
  { id: 'aokie.device', label: 'Aokie · Device', requiresConnector: 'aokie' },
  { id: 'formlogic', label: 'FormLogic' },
] as const;

const CALL_ID_HINTS = ['$event.data.callId'] as const;
const CALL_PARTY_HINTS = ['$event.data.callId', '$event.data.from', '$event.data.callerPhone', '$event.data.callerName'] as const;
const CALL_TURN_HINTS = ['$event.data.callId', '$event.data.turn', '$event.data.speaker', '$event.data.text'] as const;
const CALL_ENDED_HINTS = ['$event.data.callId', '$event.data.outcome', '$event.data.durationSeconds'] as const;
const DONGLE_HINTS = ['$event.data.dongleId'] as const;
const DEVICE_ERROR_HINTS = ['$event.data.dongleId', '$event.data.severity', '$event.data.message'] as const;
const SMS_RECEIVED_HINTS = ['$event.data.messageId', '$event.data.from', '$event.data.phone', '$event.data.body', '$event.data.text', '$event.data.receivedAt'] as const;
const SMS_SENT_HINTS = ['$event.data.messageId', '$event.data.to', '$event.data.status'] as const;
const FORM_SUBMITTED_HINTS = ['$event.data.formId', '$event.data.responseId', '$event.data.answers'] as const;

export const AOKIE_EVENT_NAMES = [
  'aokie.dongle.detected',
  'aokie.dongle.driver_required',
  'aokie.dongle.ready',
  'aokie.dongle.error',
  'aokie.phone.pairing_started',
  'aokie.phone.paired',
  'aokie.phone.connected',
  'aokie.phone.disconnected',
  'aokie.call.incoming',
  'aokie.call.ringing',
  'aokie.call.answered',
  'aokie.call.rejected',
  'aokie.call.audio.connected',
  'aokie.call.audio.disconnected',
  'aokie.call.turn.partial',
  'aokie.call.turn.final',
  'aokie.call.ended',
  'aokie.sms.received',
  'aokie.sms.sent',
  'aokie.sms.failed',
  'aokie.hardware.error',
] as const;

export const AOKIE_CONNECTOR_COMMANDS = [
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
  'call.current',
  'call.answer',
  'call.reject',
  'call.hangup',
  'call.operatorSpeak',
  'sms.threads',
  'sms.thread',
  'sms.send',
  'settings.get',
  'settings.set',
  'outbox.redrive',
] as const;

export type AokieEventName = (typeof AOKIE_EVENT_NAMES)[number];
export type AokieConnectorCommand = (typeof AOKIE_CONNECTOR_COMMANDS)[number];

export const FLOW_EVENT_CATALOG: readonly FlowEventCatalogEntry[] = [
  {
    kind: 'event',
    id: 'aokie.call.incoming',
    group: 'aokie.calls',
    event: 'aokie.call.incoming',
    label: 'Incoming call',
    description: 'A phone call started ringing through the Aokie bridge.',
    payloadHints: CALL_PARTY_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.call.ringing',
    group: 'aokie.calls',
    event: 'aokie.call.ringing',
    label: 'Call ringing',
    description: 'The phone reported another ring cycle for the incoming call.',
    payloadHints: CALL_ID_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.call.answered',
    group: 'aokie.calls',
    event: 'aokie.call.answered',
    label: 'Call answered',
    description: 'A ringing call was answered by Aokie or an operator.',
    payloadHints: [...CALL_ID_HINTS, '$event.data.answeredBy'],
  },
  {
    kind: 'event',
    id: 'aokie.call.audio.connected',
    group: 'aokie.calls',
    event: 'aokie.call.audio.connected',
    label: 'Call audio connected',
    description: 'The call audio channel came up (codec negotiated, two-way audio live).',
    payloadHints: ['$event.data.codec', '$event.data.sampleRate'],
  },
  {
    kind: 'event',
    id: 'aokie.call.audio.disconnected',
    group: 'aokie.calls',
    event: 'aokie.call.audio.disconnected',
    label: 'Call audio disconnected',
    description: 'The call audio channel dropped while the call was still up.',
    payloadHints: [],
  },
  {
    kind: 'event',
    id: 'aokie.call.rejected',
    group: 'aokie.calls',
    event: 'aokie.call.rejected',
    label: 'Call rejected',
    description: 'A ringing call was declined before it became active.',
    payloadHints: [...CALL_ID_HINTS, '$event.data.reason'],
  },
  {
    kind: 'event',
    id: 'aokie.call.turn.partial',
    group: 'aokie.calls',
    event: 'aokie.call.turn.partial',
    label: 'Transcript turn partial',
    description: 'A partial speech-to-text transcript turn arrived during a call.',
    payloadHints: CALL_TURN_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.call.turn.final',
    group: 'aokie.calls',
    event: 'aokie.call.turn.final',
    label: 'Transcript turn final',
    description: 'A final transcript turn arrived during a live call.',
    payloadHints: CALL_TURN_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.call.ended',
    group: 'aokie.calls',
    event: 'aokie.call.ended',
    label: 'Call ended',
    description: 'A call finished with an outcome and optional duration.',
    payloadHints: CALL_ENDED_HINTS,
  },
  {
    kind: 'teach',
    id: 'teach:missed-call',
    group: 'aokie.calls',
    event: 'aokie.call.ended',
    label: 'Missed call',
    description: 'Handle ended calls whose outcome is missed.',
    payloadHints: CALL_ENDED_HINTS,
    presetCondition: "event.data.outcome === 'missed'",
  },
  {
    kind: 'event',
    id: 'aokie.sms.received',
    group: 'aokie.sms',
    event: 'aokie.sms.received',
    label: 'SMS received',
    description: 'An inbound SMS arrived through the paired phone.',
    payloadHints: SMS_RECEIVED_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.sms.sent',
    group: 'aokie.sms',
    event: 'aokie.sms.sent',
    label: 'SMS sent',
    description: 'A requested outbound SMS was accepted by the phone bridge.',
    payloadHints: SMS_SENT_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.sms.failed',
    group: 'aokie.sms',
    event: 'aokie.sms.failed',
    label: 'SMS failed',
    description: 'An outbound SMS failed before delivery.',
    payloadHints: ['$event.data.messageId', '$event.data.to', '$event.data.error', '$event.data.message'],
  },
  {
    kind: 'event',
    id: 'aokie.dongle.detected',
    group: 'aokie.device',
    event: 'aokie.dongle.detected',
    label: 'Dongle detected',
    description: 'A compatible phone bridge dongle was detected.',
    payloadHints: DONGLE_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.dongle.driver_required',
    group: 'aokie.device',
    event: 'aokie.dongle.driver_required',
    label: 'Dongle driver required',
    description: 'A detected dongle needs a driver before it can be used.',
    payloadHints: [...DONGLE_HINTS, '$event.data.driver', '$event.data.message'],
  },
  {
    kind: 'event',
    id: 'aokie.dongle.ready',
    group: 'aokie.device',
    event: 'aokie.dongle.ready',
    label: 'Dongle ready',
    description: 'The selected dongle is ready for phone bridge work.',
    payloadHints: DONGLE_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.dongle.error',
    group: 'aokie.device',
    event: 'aokie.dongle.error',
    label: 'Dongle error',
    description: 'The dongle reported a setup or runtime problem.',
    payloadHints: DEVICE_ERROR_HINTS,
  },
  {
    kind: 'event',
    id: 'aokie.phone.pairing_started',
    group: 'aokie.device',
    event: 'aokie.phone.pairing_started',
    label: 'Phone pairing started',
    description: 'Aokie started pairing with a phone.',
    payloadHints: ['$event.data.dongleId', '$event.data.deviceName'],
  },
  {
    kind: 'event',
    id: 'aokie.phone.paired',
    group: 'aokie.device',
    event: 'aokie.phone.paired',
    label: 'Phone paired',
    description: 'A phone finished pairing with the Aokie bridge.',
    payloadHints: ['$event.data.deviceName', '$event.data.phoneNumber', '$event.data.pairedAt'],
  },
  {
    kind: 'event',
    id: 'aokie.phone.connected',
    group: 'aokie.device',
    event: 'aokie.phone.connected',
    label: 'Phone connected',
    description: 'A paired phone connected to the Aokie bridge and is ready for calls.',
    payloadHints: ['$event.data.address'],
  },
  {
    kind: 'event',
    id: 'aokie.phone.disconnected',
    group: 'aokie.device',
    event: 'aokie.phone.disconnected',
    label: 'Phone disconnected',
    description: 'The paired phone disconnected from the bridge.',
    payloadHints: ['$event.data.deviceName', '$event.data.reason'],
  },
  {
    kind: 'event',
    id: 'aokie.hardware.error',
    group: 'aokie.device',
    event: 'aokie.hardware.error',
    label: 'Hardware error',
    description: 'A dongle, phone or audio hardware issue needs attention.',
    payloadHints: DEVICE_ERROR_HINTS,
  },
  {
    kind: 'event',
    id: 'form.submitted',
    group: 'formlogic',
    event: 'form.submitted',
    label: 'Form submitted',
    description: 'A FormLogic form response was submitted.',
    payloadHints: FORM_SUBMITTED_HINTS,
  },
  {
    kind: 'event',
    id: 'manual',
    group: 'formlogic',
    event: 'manual',
    label: 'Manual',
    description: 'Run manually from the workspace or an explicit flow.run request.',
    payloadHints: [],
  },
] as const;

export function flowEventsForGroup(group: FlowEventGroupId): readonly FlowEventCatalogEntry[] {
  return FLOW_EVENT_CATALOG.filter((entry) => entry.group === group);
}

export function flowEventGroupsForConnectors(connectorIds: readonly string[] = []): readonly FlowEventGroupMeta[] {
  const available = new Set(connectorIds);
  return FLOW_EVENT_GROUPS.filter((group) => !group.requiresConnector || available.has(group.requiresConnector));
}

export function mergeKnownConnectorCommands(
  connectorId: unknown,
  grantCommands: readonly string[] = [],
  availableConnectorIds: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (command: string) => {
    if (seen.has(command)) return;
    seen.add(command);
    out.push(command);
  };
  for (const command of grantCommands) add(command);
  if (connectorId === 'aokie' && availableConnectorIds.includes('aokie')) {
    for (const command of AOKIE_CONNECTOR_COMMANDS) add(command);
  }
  return out;
}
