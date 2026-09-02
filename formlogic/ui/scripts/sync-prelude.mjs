// Copy the canonical FormLogic prelude (the single source of truth, authored in
// src/lib/formlogic/prelude.js) to every runtime that evaluates author-written
// expressions, so all of them offer the exact same standard library.
//
// There are three such runtimes: the browser (imports the canonical file
// directly) and the PHP backend, whose WASI guest loads it at start-up. (The retired
// desktop app was a third destination until 2026-09-02.) The desktop was NOT a
// destination until now, and it shipped no standard library at all — so
// `validators.email(x)` or `sum(xs)` in a flow condition threw "is not defined",
// and the runner's `unwrap_or(false)` turned that into a silently-false branch.
// Adding it here is what keeps the three in step.
//
// Runs automatically in `prebuild`.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/lib/formlogic/prelude.js');

const destinations = [
  resolve(here, '../../backend/resources/formlogic-prelude.js'),
];

const content = readFileSync(source, 'utf8');
let written = 0;

for (const dest of destinations) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && readFileSync(dest, 'utf8') === content) {
    console.log(`sync-prelude: ${dest} already current (${content.length} bytes)`);
    continue;
  }
  writeFileSync(dest, content, 'utf8');
  written++;
  console.log(`sync-prelude: ${source} -> ${dest} (${content.length} bytes)`);
}

if (written === 0) {
  console.log('sync-prelude: all destinations current');
}
