// Cross-language vector suite (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P1).
//
// Two fixture families, mirroring docs/contracts/e2e-envelope-vectors.json discipline:
//  - e2ee-envelope-vectors.json  — deterministic KATs (Argon2id, XChaCha AAD matrix,
//    crypto_kdf, recovery-kit encode/decode). Byte-identical across JS/PHP.
//  - e2ee-sealed-js.json / e2ee-sealed-php.json — sealed-box fixtures. Sealing is
//    RANDOMIZED by construction (fresh ephemeral key per seal), so each side only ever
//    OPENS the other side's committed fixtures; there are no byte-identical seal vectors.
//
// Regenerate the JS-written files with:
//   FORMLOGIC_E2EE_VECTORS_WRITE=1 npx vitest run src/lib/crypto/vectors.test.ts
// The PHP mirror is written by: php backend/bin/e2ee-vectors-write.php

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSodium } from './sodium';
import { fromB64, fromHex, toB64, toHex, utf8Bytes, utf8String } from './encoding';
import {
  buildAad, openEnvelope, sealEnvelope, type InnerPayload, type ResponseEnvelope,
} from './envelope';
import { decodeRecoveryKey, encodeRecoveryKey } from './vault';

const CONTRACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/contracts',
);
const VECTORS_PATH = path.join(CONTRACTS_DIR, 'e2ee-envelope-vectors.json');
const SEALED_JS_PATH = path.join(CONTRACTS_DIR, 'e2ee-sealed-js.json');
const SEALED_PHP_PATH = path.join(CONTRACTS_DIR, 'e2ee-sealed-php.json');
const WRITE_MODE = process.env.FORMLOGIC_E2EE_VECTORS_WRITE === '1';

// Fixed test-only seeds (never key material for real data).
const RECIPIENT_SEED = new Uint8Array(32).fill(0x40);
const INGESTION_SEED = new Uint8Array(32).fill(0x41);

const FIXED_ENVELOPE_PARAMS = {
  formId: 'form-e2ee-fixture',
  recordId: '7d444840-9dc0-41a2-8da8-ff8cb9fca735',
  rev: 1,
  keyId: 'fik_fixture01',
  epoch: 1,
  schemaVersion: 1,
  schemaHash: 'a'.repeat(64),
};
const FIXED_INNER: InnerPayload = {
  v: 1,
  answers: { field_name: 'Ada Lovelace', field_notes: 'E2EE fixture — do not change' },
  meta: { completionTime: 42, language: 'en' },
};

interface VectorsFile {
  meta: { format: string; note: string };
  argon2id: Array<{ password: string; salt_hex: string; opslimit: number; memlimit: number; out_hex: string }>;
  xchacha: Array<{ key_hex: string; nonce_hex: string; aad: string; plaintext_b64: string; ct_b64: string; badAads: string[] }>;
  kdf: Array<{ key_hex: string; subkey_id: number; context: string; out_hex: string }>;
  recovery: Array<{ key_hex: string; display: string }>;
  envelopeAad: Array<{ params: typeof FIXED_ENVELOPE_PARAMS & { attachments?: string[] }; aad: string }>;
}

interface SealedFile {
  meta: { writer: string; recipient_seed_hex: string; note: string };
  recipient: { publicKey_b64: string };
  items: Array<{ label: string; plaintext_b64: string; sealed_b64: string }>;
  envelope?: {
    formId: string;
    ingestion_seed_hex: string;
    ingestionPublicKey_b64: string;
    envelope: ResponseEnvelope;
    expectedInner: InnerPayload;
  };
}

