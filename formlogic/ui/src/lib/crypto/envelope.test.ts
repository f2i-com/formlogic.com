import { describe, expect, it } from 'vitest';
import { getSodium } from './sodium';
import { fromB64, toB64, utf8Bytes } from './encoding';
import {
  attachmentsHash, buildAad, isEncryptedEnvelope, mintRecordId, openEnvelope,
  parseEnvelope, sealEnvelope, type InnerPayload,
} from './envelope';

const PARAMS = {
  formId: 'form-unit-1',
  recordId: '2a3c4d5e-1f2a-4b3c-8d5e-6f7a8b9c0d1e',
  rev: 1,
  keyId: 'fik_unit01',
  epoch: 1,
  schemaVersion: 2,
  schemaHash: 'd'.repeat(64),
};
const INNER: InnerPayload = { v: 1, answers: { name: 'Test Person', notes: 'héllo ✓' } };

describe('envelope', () => {
  it('round-trips seal -> open', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const env = await sealEnvelope(PARAMS, INNER, kp.publicKey);
    expect(env.__flenc).toBe(1);
    expect(fromB64(env.wrappedDek).length).toBe(80);
    expect(fromB64(env.nonce).length).toBe(24);
    const inner = await openEnvelope(env, PARAMS.formId, kp.publicKey, kp.privateKey);
    expect(inner).toEqual(INNER);
  });

  it('sorts attachments and binds them via attHash', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const env = await sealEnvelope(
      { ...PARAMS, attachments: ['fil_zz', 'fil_aa'] }, INNER, kp.publicKey,
    );
    expect(env.attachments).toEqual(['fil_aa', 'fil_zz']);
    // Same ids, either order -> same hash; different ids -> different hash.
    expect(await attachmentsHash(['fil_zz', 'fil_aa'])).toBe(await attachmentsHash(['fil_aa', 'fil_zz']));
    expect(await attachmentsHash(['fil_aa'])).not.toBe(await attachmentsHash(['fil_aa', 'fil_zz']));
    expect(await attachmentsHash([])).toBe('-');
    // Dropping the attachment list breaks the AAD -> open fails.
    const stripped = { ...env };
    delete stripped.attachments;
    await expect(openEnvelope(stripped, PARAMS.formId, kp.publicKey, kp.privateKey)).rejects.toThrow();
  });

  it('a fresh DEK + nonce per seal (no reuse across identical inputs)', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const a = await sealEnvelope(PARAMS, INNER, kp.publicKey);
    const b = await sealEnvelope(PARAMS, INNER, kp.publicKey);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.ct).not.toBe(b.ct);
  });

  it('validates params strictly', async () => {
    await expect(buildAad({ ...PARAMS, recordId: 'not-a-uuid' })).rejects.toThrow();
    await expect(buildAad({ ...PARAMS, keyId: 'bad id' })).rejects.toThrow();
    await expect(buildAad({ ...PARAMS, rev: 0 })).rejects.toThrow();
    await expect(buildAad({ ...PARAMS, schemaHash: 'short' })).rejects.toThrow();
    await expect(buildAad({ ...PARAMS, formId: 'pipe|injection' })).rejects.toThrow();
    await expect(buildAad({ ...PARAMS, attachments: ['no-prefix'] })).rejects.toThrow();
  });

  it('parseEnvelope rejects structural garbage', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const env = await sealEnvelope(PARAMS, INNER, kp.publicKey);
    expect(() => parseEnvelope({ ...env, extra: 1 })).toThrow();               // unknown key
    expect(() => parseEnvelope({ ...env, answers: {} })).toThrow();            // plaintext smuggling
    expect(() => parseEnvelope({ ...env, __flenc: 2 })).toThrow();             // unknown version
    expect(() => parseEnvelope({ ...env, content: 'aes-gcm.1' })).toThrow();   // unknown suite
    expect(() => parseEnvelope({ ...env, nonce: toB64(new Uint8Array(12)) })).toThrow(); // wrong nonce len
    expect(() => parseEnvelope({ ...env, wrappedDek: toB64(new Uint8Array(72)) })).toThrow(); // 72B FK-wrap shape refused in v1
    expect(() => parseEnvelope('nope')).toThrow();
  });

  it('detects the __flenc marker on objects and JSON strings', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const env = await sealEnvelope(PARAMS, INNER, kp.publicKey);
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(isEncryptedEnvelope(JSON.stringify(env))).toBe(true);
    expect(isEncryptedEnvelope({ name: 'plain answers' })).toBe(false);
    expect(isEncryptedEnvelope('{"name":"plain"}')).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
  });

  it('rejects oversized inner payloads before sealing', async () => {
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    const big: InnerPayload = { v: 1, answers: { blob: 'x'.repeat(1_500_000) } };
    await expect(sealEnvelope(PARAMS, big, kp.publicKey)).rejects.toMatchObject({ code: 'payload_too_large' });
  });

  it('mintRecordId produces valid v4 uuids from 16 random bytes', async () => {
    const sodium = await getSodium();
    const id = mintRecordId(sodium.randombytes_buf(16));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() => mintRecordId(utf8Bytes('short'))).toThrow();
  });
});
