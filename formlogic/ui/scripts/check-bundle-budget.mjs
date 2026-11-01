/**
 * Rough bundle-budget report for CI. Measures the INITIAL JS payload (the entry chunk + its
 * modulepreload'd chunks referenced from dist/index.html) — NOT the whole dist, since the heavy
 * Monaco editor / ZIPP worker + wasm chunks are lazy-loaded on demand and don't hit the
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

// Safari before 16.4 can't compile a lookbehind, and the build keeps supporting it: one in these
// scripts throws as they load, so a visitor gets a blank page with no error boundary to catch it.
const LOOKBEHIND = /\(\?<[!=]/;
const refused = uniq.filter((f) => {
  try {
    return LOOKBEHIND.test(readFileSync(resolve(dist, 'assets', f), 'utf8'));
  } catch {
    return false;
  }
});
if (refused.length > 0) {
  console.error(`\n✗ bundle-budget: a regex lookbehind in the first scripts breaks Safari before 16.4: ${refused.join(', ')}`);
  process.exit(1);
}

if (KB(initial) > INITIAL_BUDGET_KB) {
  console.error(`\n✗ bundle-budget: initial JS ${KB(initial)} KB exceeds ${INITIAL_BUDGET_KB} KB. Code-split or lazy-load to trim the critical path.`);
  process.exit(1);
}
console.log('\n✓ bundle-budget OK');
