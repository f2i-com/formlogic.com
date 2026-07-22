import { describe, expect, it } from 'vitest';
import { getSodium } from './sodium';
import { fromHex, toHex } from './encoding';
import {
  DEFAULT_KDF_MEMLIMIT, DEFAULT_KDF_OPSLIMIT, assertPassphraseStrength, decodeRecoveryKey, derivePuk,
  deriveRecoveryWrapKey, encodeRecoveryKey, generateVault, openBundle, recoveryAad,
  umkAad, unwrapKey, wrapKey,
} from './vault';

const USER_ID = 'user-vault-test-1';
const PASSPHRASE = 'a long and honest vault passphrase';

describe('vault', () => {
  it('generateVault -> passphrase unlock -> bundle opens with verified public keys', async () => {
    const vault = await generateVault(PASSPHRASE, USER_ID);
    expect(vault.recoveryDisplay).toMatch(/^FLRK1-([A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);

    const puk = await derivePuk(PASSPHRASE, vault.kdf);
    const umk = await unwrapKey(vault.wrappedUmk, puk, umkAad(USER_ID));
    const bundle = await openBundle(vault.encKeyBundle, umk, USER_ID, {
      x25519Pk: vault.x25519Pk,
      ed25519Pk: vault.ed25519Pk,
    });
    expect(bundle.x25519Sk.length).toBe(32);
    expect(bundle.ed25519Sk.length).toBe(64);
  }, 30_000);

  it('wrong passphrase fails closed; tampered bundle fails closed', async () => {
    const vault = await generateVault(PASSPHRASE, USER_ID);
    const badPuk = await derivePuk('wrong passphrase entirely', vault.kdf);
    await expect(unwrapKey(vault.wrappedUmk, badPuk, umkAad(USER_ID)))
      .rejects.toMatchObject({ code: 'vault_unlock_failed' });

    const puk = await derivePuk(PASSPHRASE, vault.kdf);
    const umk = await unwrapKey(vault.wrappedUmk, puk, umkAad(USER_ID));
    const tampered = new Uint8Array(vault.encKeyBundle);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(openBundle(tampered, umk, USER_ID, {
      x25519Pk: vault.x25519Pk, ed25519Pk: vault.ed25519Pk,
    })).rejects.toMatchObject({ code: 'vault_unlock_failed' });
  }, 60_000);

  it('stored-pubkey mismatch is vault_corrupt (re-derived keys are verified)', async () => {
    const sodium = await getSodium();
    const vault = await generateVault(PASSPHRASE, USER_ID);
    const puk = await derivePuk(PASSPHRASE, vault.kdf);
    const umk = await unwrapKey(vault.wrappedUmk, puk, umkAad(USER_ID));
    const swapped = sodium.crypto_box_keypair().publicKey;
    await expect(openBundle(vault.encKeyBundle, umk, USER_ID, {
      x25519Pk: swapped, ed25519Pk: vault.ed25519Pk,
    })).rejects.toMatchObject({ code: 'vault_corrupt' });
  }, 30_000);

  it('recovery kit round-trips and unlocks the UMK; checksum catches typos pre-KDF', async () => {
    const sodium = await getSodium();
    const vault = await generateVault(PASSPHRASE, USER_ID);

    const recovered = await decodeRecoveryKey(vault.recoveryDisplay);
    const wrapKeyBytes = await deriveRecoveryWrapKey(recovered);
    const umk = await unwrapKey(vault.wrappedUmkRecovery, wrapKeyBytes, recoveryAad(USER_ID));
    expect(umk.length).toBe(32);
    // The recovered UMK opens the bundle too.
    const bundle = await openBundle(vault.encKeyBundle, umk, USER_ID, {
      x25519Pk: vault.x25519Pk, ed25519Pk: vault.ed25519Pk,
    });
    expect(toHex(sodium.crypto_scalarmult_base(bundle.x25519Sk))).toBe(toHex(vault.x25519Pk));

    // Flip one body character -> checksum failure, typed recovery_invalid.
    const display = vault.recoveryDisplay;
    const idx = 8; // inside the first body group
    const flipped = display.slice(0, idx) + (display[idx] === 'A' ? 'B' : 'A') + display.slice(idx + 1);
    await expect(decodeRecoveryKey(flipped)).rejects.toMatchObject({ code: 'recovery_invalid' });
    await expect(decodeRecoveryKey('FLRK1-AAAA')).rejects.toMatchObject({ code: 'recovery_invalid' });
    await expect(decodeRecoveryKey('NOPE0-' + display.slice(6))).rejects.toMatchObject({ code: 'recovery_invalid' });
  }, 30_000);

  it('recovery display tolerates lowercase and missing hyphens', async () => {
    const key = fromHex('7f'.repeat(32));
    const display = await encodeRecoveryKey(key);
    const sloppy = display.toLowerCase().replace(/-/g, ' ');
    expect(toHex(await decodeRecoveryKey(sloppy))).toBe('7f'.repeat(32));
  });

  it('refuses KDF parameters below the launch floor (downgrade guard)', async () => {
    const sodium = await getSodium();
    await expect(derivePuk(PASSPHRASE, {
      kdf: 'argon2id13.1',
      salt: sodium.randombytes_buf(16),
      opslimit: DEFAULT_KDF_OPSLIMIT - 1,
      memlimit: DEFAULT_KDF_MEMLIMIT,
    })).rejects.toMatchObject({ code: 'vault_corrupt' });
    await expect(derivePuk(PASSPHRASE, {
      kdf: 'argon2id13.1',
      salt: sodium.randombytes_buf(16),
      opslimit: DEFAULT_KDF_OPSLIMIT,
      memlimit: DEFAULT_KDF_MEMLIMIT - 1,
    })).rejects.toMatchObject({ code: 'vault_corrupt' });
  });

  it('AAD binds wraps to their slot and user', async () => {
    const sodium = await getSodium();
    const kek = sodium.randombytes_buf(32);
    const secret = sodium.randombytes_buf(32);
    const blob = await wrapKey(secret, kek, umkAad(USER_ID));
    await expect(unwrapKey(blob, kek, umkAad('someone-else'))).rejects.toMatchObject({ code: 'vault_unlock_failed' });
    await expect(unwrapKey(blob, kek, recoveryAad(USER_ID))).rejects.toMatchObject({ code: 'vault_unlock_failed' });
    expect(toHex(await unwrapKey(blob, kek, umkAad(USER_ID)))).toBe(toHex(secret));
  });

  it('enforces the 12-character passphrase floor (offline-attack resistance)', async () => {
    await expect(generateVault('eleven-chrs', USER_ID)).rejects.toMatchObject({ code: 'vault_invalid' });
    await expect(generateVault('twelve-chars', USER_ID)).resolves.toBeDefined();
    expect(() => assertPassphraseStrength('short')).toThrowError(/12 characters/);
    expect(() => assertPassphraseStrength('a long enough passphrase')).not.toThrow();
  }, 30_000);
});
