// Data-node wire types (docs/FORMLOGIC_DATA_NODES.md §11). Server wraps
// responses in {data:…}; lib/api.ts unwraps before these shapes apply.

export interface DataNodeWire {
  id: string;
  connectionId: string;
  /** A desktop that can host data, or a computer that only keeps backups. */
  kind?: 'desktop' | 'backup';
  displayName: string;
  signingPublicKey: string;
  signingKeyId: string;
  signingKeyGeneration: number;
  fingerprint: string;
  transportKeyFingerprint: string | null;
  status: 'pending' | 'approved' | 'revoked';
  approved: boolean;
  certificateExpiresAt: string | null;
  protocolMin: number;
  protocolMax: number;
  capabilities: string[];
  rosterRevision: number;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
}

/** A one-time code on its way to a linked computer's backup plugin. */
export interface BackupLinkStatus {
  state: 'waiting' | 'linked' | 'failed' | 'expired';
  message: string | null;
  /** Once the plugin has told FormLogic who it is. */
  nodeId: string | null;
}

export interface CloudSignerIdentity {
  publicKey: string;
  keyId: string;
  fingerprint: string;
}

export interface DataPlacementState {
  formId: string;
  legacyCloudPrimary: boolean;
  placement: {
    storageEpoch: number;
    manifestHash: string;
    primaryReplicaId: string;
    createdAt: string | null;
    manifest: Record<string, unknown>;
  } | null;
  cloudSigner: CloudSignerIdentity;
}
