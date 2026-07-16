import type { AokieEndpointIdentityStatus } from '../api';

export const COMPANION_ENROLLMENT_HEADING = 'Connect a Companion app';

export const COMPANION_TOPOLOGY_COPY =
  'The Aokie plugin receives the caller audio from the Bluetooth phone link. Desktop bridges that audio over encrypted WebRTC to an approved Companion app, which uses its own microphone and speakers. This screen enrolls and trusts the app; it does not pair audio hardware.';

export const COMPANION_MEDIA_PRIVACY_COPY =
  'The server routes signalling and may relay encrypted TURN packets; it never receives decoded call PCM.';

export function shortEndpointThumbprint(value: string | undefined): string {
  if (!value) return '-';
  return value.length > 22 ? `${value.slice(0, 11)}...${value.slice(-9)}` : value;
}

/** Security comparisons must render the complete public thumbprint. */
export function fullEndpointThumbprint(value: string | undefined): string {
  return value || '-';
}

export function companionPairingSummary(status: AokieEndpointIdentityStatus | null): {
  label: string;
  tone: 'is-ok' | 'is-neutral';
  canGenerateOffer: boolean;
} {
  return {
    label: status?.remoteAccessReady ? 'Companion trusted' : 'Companion approval required',
    tone: status?.remoteAccessReady ? 'is-ok' : 'is-neutral',
    canGenerateOffer: status?.available !== false,
  };
}
