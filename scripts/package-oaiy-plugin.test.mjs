import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import { packageEntries, pluginManifest, refuseTestBuild, zipOf } from './package-oaiy-plugin.mjs';

const cargo = '[package]\nname = "formlogic-backups"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n';
const manifest = {
  id: 'formlogic-backups',
  version: '0.1.0',
  entry: { kind: 'process', command: 'bin/formlogic-backups', args: [] },
  ui: { screens: [{ id: 'backups', entry: 'ui/index.html', files: ['ui/index.html', 'ui/backups.js'] }] },
};

/** Reads a zip by its central directory, as an extractor does. */
function entriesOf(zip) {
  const end = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const found = [];
  for (let n = 0; n < count; n += 1) {
    assert.equal(zip.toString('latin1', at, at + 4), 'PK\x01\x02');
    const madeBy = zip.readUInt16LE(at + 4);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const attributes = zip.readUInt32LE(at + 38);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength;
    found.push({ name, madeBy: madeBy >> 8, mode: (attributes >>> 16) & 0o777, type: (attributes >>> 16) & 0o170000, bytes: inflateRawSync(zip.subarray(start, start + packedSize)) });
    at += 46 + nameLength;
  }
  return found;
}

test('a zip records each file and its Unix mode', () => {
  const zip = zipOf([
    { name: 'manifest.json', bytes: Buffer.from('{}'), mode: 0o644 },
    { name: 'bin/formlogic-backups', bytes: Buffer.alloc(100000, 7), mode: 0o755 },
  ]);
  const [first, second] = entriesOf(zip);
  assert.equal(first.name, 'manifest.json');
  assert.equal(first.mode, 0o644);
  assert.equal(second.name, 'bin/formlogic-backups');
  assert.equal(second.mode, 0o755, "a Mac's program must arrive executable");
  assert.equal(second.madeBy, 3, 'made on Unix, or an extractor ignores the mode');
  assert.equal(second.type, 0o100000, 'a regular file, not a link');
  assert.equal(second.bytes.length, 100000);
});

test('the same input makes the same zip', () => {
  const entries = [{ name: 'a', bytes: Buffer.from('a'), mode: 0o644 }];
  assert.deepEqual(zipOf(entries), zipOf(entries));
});

test('the manifest names the program of each system', () => {
  assert.equal(pluginManifest(manifest, cargo, 'windows-x64').entry.command, 'bin/formlogic-backups.exe');
  assert.equal(pluginManifest(manifest, cargo, 'macos').entry.command, 'bin/formlogic-backups');
  assert.throws(() => pluginManifest(manifest, cargo, 'linux-x64'), /No package/);
});

test('the manifest and the crate must agree on the version', () => {
  assert.throws(() => pluginManifest({ ...manifest, version: '0.2.0' }, cargo, 'macos'), /0\.2\.0/);
});

test('a program built for the tests is refused', () => {
  assert.throws(() => refuseTestBuild(Buffer.from('...FORMLOGIC_BACKUPS_SCRIPTED...')), /scripted-dialogs/);
  assert.doesNotThrow(() => refuseTestBuild(Buffer.from('a release build')));
});

test('a package holds the manifest, the program and the page, and no signature', () => {
  const files = { 'manifest.json': JSON.stringify(manifest), 'Cargo.toml': cargo, 'ui/index.html': '<main>', 'ui/backups.js': '1' };
  const entries = packageEntries('windows-x64', Buffer.from('program'), (name) => Buffer.from(files[name]));
  assert.deepEqual(entries.map((entry) => entry.name), ['manifest.json', 'bin/formlogic-backups.exe', 'ui/index.html', 'ui/backups.js']);
  assert.equal(JSON.parse(entries[0].bytes).entry.command, 'bin/formlogic-backups.exe');
});
