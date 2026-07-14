/**
 * Rough bundle-budget report for CI. Measures the INITIAL JS payload (the entry chunk + its
 * modulepreload'd chunks referenced from dist/index.html) — NOT the whole dist, since the heavy
 * Monaco editor / QuickJS worker / emscripten chunks are lazy-loaded on demand and don't hit the
 * first paint. Prints the breakdown; fails only if the initial payload blows past a generous cap.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const KB = (b) => Math.round(b / 1024);
const INITIAL_BUDGET_KB = 1400; // generous raw-bytes cap for the critical-path JS

let html;
try {
  html = readFileSync(resolve(dist, 'index.html'), 'utf8');
} catch {
  console.error('✗ bundle-budget: dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

// Entry <script src> + <link rel=modulepreload href> — the initial critical path.
const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => basename(m[1]));
const uniq = [...new Set(refs)];

let initial = 0;
const rows = [];
for (const f of uniq) {
  try {
    const s = statSync(resolve(dist, 'assets', f)).size;
    initial += s;
    rows.push([f, s]);
  } catch { /* ignore */ }
}
rows.sort((a, b) => b[1] - a[1]);

console.log('Initial JS (entry + preloads):');
for (const [f, s] of rows) console.log(`  ${String(KB(s)).padStart(5)} KB  ${f}`);
console.log(`  ${'─'.repeat(7)}`);
console.log(`  ${String(KB(initial)).padStart(5)} KB  TOTAL initial (budget ${INITIAL_BUDGET_KB} KB)`);

// Context: biggest lazy chunks (informational only).
const all = readdirSync(resolve(dist, 'assets')).filter((f) => f.endsWith('.js'))
  .map((f) => [f, statSync(resolve(dist, 'assets', f)).size]).sort((a, b) => b[1] - a[1]);
console.log('\nLargest chunks overall (most are lazy-loaded):');
for (const [f, s] of all.slice(0, 5)) console.log(`  ${String(KB(s)).padStart(5)} KB  ${f}`);

if (KB(initial) > INITIAL_BUDGET_KB) {
  console.error(`\n✗ bundle-budget: initial JS ${KB(initial)} KB exceeds ${INITIAL_BUDGET_KB} KB. Code-split or lazy-load to trim the critical path.`);
  process.exit(1);
}
console.log('\n✓ bundle-budget OK');
