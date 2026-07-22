// Owner-side data-node orchestration (docs/FORMLOGIC_DATA_NODES.md §11):
// compose the flnodecert:1 node-authority certificate and the flplacement:1
// epoch-1 baseline, have the VAULT WORKER sign them (the Ed25519 secret never
// leaves it), and submit to the server — which re-verifies everything against
// the same vault public key. Pure builders are exported for tests.

import { api } from './api';
import { getCryptoClient } from './crypto/cryptoClient';
import { fromB64 } from './crypto/encoding';
import {
  DATA_PROTOCOL,
  DOMAIN_NODE_CERT,
  DOMAIN_PLACEMENT,
  dataKeyFingerprint,
  dataKeyId,
} from './data/canonical';
import type { CloudSignerIdentity, DataNodeWire } from '../types/dataPlacement';

/** RFC3339 UTC with integer seconds (the frozen signed-timestamp shape). */
function utcNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

export interface OwnerSignerIdentity {
  keyId: string;
  fingerprint: string;
}

/** Derive the owner signer identity from the vault's served Ed25519 public key. */
export async function ownerSignerFromVaultPk(ed25519PkB64: string): Promise<OwnerSignerIdentity> {
  const raw = fromB64(ed25519PkB64);
  return { keyId: await dataKeyId(raw), fingerprint: await dataKeyFingerprint(raw) };
}

/** The flnodecert:1 body (without signature) for approving one node. */
export function buildNodeCertificate(
  node: DataNodeWire,
  ownerUserId: string,
  signer: OwnerSignerIdentity,
): Record<string, unknown> {
  return {
    protocol: DATA_PROTOCOL,
    kind: 'node-authority',
    nodeId: node.id,
    connectionId: node.connectionId,
    ownerUserId,
    signingKeyId: node.signingKeyId,
    signingKeyGeneration: node.signingKeyGeneration,
    signingPublicKey: node.signingPublicKey,
    fingerprint: node.fingerprint,
    capabilities: ['storage'],
    issuedAt: utcNow(),
    expiresAt: null,
    ownerSignerKeyId: signer.keyId,
    ownerSignerFingerprint: signer.fingerprint,
  };
}

/** The flplacement:1 epoch-1 Cloud-primary baseline (without signature). */
export function buildPlacementBaseline(
  formId: string,
  cloudSigner: CloudSignerIdentity,
  signer: OwnerSignerIdentity,
): Record<string, unknown> {
  const authority = {
    keyId: cloudSigner.keyId,
    generation: 1,
    ed25519PublicKey: cloudSigner.publicKey,
    fingerprint: cloudSigner.fingerprint,
  };
  return {
    protocol: DATA_PROTOCOL,
    datasetId: formId,
    formId,
    protocolVersion: 1,
    storageEpoch: 1,
    primaryReplicaId: 'cloud',
    replicas: [{
      replicaId: 'cloud',
      kind: 'cloud',
      role: 'primary',
      desiredState: 'active',
      authoritySigningKey: authority,
      transportKeyFingerprint: cloudSigner.fingerprint,
    }],
    offlineSubmissionPolicy: { mode: 'reject' },
    readFallbackPolicy: { mode: 'none' },
    leaseAuthority: authority,
    cutoverCheckpointHash: null,
    recoveryAuthorization: null,
    previousManifestHash: null,
    createdAt: utcNow(),
    ownerSignerKeyId: signer.keyId,
    ownerSignerGeneration: 1,
    ownerSignerFingerprint: signer.fingerprint,
  };
}

/** Sign + submit a node approval. The vault must already be unlocked. */
export async function approveDataNode(
  node: DataNodeWire,
  ownerUserId: string,
  ed25519PkB64: string,
): Promise<DataNodeWire> {
  const signer = await ownerSignerFromVaultPk(ed25519PkB64);
  const certificate = buildNodeCertificate(node, ownerUserId, signer);
  const { signature } = await getCryptoClient().signDataStructure(DOMAIN_NODE_CERT, certificate);
  const res = await api.approveDataNode(node.id, { ...certificate, signature });
  if (!res.ok) {
    throw new Error((res.body as { message?: string })?.message || 'Node approval failed');
  }
  return (res.body as { data: { node: DataNodeWire } }).data.node;
}

/** Sign + submit the epoch-1 placement baseline. The vault must be unlocked. */
export async function signPlacementBaseline(formId: string, ed25519PkB64: string): Promise<void> {
  const current = await api.getDataPlacement(formId);
  if (current.error || !current.data) {
    throw new Error(current.error || 'Could not load placement state');
  }
  if (!current.data.legacyCloudPrimary) {
    throw new Error('This form already has a signed placement');
  }
  const signer = await ownerSignerFromVaultPk(ed25519PkB64);
  const manifest = buildPlacementBaseline(formId, current.data.cloudSigner, signer);
  const { signature } = await getCryptoClient().signDataStructure(DOMAIN_PLACEMENT, manifest);
  const res = await api.putDataPlacement(formId, { ...manifest, signature });
  if (!res.ok) {
    throw new Error((res.body as { message?: string })?.message || 'Placement signing failed');
  }
}
