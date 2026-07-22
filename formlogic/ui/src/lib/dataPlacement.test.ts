// N3a owner-side signing (docs/FORMLOGIC_DATA_NODES.md §11): the vault worker
// signs flnodecert:1 / flplacement:1 structures end-to-end (built → signed →
// verified against the vault public key), refuses non-allowlisted domains, and
// refuses identity claims that do not match the vault.

import { beforeAll, describe, expect, it } from 'vitest';
import { CryptoClient, createInlineWorker } from './crypto/cryptoClient';
import { __resetCryptoWorkerState } from './crypto/worker';
import { fromB64 } from './crypto/encoding';
import { DOMAIN_NODE_CERT, DOMAIN_OPERATION, DOMAIN_PLACEMENT, verifyStructure } from './data/canonical';
import {
  buildNodeCertificate,
  buildPlacementBaseline,
  ownerSignerFromVaultPk,
} from './dataPlacement';
import type { DataNodeWire } from '../types/dataPlacement';

const USER_ID = 'user-dp-test';

describe('data placement owner signing', () => {
  let client: CryptoClient;
  let ed25519PkB64 = '';

  beforeAll(async () => {
    __resetCryptoWorkerState();
    client = new CryptoClient(createInlineWorker);
    const { vault } = await client.createVault(USER_ID, 'a-strong-passphrase');
    ed25519PkB64 = vault.ed25519Pk;
  });

  const node: DataNodeWire = {
    id: 'dn_test',
    connectionId: 'dc_test',
    displayName: 'Office PC',
    signingPublicKey: 'A'.repeat(43) + '=',
    signingKeyId: 'ab'.repeat(8),
    signingKeyGeneration: 1,
    fingerprint: 'ab'.repeat(32),
    transportKeyFingerprint: null,
    status: 'pending',
    approved: false,
    certificateExpiresAt: null,
    protocolMin: 1,
    protocolMax: 1,
    capabilities: ['storage'],
    rosterRevision: 1,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: null,
  };

  it('signs a node certificate the vault public key verifies', async () => {
    const signer = await ownerSignerFromVaultPk(ed25519PkB64);
    const cert = buildNodeCertificate(node, USER_ID, signer);
    const { signature, signerKeyId, signerFingerprint } = await client.signDataStructure(DOMAIN_NODE_CERT, cert);
    expect(signerKeyId).toBe(signer.keyId);
    expect(signerFingerprint).toBe(signer.fingerprint);
    const signed = { ...cert, signature };
    expect(await verifyStructure(DOMAIN_NODE_CERT, signed, fromB64(ed25519PkB64))).toBe(true);
    // …and not under another domain or after tampering.
    expect(await verifyStructure(DOMAIN_PLACEMENT, signed, fromB64(ed25519PkB64))).toBe(false);
    expect(await verifyStructure(DOMAIN_NODE_CERT, { ...signed, nodeId: 'dn_other' }, fromB64(ed25519PkB64))).toBe(false);
  });

  it('signs the epoch-1 placement baseline with the pinned structure', async () => {
    const signer = await ownerSignerFromVaultPk(ed25519PkB64);
    const cloudSigner = { publicKey: 'B'.repeat(43) + '=', keyId: 'cd'.repeat(8), fingerprint: 'cd'.repeat(32) };
    const manifest = buildPlacementBaseline('form-1', cloudSigner, signer);
    expect(manifest['storageEpoch']).toBe(1);
    expect(manifest['primaryReplicaId']).toBe('cloud');
    expect((manifest['replicas'] as unknown[]).length).toBe(1);
    const { signature } = await client.signDataStructure(DOMAIN_PLACEMENT, manifest);
    expect(await verifyStructure(DOMAIN_PLACEMENT, { ...manifest, signature }, fromB64(ed25519PkB64))).toBe(true);
  });

  it('refuses non-allowlisted domains and mismatched signer identity', async () => {
    const signer = await ownerSignerFromVaultPk(ed25519PkB64);
    const cert = buildNodeCertificate(node, USER_ID, signer);
    await expect(client.signDataStructure(DOMAIN_OPERATION, cert)).rejects.toMatchObject({ code: 'data_sign_domain' });
    const impostor = buildNodeCertificate(node, USER_ID, { keyId: '00'.repeat(8), fingerprint: '00'.repeat(32) });
    await expect(client.signDataStructure(DOMAIN_NODE_CERT, impostor)).rejects.toMatchObject({ code: 'data_sign_identity' });
  });
});
