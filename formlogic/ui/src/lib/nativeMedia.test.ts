import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'fflate';

const mocks = vi.hoisted(() => ({ getNativeMediaPack: vi.fn(), getNativeMediaFile: vi.fn(), nativeMediaFileUrl: vi.fn() }));
vi.mock('./api', () => ({ api: { getNativeMediaPack: mocks.getNativeMediaPack, getNativeMediaFile: mocks.getNativeMediaFile, nativeMediaFileUrl: mocks.nativeMediaFileUrl } }));

import { fromBase64, keepUnchanged, pictureUrl, sha256Hex, toBase64, withMediaBytes } from './nativeMedia';
import { isKeptMedia, mediaSize, readOwnerMediaPack, type NativeProject } from './nativeHosting';

/** Bytes made up for a test: `length` of them, from `seed`. */
const bytesOf = (length: number, seed = 1) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256);
const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('');

/** A pack as the server writes its owner's one (NativeAppService::ownerMediaPack). */
async function packOf(files: Record<string, Uint8Array>): Promise<ArrayBuffer> {
  let offset = 0;
  const index = [];
  for (const [path, bytes] of Object.entries(files)) { index.push({ path, offset, size: bytes.length, kept: await hex(bytes) }); offset += bytes.length; }
  const header = strToU8(JSON.stringify({ files: index }));
  const out = new Uint8Array(12 + header.length + offset);
  out.set(strToU8('FLMEDIA1'), 0);
  new DataView(out.buffer).setUint32(8, header.length, false);
  out.set(header, 12);
  let at = 12 + header.length;
  for (const bytes of Object.values(files)) { out.set(bytes, at); at += bytes.length; }
  return out.buffer;
}

const project = (assets: NativeProject['assets']): NativeProject => ({ version: 3, files: { 'manifest.json': '{}' }, assets, access: 'application' });

beforeEach(() => { mocks.getNativeMediaPack.mockReset(); mocks.getNativeMediaFile.mockReset().mockResolvedValue(null); mocks.nativeMediaFileUrl.mockReset(); });

describe('base64 and SHA-256', () => {
  it('turns bytes into base64 and back, a large file and line breaks included', () => {
    const bytes = bytesOf(70_001);
    const text = toBase64(bytes);
    expect(text).toBe(Buffer.from(bytes).toString('base64'));
    expect(fromBase64(text)).toEqual(bytes);
    expect(fromBase64(text.replace(/(.{76})/g, '$1\r\n'))).toEqual(bytes);
    expect(toBase64(new Uint8Array())).toBe('');
  });

  it('hashes with the browser’s own SHA-256, and with libsodium’s where a page on plain HTTP has none', async () => {
    const abc = strToU8('abc');
    const known = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(await sha256Hex(abc)).toBe(known);
    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    try { expect(await sha256Hex(abc)).toBe(known); }
    finally { if (subtle) Object.defineProperty(globalThis.crypto, 'subtle', subtle); else delete (globalThis.crypto as { subtle?: unknown }).subtle; }
  });

  it('says how many bytes a media file is, named or in base64', () => {
    expect(mediaSize({ kept: 'a'.repeat(64), size: 1234 })).toBe(1234);
    for (const length of [0, 1, 2, 3, 4, 5, 1000]) expect(mediaSize(toBase64(bytesOf(length)))).toBe(length);
    expect(isKeptMedia({ kept: 'a'.repeat(64), size: 0 })).toBe(true);
    for (const odd of [null, 'text', {}, { kept: 'A'.repeat(64), size: 1 }, { kept: 'a'.repeat(63), size: 1 }, { kept: 'a'.repeat(64), size: -1 }, { kept: 'a'.repeat(64), size: 1.5 }]) expect(isKeptMedia(odd)).toBe(false);
  });
});

