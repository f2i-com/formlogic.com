#!/usr/bin/env node
// Engine provenance guard: engines come from releases, never from git.
//
// FormLogic's browser engine is the installed Softn release's zipp/ tree
// (scripts/fetch-softn-release.mjs installs it at formlogic/ui/vendor/zipp-wasm,
// which git ignores), and Softn takes it from a ZIPP release. The server
// sandbox (guest wasm and launchers) is built from that ZIPP release's source,
// by CI every run or by scripts/build-runtime.sh. A committed copy of either
// would be a second, unverified engine that silently outlives the release it
// came from, so this fails on any tracked file that is:
//
//   - a compiled binary: wasm, ELF, or a PE (MZ header with a PE signature), or a *.cwasm;
//   - anything under formlogic/ui/vendor/;
//   - named zipp_wasm* (the engine's glue, declarations or module, under any folder);
//   - a Cargo.toml naming a zipp.org source (git, tag, rev, branch or [patch]) or
//     zipp-vm / zipp-regress other than as a path into .runtime-source/zipp/src;
//   - a file under .github/ other than .github/actions/prepare-sandbox-runtime that
//     fetches ZIPP (that action checks it out, at the release the installed Softn
//     release names; anywhere else it would be a second, unchecked source): one
//     that names f2i-com/zipp.org outside a comment (a checkout, git clone, gh -R,
//     curl or wget, an API or codeload URL), checks out a repository given by an
//     expression it cannot read, or runs scripts/zipp-source.mjs or
//     scripts/build-runtime.sh in a mode that clones ZIPP (fetch; all, zipp-source).
//
// Static: it reads `git ls-files` and the tracked bytes, and needs no install.
//
//   node scripts/engine-provenance-guard.mjs [--root <repository>]
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tracked binaries allowed anyway: none. Adding one is a decision to commit an engine, and reads as one in review. */
export const BINARY_ALLOWLIST = Object.freeze([]);
/** The one file that may check out ZIPP source in CI. */
export const ZIPP_CHECKOUT_ACTION = '.github/actions/prepare-sandbox-runtime/action.yml';

const ZIPP_SOURCE_PATH = /(^|\/)\.runtime-source\/zipp\/src\//;
const ZIPP_CRATE = /^(zipp-vm|zipp-regress)$/;
/** ZIPP's repository, however a step names it: owner/name, a clone or API URL, an ssh remote. */
const ZIPP_REPOSITORY = /f2i-com\/zipp\.org/i;

/** What the first bytes say a file is, or null. */
export function binaryKind(header) {
  if (header.length >= 4 && header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d) return 'wasm';
  if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return 'ELF';
  if (header.length >= 0x40 && header[0] === 0x4d && header[1] === 0x5a) {
    const offset = header.readUInt32LE(0x3c);
    if (offset + 4 <= header.length && header[offset] === 0x50 && header[offset + 1] === 0x45 && header[offset + 2] === 0 && header[offset + 3] === 0) return 'PE';
  }
  return null;
}

/** Violations of the zipp.org-source rule in one Cargo.toml's text. */
export function cargoViolations(text) {
  const problems = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let table = null;
  let tableBody = [];
  const closeTable = () => {
    if (table && !tableBody.some((line) => /^\s*path\s*=\s*"([^"]*)"/.test(line) && ZIPP_SOURCE_PATH.test(/"([^"]*)"/.exec(line)[1]))) problems.push(`[${table}] does not take ${table.split('.').pop()} as a path into .runtime-source/zipp/src`);
    table = null;
    tableBody = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    const header = /^\s*\[+([^\]]+)\]+\s*$/.exec(line);
    if (header) {
      closeTable();
      const name = header[1].trim();
      if (/zipp\.org/i.test(name)) problems.push(`[${name}] patches a zipp.org source`);
      else if (ZIPP_CRATE.test(name.split('.').pop().replace(/"/g, '')) && /dependencies/.test(name)) table = name;
      continue;
    }
    if (table) tableBody.push(line);
    if (/zipp\.org/i.test(line)) { problems.push(`names a zipp.org source: ${raw.trim()}`); continue; }
    const dependency = /^\s*"?(zipp-vm|zipp-regress)"?\s*=\s*(.+)$/.exec(line);
    if (dependency) {
      const path = /\bpath\s*=\s*"([^"]*)"/.exec(dependency[2])?.[1];
      if (!path || !ZIPP_SOURCE_PATH.test(path) || /\b(git|tag|rev|branch|registry)\s*=/.test(dependency[2])) problems.push(`takes ${dependency[1]} other than as a path into .runtime-source/zipp/src: ${raw.trim()}`);
    }
  }
  closeTable();
  return problems;
}

