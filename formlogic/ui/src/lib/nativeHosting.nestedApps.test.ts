// An app a web app's page nests (`<softn-app src="assets/widgets/clock.softn">`): a .softn archive
// kept with the app's media. It was refused as a file of a kind this host cannot keep, so an app
// hosted here could nest none; and a media pack that held one would have been refused whole.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { NATIVE_LIMITS, exportNativeProject, importNativeProject, readMediaPackBytes, sourceNameProblem } from './nativeHosting';

const softn = (files: Record<string, string | Uint8Array>) =>
  new File([zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])))], 'board.softn');
const page = {
  'manifest.json': JSON.stringify({ name: 'Board', version: '1.0.0', engine: 2, main: 'index.html' }),
  'index.html': '<!doctype html><html><body><softn-app src="assets/widgets/clock.softn" style="display:block;height:240px"></softn-app></body></html>',
};
/** The nested app: an archive of its own, as SoftN packs one. */
const clock = zipSync({ 'index.html': strToU8('<!doctype html><p id="time">12:00</p>'), 'manifest.json': strToU8('{"name":"Clock","engine":2,"main":"index.html"}') });
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

describe('an app this one nests', () => {
  it('is kept under assets/ with the media, byte for byte, and comes back as it was from a download', async () => {
    const project = await importNativeProject(softn({ ...page, 'assets/widgets/clock.softn': clock, 'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }));
    expect(Object.keys(project.assets).sort()).toEqual(['assets/logo.png', 'assets/widgets/clock.softn']);
    expect(bytesOf(project.assets['assets/widgets/clock.softn'])).toEqual(clock);
    // Never a source file: no text the page or the runner reads.
    expect(Object.keys(project.files).sort()).toEqual(['index.html', 'manifest.json']);
    expect(sourceNameProblem('assets/widgets/clock.softn')).not.toBeNull();
    const again = await importNativeProject(new File([exportNativeProject(project) as BlobPart], 'again.softn'));
    expect(again.files).toEqual(project.files);
    expect(again.assets).toEqual(project.assets);
  });

  it('is moved under assets/ when it sits beside the page, and never advised there from the private tree', async () => {
    await expect(importNativeProject(softn({ ...page, 'widgets/clock.softn': clock }))).rejects.toThrow(
      'widgets/clock.softn is an app this one nests, which this host keeps with the app\'s media, under assets/. Move it to assets/widgets/clock.softn, have the page that runs it name it there (<softn-app src="/assets/widgets/clock.softn">), and try again.',
    );
    for (const path of ['backend/clock.softn', 'server/clock.softn', 'private/clock.softn', 'site/clock.softn']) {
      await expect(importNativeProject(softn({ ...page, [path]: clock })), path).rejects.toThrow(`${path} is a kind of file this host cannot keep with an app. Remove it from the project ZIP and try again.`);
    }
    // An archive kept as media is named as an app: a .zip under assets/ is not one.
    await expect(importNativeProject(softn({ ...page, 'assets/widgets/clock.zip': clock }))).rejects.toThrow('assets/widgets/clock.zip cannot be hosted with this app: its media can be');
    await expect(importNativeProject(softn({ ...page, 'assets/widgets/clock.zip': clock }))).rejects.toThrow('apps its page nests (SOFTN)');
  });

  it('is held to a media file\'s limit, and counts towards what the project holds', async () => {
    // 32 MB a file, as every media file is: half of what SoftN itself nests (64 MiB).
    await expect(importNativeProject(softn({ ...page, 'assets/widgets/big.softn': new Uint8Array(NATIVE_LIMITS.mediaFileBytes + 1) }))).rejects.toThrow(
      'assets/widgets/big.softn is larger than this host keeps (32 MB per media file).',
    );
    // Sources just under the project's 64 MB are kept; one small nested app more is over it.
    const styles = Object.fromEntries(Array.from({ length: 44 }, (_, i) => [`styles/s${i}.css`, 'a'.repeat(NATIVE_LIMITS.sourceFileBytes)]));
    await expect(importNativeProject(softn({ ...page, ...styles }))).resolves.toMatchObject({ version: 0 });
    await expect(importNativeProject(softn({ ...page, ...styles, 'assets/widgets/clock.softn': new Uint8Array(1_200_000) }))).rejects.toThrow('This app is 64.1 MB; this host keeps apps up to 64 MB.');
  }, 60_000);

  it('is read from the media pack the page fetches, which held none before', () => {
    const files: Array<[string, Uint8Array]> = [['assets/widgets/clock.softn', clock], ['assets/logo.png', new Uint8Array([1, 2, 3])]];
    let offset = 0;
    const header = strToU8(JSON.stringify({ files: files.map(([path, bytes]) => { const entry = { path, offset, size: bytes.length }; offset += bytes.length; return entry; }) }));
    const pack = new Uint8Array(12 + header.length + offset);
    pack.set(strToU8('FLMEDIA1'), 0);
    new DataView(pack.buffer).setUint32(8, header.length, false);
    pack.set(header, 12);
    let at = 12 + header.length;
    for (const [, bytes] of files) { pack.set(bytes, at); at += bytes.length; }
    const assets = readMediaPackBytes(pack.buffer);
    expect(Object.keys(assets)).toEqual(['assets/widgets/clock.softn', 'assets/logo.png']);
    expect(assets['assets/widgets/clock.softn']).toEqual(clock);
  });
});
