import { describe, expect, it } from 'vitest';
import type { AokieCompanionDevice, AokieCompanionDiscovery, ApiKey, ConnectorAssignments, DesktopConnection } from '../../../lib/api';
import { companionDesktopDiagnostic, companionEndpointView, companionReadiness } from './aokieCompanionUi';

function discovery(overrides: Partial<AokieCompanionDiscovery> = {}): AokieCompanionDiscovery {
  return {
    schemaVersion: 2,
    issuer: 'https://forms.example.test',
    deploymentId: 'managed-au-1',
    appId: 'app-1',
    appSlug: 'front-desk',
    available: true,
    gatewayUrl: 'wss://realtime.example.test/v2/realtime',
    features: ['monitor', 'consult', 'takeover'],
    scopesSupported: ['aokie:state'],
    trustStatus: 'signed',
    signatureVerified: true,
    signatureAlgorithm: 'Ed25519',
    signingKeyId: 'formlogic-ed25519-1',
    iceServerCount: 1,
    hasTurnRelay: true,
    relayOnly: false,
    turnCredentialExpiresAt: 2_000,
    remoteConsent: {
      configured: true,
      remoteMonitoring: true,
      remoteConsult: true,
      remoteTakeover: true,
      remoteCaptions: false,
      remoteAssistance: false,
    },
    media: {
      transport: 'webrtc',
      gatewayRelaysMedia: false,
      companionUsesBluetoothDongle: false,
      relayOnly: false,
    },
    ...overrides,
  };
}

function device(overrides: Partial<AokieCompanionDevice> = {}): AokieCompanionDevice {
  return {
    id: 'endpoint-1',
    userId: 'user-1',
    appId: 'app-1',
    subjectId: 'device-native-1',
    role: 'mobile',
    displayName: 'Front desk headset',
    grants: ['state_read', 'monitor'],
    approvedAt: '2026-07-16 01:00:00',
    lastSeenAt: '2026-07-16 01:05:00',
    revokedAt: null,
    ...overrides,
  };
}

describe('Aokie Companion readiness view', () => {
  it('is ready only for an app-bound, verified v2 WebRTC signalling deployment', () => {
    const result = companionReadiness(discovery(), 'app-1', 1_000);
    expect(result.ready).toBe(true);
    expect(result.server.label).toBe('Available');
    expect(result.trust.label).toBe('Signature verified');
    expect(result.media.label).toBe('Endpoint media');
  });

  it('fails closed on an app-binding mismatch or a server-media topology mismatch', () => {
    const wrongApp = companionReadiness(discovery(), 'another-app', 1_000);
    expect(wrongApp.ready).toBe(false);
    expect(wrongApp.server.label).toBe('App binding mismatch');

    const wrongMedia = companionReadiness(discovery({
      media: { transport: 'webrtc', gatewayRelaysMedia: true, companionUsesBluetoothDongle: true, relayOnly: false },
    }), 'app-1', 1_000);
    expect(wrongMedia.ready).toBe(false);
    expect(wrongMedia.media.label).toBe('Topology mismatch');
  });

  it('fails closed when relay-only TURN credentials are expired', () => {
    const result = companionReadiness(discovery({
      relayOnly: true,
      turnCredentialExpiresAt: 1_020,
      media: { transport: 'webrtc', gatewayRelaysMedia: false, companionUsesBluetoothDongle: false, relayOnly: true },
    }), 'app-1', 1_000);
    expect(result.ready).toBe(false);
    expect(result.relay.label).toBe('TURN credentials expired');
  });

  it('does not describe a merely approved registry row as online', () => {
    const view = companionEndpointView(device());
    expect(view.statusLabel).toBe('Approved');
    expect(view.lastSeenLabel).toMatch(/^Admission /);
    expect(view.lastSeenLabel.toLowerCase()).not.toContain('online');
  });

  it('distinguishes revoked endpoints and tolerates an invalid timestamp', () => {
    const view = companionEndpointView(device({ revokedAt: '2026-07-16 02:00:00', lastSeenAt: 'not-a-date' }));
    expect(view.statusLabel).toBe('Revoked');
    expect(view.lastSeenLabel).toBe('No recent admission');
    expect(view.lastSeenTitle).toBeNull();
  });
});

describe('Aokie Desktop admission diagnostic', () => {
  const assignments: ConnectorAssignments = {
    assignments: [{
      connectorId: 'aokie', appId: 'app-1', appName: 'Front desk', appSlug: 'front-desk',
      desktopConnectionId: 'desktop-1', desktopDeviceName: 'Office PC', desktopInstanceId: 'instance-1', desktopLastSeenAt: '2026-07-16 01:00:00',
    }],
    candidates: {},
    desktops: [],
  };
  const connection: DesktopConnection = {
    id: 'desktop-1', deviceName: 'Office PC', desktopInstanceId: 'instance-1', apiKeyId: 'key-1',
    capabilities: ['companion.admission'], trustedOrigins: [], lastSeenAt: '2026-07-16 01:00:00', createdAt: '', updatedAt: '',
  };
  const key: ApiKey = {
    id: 'key-1', name: 'Desktop', keyPrefix: 'flk_', scopes: ['connector:relay'], formIds: null,
    lastUsedAt: null, expiresAt: null, createdAt: '',
  };

  it('requires relinking when the pinned key lacks aokie:realtime', () => {
    const result = companionDesktopDiagnostic('app-1', assignments, [connection], [key], Date.parse('2026-07-16T01:00:30Z'));
    expect(result.code).toBe('relink_required');
    expect(result.detail).toContain('aokie:realtime');
  });

  it('reports ready only with scope, capability and a fresh exact assignment', () => {
    const result = companionDesktopDiagnostic('app-1', assignments, [connection], [{ ...key, scopes: [...key.scopes, 'aokie:realtime'] }], Date.parse('2026-07-16T01:00:30Z'));
    expect(result.code).toBe('scope_ready');
    expect(result.tone).toBe('ready');
  });
});
