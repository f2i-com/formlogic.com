import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadReleaseSigner, signReleaseManifest } from './release-signing.mjs';
import { readReleaseForVerification, verifyUploadedAsset } from './check-published-release.mjs';
import { checkReleaseRuntime } from './release-runtime.mjs';
import { writeRuntimeManifest } from '../formlogic/ui/scripts/hosted-runtime-artifact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const keys = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { FORMLOGIC_RELEASE_SIGNING_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temp = t => {
  const directory = mkdtempSync(join(tmpdir(), 'formlogic-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('official releases need no key; offline distribution can require a signature', () => {
  assert.equal(loadReleaseSigner({}), null);
  assert.throws(() => loadReleaseSigner({}, { requireSignature: true }), /signing is required/);
  assert.equal(loadReleaseSigner({}, { allowUnsigned: true }), null);
  for (const env of [{ GITHUB_ACTIONS: 'true' }, { GITHUB_REF_TYPE: 'tag' }]) {
    assert.equal(loadReleaseSigner(env), null);
  }
});

test('release verification resolves authenticated drafts before checking uploaded bytes', () => {
  const bytes = Buffer.from('draft ZIP fixture');
  const asset = { name: 'formlogic-2.0.0.zip', digest: 'sha256:' + hash(bytes), size: bytes.length };
  const run = (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['release', 'view', 'v2.0.0', '--repo', 'f2i-com/formlogic.com', '--json', 'tagName,assets']);
    return JSON.stringify({ tagName: 'v2.0.0', assets: [asset] });
  };
  verifyUploadedAsset(readReleaseForVerification('f2i-com/formlogic.com', 'v2.0.0', run), asset.name, bytes);
  assert.throws(() => readReleaseForVerification('f2i-com/formlogic.com', 'v2.0.0', () => JSON.stringify({ tagName: 'v1.0.0' })), /tag does not match/);
});

test('publishing requires GitHub to confirm the exact built ZIP', () => {
  const bytes = Buffer.from('local ZIP fixture');
  const asset = { name: 'formlogic-2.0.0.zip', digest: 'sha256:' + hash(bytes), size: bytes.length };
  verifyUploadedAsset({ assets: [asset] }, asset.name, bytes);
  for (const assets of [[], [asset, asset], [{ ...asset, digest: null }], [{ ...asset, size: 1 }]]) {
    assert.throws(() => verifyUploadedAsset({ assets }, asset.name, bytes), /not confirmed/);
  }
  assert.throws(() => verifyUploadedAsset({ assets: [asset] }, asset.name, Buffer.from('changed')), /not confirmed/);
});

