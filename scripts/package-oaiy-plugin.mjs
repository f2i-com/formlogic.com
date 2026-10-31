#!/usr/bin/env node
/**
 * Packages FormLogic Backups, the plugin for OAIY, for one operating system:
 *
 *   node scripts/package-oaiy-plugin.mjs --platform windows-x64 --binary <built program> [--out <dir>]
 *
 * A plugin package is a zip with manifest.json at its root (OAIY: plugins/install.rs). It holds one
 * program, so there is one zip per system, and the manifest is written here to name that program.
 * It has no package-manifest.json: OAIY quarantines a signature it has no pin for, and an unsigned
 * plugin is installed and trusted by hand.
 *
 * The zip is written here and not by a tool, because each system's tool records modes differently
 * and a Mac's program must arrive executable. Refuses a program built for the tests, which would
 * answer its own confirmations.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'formlogic', 'oaiy-plugin');

const PLATFORMS = {
  'windows-x64': { program: 'bin/formlogic-backups.exe' },
  macos: { program: 'bin/formlogic-backups' },
};

/** What only a test build holds: src/native/scripted.rs reads it. */
const TEST_BUILD_MARK = 'FORMLOGIC_BACKUPS_SCRIPTED';

export function pluginManifest(manifest, cargoToml, platform) {
  const target = PLATFORMS[platform];
  if (!target) throw new Error(`No package for ${platform}: choose one of ${Object.keys(PLATFORMS).join(', ')}.`);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
  if (manifest.version !== version) throw new Error(`manifest.json says ${manifest.version} and Cargo.toml says ${version}.`);
  return { ...manifest, entry: { ...manifest.entry, command: target.program } };
}

export function refuseTestBuild(program) {
  if (program.includes(TEST_BUILD_MARK)) throw new Error('This program was built with scripted-dialogs. It would answer its own confirmations.');
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A zip of `{name, bytes, mode}`, made on no particular system: every entry records its Unix mode. */
export function zipOf(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes, mode } of entries) {
    const packed = deflateRawSync(bytes, { level: 9 });
    const fileName = Buffer.from(name, 'utf8');
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // version needed
    common.writeUInt16LE(0x0800, 2); // names are UTF-8
    common.writeUInt16LE(8, 4); // deflate
    common.writeUInt16LE(0, 6); // no time: the same input makes the same zip
    common.writeUInt16LE(33, 8); // 1980-01-01
    common.writeUInt32LE(crc32(bytes), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(bytes.length, 18);
    common.writeUInt16LE(fileName.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), common, fileName]);
    parts.push(local, packed);

    const centralTail = Buffer.alloc(14);
    centralTail.writeUInt16LE(0, 0); // comment
    centralTail.writeUInt16LE(0, 2); // disk
    centralTail.writeUInt16LE(0, 4); // internal attributes
    centralTail.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 6); // regular file, this mode
    centralTail.writeUInt32LE(offset, 10);
    const madeBy = Buffer.alloc(2);
    madeBy.writeUInt16LE((3 << 8) | 20, 0); // Unix
    central.push(Buffer.concat([Buffer.from('PK\x01\x02', 'latin1'), madeBy, common, centralTail, fileName]));
    offset += local.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(18);
  end.writeUInt16LE(0, 0);
  end.writeUInt16LE(0, 2);
  end.writeUInt16LE(entries.length, 4);
  end.writeUInt16LE(entries.length, 6);
  end.writeUInt32LE(directory.length, 8);
  end.writeUInt32LE(offset, 12);
  end.writeUInt16LE(0, 16);
  return Buffer.concat([...parts, directory, Buffer.from('PK\x05\x06', 'latin1'), end]);
}

/** Every file of the package, the manifest first. */
export function packageEntries(platform, programBytes, read = (name) => readFileSync(path.join(pluginRoot, name))) {
  refuseTestBuild(programBytes);
  const manifest = pluginManifest(JSON.parse(read('manifest.json')), read('Cargo.toml').toString('utf8'), platform);
  const screens = manifest.ui.screens.flatMap((screen) => screen.files);
  return [
    { name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 },
    { name: manifest.entry.command, bytes: programBytes, mode: 0o755 },
    ...screens.map((name) => ({ name, bytes: read(name), mode: 0o644 })),
  ];
}

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = argument('platform');
  const binary = argument('binary');
  if (!platform || !binary) throw new Error('Give --platform and --binary.');
  const entries = packageEntries(platform, readFileSync(binary));
  const { version } = JSON.parse(entries[0].bytes);
  const out = path.resolve(argument('out') ?? path.join(repoRoot, 'dist-oaiy-plugin'));
  mkdirSync(out, { recursive: true });
  const zipPath = path.join(out, `formlogic-backups-${version}-${platform}.zip`);
  const zip = zipOf(entries);
  writeFileSync(zipPath, zip);
  console.log(`${zipPath} (${zip.length} bytes, sha256 ${createHash('sha256').update(zip).digest('hex')})`);
}