async function buildVectors(): Promise<VectorsFile> {
  const sodium = await getSodium();
  const argonInputs = [
    { password: 'formlogic vector passphrase', salt_hex: '000102030405060708090a0b0c0d0e0f', opslimit: 2, memlimit: 8 * 1024 * 1024 },
    { password: 'correct horse battery staple 🐴', salt_hex: 'f0e0d0c0b0a090807060504030201000', opslimit: 3, memlimit: 64 * 1024 * 1024 },
  ];
  const argon2id = argonInputs.map((v) => ({
    ...v,
    out_hex: toHex(sodium.crypto_pwhash(
      32, utf8Bytes(v.password), fromHex(v.salt_hex), v.opslimit, v.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    )),
  }));

  const goodAad = 'flenc:1|form-a|7d444840-9dc0-41a2-8da8-ff8cb9fca735|1|fik_v1|1|1|' + 'b'.repeat(64) + '|-';
  const xchachaInputs = [
    {
      key_hex: '11'.repeat(32),
      nonce_hex: '22'.repeat(24),
      aad: goodAad,
      plaintext: '{"v":1,"answers":{"q":"vector"}}',
      badAads: [
        goodAad.replace('|1|fik_v1|', '|2|fik_v1|'), // rev flip
        goodAad.replace('form-a', 'form-b'),          // form swap
        goodAad.replace('|-', '|' + 'c'.repeat(64)),  // attachment hash injected
        '',
      ],
    },
    {
      key_hex: 'a3'.repeat(32),
      nonce_hex: '5c'.repeat(24),
      aad: 'flvault-umk:1|user-vector-1',
      plaintext: 'vault unit vector payload',
      badAads: ['flvault-umk:1|user-vector-2', 'flvault-umk:2|user-vector-1'],
    },
  ];
  const xchacha = xchachaInputs.map((v) => ({
    key_hex: v.key_hex,
    nonce_hex: v.nonce_hex,
    aad: v.aad,
    plaintext_b64: toB64(utf8Bytes(v.plaintext)),
    ct_b64: toB64(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      utf8Bytes(v.plaintext), v.aad, null, fromHex(v.nonce_hex), fromHex(v.key_hex),
    )),
    badAads: v.badAads,
  }));

  const kdfInputs = [
    { key_hex: '42'.repeat(32), subkey_id: 1, context: 'flrecov1' },
    { key_hex: '9d'.repeat(32), subkey_id: 7, context: 'flrecov1' },
  ];
  const kdf = kdfInputs.map((v) => ({
    ...v,
    out_hex: toHex(sodium.crypto_kdf_derive_from_key(32, v.subkey_id, v.context, fromHex(v.key_hex))),
  }));

  const recoveryKeys = ['00'.repeat(32), 'ff'.repeat(32), '0123456789abcdef'.repeat(4)];
  const recovery = await Promise.all(recoveryKeys.map(async (key_hex) => ({
    key_hex,
    display: await encodeRecoveryKey(fromHex(key_hex)),
  })));

  const aadParams = [
    { ...FIXED_ENVELOPE_PARAMS },
    { ...FIXED_ENVELOPE_PARAMS, rev: 3, attachments: ['fil_b2', 'fil_a1'] },
  ];
  const envelopeAad = await Promise.all(aadParams.map(async (params) => ({
    params,
    aad: await buildAad(params),
  })));

  return {
    meta: {
      format: 'formlogic-e2ee-vectors.1',
      note: 'Deterministic KATs shared by vitest + phpunit. recovery/envelopeAad sections are client-only (PHP never builds AADs or recovery kits). Regenerate: FORMLOGIC_E2EE_VECTORS_WRITE=1 vitest run src/lib/crypto/vectors.test.ts',
    },
    argon2id, xchacha, kdf, recovery, envelopeAad,
  };
}

async function buildSealedJs(): Promise<SealedFile> {
  const sodium = await getSodium();
  const recipient = sodium.crypto_box_seed_keypair(RECIPIENT_SEED);
  const plaintexts = [
    'formlogic e2ee sealed fixture 1',
    '{"v":1,"answers":{"a":"€ unicode ✓"}}',
    '', // empty message must round-trip too
  ];
  const items = plaintexts.map((p, i) => ({
    label: `js-item-${i + 1}`,
    plaintext_b64: toB64(utf8Bytes(p)),
    sealed_b64: toB64(sodium.crypto_box_seal(utf8Bytes(p), recipient.publicKey)),
  }));
  const ingestion = sodium.crypto_box_seed_keypair(INGESTION_SEED);
  const envelope = await sealEnvelope(FIXED_ENVELOPE_PARAMS, FIXED_INNER, ingestion.publicKey);
  return {
    meta: {
      writer: 'vitest',
      recipient_seed_hex: toHex(RECIPIENT_SEED),
      note: 'Sealed-box fixtures written by JS, opened by PHP (and JS self-check). Sealing is randomized; only OPEN these.',
    },
    recipient: { publicKey_b64: toB64(recipient.publicKey) },
    items,
    envelope: {
      formId: FIXED_ENVELOPE_PARAMS.formId,
      ingestion_seed_hex: toHex(INGESTION_SEED),
      ingestionPublicKey_b64: toB64(ingestion.publicKey),
      envelope,
      expectedInner: FIXED_INNER,
    },
  };
}

