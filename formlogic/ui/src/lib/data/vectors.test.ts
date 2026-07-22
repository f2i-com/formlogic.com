// Cross-language vector suite for the data-nodes protocol (flcanon/1 + signing
// preimages + logical roots; docs/FORMLOGIC_DATA_NODES.md §1-§3).
//
// One deterministic fixture file, asserted byte-identically by three consumers:
//   - this vitest suite (writer)
//   - backend/tests/Unit/DataSyncVectorsTest.php
//   - desktop/src-tauri/src/data/canonical.rs tests
//
// Regenerate with:
//   FORMLOGIC_DATA_VECTORS_WRITE=1 npx vitest run src/lib/data/vectors.test.ts

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSodium } from '../crypto/sodium';
import { fromHex, toB64, toHex } from '../crypto/encoding';
import {
  DOMAIN_CHECKPOINT,
  DOMAIN_HIGH_WATER,
  DOMAIN_OPERATION,
  DOMAIN_PLACEMENT,
  canonicalize,
  computeLogicalRootHex,
  dataKeyFingerprint,
  dataKeyId,
  domainHashHex,
  signStructure,
  verifyStructure,
  type LogicalRootEntry,
} from './canonical';

const CONTRACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/contracts',
);
const VECTORS_PATH = path.join(CONTRACTS_DIR, 'data-sync-vectors.json');
const WRITE_MODE = process.env.FORMLOGIC_DATA_VECTORS_WRITE === '1';

// Fixed test-only seed (never key material for real data).
const SIGNER_SEED_HEX = '42'.repeat(32);

interface VectorsFile {
  meta: { format: string; note: string };
  canonicalize: Array<{ name: string; json: string; canonical: string }>;
  reject: Array<{ name: string; json: string; reason: string }>;
  hashes: Array<{ name: string; domain: string; json: string; sha256: string }>;
  ed25519: {
    seed_hex: string;
    public_key_b64: string;
    key_id: string;
    fingerprint: string;
    signatures: Array<{ name: string; domain: string; json: string; signature_b64: string }>;
  };
  logical_roots: Array<{ name: string; dataset_id: string; entries: LogicalRootEntry[]; root_hex: string }>;
}

// Raw-text inputs. The emoji-vs-U+FFFD key pair pins UTF-16 code-unit ordering:
// in UTF-16, U+1F600 is the surrogate pair d83d/de00 and d83d < fffd, so the emoji
// key sorts FIRST (code-point order would put U+FFFD first).
const CANONICALIZE_INPUTS: Array<{ name: string; json: string }> = [
  { name: 'key-sort-ascii', json: '{"b":1,"a":2}' },
  {
    name: 'nested-mixed',
    json: '{"z":[1,true,null,"x"],"a":{"nested":{"deep":[[]]},"empty":{}},"s":"h\\u00e9llo \\u2713"}',
  },
  { name: 'utf16-key-order', json: '{"\\ufffd":2,"\\ud83d\\ude00":1}' },
  { name: 'integer-bounds', json: '{"max":9007199254740991,"min":-9007199254740991,"zero":0}' },
  { name: 'empty-string-key', json: '{"":1,"a":2}' },
  {
    name: 'string-escapes',
    json: '{"controls":"\\u0000\\u0001\\u001f","five":"\\b\\f\\n\\r\\t","quote":"\\"\\\\","raw":"日本語"}',
  },
];

const REJECT_INPUTS: Array<{ name: string; json: string; reason: string }> = [
  { name: 'float', json: '{"a":1.5}', reason: 'non-integer number' },
  { name: 'exponent', json: '{"a":1e3}', reason: 'exponent form re-serializes differently (or float)' },
  { name: 'minus-zero', json: '{"a":-0}', reason: '-0 invalid' },
  { name: 'unsafe-integer', json: '{"a":9007199254740992}', reason: 'beyond 2^53-1' },
  { name: 'duplicate-key', json: '{"a":1,"a":2}', reason: 'duplicate keys invalid' },
  { name: 'whitespace', json: '{ "a": 1 }', reason: 'whitespace re-serializes differently' },
  { name: 'unsorted-keys', json: '{"b":1,"a":2}', reason: 'byte-verification requires sorted form' },
  { name: 'lone-surrogate', json: '{"a":"\\ud800"}', reason: 'lone surrogate invalid' },
];

