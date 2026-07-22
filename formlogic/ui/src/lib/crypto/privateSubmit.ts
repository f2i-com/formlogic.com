// Public private-form submission path (docs/E2EE_PRIVATE_FORMS_PLAN.md SS8).
//
// Dynamically imported by FormResponse.tsx ONLY when the served form carries
// encryption.mode === 'private', so the sodium WASM (and everything else here)
// stays out of the base bundle. Public submission needs NO vault and NO worker:
// the browser verifies the signed manifest (signature + schema-hash), enforces
// the TOFU signer pin, mints a DEK + recordId locally, and seals to the form's
// ingestion public key.
//
// ANY failure here must surface as a blocking error - the caller NEVER falls
// back to a plaintext submission.

import { getSodium } from './sodium';
import { fromB64 } from './encoding';
import { mintRecordId, sealEnvelope, EnvelopeError, type InnerPayload, type ResponseEnvelope } from './envelope';
import { verifyManifest, ManifestError } from './manifest';
import { getPinnedSigner, pinSigner, SignerChangedError, signerFingerprint } from './signerPins';
import type { FormEncryptionManifest } from '../../types/e2ee';

export { trustFormSignerKey, clearSignerPins } from './signerPins';
export type { FormEncryptionManifest };

export class PrivateSubmitError extends Error {
  readonly code: string;
  /** Present on a signer-pin mismatch, for the changed-key refusal UX. */
  readonly pinChange?: { pinnedFingerprint: string; servedFingerprint: string };
  constructor(code: string, message: string, pinChange?: PrivateSubmitError['pinChange']) {
    super(message);
    this.name = 'PrivateSubmitError';
    this.code = code;
    this.pinChange = pinChange;
  }
}

export interface SealPrivateSubmissionArgs {
  formId: string;
  encryption: FormEncryptionManifest;
  answers: Record<string, unknown>;
  completionTime?: number;
  language?: string;
}

function fingerprintOf(b64: string): string {
  try {
    return signerFingerprint(fromB64(b64));
  } catch {
    return '(unreadable)';
  }
}

/**
 * Verify the manifest (signature + schema hash), enforce the TOFU signer pin,
 * then seal the complete answer set as a fresh rev=1 envelope. Calculated/hidden
 * values must already be folded into `answers` by the caller (the server no
 * longer derives anything for private forms).
 */
export async function sealPrivateSubmission(
  args: SealPrivateSubmissionArgs,
): Promise<{ envelope: ResponseEnvelope; recordId: string }> {
  const { formId, encryption, answers, completionTime, language } = args;
  try {
    // 1. Mathematical verification of the served manifest (throws ManifestError).
    await verifyManifest(formId, encryption);
    // 2. TOFU signer pin: first sight records; a changed signer is refused loudly.
    pinSigner(formId, encryption.signerPk);

    const sodium = await getSodium();
    const recordId = mintRecordId(sodium.randombytes_buf(16));
    const meta: InnerPayload['meta'] = {};
    if (typeof completionTime === 'number' && Number.isFinite(completionTime)) meta.completionTime = completionTime;
    if (language) meta.language = language;
    const inner: InnerPayload = {
      v: 1,
      answers,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
    const envelope = await sealEnvelope(
      {
        formId,
        recordId,
        rev: 1,
        keyId: encryption.keyId,
        epoch: encryption.epoch,
        schemaVersion: encryption.schemaVersion,
        schemaHash: encryption.schemaHash,
      },
      inner,
      fromB64(encryption.publicKey),
    );
    return { envelope, recordId };
  } catch (e) {
    if (e instanceof SignerChangedError) {
      const pinned = getPinnedSigner(formId);
      throw new PrivateSubmitError('signer_pin_mismatch', e.message,
        pinned ? { pinnedFingerprint: fingerprintOf(pinned), servedFingerprint: fingerprintOf(encryption.signerPk) } : undefined);
    }
    if (e instanceof ManifestError) {
      throw new PrivateSubmitError(e.code, e.message);
    }
    if (e instanceof EnvelopeError) {
      throw new PrivateSubmitError(e.code, e.message);
    }
    throw new PrivateSubmitError(
      'seal_failed',
      e instanceof Error ? e.message : 'Could not encrypt your response',
    );
  }
}
