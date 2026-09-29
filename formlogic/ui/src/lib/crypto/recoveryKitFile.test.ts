// What the downloaded recovery-kit file says. Node environment: the round trip through
// decodeRecoveryKey uses the real libsodium (jsdom's realm breaks its instanceof checks).
// The DOM side — the Blob URL and the print view — is in recoveryKitFile.dom.test.ts.
import { describe, expect, it } from 'vitest';
import { fromHex } from './encoding';
import { decodeRecoveryKey, encodeRecoveryKey } from './vault';
import { recoveryKitFileName, recoveryKitSheet, recoveryKitText } from './recoveryKitFile';

// Local time on purpose: the file carries the user's own calendar date, in any time zone.
const CREATED = new Date(2026, 8, 29, 23, 59, 30);
const KEY = fromHex('7f'.repeat(32));

describe('recovery kit file', () => {
  it('carries the kit exactly as displayed, the date it was made, and a plain warning', async () => {
    const kit = await encodeRecoveryKey(KEY);
    const text = recoveryKitText(recoveryKitSheet(kit, CREATED));

    expect(text).toContain(`\n    ${kit}\n`);
    expect(text).toContain('Created: 2026-09-29');
    expect(text).toContain('Anyone who has this kit can open your encrypted vault.');
    expect(text).toContain('If you lose your vault passphrase AND this kit, your encrypted responses are gone for good.');
    expect(text).toContain('FormLogic cannot recover them for you.');
    expect(text).toContain('Do not email it to yourself.');
    expect(text).toContain('choose "Use recovery kit"');
    // The kit appears once — no second copy to be mistaken for another kit.
    expect(text.split(kit)).toHaveLength(2);
  });

  it('the kit line is the checksum-bearing FLRK1 form: it decodes back to the key, and a typo is caught', async () => {
    const kit = await encodeRecoveryKey(KEY);
    const text = recoveryKitText(recoveryKitSheet(kit, CREATED));

    const line = /^ {4}(FLRK1-\S+)$/m.exec(text)?.[1];
    expect(line).toBe(kit);
    // FLRK1 + 13 groups of four + the checksum group.
    expect(line!.split('-')).toHaveLength(15);
    expect([...await decodeRecoveryKey(line!)]).toEqual([...KEY]);

    const idx = 8;
    const typo = line!.slice(0, idx) + (line![idx] === 'A' ? 'B' : 'A') + line!.slice(idx + 1);
    await expect(decodeRecoveryKey(typo)).rejects.toMatchObject({ code: 'recovery_invalid' });
  });

  it('is plain text any editor opens: ASCII only, no markup', async () => {
    const text = recoveryKitText(recoveryKitSheet(await encodeRecoveryKey(KEY), CREATED));

    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    expect(text).not.toContain('<');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('names the file by the user\'s local calendar date, zero padded', async () => {
    const kit = await encodeRecoveryKey(KEY);

    expect(recoveryKitFileName(recoveryKitSheet(kit, CREATED))).toBe('formlogic-vault-recovery-kit-2026-09-29.txt');
    expect(recoveryKitFileName(recoveryKitSheet(kit, new Date(2026, 0, 5, 0, 5)))).toBe('formlogic-vault-recovery-kit-2026-01-05.txt');
  });
});
