#!/usr/bin/env node
/**
 * Cross-runtime expression parity — the check that actually enforces the claim.
 *
 * FormLogic evaluates author-written expressions in two places: the browser
 * (the zipp wasm module in a Worker) and the backend (the same engine as a WASI
 * guest under the formlogic-runtime launcher). A condition, a calculated field
 * or a validation rule is supposed to mean the SAME THING in both. (A third
 * leg, the desktop flow runner, existed until the desktop app was retired on
 * 2026-09-02; the comparator fails on a MISSING leg, so it was removed here
 * rather than left to skip.)
 *
 * `docs/contracts/formlogic-expression-corpus.json` is the shared authority, and
 * each runtime has its own test that asserts it:
 *
 *   backend/tests/Unit/FormLogicExpressionParityTest.php
 *   ui/src/lib/formlogic/corpusParity.test.ts
 *
 * For the 124 cases that pin an exact value, those two suites already prove
 * agreement transitively — both assert the same literal, so both agree.
 *
 * The other 13 cases pin NOTHING. They are the environment-dependent probes
 * (timezone, locale, Intl) and the throw-class probes, where the right assertion
 * is "whatever the answer is, both give the same one" rather than a value
 * baked into a fixture. Each leg records what it produced — and until this script
 * existed, nothing ever compared those recordings. The claim was made and never
 * checked.
 *
 * This closes that. It is a POST-PROCESSING step: run both suites first,
 * then run this. It fails if a leg is missing, if the legs ran different corpora,
 * or if any case disagrees.
 *
 *   php vendor/bin/phpunit --filter FormLogicExpressionParityTest   # backend
 *   npx vitest run src/lib/formlogic/corpusParity.test.ts           # browser
 *   node scripts/check-expression-parity.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'test-results', 'parity');

const LEGS = [
  { file: 'backend.json', label: 'backend', how: 'php vendor/bin/phpunit --filter FormLogicExpressionParityTest' },
  { file: 'browser.json', label: 'browser', how: 'npx vitest run src/lib/formlogic/corpusParity.test.ts' },
];

const problems = [];
const legs = [];

for (const leg of LEGS) {
  const path = join(DIR, leg.file);
  if (!existsSync(path)) {
    // A missing leg must FAIL, not silently reduce the comparison to the legs
    // that happen to be present — one leg agreeing with itself is not parity.
    problems.push(`missing ${leg.label} artifact (${path})\n    produce it with: ${leg.how}`);
    continue;
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const byId = new Map();
    for (const r of data.results ?? []) byId.set(r.id, r);
    legs.push({ ...leg, engine: data.engine, sha: data.corpus?.sha256 ?? '', byId });
  } catch (err) {
    problems.push(`${leg.label} artifact is unreadable: ${err.message}`);
  }
}

if (problems.length) {
  console.error('Expression parity could not run:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Every leg must have asserted the SAME corpus. Comparing runs of different
// corpora would report divergences that are really just version skew.
const shas = new Set(legs.map((l) => l.sha).filter(Boolean));
if (shas.size > 1) {
  console.error('Legs ran DIFFERENT corpora — re-run them all against the current file:\n');
  for (const l of legs) console.error(`  ${l.label.padEnd(8)} ${l.sha || '(no digest recorded)'}`);
  process.exit(1);
}

/** One of 'value' | 'threw' | 'harness-failed', whatever a leg calls it. */
function outcomeClass(outcome) {
  const o = String(outcome ?? '');
  if (o === 'ok' || o === 'value') return 'value';
  if (o.endsWith('threw')) return 'threw';
  return 'harness-failed';
}

/** What two legs must match on: the class, plus the value when there is one. */
function fingerprint(row) {
  const cls = outcomeClass(row.outcome);
  return cls === 'value' ? `value:${row.canonical}` : cls;
}

const corpus = JSON.parse(readFileSync(join(ROOT, 'docs/contracts/formlogic-expression-corpus.json'), 'utf8'));
const disagreements = [];
const absent = [];
let compared = 0;
let agreeMode = 0;

for (const c of corpus.cases) {
  const seen = legs.map((l) => ({ leg: l.label, row: l.byId.get(c.id) }));
  const missing = seen.filter((s) => !s.row).map((s) => s.leg);
  if (missing.length) {
    absent.push(`  ${c.id} — not recorded by: ${missing.join(', ')}`);
    continue;
  }
  compared++;
  const isAgree = !!c.expect?.agree;
  if (isAgree) agreeMode++;

  // Compare the OUTCOME CLASS first, and the value only when there is one. The
  // legs spell the same outcome differently ('threw' vs 'guest-threw'), and an
  // error's MESSAGE is engine-defined by design — pinning message text would
  // report a divergence where the engines actually agree that it throws.
  const values = new Set(seen.map((s) => fingerprint(s.row)));
  if (values.size > 1) {
    disagreements.push(
      `  ${c.id} [${c.source}]${isAgree ? '  (engine-defined — ONLY this check covers it)' : ''}\n` +
        `      expression: ${String(c.expression).replace(/\n/g, '\n                  ')}\n` +
        seen.map((s) => `      ${s.leg.padEnd(8)} ${outcomeClass(s.row.outcome)}  ${s.row.canonical}`).join('\n')
    );
  }
}

if (absent.length) {
  console.error(`\n${absent.length} case(s) missing from at least one leg:\n`);
  console.error(absent.join('\n'));
}
if (disagreements.length) {
  console.error(`\n${disagreements.length} case(s) DISAGREE across runtimes:\n`);
  console.error(disagreements.join('\n\n'));
  console.error(
    '\nAn expression must mean the same thing in the browser and on the backend.\n' +
      'A divergence here is a real behaviour difference a user can hit.\n'
  );
}
if (absent.length || disagreements.length) process.exit(1);

console.log(
  `expression parity OK — ${compared} cases agree across ${legs.length} runtimes ` +
    `(${legs.map((l) => l.engine).join(', ')})`
);
console.log(
  `  ${agreeMode} of them are engine-defined (timezone/locale/Intl/throw-class) and are ` +
    'checked ONLY here.'
);
