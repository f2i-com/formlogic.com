// A private form served without its encryption block.
//
// Private mode cannot be turned off, and this browser pins a form's signer only
// when it has sealed a submission to that form. So a pinned form that arrives as
// an ordinary one was stripped of its encryption on the way, and the public page
// would have submitted the answers in the clear: it read `encryption.mode` from
// what the server served and nothing else.
import { describe, expect, it } from 'vitest';
import { pinSigner, servedWithoutItsEncryption } from './signerPins';

function memoryStorage(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => { held.set(key, String(value)); },
    removeItem: (key) => { held.delete(key); },
    clear: () => held.clear(),
    key: (index) => Array.from(held.keys())[index] ?? null,
    get length() { return held.size; },
  } as Storage;
}

describe('servedWithoutItsEncryption', () => {
  it('is true for a form this browser has sealed answers for, served as an ordinary form', () => {
    const storage = memoryStorage();
    pinSigner('form-1', 'c2lnbmVyLWtleQ==', storage);
    expect(servedWithoutItsEncryption({ id: 'form-1' }, storage)).toBe(true);
    expect(servedWithoutItsEncryption({ id: 'form-1', encryption: null }, storage)).toBe(true);
    expect(servedWithoutItsEncryption({ id: 'form-1', encryption: { mode: 'none' } }, storage)).toBe(true);
  });

  it('is false while the form is still served as private', () => {
    const storage = memoryStorage();
    pinSigner('form-1', 'c2lnbmVyLWtleQ==', storage);
    expect(servedWithoutItsEncryption({ id: 'form-1', encryption: { mode: 'private' } }, storage)).toBe(false);
  });

  it('is false for a form this browser never sealed anything for', () => {
    const storage = memoryStorage();
    pinSigner('form-1', 'c2lnbmVyLWtleQ==', storage);
    expect(servedWithoutItsEncryption({ id: 'form-2' }, storage)).toBe(false);
  });

  it('is false when the pins cannot be read: nothing is known, so nothing is claimed', () => {
    expect(servedWithoutItsEncryption({ id: 'form-1' }, null)).toBe(false);
  });
});
