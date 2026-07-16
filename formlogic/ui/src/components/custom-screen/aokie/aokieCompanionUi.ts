import type {
  AokieCompanionActivity,
  AokieCompanionDevice,
  AokieCompanionDiscovery,
  ApiKey,
  ConnectorAssignments,
  DesktopConnection,
} from '../../../lib/api';

export type ReadinessTone = 'ready' | 'warning' | 'unavailable';

export interface CompanionReadiness {
  ready: boolean;
  server: { tone: ReadinessTone; label: string };
  trust: { tone: ReadinessTone; label: string };
  gateway: { tone: ReadinessTone; label: string };
  media: { tone: ReadinessTone; label: string };
  relay: { tone: ReadinessTone; label: string };
}

/** One deterministic view model shared by the readiness chips and their tests. */
export function companionReadiness(
  discovery: AokieCompanionDiscovery | null,
  expectedAppId?: string,
  nowUnix = Math.floor(Date.now() / 1000),
): CompanionReadiness {
  if (!discovery) {
    const unavailable = { tone: 'unavailable' as const, label: 'Unavailable' };
    return { ready: false, server: unavailable, trust: unavailable, gateway: unavailable, media: unavailable, relay: unavailable };
  }
  const appBound = !expectedAppId || discovery.appId === expectedAppId;
  const serverReady = discovery.available && discovery.schemaVersion === 2 && appBound;
  const trustReady = discovery.trustStatus === 'signed' && discovery.signatureVerified;
  const gatewayReady = typeof discovery.gatewayUrl === 'string' && discovery.gatewayUrl.length > 0;
  const mediaReady = discovery.media.transport === 'webrtc'
    && !discovery.media.gatewayRelaysMedia
    && !discovery.media.companionUsesBluetoothDongle
    && discovery.media.relayOnly === discovery.relayOnly;
  const turnFresh = discovery.turnCredentialExpiresAt !== null
    && discovery.turnCredentialExpiresAt > nowUnix + 30;
  const relayReady = discovery.hasTurnRelay ? turnFresh : !discovery.relayOnly;
  return {
    ready: serverReady && trustReady && gatewayReady && mediaReady && relayReady,
    server: serverReady
      ? { tone: 'ready', label: 'Available' }
      : {
          tone: 'unavailable',
          label: !discovery.available
            ? 'Not configured'
            : !appBound
              ? 'App binding mismatch'
              : 'Unsupported schema',
        },
    trust: trustReady
      ? { tone: 'ready', label: 'Signature verified' }
      : { tone: 'warning', label: discovery.trustStatus === 'signed' ? 'Verification failed' : 'Unsigned' },
    gateway: gatewayReady
      ? { tone: 'ready', label: 'Configured' }
      : { tone: 'unavailable', label: 'Not configured' },
    media: mediaReady
      ? { tone: 'ready', label: 'Endpoint media' }
      : { tone: 'warning', label: 'Topology mismatch' },
    relay: discovery.hasTurnRelay
      ? turnFresh
        ? { tone: 'ready', label: discovery.relayOnly ? 'Relay-only ready' : 'TURN fallback ready' }
        : { tone: 'unavailable', label: 'TURN credentials expired' }
      : discovery.relayOnly
        ? { tone: 'unavailable', label: 'TURN required' }
        : { tone: 'warning', label: 'Direct connections only' },
  };
}

function parsedTimestamp(value: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

export function companionTimestamp(value: string | null): { label: string; title: string | null } {
  if (!value) return { label: 'Not recorded', title: null };
  const parsed = parsedTimestamp(value);
  return parsed
    ? {
        label: parsed.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
        title: parsed.toLocaleString(),
      }
    : { label: 'Invalid timestamp', title: null };
}

const ACTIVITY_LABELS: Record<string, string> = {
  admission_issued: 'Admission issued',
  monitor_joined: 'Monitoring started',
  monitor_left: 'Monitoring ended',
  consult_joined: 'Voice consult started',
  consult_left: 'Voice consult ended',
  takeover_prepared: 'Takeover prepared',
  takeover_joined: 'Takeover activated',
  takeover_left: 'Takeover ended',
  returned_to_aokie: 'Returned to Aokie',
  session_recovered: 'Session recovered',
  session_revoked: 'Session revoked',
  endpoint_revoked: 'Endpoint revoked',
};

export function companionActivityLabel(activity: Pick<AokieCompanionActivity, 'eventType'>): string {
  return ACTIVITY_LABELS[activity.eventType]
    ?? activity.eventType.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());
}

