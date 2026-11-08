// node --test scripts/publish-zipp.test.mjs
// The site's ZIPP folder a build publishes: the installed ZIPP's glue, torch package and record,
// in a folder named by its engine, each file held to its digest first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishZipp, zippFolderName } from './publish-zipp.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const GLUE = 'export default function init() {}\n';
const TORCH = 'torch package';
const ENGINE = 'a844efe3d7d0'.padEnd(64, '0');

function ui(t, { torchTree = true, glue = GLUE, torchRecorded = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-zipp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'vendor/zipp'), { recursive: true });
  writeFileSync(join(root, 'vendor/zipp/zipp_wasm.js'), glue);
  writeFileSync(join(root, 'vendor/zipp/SOURCE.json'), JSON.stringify({ release: 'v0.0.33', version: '0.0.33', sha256: ENGINE, glueSha256: sha256(GLUE), ...(torchRecorded ? { packages: { torch: { sha256: sha256(TORCH) } } } : {}) }));
  const torchAt = torchTree ? 'vendor/zipp-torch' : 'public/hosted-runtime/assets/core-runtime';
  mkdirSync(join(root, torchAt), { recursive: true });
  writeFileSync(join(root, torchAt, 'zipp_torch.wasm'), TORCH);
  return root;
}

test('publishes the glue, the torch package and the record in a folder named by the engine', (t) => {
  const root = ui(t);
  assert.deepEqual(publishZipp(root), { name: 'a844efe3d7d0', files: ['zipp_wasm.js', 'SOURCE.json', 'zipp_torch.wasm'] });
  const folder = join(root, 'dist/zipp/a844efe3d7d0');
  assert.equal(readFileSync(join(folder, 'zipp_wasm.js'), 'utf8'), GLUE);
  assert.equal(readFileSync(join(folder, 'zipp_torch.wasm'), 'utf8'), TORCH);
  assert.equal(JSON.parse(readFileSync(join(folder, 'SOURCE.json'), 'utf8')).sha256, ENGINE);
});

test("takes the torch package from the hosted runtime's verified copy where no torch tree is installed, and none where the release records none", (t) => {
  assert.deepEqual(publishZipp(ui(t, { torchTree: false })).files, ['zipp_wasm.js', 'SOURCE.json', 'zipp_torch.wasm']);
  assert.deepEqual(publishZipp(ui(t, { torchRecorded: false })).files, ['zipp_wasm.js', 'SOURCE.json']);
});

test('refuses a glue that is not the one the record names, and writes nothing', (t) => {
  const root = ui(t, { glue: 'export default function changed() {}\n' });
  assert.throws(() => publishZipp(root), /is not the glue SOURCE\.json records/);
  assert.equal(existsSync(join(root, 'dist/zipp')), false);
});

test("removes an earlier ZIPP's folder, and keeps the folder's own rules", (t) => {
  const root = ui(t);
  mkdirSync(join(root, 'dist/zipp/0123456789ab'), { recursive: true });
  writeFileSync(join(root, 'dist/zipp/.htaccess'), 'rules');
  publishZipp(root);
  assert.deepEqual(readdirSync(join(root, 'dist/zipp')).sort(), ['.htaccess', 'a844efe3d7d0']);
  assert.throws(() => zippFolderName({}), /no engine sha256/);
});