test('validates key format and production public-key pin before building', () => {
  assert.throws(() => loadReleaseSigner({ FORMLOGIC_RELEASE_SIGNING_KEY_PEM: 'invalid' }), /Cannot load/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => loadReleaseSigner({ FORMLOGIC_RELEASE_SIGNING_KEY_PEM: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /must be Ed25519/);
  const env = keys();
  const signer = loadReleaseSigner(env);
  assert.ok(loadReleaseSigner({ ...env, GITHUB_ACTIONS: 'true' }));
  assert.throws(() => loadReleaseSigner({ ...env, FORMLOGIC_RELEASE_PUBLIC_KEY: 'wrong' }), /does not match/);
  assert.ok(loadReleaseSigner({ ...env, GITHUB_ACTIONS: 'true', FORMLOGIC_RELEASE_PUBLIC_KEY: signer.raw.toString('base64') }));
});

test('local PEM files produce the same signed envelope as CI PEM input', t => {
  const directory = temp(t);
  const env = keys();
  const keyPath = join(directory, 'test-only.pem');
  writeFileSync(keyPath, env.FORMLOGIC_RELEASE_SIGNING_KEY_PEM, { mode: 0o600 });
  const bytes = Buffer.from('{"version":"test"}\n');
  const signer = loadReleaseSigner(env);
  const envelope = signReleaseManifest(bytes, signer);
  assert.deepEqual(signReleaseManifest(bytes, loadReleaseSigner({ FORMLOGIC_RELEASE_SIGNING_KEY: keyPath })), envelope);
  assert.ok(verify(null, bytes, signer.publicKey, Buffer.from(envelope.signature, 'base64')));
  assert.equal(verify(null, Buffer.from('{}'), signer.publicKey, Buffer.from(envelope.signature, 'base64')), false);
});

test('explicit offline signature requirement stops the packager without credentials', t => {
  const directory = temp(t);
  const env = { ...process.env };
  delete env.FORMLOGIC_RELEASE_SIGNING_KEY;
  delete env.FORMLOGIC_RELEASE_SIGNING_KEY_PEM;
  const output = join(directory, 'output');
  const result = spawnSync(process.execPath, ['scripts/package-dist.mjs', '--require-signature', '--skip-ui-build', '--out', output], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /signing is required/);
  assert.equal(existsSync(output), false);
});

test('production PHP upgrader accepts Node signature and rejects modified or unsigned packages', t => {
  const directory = temp(t);
  const files = {};
  for (const path of ['index.html', 'api/public/index.php', 'api/vendor/autoload.php', 'api/database/schema.sql']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'test fixture');
    files[path] = hash('test fixture');
  }
  const bytes = Buffer.from(JSON.stringify({ version: 'test-only', files }));
  const signer = loadReleaseSigner(keys());
  writeFileSync(join(directory, 'manifest.json'), bytes);
  writeFileSync(join(directory, 'manifest.sig.json'), JSON.stringify(signReleaseManifest(bytes, signer)));
  const check = () => spawnSync(process.env.PHP_BINARY || 'php', ['scripts/test-fixtures/verify-production-package.php', directory, signer.raw.toString('base64')], { cwd: root, encoding: 'utf8' });
  let result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).integrity, 'signed');
  writeFileSync(join(directory, 'index.html'), 'changed');
  result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum/);
  writeFileSync(join(directory, 'index.html'), 'test fixture');
  writeFileSync(join(directory, 'manifest.json'), Buffer.concat([bytes, Buffer.from(' ')]));
  assert.match(check().stderr, /signature verification FAILED/);
  writeFileSync(join(directory, 'manifest.json'), bytes);
  rmSync(join(directory, 'manifest.sig.json'));
  assert.match(check().stderr, /unsigned/);
});

test('release runtime requires real JavaScript and matching ZIPP bytes, even with a valid manifest', async t => {
  const directory = temp(t);
  const expected = { version: 'test', sha256: hash('wasm fixture') };
  writeFileSync(join(directory, 'index.html'), '<script src="assets/main.js"></script>');
  await writeRuntimeManifest(directory, expected);
  await assert.rejects(checkReleaseRuntime(directory, expected), /JavaScript/);
  mkdirSync(join(directory, 'assets/core-runtime'), { recursive: true });
  writeFileSync(join(directory, 'assets/main.js'), 'console.log("fixture")');
  await writeRuntimeManifest(directory, expected);
  await assert.rejects(checkReleaseRuntime(directory, expected), /ZIPP binary/);
  writeFileSync(join(directory, 'assets/core-runtime/zipp_wasm_bg.wasm'), 'wasm fixture');
  await writeRuntimeManifest(directory, expected);
  await checkReleaseRuntime(directory, expected);
  writeFileSync(join(directory, 'assets/main.js'), 'changed');
  await assert.rejects(checkReleaseRuntime(directory, expected), /asset has changed/);
  writeFileSync(join(directory, 'assets/main.js.map'), '{}');
  await writeRuntimeManifest(directory, expected);
  await assert.rejects(checkReleaseRuntime(directory, expected), /source maps/);
});

test('fresh installer creates and verifies private hosted-app storage', t => {
  const directory = temp(t);
  mkdirSync(join(directory, 'api'));
  copyFileSync(join(root, 'formlogic/install.php'), join(directory, 'install.php'));
  const result = spawnSync(process.env.PHP_BINARY || 'php', ['-r',
    'define("FORMLOGIC_INSTALL_NO_RUN", true); require $argv[1]; echo json_encode(checkRequirements(), JSON_THROW_ON_ERROR);',
    join(directory, 'install.php')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const checks = JSON.parse(result.stdout).checks;
  assert.equal(checks['dir_api_storage_hosted-apps'].pass, true);
  assert.equal(existsSync(join(directory, 'api/storage/hosted-apps')), true);
});
