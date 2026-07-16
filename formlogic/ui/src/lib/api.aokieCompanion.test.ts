import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function requestPath(value: unknown): string {
  const url = new URL(String(value), 'http://test.local');
  return url.pathname + url.search;
}

function signedDiscovery() {
  const payload = {
    schemaVersion: 2,
    issuer: 'https://forms.example.test',
    apiBaseUrl: 'https://forms.example.test/api',
    gatewayUrl: 'wss://realtime.example.test/v2/realtime?private=must-not-render',
    realtimeUrl: 'wss://realtime.example.test/v2/realtime?private=must-not-render',
    oauthAuthorizationUrl: 'https://forms.example.test/oauth/authorize',
    oauthTokenUrl: 'https://forms.example.test/api/oauth/token',
    oauthResource: 'https://forms.example.test/api/aokie-companion',
    admissionEndpoint: 'https://forms.example.test/api/aokie-companion/admission',
    clientId: 'aokie-companion',
    deploymentId: 'managed-au-1',
    available: true,
    scopesSupported: ['aokie:state', 'aokie:takeover'],
    features: ['monitor', 'consult', 'takeover'],
    remoteConsent: {
      configured: true,
      remoteMonitoring: true,
      remoteConsult: true,
      remoteTakeover: true,
      remoteCaptions: false,
      remoteAssistance: false,
    },
    relayOnly: true,
    turnCredentialExpiresAt: 1_784_176_000,
    iceServers: [{
      urls: ['turns:turn.example.test:5349'],
      username: 'temporary-user',
      credential: 'temporary-secret',
      expiresAt: 1_784_176_000,
    }],
    media: {
      transport: 'webrtc',
      gatewayRelaysMedia: false,
      companionUsesBluetoothDongle: false,
      relayOnly: true,
    },
    appId: 'app-1',
    appSlug: 'front-desk',
  };
  const envelope = {
    payload,
    signature: 'AA',
    alg: 'Ed25519',
    keyId: 'formlogic-ed25519-1',
  };
  return {
    ...payload,
    trustStatus: 'signed',
    signingKeyId: envelope.keyId,
    signatureAlgorithm: envelope.alg,
    signature: envelope.signature,
    signingKeyUrl: 'https://forms.example.test/api/public/signing-key',
    signatureEnvelope: envelope,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('api Aokie Companion discovery', () => {
  it('verifies the signed envelope and returns a credential-free readiness view', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(signedDiscovery()))
      .mockResolvedValueOnce(jsonResponse({
        alg: 'Ed25519',
        keyId: 'formlogic-ed25519-1',
        publicKey: 'AA==',
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: vi.fn().mockResolvedValue({ type: 'public' }),
        verify: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await api.getAokieCompanionDiscovery('front-desk');

    expect(result.error).toBeUndefined();
    expect(result.data?.signatureVerified).toBe(true);
    expect(result.data?.gatewayUrl).toBe('wss://realtime.example.test/v2/realtime');
    expect(result.data?.iceServerCount).toBe(1);
    expect(result.data?.hasTurnRelay).toBe(true);
    expect(result.data?.relayOnly).toBe(true);
    expect(result.data?.turnCredentialExpiresAt).toBe(1_784_176_000);
    expect(result.data?.remoteConsent.remoteConsult).toBe(true);
    expect(result.data?.features).toContain('consult');
    expect(JSON.stringify(result.data)).not.toContain('temporary-user');
    expect(JSON.stringify(result.data)).not.toContain('temporary-secret');
    expect(JSON.stringify(result.data)).not.toContain('turn.example.test');
    expect(result.data).not.toHaveProperty('iceServers');
    expect(requestPath(fetchMock.mock.calls[0][0])).toBe('/api/app/front-desk/aokie-discovery');
    expect(fetchMock.mock.calls[1][0]).toBe('https://forms.example.test/api/public/signing-key');
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe('omit');
  });

  it('fails trust when an additive top-level field differs from the signed payload', async () => {
    const tampered = signedDiscovery();
    tampered.gatewayUrl = 'wss://attacker.example/realtime';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(tampered)));

    const result = await api.getAokieCompanionDiscovery('front-desk');

    expect(result.data?.signatureVerified).toBe(false);
    // Diagnostics use the envelope payload, not the conflicting unsigned top-level URL.
    expect(result.data?.gatewayUrl).toBe('wss://realtime.example.test/v2/realtime');
  });
});

describe('api Aokie Companion owner endpoints', () => {
  it('lists only well-formed typed device rows for the selected app', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      devices: [{
        id: 'row-1',
        userId: 'user-1',
        appId: 'app/id',
        subjectId: 'native-1',
        role: 'mobile',
        displayName: 'Office headset',
        grants: ['state_read', 123],
        approvedAt: '2026-07-16 01:00:00',
        lastSeenAt: '2026-07-16 01:05:00',
        revokedAt: null,
      }, { id: 'invalid-row' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getAokieCompanionDevices('app/id');

    expect(requestPath(fetchMock.mock.calls[0][0])).toBe('/api/aokie-companion/devices?appId=app%2Fid');
    expect(result.data?.devices).toHaveLength(1);
    expect(result.data?.devices[0].grants).toEqual(['state_read']);
  });

  it('uses the policy, audit, routing and availability contracts without widening payloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ appId: 'app/1', remoteConsent: { configured: false } }))
      .mockResolvedValueOnce(jsonResponse({ appId: 'app/1', remoteConsent: { remoteMonitoring: true, remoteConsult: true, remoteTakeover: false, remoteCaptions: false, remoteAssistance: true } }))
      .mockResolvedValueOnce(jsonResponse({ activity: [], sessions: [] }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 'group-1' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 'group-1' } }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true, availability: 'busy' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'formlogic_csrf=csrf-123' });

    await api.getAokieCompanionPolicy('app/1');
    await api.updateAokieCompanionPolicy('app/1', {
      remoteMonitoring: true, remoteConsult: true, remoteTakeover: false, remoteCaptions: false, remoteAssistance: true,
    });
    await api.getAokieCompanionHistory('app/1', 25, 1_700_000_000);
    await api.getAokieCompanionRoutingGroups('app/1');
    const group = { appId: 'app/1', name: 'On call', policy: 'round_robin' as const, enabled: true, members: [{ deviceId: 'device-1', priority: 10, enabled: true }] };
    await api.createAokieCompanionRoutingGroup(group);
    await api.updateAokieCompanionRoutingGroup('group/1', group);
    await api.deleteAokieCompanionRoutingGroup('group/1', 'app/1');
    await api.setAokieCompanionAvailability('app/1', 'device/1', 'busy');

    expect(requestPath(fetchMock.mock.calls[0][0])).toBe('/api/aokie-companion/policy?appId=app%2F1');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      appId: 'app/1',
      remoteConsent: { remoteMonitoring: true, remoteConsult: true, remoteTakeover: false, remoteCaptions: false, remoteAssistance: true },
    });
    expect(requestPath(fetchMock.mock.calls[2][0])).toBe('/api/aokie-companion/history?appId=app%2F1&limit=25&before=1700000000');
    expect(requestPath(fetchMock.mock.calls[3][0])).toBe('/api/aokie-companion/routing-groups?appId=app%2F1');
    expect((fetchMock.mock.calls[4][1] as RequestInit).method).toBe('POST');
    expect(requestPath(fetchMock.mock.calls[5][0])).toBe('/api/aokie-companion/routing-groups/group%2F1');
    expect((fetchMock.mock.calls[5][1] as RequestInit).method).toBe('PUT');
    expect(requestPath(fetchMock.mock.calls[6][0])).toBe('/api/aokie-companion/routing-groups/group%2F1?appId=app%2F1');
    expect((fetchMock.mock.calls[6][1] as RequestInit).method).toBe('DELETE');
    expect(JSON.parse(String((fetchMock.mock.calls[7][1] as RequestInit).body))).toEqual({ appId: 'app/1', deviceId: 'device/1', availability: 'busy' });
  });

  it('uses CSRF-protected DELETE/POST routes for revoke and reapproval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, reauthorizationRequired: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', { cookie: 'formlogic_csrf=csrf-123' });

    await api.revokeAokieCompanionDevice('endpoint/1');
    await api.approveAokieCompanionDevice('endpoint/1');

    expect(requestPath(fetchMock.mock.calls[0][0])).toBe('/api/aokie-companion/devices/endpoint%2F1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-CSRF-Token': 'csrf-123' });
    expect(requestPath(fetchMock.mock.calls[1][0])).toBe('/api/aokie-companion/devices/endpoint%2F1/approve');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });
});
