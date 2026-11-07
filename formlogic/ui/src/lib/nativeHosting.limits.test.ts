// The app page's import reads the server's limits first, so a file the server would refuse makes no
// app: the two must be the same numbers. And the media pack the server writes is read back whole.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { NATIVE_LIMITS, readMediaPack } from './nativeHosting';

const php = readFileSync(resolve(__dirname, '../../../backend/src/Services/NativeAppService.php'), 'utf8');
const constant = (name: string): number => {
  const match = new RegExp(`public const ${name} = ([0-9_ *]+);`).exec(php);
  if (!match) throw new Error(`NativeAppService has no ${name}`);
  return match[1].replace(/_/g, '').split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
};

describe('the import holds a project to the server’s limits', () => {
  it('names the same numbers as NativeAppService', () => {
    expect(NATIVE_LIMITS).toEqual({
      sourceFiles: constant('MAX_SOURCE_FILES'),
      sourceFileBytes: constant('MAX_SOURCE_FILE_BYTES'),
      mediaFiles: constant('MAX_MEDIA_FILES'),
      mediaFileBytes: constant('MAX_MEDIA_FILE_BYTES'),
      projectBytes: constant('MAX_PROJECT_BYTES'),
    });
  });
  it('takes a game’s hundreds of media files and tens of megabytes', () => {
    expect(NATIVE_LIMITS.mediaFiles).toBeGreaterThanOrEqual(334);
    expect(NATIVE_LIMITS.projectBytes).toBeGreaterThanOrEqual(17.5 * 1024 * 1024);
  });
});

/** A pack as NativeAppService::buildRuntimeCache writes one. */
function pack(files: Array<[string, Uint8Array]>, mangle?: (header: { files: Array<{ path: string; offset: number; size: number }> }) => void): ArrayBuffer {
  let offset = 0;
  const header = { files: files.map(([path, bytes]) => { const entry = { path, offset, size: bytes.length }; offset += bytes.length; return entry; }) };
  mangle?.(header);
  const json = strToU8(JSON.stringify(header));
  const out = new Uint8Array(12 + json.length + offset);
  out.set(strToU8('FLMEDIA1'), 0);
  new DataView(out.buffer).setUint32(8, json.length, false);
  out.set(json, 12);
  let at = 12 + json.length;
  for (const [, bytes] of files) { out.set(bytes, at); at += bytes.length; }
  return out.buffer;
}

describe('readMediaPack', () => {
  it('gives each file back in base64, byte for byte, an empty one included', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 7]);
    const big = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
    const assets = readMediaPack(pack([['assets/art/a.png', png], ['assets/audio/b.mp3', big], ['assets/empty.txt', new Uint8Array(0)]]));
    expect(Object.keys(assets)).toEqual(['assets/art/a.png', 'assets/audio/b.mp3', 'assets/empty.txt']);
    expect(Uint8Array.from(atob(assets['assets/art/a.png']), c => c.charCodeAt(0))).toEqual(png);
    expect(Uint8Array.from(atob(assets['assets/audio/b.mp3']), c => c.charCodeAt(0))).toEqual(big);
    expect(assets['assets/empty.txt']).toBe('');
  });
  it('refuses what is not a pack, a file past its end, and a path an app may not have', () => {
    expect(() => readMediaPack(strToU8('not a pack at all').buffer as ArrayBuffer)).toThrow(/not a media pack/);
    const file: Array<[string, Uint8Array]> = [['assets/a.png', new Uint8Array(4)]];
    expect(() => readMediaPack(pack(file, h => { h.files[0].size = 5; }))).toThrow(/past its end/);
    expect(() => readMediaPack(pack(file, h => { h.files[0].path = 'assets/../secret.png'; }))).toThrow(/not one an app may have/);
    expect(() => readMediaPack(pack(file, h => { h.files[0].path = 'assets/run.html'; }))).toThrow(/not one an app may have/);
    expect(() => readMediaPack(pack(file, h => { h.files[0].offset = -1; }))).toThrow(/not one an app may have/);
  });
});
