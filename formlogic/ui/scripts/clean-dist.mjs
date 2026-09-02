#!/usr/bin/env node
/**
 * Empty dist/ before a build — everything except the `api` entry.
 *
 * vite.config.ts sets `emptyOutDir: false` on purpose: on this deployment
 * `dist/api` is a junction onto backend/public, and Vite's own emptying would
 * follow it and delete the backend's public files. The cost of that setting was
 * that nothing ever emptied dist/, so content-hashed chunks from every previous
 * build accumulated — including, at the time this was written, the retired
 * QuickJS engine's wasm and the worker that loaded it, all of which
 * package-dist.mjs was faithfully shipping in every locally built release zip.
 *
 * This removes each top-level entry of dist/ except `api`, without ever
 * descending into it: `rmSync` on a junction/symlink removes the link itself,
 * but skipping the name entirely is the guarantee, not a behaviour to rely on.
 */
import { existsSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const KEEP = new Set(['api']);

if (!existsSync(dist)) {
  process.exit(0);
}

let removed = 0;
for (const entry of readdirSync(dist)) {
  if (KEEP.has(entry)) continue;
  const target = join(dist, entry);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    // Anything else that is a link is not ours to walk into either.
    rmSync(target, { force: true });
  } else {
    rmSync(target, { recursive: true, force: true });
  }
  removed++;
}
console.log(`clean-dist: removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from dist/ (kept: ${[...KEEP].join(', ')})`);