export interface CompanionDesktopDiagnostic {
  tone: ReadinessTone;
  code: 'assignment_required' | 'desktop_pin_required' | 'relink_required' | 'scope_ready' | 'capability_missing' | 'desktop_offline';
  label: string;
  detail: string;
  desktopName: string | null;
}

/**
 * Owner-only, credential-free diagnosis of the exact Aokie assignment, linked key scope,
 * advertised Desktop capability, and 90-second heartbeat gate used by the admission API.
 */
export function companionDesktopDiagnostic(
  appId: string,
  assignments: ConnectorAssignments | null,
  connections: DesktopConnection[],
  keys: ApiKey[],
  nowMillis = Date.now(),
): CompanionDesktopDiagnostic {
  const assignment = assignments?.assignments.find((row) => row.connectorId === 'aokie' && row.appId === appId);
  if (!assignment) {
    return {
      tone: 'unavailable',
      code: 'assignment_required',
      label: 'Aokie assignment required',
      detail: 'Assign the Aokie connector to this app and pin one linked Desktop.',
      desktopName: null,
    };
  }
  if (!assignment.desktopConnectionId) {
    return {
      tone: 'unavailable',
      code: 'desktop_pin_required',
      label: 'Desktop pin required',
      detail: 'The Aokie assignment exists, but it is not pinned to one linked Desktop.',
      desktopName: null,
    };
  }
  const connection = connections.find((row) => row.id === assignment.desktopConnectionId);
  if (!connection || !connection.apiKeyId) {
    return {
      tone: 'unavailable',
      code: 'relink_required',
      label: 'Desktop relink required',
      detail: 'The pinned Desktop or its linked key is missing. Relink FormLogic Desktop before using realtime calls.',
      desktopName: connection?.deviceName ?? assignment.desktopDeviceName,
    };
  }
  const key = keys.find((row) => row.id === connection.apiKeyId);
  if (!key?.scopes.includes('aokie:realtime')) {
    return {
      tone: 'unavailable',
      code: 'relink_required',
      label: 'Desktop relink required',
      detail: 'This Desktop key predates the dedicated aokie:realtime scope. connector:relay alone is not media authority.',
      desktopName: connection.deviceName,
    };
  }
  if (!connection.capabilities.includes('aokie') && !connection.capabilities.includes('companion.admission')) {
    return {
      tone: 'unavailable',
      code: 'capability_missing',
      label: 'Companion capability missing',
      detail: 'The pinned Desktop heartbeat does not advertise the Aokie Companion admission capability.',
      desktopName: connection.deviceName,
    };
  }
  const lastSeen = connection.lastSeenAt ? parsedTimestamp(connection.lastSeenAt)?.getTime() ?? 0 : 0;
  if (lastSeen === 0 || lastSeen < nowMillis - 90_000) {
    return {
      tone: 'warning',
      code: 'desktop_offline',
      label: 'Assigned Desktop is offline',
      detail: 'The dedicated scope is present, but the pinned Desktop has not sent a heartbeat in the last 90 seconds.',
      desktopName: connection.deviceName,
    };
  }
  return {
    tone: 'ready',
    code: 'scope_ready',
    label: 'Dedicated realtime scope ready',
    detail: 'The exact assigned Desktop is linked with aokie:realtime and advertises Companion admission.',
    desktopName: connection.deviceName,
  };
}

export function companionEndpointView(device: AokieCompanionDevice): {
  roleLabel: string;
  statusLabel: 'Approved' | 'Revoked';
  lastSeenLabel: string;
  lastSeenTitle: string | null;
} {
  const seen = parsedTimestamp(device.lastSeenAt);
  return {
    roleLabel: device.role === 'plugin'
      ? 'Desktop bridge'
      : device.role === 'mobile'
        ? 'Companion endpoint'
        : 'Endpoint',
    // Do not call an approved row "online": lastSeenAt records the latest admission,
    // not a realtime heartbeat or WebSocket presence assertion.
    statusLabel: device.revokedAt ? 'Revoked' : 'Approved',
    lastSeenLabel: seen
      ? `Admission ${seen.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${seen.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      : 'No recent admission',
    lastSeenTitle: seen?.toLocaleString() ?? null,
  };
}
