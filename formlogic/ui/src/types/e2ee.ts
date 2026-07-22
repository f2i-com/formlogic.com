// Wire shapes for the E2EE private-forms feature (docs/E2EE_PRIVATE_FORMS_PLAN.md).
// These are the client-side views of the backend contract — every byte field is
// standard base64 (with padding) on the wire, per plan §5. Where the plan is silent
// the shapes mirror the backend exactly (its integration tests assert them):
// success bodies are wrapped in {data: …} and errors are {error:true, message, code,
// details?} — api.ts unwraps the {data:…} envelope before these types apply.

import type { PublicFormEncryption } from './form';

/** The encryption manifest served inside GET /api/public/forms/{id} (§8).
 *  Single source of truth: PublicFormEncryption in types/form.ts. */
export type FormEncryptionManifest = PublicFormEncryption;

/** user_vaults row as served/accepted by GET/PUT /api/vault (§7). */
export interface VaultWire {
  /** Optimistic-lock version; 1 at creation, CAS on every rewrite. */
  version: number;
  kdf: 'argon2id13.1';
  kdfSalt: string; // b64(16B)
  kdfMemlimit: number;
  kdfOpslimit: number;
  wrappedUmk: string; // b64(nonce||ct)
  wrappedUmkRecovery: string | null; // b64(nonce||ct)
  encKeyBundle: string; // b64(nonce||ct of the private-key bundle)
  x25519Pk: string; // b64(32B)
  ed25519Pk: string; // b64(32B)
}

/** form_key_grants row as served to the owner inside GET /api/forms/{id}/encryption (§7). */
export interface FormKeyGrantWire {
  grantId: string;
  fkEpoch: number;
  wrappedKey: string; // b64 sealed box of FK to grantee
  role: string;
  grantorUserId: string;
  granteeUserId: string;
  granteePk: string; // b64(32B) snapshot
  sigVersion: number;
  signature: string; // b64(64B)
}

/** form_ingestion_keys row as served to the owner (§7). */
export interface IngestionKeyWire {
  id: string;
  epoch: number;
  publicKey: string; // b64(32B)
  wrappedSecret: string; // b64 XChaCha wrap under FK[fkEpoch]
  fkEpoch: number;
  state: 'active' | 'retiring' | 'retired' | 'trashed';
  /** Retiring grace deadline; the backend omits it when null (absent in v1 responses). */
  acceptUntil?: string | null;
}

/** Stored manifest row descriptor used for the envelope acceptance rule (§8). */
export interface ManifestRowWire {
  manifestSeq: number;
  keyId: string;
  ingestEpoch: number;
  schemaVersion: number;
  schemaHash: string;
  contentSuite: string;
  wrapSuite: string;
  signerKeyId: string;
  signerPk: string;
  signedBytes: string;
  signature: string; // b64(64B)
  expiresAt: string | null;
  supersededAt: string | null;
}

/** GET /api/forms/{id}/encryption response (the {data:…} payload, unwrapped). */
export interface FormEncryptionStateWire {
  encryption: {
    mode: 'private';
    currentIngestEpoch: number;
    currentFkEpoch: number;
  };
  /** The caller's latest non-revoked grant, or null when they have none. */
  grant: FormKeyGrantWire | null;
  ingestionKeys: IngestionKeyWire[];
  manifests: ManifestRowWire[];
  schemaVersions: { version: number; schemaHash: string; schemaJson: string }[];
}

/** Client-computed payload for POST /api/forms/{id}/encryption (§9.1).
 *  Field names match the backend contract exactly — the server verifies both
 *  signatures against the requester's vault keys and stores only what it needs. */
export interface EnableEncryptionPayload {
  keyId: string; // fik_…
  ingestEpoch: 1;
  fkEpoch: 1;
  ingestionPublicKey: string; // b64(32B)
  wrappedIngestionSecret: string; // b64(72B XChaCha wrap under FK)
  grant: {
    grantId: string; // fkg_…
    wrappedKey: string; // b64(80B sealed FK)
    signature: string; // b64(64B Ed25519 over the §11 canonical string)
    role: 'owner';
    sigVersion: 1;
  };
  schema: { schemaJson: string; schemaHash: string };
  manifest: {
    signature: string; // b64(64B Ed25519 over the §8 canonical string)
    signerKeyId: string; // hex16 SHA-256 prefix of the vault Ed25519 key
    expiresAt: null;
  };
}

/** Client-computed payload for POST /api/forms/{id}/encryption/schema (field publish). */
export interface PublishSchemaPayload {
  schema: { schemaJson: string; schemaHash: string };
  manifest: EnableEncryptionPayload['manifest'];
}
