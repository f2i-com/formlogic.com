// Copy the canonical FormLogic prelude (the single source of truth, authored in
// src/lib/formlogic/prelude.js) into the backend so the qjs harness evaluates the
// exact same standard library the browser does. Run automatically in `prebuild`.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/lib/formlogic/prelude.js');
const dest = resolve(here, '../../backend/resources/formlogic-prelude.js');

const content = readFileSync(source, 'utf8');
mkdirSync(dirname(dest), { recursive: true });
if (existsSync(dest) && readFileSync(dest, 'utf8') === content) {
  console.log(`sync-prelude: ${dest} already current (${content.length} bytes)`);
  process.exit(0);
}
writeFileSync(dest, content, 'utf8');

console.log(`sync-prelude: ${source} -> ${dest} (${content.length} bytes)`);