describe('readOwnerMediaPack', () => {
  it('finds each file by the SHA-256 its index names', async () => {
    const picture = bytesOf(500), model = bytesOf(9000, 7);
    const found = readOwnerMediaPack(await packOf({ 'assets/a.png': picture, 'site/x/model.glb': model, 'assets/empty.txt': new Uint8Array() }));
    expect(found.get(await hex(picture))).toEqual(picture);
    expect(found.get(await hex(model))).toEqual(model);
    expect(found.get(await hex(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('refuses what is not a whole pack', async () => {
    expect(() => readOwnerMediaPack(strToU8('not a pack at all').buffer as ArrayBuffer)).toThrow('could not be read');
    const whole = new Uint8Array(await packOf({ 'assets/a.png': bytesOf(500) }));
    expect(() => readOwnerMediaPack(whole.slice(0, whole.length - 1).buffer)).toThrow('runs past its end');
    // An index whose file is not named by a SHA-256.
    const header = strToU8(JSON.stringify({ files: [{ path: 'assets/a.png', offset: 0, size: 1, kept: 'nope' }] }));
    const unnamed = new Uint8Array(12 + header.length + 1);
    unnamed.set(strToU8('FLMEDIA1')); new DataView(unnamed.buffer).setUint32(8, header.length, false); unnamed.set(header, 12);
    expect(() => readOwnerMediaPack(unnamed.buffer)).toThrow('not named');
  });
});

describe('withMediaBytes', () => {
  it('reads nothing for a project that holds every file’s bytes', async () => {
    const whole = project({ 'assets/a.png': toBase64(bytesOf(10)) });
    expect(await withMediaBytes('app-1', whole)).toBe(whole);
    expect(mocks.getNativeMediaPack).not.toHaveBeenCalled();
  });

  it('gives each named file its bytes from the server’s pack, a renamed one by its bytes', async () => {
    const picture = bytesOf(500), sound = bytesOf(70_000, 3), added = bytesOf(40, 9);
    mocks.getNativeMediaPack.mockResolvedValue(await packOf({ 'assets/a.png': picture, 'assets/sound/b.mp3': sound }));
    const result = await withMediaBytes('app-1', project({
      'assets/a.png': { kept: await hex(picture), size: picture.length },
      'assets/renamed.mp3': { kept: await hex(sound), size: sound.length },
      'assets/new.bin': toBase64(added),
    }));
    expect(mocks.getNativeMediaPack).toHaveBeenCalledWith('app-1');
    expect(result.assets).toEqual({ 'assets/a.png': toBase64(picture), 'assets/renamed.mp3': toBase64(sound), 'assets/new.bin': toBase64(added) });
    expect(result.files).toEqual({ 'manifest.json': '{}' });
  });

  it('reads on its own a file the installed version no longer has, from wherever the server still has it', async () => {
    // A draft made before the app was changed elsewhere: its picture is an earlier version's.
    const earlier = bytesOf(12, 5);
    mocks.getNativeMediaPack.mockResolvedValue(await packOf({ 'assets/a.png': bytesOf(500) }));
    mocks.getNativeMediaFile.mockResolvedValue(earlier.slice().buffer);
    const result = await withMediaBytes('app-1', project({ 'assets/old.png': { kept: await hex(earlier), size: 12 } }));
    expect(mocks.getNativeMediaFile).toHaveBeenCalledWith('app-1', 'assets/old.png', await hex(earlier));
    expect(result.assets).toEqual({ 'assets/old.png': toBase64(earlier) });
  });

  it('says which file is not on the server any more, and never takes other bytes for it', async () => {
    mocks.getNativeMediaPack.mockResolvedValue(await packOf({ 'assets/a.png': bytesOf(500) }));
    const named = project({ 'assets/gone.png': { kept: await hex(bytesOf(12, 5)), size: 12 } });
    await expect(withMediaBytes('app-1', named)).rejects.toThrow('assets/gone.png is not on the server any more');
    mocks.getNativeMediaFile.mockResolvedValue(bytesOf(12, 6).buffer);
    await expect(withMediaBytes('app-1', named), 'bytes that are not the ones named').rejects.toThrow('assets/gone.png is not on the server any more');
    mocks.getNativeMediaFile.mockRejectedValue(new Error('The app’s media could not be downloaded. Check your connection and try again.'));
    await expect(withMediaBytes('app-1', named), 'a failure of another kind says what it was').rejects.toThrow('Check your connection');
  });

  it('passes on what the server said when the pack could not be had', async () => {
    mocks.getNativeMediaPack.mockRejectedValue(new Error('The app’s media could not be read. Try again in a moment.'));
    await expect(withMediaBytes('app-1', project({ 'assets/a.png': { kept: 'a'.repeat(64), size: 1 } }))).rejects.toThrow('could not be read');
  });
});

describe('keepUnchanged', () => {
  it('names each file the installed version has rather than sending it again', async () => {
    const picture = bytesOf(500), sound = bytesOf(70_000, 3), changed = bytesOf(500, 2), added = bytesOf(41, 9);
    const installed = project({ 'assets/a.png': { kept: await hex(picture), size: 500 }, 'assets/b.mp3': { kept: await hex(sound), size: 70_000 } });
    const draft = project({
      // As it was; moved to another name; the same name with other bytes of the same length; new.
      'assets/a.png': toBase64(picture),
      'assets/music/b.mp3': toBase64(sound),
      'assets/c.png': toBase64(changed),
      'assets/d.bin': toBase64(added),
      'assets/kept.png': { kept: await hex(picture), size: 500 },
    });
    const sent = await keepUnchanged(draft, installed);
    expect(sent.assets).toEqual({
      'assets/a.png': { kept: await hex(picture), size: 500 },
      'assets/music/b.mp3': { kept: await hex(sound), size: 70_000 },
      'assets/c.png': toBase64(changed),
      'assets/d.bin': toBase64(added),
      'assets/kept.png': { kept: await hex(picture), size: 500 },
    });
    expect(draft.assets['assets/a.png']).toBe(toBase64(picture));
    expect(sent.files).toBe(draft.files);
  });

  it('sends the project as it is where the server named nothing', async () => {
    const draft = project({ 'assets/a.png': toBase64(bytesOf(500)) });
    expect(await keepUnchanged(draft, null)).toBe(draft);
    expect(await keepUnchanged(draft, project({ 'assets/a.png': toBase64(bytesOf(500)) }))).toBe(draft);
    // Nothing the size of an installed file: nothing hashed, nothing changed.
    expect(await keepUnchanged(draft, project({ 'assets/x.png': { kept: 'b'.repeat(64), size: 7 } }))).toBe(draft);
  });
});

describe('pictureUrl', () => {
  it('shows a draft’s picture from its bytes and a named one from the server', () => {
    mocks.nativeMediaFileUrl.mockReturnValue('/api/apps/app-1/native/media?path=assets%2Fa.png&kept=abc');
    expect(pictureUrl('app-1', 'assets/a.svg', 'PHN2Zz4=')).toBe('data:image/svg+xml;base64,PHN2Zz4=');
    expect(pictureUrl('app-1', 'assets/a.png', { kept: 'c'.repeat(64), size: 9 })).toBe('/api/apps/app-1/native/media?path=assets%2Fa.png&kept=abc');
    expect(mocks.nativeMediaFileUrl).toHaveBeenCalledWith('app-1', 'assets/a.png', 'c'.repeat(64));
    expect(pictureUrl('app-1', 'assets/a.png', undefined)).toBe('');
    expect(pictureUrl('app-1', undefined, 'AAAA')).toBe('');
    mocks.nativeMediaFileUrl.mockReturnValue(null);
    expect(pictureUrl('app-1', 'assets/a.png', { kept: 'c'.repeat(64), size: 9 })).toBe('');
  });
});
