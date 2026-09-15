/**
 * scripts/check-expression-parity.mjs over fixture legs: besides agreeing case
 * by case on one corpus, the two legs must name one ZIPP release, the one the
 * installed Softn release names when one is installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-expression-parity.mjs');
const ZIPP = { release: 'v0.0.18', revision: 'f'.repeat(40) };
const corpus = JSON.stringify({ version: 1, cases: [
  { id: 'sum', source: 'fixture', expression: '1 + 1', expect: { ok: true, value: 2 } },
  { id: 'zone', source: 'fixture', expression: 'new Date(0).getTimezoneOffset()', expect: { agree: true } },
] });
const corpusSha = createHash('sha256').update(corpus).digest('hex');

function leg(engine, zipp, { zone = '0' } = {}) {
  return {
    schemaVersion: 1,
    engine,
    engineDetail: zipp === undefined ? { host: engine } : { host: engine, zipp },
    corpus: { sha256: corpusSha },
    results: [{ id: 'sum', outcome: 'ok', canonical: '2' }, { id: 'zone', outcome: 'ok', canonical: zone }],
  };
}

async function run(t, { backend, browser, installed = ZIPP }) {
  const root = await mkdtemp(resolve(tmpdir(), 'formlogic-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  await write('docs/contracts/formlogic-expression-corpus.json', corpus);
  await write('test-results/parity/backend.json', backend);
  await write('test-results/parity/browser.json', browser);
  if (installed) await write('.runtime-source/softn-release/current.json', { tag: 'v0.0.15', zipp: { ...installed, version: installed.release.slice(1) } });
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

test('legs on the installed ZIPP release that agree pass, naming the release', async (t) => {
  const result = await run(t, { backend: leg('backend-formlogic-runtime', ZIPP), browser: leg('browser-zipp', { ...ZIPP, sha256: 'a'.repeat(64) }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /expression parity OK — 2 cases agree across 2 runtimes .* on ZIPP v0\.0\.18 \(ffffffffffff\)/);
});

test('legs on different ZIPP releases are refused before any case is compared', async (t) => {
  const result = await run(t, { backend: leg('backend-formlogic-runtime', { release: 'v0.0.17', revision: '1'.repeat(40) }), browser: leg('browser-zipp', ZIPP) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Legs did not run one ZIPP release/);
  assert.match(result.stderr, /backend\s+v0\.0\.17 1{40}/);
  assert.match(result.stderr, /browser\s+v0\.0\.18 f{40}/);
});

test('a leg that does not record its ZIPP release is refused', async (t) => {
  const result = await run(t, { backend: leg('backend-formlogic-runtime', null), browser: leg('browser-zipp', ZIPP) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\s+\(engineDetail\.zipp not recorded\)/);
  assert.match(result.stderr, /bin\/runtime\/SOURCE\.json, which must list the launcher it ran/);
  const absent = await run(t, { backend: leg('backend-formlogic-runtime', ZIPP), browser: leg('browser-zipp', undefined) });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /browser\s+\(engineDetail\.zipp not recorded\)/);
});

test('legs that agree with each other but not with the installed Softn release are refused; with none installed they pass', async (t) => {
  const other = { release: 'v0.0.19', revision: '2'.repeat(40) };
  const stale = await run(t, { backend: leg('backend-formlogic-runtime', other), browser: leg('browser-zipp', other) });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Legs did not run one ZIPP release, the installed Softn release's \(v0\.0\.18 f{40}\)/);
  const none = await run(t, { backend: leg('backend-formlogic-runtime', other), browser: leg('browser-zipp', other), installed: null });
  assert.equal(none.status, 0, none.stderr);
});

test('a case the legs disagree on still fails', async (t) => {
  const result = await run(t, { backend: leg('backend-formlogic-runtime', ZIPP, { zone: '-600' }), browser: leg('browser-zipp', ZIPP) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 case\(s\) DISAGREE across runtimes/);
});