const HASH_INPUTS: Array<{ name: string; domain: string; json: string }> = [
  {
    name: 'placement-mini',
    domain: DOMAIN_PLACEMENT,
    json: '{"datasetId":"ds-fixture","protocol":"formlogic-data-sync/1","storageEpoch":1}',
  },
  {
    name: 'operation-mini',
    domain: DOMAIN_OPERATION,
    json: '{"datasetId":"ds-fixture","kind":"response.create","sequence":1}',
  },
  {
    name: 'high-water',
    domain: DOMAIN_HIGH_WATER,
    json: '{"datasetId":"ds-fixture","lastAcknowledgedSequence":42,"storageEpoch":3,"v":1}',
  },
];

const SIGNATURE_INPUTS: Array<{ name: string; domain: string; json: string }> = [
  {
    name: 'operation-signed',
    domain: DOMAIN_OPERATION,
    json: '{"datasetId":"ds-fixture","kind":"response.create","sequence":1,"storageEpoch":1}',
  },
  {
    name: 'checkpoint-signed',
    domain: DOMAIN_CHECKPOINT,
    json: '{"datasetId":"ds-fixture","lastSequence":7,"logicalRoot":"' + 'ab'.repeat(32) + '","storageEpoch":1}',
  },
];

const LOGICAL_ROOT_INPUTS: Array<{ name: string; dataset_id: string; entries: LogicalRootEntry[] }> = [
  {
    name: 'mixed-entries',
    dataset_id: 'ds-fixture',
    entries: [
      ['response', '7d444840-9dc0-41a2-8da8-ff8cb9fca735', 2, 2, 'aa'.repeat(32)],
      ['response', '11111111-2222-4333-8444-555555555555', 1, 1, 'bb'.repeat(32)],
      ['tombstone', '99999999-8888-4777-a666-555555555555', 3, 'cc'.repeat(32)],
      ['artifact', 'manifest', 'man_1', 'dd'.repeat(32)],
      ['attachment', 'fil_fixture01', 'ee'.repeat(32)],
    ],
  },
  { name: 'empty-dataset', dataset_id: 'ds-empty', entries: [] },
];

async function buildVectors(): Promise<VectorsFile> {
  const sodium = await getSodium();
  const seed = fromHex(SIGNER_SEED_HEX);
  const pair = sodium.crypto_sign_seed_keypair(seed);
  const signatures = [] as VectorsFile['ed25519']['signatures'];
  for (const s of SIGNATURE_INPUTS) {
    signatures.push({
      name: s.name,
      domain: s.domain,
      json: s.json,
      signature_b64: await signStructure(s.domain, JSON.parse(s.json), pair.privateKey),
    });
  }
  const hashes = [] as VectorsFile['hashes'];
  for (const h of HASH_INPUTS) {
    hashes.push({ ...h, sha256: await domainHashHex(h.domain, JSON.parse(h.json)) });
  }
  const roots = [] as VectorsFile['logical_roots'];
  for (const r of LOGICAL_ROOT_INPUTS) {
    roots.push({ ...r, root_hex: await computeLogicalRootHex(r.dataset_id, r.entries) });
  }
  return {
    meta: {
      format: 'formlogic-data-vectors.1',
      note: 'Deterministic flcanon/1 + domain preimage + Ed25519 + logical-root vectors. '
        + 'Byte-identical across JS/PHP/Rust. Regenerate: FORMLOGIC_DATA_VECTORS_WRITE=1 '
        + 'npx vitest run src/lib/data/vectors.test.ts. Fixed test-only seed.',
    },
    canonicalize: CANONICALIZE_INPUTS.map((c) => ({ ...c, canonical: canonicalize(JSON.parse(c.json)) })),
    reject: REJECT_INPUTS,
    hashes,
    ed25519: {
      seed_hex: SIGNER_SEED_HEX,
      public_key_b64: toB64(pair.publicKey),
      key_id: await dataKeyId(pair.publicKey),
      fingerprint: await dataKeyFingerprint(pair.publicKey),
      signatures,
    },
    logical_roots: roots,
  };
}