describe('e2ee cross-language vectors', () => {
  it('writes fixtures in write mode', async () => {
    if (!WRITE_MODE) return;
    fs.mkdirSync(CONTRACTS_DIR, { recursive: true });
    fs.writeFileSync(VECTORS_PATH, JSON.stringify(await buildVectors(), null, 2) + '\n');
    fs.writeFileSync(SEALED_JS_PATH, JSON.stringify(await buildSealedJs(), null, 2) + '\n');
    expect(fs.existsSync(VECTORS_PATH)).toBe(true);
  });

  it('asserts every deterministic KAT byte-identically', async () => {
    if (WRITE_MODE) return;
    expect(fs.existsSync(VECTORS_PATH), 'run FORMLOGIC_E2EE_VECTORS_WRITE=1 first').toBe(true);
    const sodium = await getSodium();
    const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf-8')) as VectorsFile;

    for (const v of vectors.argon2id) {
      const out = sodium.crypto_pwhash(
        32, utf8Bytes(v.password), fromHex(v.salt_hex), v.opslimit, v.memlimit,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
      expect(toHex(out)).toBe(v.out_hex);
    }

    for (const v of vectors.xchacha) {
      const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        fromB64(v.plaintext_b64), v.aad, null, fromHex(v.nonce_hex), fromHex(v.key_hex),
      );
      expect(toB64(ct)).toBe(v.ct_b64);
      const opened = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, fromB64(v.ct_b64), v.aad, fromHex(v.nonce_hex), fromHex(v.key_hex),
      );
      expect(toB64(opened)).toBe(v.plaintext_b64);
      for (const bad of v.badAads) {
        expect(() => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null, fromB64(v.ct_b64), bad, fromHex(v.nonce_hex), fromHex(v.key_hex),
        ), `bad AAD must fail: ${bad}`).toThrow();
      }
    }

    for (const v of vectors.kdf) {
      const out = sodium.crypto_kdf_derive_from_key(32, v.subkey_id, v.context, fromHex(v.key_hex));
      expect(toHex(out)).toBe(v.out_hex);
    }

    for (const v of vectors.recovery) {
      expect(await encodeRecoveryKey(fromHex(v.key_hex))).toBe(v.display);
      expect(toHex(await decodeRecoveryKey(v.display))).toBe(v.key_hex);
    }

    for (const v of vectors.envelopeAad) {
      expect(await buildAad(v.params)).toBe(v.aad);
    }
  });

  it('opens the committed JS-sealed fixtures (self-check) and the full envelope', async () => {
    if (WRITE_MODE) return;
    expect(fs.existsSync(SEALED_JS_PATH)).toBe(true);
    const sodium = await getSodium();
    const file = JSON.parse(fs.readFileSync(SEALED_JS_PATH, 'utf-8')) as SealedFile;
    const recipient = sodium.crypto_box_seed_keypair(fromHex(file.meta.recipient_seed_hex));
    expect(toB64(recipient.publicKey)).toBe(file.recipient.publicKey_b64);
    for (const item of file.items) {
      const opened = sodium.crypto_box_seal_open(
        fromB64(item.sealed_b64), recipient.publicKey, recipient.privateKey,
      );
      expect(toB64(opened)).toBe(item.plaintext_b64);
    }
    const envFix = file.envelope;
    expect(envFix).toBeDefined();
    if (!envFix) return;
    const ingestion = sodium.crypto_box_seed_keypair(fromHex(envFix.ingestion_seed_hex));
    const inner = await openEnvelope(envFix.envelope, envFix.formId, ingestion.publicKey, ingestion.privateKey);
    expect(inner).toEqual(envFix.expectedInner);
  });

  it('opens the PHP-sealed fixtures (PHP-seal -> JS-open interop)', async () => {
    if (WRITE_MODE) return;
    expect(fs.existsSync(SEALED_PHP_PATH), 'run php backend/bin/e2ee-vectors-write.php first').toBe(true);
    const sodium = await getSodium();
    const file = JSON.parse(fs.readFileSync(SEALED_PHP_PATH, 'utf-8')) as SealedFile;
    const recipient = sodium.crypto_box_seed_keypair(fromHex(file.meta.recipient_seed_hex));
    for (const item of file.items) {
      const opened = sodium.crypto_box_seal_open(
        fromB64(item.sealed_b64), recipient.publicKey, recipient.privateKey,
      );
      expect(utf8String(opened)).toBe(utf8String(fromB64(item.plaintext_b64)));
    }
  });

  it('rejects the malformed corpus derived from the committed envelope', async () => {
    if (WRITE_MODE) return;
    const sodium = await getSodium();
    const file = JSON.parse(fs.readFileSync(SEALED_JS_PATH, 'utf-8')) as SealedFile;
    const fix = file.envelope;
    if (!fix) throw new Error('fixture missing envelope');
    const ingestion = sodium.crypto_box_seed_keypair(fromHex(fix.ingestion_seed_hex));
    const open = (env: ResponseEnvelope, formId = fix.formId) =>
      openEnvelope(env, formId, ingestion.publicKey, ingestion.privateKey);
    const base = fix.envelope;

    await expect(open({ ...base, rev: base.rev + 1 })).rejects.toThrow();          // rev replay/flip
    await expect(open({ ...base, epoch: 2 })).rejects.toThrow();                    // epoch flip
    await expect(open({ ...base, schemaVersion: 9 })).rejects.toThrow();            // schema version flip
    await expect(open({ ...base, schemaHash: 'b'.repeat(64) })).rejects.toThrow();  // schema hash flip
    await expect(open({ ...base, attachments: ['fil_evil1'] })).rejects.toThrow();  // attachment injection
    await expect(open(base, 'other-form')).rejects.toThrow();                       // cross-form replay
    const ctBytes = fromB64(base.ct);
    const truncated = { ...base, ct: toB64(ctBytes.subarray(0, ctBytes.length - 4)) };
    await expect(open(truncated)).rejects.toThrow();                                // truncated ct
    const flipped = new Uint8Array(ctBytes);
    flipped[flipped.length - 1] ^= 0x01;                                            // corrupt the Poly1305 tag
    await expect(open({ ...base, ct: toB64(flipped) })).rejects.toThrow();
    await expect(open({ ...base, wrap: 'hpke-x25519.1' as never })).rejects.toThrow();     // unknown suite
    await expect(open({ ...base, answers: { q: 'smuggled' } } as never)).rejects.toThrow(); // plaintext smuggling
  });
});
