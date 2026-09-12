import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { checkRuntimeArtifact, installRuntimeArtifact, writeRuntimeManifest } from './hosted-runtime-artifact.mjs';

const identity = { version: '0.0.17', sha256: 'a'.repeat(64) };

async function fixture(t) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(resolve(base, 'formlogic-hosted-runtime-test-'));
  assert.equal(dirname(directory), base);
  assert.ok(basename(directory).startsWith('formlogic-hosted-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'assets'));
  await writeFile(resolve(directory, 'index.html'), '<script src="./assets/app.js"></script>');
  await writeFile(resolve(directory, 'assets/app.js'), 'export const ready = true;');
  await writeRuntimeManifest(directory, identity);
  return directory;
}

test('accepts a complete build with the same engine identity', async t => {
  const directory = await fixture(t);
  const manifest = await checkRuntimeArtifact(directory, identity);
  assert.deepEqual(manifest.zipp, identity);
  assert.deepEqual(Object.keys(manifest.files), ['assets/app.js', 'index.html']);
});

test('rejects a stale hosted build even when its index still exists', async t => {
  const directory = await fixture(t);
  await assert.rejects(checkRuntimeArtifact(directory, { ...identity, sha256: 'b'.repeat(64) }), /versions do not match/);
});

test('rejects incomplete or modified assets', async t => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'assets/app.js'), 'broken build');
  await assert.rejects(checkRuntimeArtifact(directory, identity), /asset has changed/);
  await rm(resolve(directory, 'assets/app.js'));
  await assert.rejects(checkRuntimeArtifact(directory, identity), /missing or stale/);
});

test('rejects obsolete hashed files left behind by a previous build', async t => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'assets/old-runtime.js'), 'obsolete');
  await assert.rejects(checkRuntimeArtifact(directory, identity), /missing or stale/);
});

test('copies and re-verifies a staged build when Windows locks directory rename', async t => {
  const staged = await fixture(t);
  const output = await fixture(t);
  await writeFile(resolve(output, 'assets/app.js'), 'old build');
  let moves = 0;
  await installRuntimeArtifact(staged, output, identity, async () => {
    moves++;
    throw Object.assign(new Error('Directory in use'), { code: 'EPERM' });
  });
  assert.equal(moves, 1);
  assert.equal(await readFile(resolve(output, 'assets/app.js'), 'utf8'), 'export const ready = true;');
  await checkRuntimeArtifact(output, identity);
});

test('does not hide unrelated filesystem failures behind the Windows fallback', async t => {
  const staged = await fixture(t);
  const output = await fixture(t);
  await assert.rejects(installRuntimeArtifact(staged, output, identity, async () => {
    throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' });
  }), /Disk unavailable/);
});
