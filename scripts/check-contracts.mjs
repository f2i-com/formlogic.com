#!/usr/bin/env node
/**
 * Cross-repository contract compatibility harness (audit FL-34).
 *
 * The formlogic and aokie repos each carry a copy of the shared contract
 * files under docs/contracts/ (connector contract, desktop-event schema,
 * plugin-manifest schema, settings schema, fixtures...). They are REQUIRED to
 * stay byte-identical — drift means the paired desktop/plugin builds disagree
 * about the wire contract. This harness:
 *
 *   1. fails LOUDLY if the sibling repo is missing (no silent self-skip);
 *   2. requires the known shared contract set to exist in BOTH repos;
 *   3. content-compares (sha256, CRLF-normalized — both repos check out with
 *      core.autocrlf, so raw working-tree bytes differ by checkout artifact
 *      while the committed blobs are identical) every file present in both
 *      contract trees, fixtures included;
 *   4. parses every *.json on both sides (a truncated/merge-damaged contract
 *      fails even when both copies are identically broken);
 *   5. sanity-checks that *.schema.json files look like JSON Schema.
 *
 * The RUNTIME half of FL-34 — building the paired Desktop + plugin binaries
 * and exercising init/command/event/ack/shutdown — is the desktop full
 * `cargo test --features gui` run with a locally built plugin, which stays a
 * labelled MANUAL step (see CLAUDE.md rebuild recipes); this harness is the
 * automatable digest half.
 *
 * Usage:  node scripts/check-contracts.mjs
 * Env:    AOKIE_REPO — path to the aokie checkout
 *         (default C:/Users/User/Documents/repos/aokie.com or ../aokie.com)
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aokieRoot = process.env.AOKIE_REPO
  || ['C:/Users/User/Documents/repos/aokie.com', path.join(repoRoot, '..', 'aokie.com')]
    .find((p) => existsSync(p));

if (!aokieRoot || !existsSync(aokieRoot)) {
  console.error('check-contracts: FAIL — aokie repo not found (set AOKIE_REPO). '
    + 'The cross-repo digest cannot run without both checkouts; this is a hard '
    + 'failure by design (FL-34: no silent self-skip).');
  process.exit(1);
}

const ourDir = path.join(repoRoot, 'docs', 'contracts');
const theirDir = path.join(aokieRoot, 'docs', 'contracts');
for (const [label, dir] of [['formlogic', ourDir], ['aokie', theirDir]]) {
  if (!existsSync(dir)) {
    console.error(`check-contracts: FAIL — ${label} docs/contracts missing at ${dir}`);
    process.exit(1);
  }
}

// Files that MUST exist in both repos (the shared wire contract). Everything
// else is compared opportunistically when present on both sides.
const REQUIRED_SHARED = [
  'aokie-connector-contract.v1.json',
  'aokie-persona.v1.json',
  'aokie-settings-schema.v1.json',
  'connector-request.schema.json',
  'connector-response.schema.json',
  'desktop-event.schema.json',
  'plugin-manifest.schema.json',
];

function listFiles(dir, rel = '', out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFiles(path.join(dir, entry.name), r, out);
    else out.push(r);
  }
  return out;
}

const ours = new Set(listFiles(ourDir));
const theirs = new Set(listFiles(theirDir));
const problems = [];

for (const required of REQUIRED_SHARED) {
  if (!ours.has(required)) problems.push(`required shared contract missing from formlogic: ${required}`);
  if (!theirs.has(required)) problems.push(`required shared contract missing from aokie: ${required}`);
}

const shared = [...ours].filter((f) => theirs.has(f)).sort();
let compared = 0;
// CRLF -> LF, the same normalization git applies at commit time under the
// autocrlf settings both repos use; without it a checkout artifact reads as
// drift while the committed blobs are byte-identical.
const norm = (buf) => buf.toString('binary').replaceAll('\r\n', '\n');
for (const rel of shared) {
  const a = readFileSync(path.join(ourDir, rel));
  const b = readFileSync(path.join(theirDir, rel));
  const ha = createHash('sha256').update(norm(a), 'binary').digest('hex');
  const hb = createHash('sha256').update(norm(b), 'binary').digest('hex');
  if (ha !== hb) {
    problems.push(`contract drift: ${rel}\n    formlogic ${ha}\n    aokie     ${hb}`);
  }
  compared++;
}

let parsed = 0;
for (const [dir, files] of [[ourDir, ours], [theirDir, theirs]]) {
  for (const rel of files) {
    if (!rel.endsWith('.json')) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(path.join(dir, rel), 'utf8'));
      parsed++;
    } catch (err) {
      problems.push(`invalid JSON: ${path.join(dir, rel)} — ${err.message}`);
      continue;
    }
    if (/\.schema\.json$/.test(rel) && !rel.includes('fixtures/')) {
      const looksLikeSchema = doc && typeof doc === 'object'
        && ('$schema' in doc || 'type' in doc || 'oneOf' in doc || 'anyOf' in doc || 'properties' in doc || '$defs' in doc || 'definitions' in doc);
      if (!looksLikeSchema) problems.push(`does not look like a JSON Schema: ${path.join(dir, rel)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-contracts: FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`check-contracts: OK — ${shared.length} shared files byte-identical (${compared} compared, ${parsed} JSON docs parsed)`);
console.log('check-contracts: NOTE — the paired Desktop+plugin runtime handshake remains a labelled manual step (desktop full cargo test with a built plugin).');