function loadVectors(): VectorsFile {
  return JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8')) as VectorsFile;
}

describe('data-sync vectors (flcanon/1)', () => {
  it('writes or loads the committed vector file', async () => {
    if (WRITE_MODE) {
      const built = await buildVectors();
      fs.writeFileSync(VECTORS_PATH, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(fs.existsSync(VECTORS_PATH)).toBe(true);
  });

  it('canonicalize vectors round-trip', () => {
    const vectors = loadVectors();
    expect(vectors.canonicalize.length).toBeGreaterThanOrEqual(CANONICALIZE_INPUTS.length);
    for (const c of vectors.canonicalize) {
      expect(canonicalize(JSON.parse(c.json)), c.name).toBe(c.canonical);
    }
  });

  it('reject vectors never verify as canonical bytes', () => {
    const vectors = loadVectors();
    for (const r of vectors.reject) {
      let verifies = false;
      try {
        verifies = canonicalize(JSON.parse(r.json)) === r.json;
      } catch {
        verifies = false;
      }
      expect(verifies, `${r.name} (${r.reason})`).toBe(false);
    }
  });

  it('domain hash vectors match', async () => {
    const vectors = loadVectors();
    for (const h of vectors.hashes) {
      expect(await domainHashHex(h.domain, JSON.parse(h.json)), h.name).toBe(h.sha256);
    }
  });

  it('ed25519 identity and signatures match and stay domain-separated', async () => {
    const vectors = loadVectors();
    const sodium = await getSodium();
    const pair = sodium.crypto_sign_seed_keypair(fromHex(vectors.ed25519.seed_hex));
    expect(toB64(pair.publicKey)).toBe(vectors.ed25519.public_key_b64);
    expect(await dataKeyId(pair.publicKey)).toBe(vectors.ed25519.key_id);
    expect(await dataKeyFingerprint(pair.publicKey)).toBe(vectors.ed25519.fingerprint);
    expect(toHex(pair.publicKey).length).toBe(64);
    for (const s of vectors.ed25519.signatures) {
      const structure = JSON.parse(s.json) as Record<string, unknown>;
      expect(await signStructure(s.domain, structure, pair.privateKey), s.name).toBe(s.signature_b64);
      const signed = { ...structure, signature: s.signature_b64 };
      expect(await verifyStructure(s.domain, signed, pair.publicKey), `${s.name} verifies`).toBe(true);
      // A signature must not validate under another domain (docs/FORMLOGIC_DATA_NODES.md §2).
      const otherDomain = s.domain === DOMAIN_OPERATION ? DOMAIN_CHECKPOINT : DOMAIN_OPERATION;
      expect(await verifyStructure(otherDomain, signed, pair.publicKey), `${s.name} cross-domain`).toBe(false);
      // Nor after any field mutation.
      const tampered = { ...signed, sequence: 999999 };
      expect(await verifyStructure(s.domain, tampered, pair.publicKey), `${s.name} tampered`).toBe(false);
    }
  });

  it('logical root vectors match', async () => {
    const vectors = loadVectors();
    for (const r of vectors.logical_roots) {
      expect(await computeLogicalRootHex(r.dataset_id, r.entries), r.name).toBe(r.root_hex);
    }
  });
});