/**
 * How one file under .github (not the sandbox action) fetches ZIPP itself, one
 * reason per line that does; empty when it does not. YAML and shell comments
 * are not steps, so they are read past.
 */
export function zippFetchViolations(text) {
  const problems = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '$1');
    if (!line.trim()) continue;
    const step = raw.trim();
    const repository = /^\s*-?\s*repository:\s*(.*)$/.exec(line)?.[1]?.trim() ?? null;
    if (repository !== null && ZIPP_REPOSITORY.test(repository)) problems.push(`checks out f2i-com/zipp.org: ${step}`);
    else if (repository !== null && repository.includes('${{') && !/^["']?\$\{\{\s*github\.repository\s*\}\}["']?$/.test(repository)) problems.push(`checks out a repository named by an expression, which could be f2i-com/zipp.org (name it literally): ${step}`);
    else if (ZIPP_REPOSITORY.test(line)) problems.push(`fetches from f2i-com/zipp.org: ${step}`);
    else if (/zipp-source\.mjs(?![\w.-])/.test(line) && !/--(identity|verify|seed-lock)\b/.test(line)) problems.push(`clones ZIPP source (scripts/zipp-source.mjs without --identity, --verify or --seed-lock): ${step}`);
    else {
      const steps = /build-runtime\.sh(?![\w.-])([^;&|)]*)/.exec(line)?.[1];
      if (steps !== undefined && (!steps.trim() || /(^|\s)(all|zipp-source)(?=\s|$)/.test(steps))) problems.push(`clones ZIPP source (scripts/build-runtime.sh ${steps.trim() || 'with no step, which is all'}): ${step}`);
    }
  }
  return problems;
}

/** Every violation in the repository at `root`, as "<path>: <reason>". */
export function findViolations({ root }) {
  const git = (args, options = {}) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 28, ...options });
  const files = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  // A tracked file missing from the working tree is still committed: read what the index holds.
  const tracked = (path) => (existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile() ? null : git(['cat-file', 'blob', `:${path}`]));
  const violations = [];
  for (const path of files) {
    const name = basename(path);
    if (path.startsWith('formlogic/ui/vendor/')) violations.push(`${path}: formlogic/ui/vendor is generated by scripts/fetch-softn-release.mjs and must not be tracked`);
    if (name.startsWith('zipp_wasm')) violations.push(`${path}: a ZIPP engine file (zipp_wasm*) must come from the installed Softn release, not git`);
    if (name.endsWith('.cwasm')) violations.push(`${path}: a precompiled wasm module (*.cwasm) must not be tracked`);
    const blob = tracked(path);
    let header;
    if (blob) header = blob.subarray(0, 4096);
    else {
      const fd = openSync(resolve(root, path), 'r');
      try { header = Buffer.alloc(4096); header = header.subarray(0, readSync(fd, header, 0, 4096, 0)); } finally { closeSync(fd); }
    }
    const kind = binaryKind(header);
    if (kind && !BINARY_ALLOWLIST.includes(path)) violations.push(`${path}: a tracked ${kind} binary; engines and launchers come from releases and CI builds, not git`);
    if (name === 'Cargo.toml') {
      for (const problem of cargoViolations((blob ?? readFileSync(resolve(root, path))).toString('utf8'))) violations.push(`${path}: ${problem}`);
    }
    // Workflows, actions and anything they run; prose (*.md) only describes.
    if (path.startsWith('.github/') && !/\.md$/i.test(name) && path !== ZIPP_CHECKOUT_ACTION && !kind) {
      for (const problem of zippFetchViolations((blob ?? readFileSync(resolve(root, path))).toString('utf8'))) {
        violations.push(`${path}: ${problem} (only ${ZIPP_CHECKOUT_ACTION} fetches ZIPP, at the release the installed Softn release names)`);
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = findViolations({ root });
  if (violations.length) {
    console.error('engine provenance guard:');
    for (const violation of violations) console.error(` - ${violation}`);
    process.exit(1);
  }
  console.log(`engine provenance guard: no tracked engine binaries, zipp.org pins or ZIPP fetches outside ${ZIPP_CHECKOUT_ACTION}`);
}
