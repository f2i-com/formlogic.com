import assert from 'node:assert/strict';
import test from 'node:test';
import type { AokieEndpointIdentityStatus } from '../api';
import {
  COMPANION_ENROLLMENT_HEADING,
  COMPANION_MEDIA_PRIVACY_COPY,
  COMPANION_TOPOLOGY_COPY,
  companionPairingSummary,
  fullEndpointThumbprint,
  shortEndpointThumbprint,
} from './companionPairingUi.ts';

function status(overrides: Partial<AokieEndpointIdentityStatus> = {}): AokieEndpointIdentityStatus {
  return {
    available: true,
    rosterRevision: 1,
    rosterHash: 'hash',
    approvedMobiles: [],
    pendingApprovals: [],
    remoteAccessReady: false,
    ...overrides,
  };
}

test('empty or pending-only roster remains visibly approval-required', () => {
  assert.deepEqual(companionPairingSummary(status()), {
    label: 'Companion approval required',
    tone: 'is-neutral',
    canGenerateOffer: true,
  });
  assert.equal(
    companionPairingSummary(status({ pendingApprovals: [{
      id: 'pending',
      deviceId: 'mobile',
      displayName: 'Desk',
      endpointKey: { algorithm: 'ed25519', publicKey: 'public', thumbprint: 'thumb' },
      thumbprint: 'thumb',
      fingerprint: 'AA:BB',
      receivedAt: '2026-07-16T00:00:00Z',
    }] })).label,
    'Companion approval required',
  );
});

test('only an approved roster reports a trusted Companion', () => {
  assert.deepEqual(companionPairingSummary(status({ remoteAccessReady: true })), {
    label: 'Companion trusted',
    tone: 'is-ok',
    canGenerateOffer: true,
  });
  assert.equal(companionPairingSummary(status({ available: false })).canGenerateOffer, false);
});

test('topology copy distinguishes plugin capture, Desktop bridging and Companion audio', () => {
  assert.equal(COMPANION_ENROLLMENT_HEADING, 'Connect a Companion app');
  assert.doesNotMatch(COMPANION_ENROLLMENT_HEADING, /microphone|speaker|audio hardware/i);
  assert.match(COMPANION_TOPOLOGY_COPY, /plugin receives the caller audio/i);
  assert.match(COMPANION_TOPOLOGY_COPY, /Desktop bridges that audio over encrypted WebRTC/i);
  assert.match(COMPANION_TOPOLOGY_COPY, /uses its own microphone and speakers/i);
  assert.match(COMPANION_TOPOLOGY_COPY, /does not pair audio hardware/i);
  assert.match(COMPANION_MEDIA_PRIVACY_COPY, /encrypted TURN packets/i);
  assert.match(COMPANION_MEDIA_PRIVACY_COPY, /never receives decoded call PCM/i);
});

test('thumbprints are compact in cards without changing the full value', () => {
  assert.equal(shortEndpointThumbprint(undefined), '-');
  assert.equal(shortEndpointThumbprint('short'), 'short');
  assert.equal(
    shortEndpointThumbprint('abcdefghijklmnopqrstuvwxyz0123456789'),
    'abcdefghijk...123456789',
  );
});

test('owner security comparison preserves the complete public thumbprint', () => {
  const thumbprint = 'n7DjBmmijlWJXN1Rc6A82tabWuGzlHptVTzsB21vfMU';
  assert.equal(fullEndpointThumbprint(thumbprint), thumbprint);
  assert.equal(fullEndpointThumbprint(undefined), '-');
  assert.doesNotMatch(fullEndpointThumbprint(thumbprint), /\.\.\./);
});
