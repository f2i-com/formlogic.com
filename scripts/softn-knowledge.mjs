#!/usr/bin/env node
// What an AI is told about writing a SoftN app, taken from the installed Softn release.
//
// SoftN's own AI Studio answers from two generated modules: the reference of every component
// (COMPONENT_REFERENCE) and the published guides as text (DOC_PAGES). They are built from SoftN's
// component manifest and its docs (softn.com: apps/softn-studio/scripts/generate-agent-knowledge.mjs)
// and ship in the release's Studio as two chunks of nothing but data:
//
//   formlogic/ui/public/app-editors/studio/assets/components.generated-<hash>.js
//   formlogic/ui/public/app-editors/studio/assets/docs.generated-<hash>.js
//
// FormLogic's MCP server and its chat give an AI the same material (get_softn_guide,
// lookup_softn_components: backend/src/Services/SoftnKnowledge.php), so that what an outside AI is
// told is what the installed SoftN is, at exactly that release. PHP cannot read a JavaScript module,
// so this script writes the two as JSON beside the backend's other resources:
//
//   formlogic/backend/resources/softn-knowledge.json   (generated, not in Git, shipped in the package)
//
// It moves with the installed release, like the trees it is read from: scripts/fetch-softn-release.mjs
// writes it after every install and holds it to the installed Studio at --check. Nothing is pinned here.
//
//   node scripts/softn-knowledge.mjs            write it from the installed Studio
//   node scripts/softn-knowledge.mjs --check    fail unless it is what the installed Studio gives
//
// The chunks are read as DATA: each must be exactly `var x=<literal>;export{x as NAME};`, and the
// literal is parsed, never run (parseLiteral below). Anything else in the file is refused.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class KnowledgeError extends Error {}
/** The file has not been written at all (a checkout from before it existed): something to do, not something wrong. */
export class KnowledgeMissingError extends KnowledgeError {}

const HERE = dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_FILE = 'formlogic/backend/resources/softn-knowledge.json';
const STUDIO_ASSETS = 'formlogic/ui/public/app-editors/studio/assets';
const CURRENT = '.runtime-source/softn-release/current.json';
/** Larger than either chunk has ever been (about 0.2 MB each); a file past it is not one of them. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The one chunk whose name is `<stem>-<hash>.js`, or a KnowledgeError that says what is there instead. */
async function chunkFile(assets, stem) {
  let names;
  try { names = await readdir(assets); }
  catch { throw new KnowledgeError(`SoftN Studio is not installed (${STUDIO_ASSETS} is missing); run node scripts/fetch-softn-release.mjs.`); }
  const found = names.filter((name) => name.startsWith(`${stem}-`) && name.endsWith('.js') && !name.endsWith('.map.js'));
  if (found.length !== 1) throw new KnowledgeError(`The installed SoftN Studio has ${found.length} files named ${stem}-*.js; exactly one is expected. This FormLogic reads SoftN's AI reference from that chunk: a Softn release that names it differently needs scripts/softn-knowledge.mjs taught the new name.`);
  return resolve(assets, found[0]);
}

/**
 * A JavaScript literal read as data, without running anything: objects, arrays, strings in any of
 * the three quotes (a template literal with no `${…}` in it), numbers, true, false, null, and the
 * minifier's `!0` / `!1`. Anything else (a name, a call, a function, `import()`, a getter, a
 * spread, a computed key) is not a literal and is refused where it stands.
 *
 * It is a parser and not an evaluation on purpose. A sandbox for evaluating text that might be
 * hostile has to be right about everything the language can do (a first version of this used
 * `vm.runInNewContext` with an empty context, and `import()` was a way out of it); a parser that
 * knows only literals has nothing to get out of.
 */
function parseLiteral(text) {
  let at = 0;
  const fail = (what) => { throw new KnowledgeError(`it is not a plain value: ${what} at character ${at}`); };
  const space = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  const string = (quote) => {
    let out = '';
    at++;
    for (;;) {
      if (at >= text.length) fail('a string that does not end');
      const ch = text[at];
      if (ch === quote) { at++; return out; }
      if (quote === '`' && ch === '$' && text[at + 1] === '{') fail('a template literal that works a value out');
      if (quote !== '`' && (ch === '\n' || ch === '\r')) fail('a line break in a string');
      if (ch !== '\\') { out += ch; at++; continue; }
      const next = text[at + 1];
      if (next === undefined) fail('a string that does not end');
      if (next === 'u') {
        const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(at + 2, at + 10));
        const four = /^[0-9a-fA-F]{4}/.exec(text.slice(at + 2, at + 6));
        if (braced) { const code = parseInt(braced[1], 16); if (code > 0x10ffff) fail('a character that does not exist'); out += String.fromCodePoint(code); at += 2 + braced[0].length; }
        else if (four) { out += String.fromCharCode(parseInt(four[0], 16)); at += 6; }
        else fail('an escape that is not one');
      } else if (next === 'x') {
        const two = /^[0-9a-fA-F]{2}/.exec(text.slice(at + 2, at + 4));
        if (!two) fail('an escape that is not one');
        out += String.fromCharCode(parseInt(two[0], 16)); at += 4;
      } else if (next === '\r') { at += text[at + 2] === '\n' ? 3 : 2; }   // a line carried on
      else if (next === '\n' || next === '\u2028' || next === '\u2029') { at += 2; }
      else if (next === '0' && /[0-9]/.test(text[at + 2] ?? '')) fail('an octal escape');
      else if (/[1-9]/.test(next)) fail('an octal escape');
      else { out += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : next; at += 2; }
    }
  };
  const number = () => {
    const found = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(at, at + 64));
    if (!found) fail('something that is not a value');
    at += found[0].length;
    const value = Number(found[0]);
    if (!Number.isFinite(value)) fail('a number that is not one');
    return value;
  };
  const value = (depth) => {
    if (depth > 64) fail('a value nested too deep');
    space();
    const ch = text[at];
    if (ch === '{') {
      const out = {};
      at++; space();
      if (text[at] === '}') { at++; return out; }
      for (;;) {
        space();
        let key;
        if (text[at] === '"' || text[at] === "'") key = string(text[at]);
        else { const name = /^(?:[A-Za-z_$][\w$]*|\d+)/.exec(text.slice(at, at + 256)); if (!name) fail('a key that is not a name'); key = name[0]; at += key.length; }
        space();
        if (text[at] !== ':') fail('a key with no value (a method, a shorthand or a spread)');
        at++;
        // Defined, never assigned: `__proto__` is a key like any other here.
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        if (text[at] === ',') { at++; space(); if (text[at] === '}') { at++; return out; } continue; }
        if (text[at] === '}') { at++; return out; }
        fail('an object that does not end');
      }
    }
    if (ch === '[') {
      const out = [];
      at++; space();
      if (text[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        space();
        if (text[at] === ',') { at++; space(); if (text[at] === ']') { at++; return out; } continue; }
        if (text[at] === ']') { at++; return out; }
        fail('a list that does not end');
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') return string(ch);
    if (ch === '!' && (text[at + 1] === '0' || text[at + 1] === '1') && !/[\w$.]/.test(text[at + 2] ?? '')) { const out = text[at + 1] === '0'; at += 2; return out; }
    for (const [word, is] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, at) && !/[\w$]/.test(text[at + word.length] ?? '')) { at += word.length; return is; }
    }
    return number();
  };
  const out = value(0);
  space();
  if (at !== text.length) fail('something after the value');
  return out;
}

/**
 * The value a data chunk exports under `exportName`. The file must be one declaration of one
 * literal and one export of it, and the literal is read as data (parseLiteral): nothing in the
 * file is run.
 */
export function readDataChunk(source, exportName) {
  const head = /^\s*(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(source);
  if (!head) throw new KnowledgeError(`The ${exportName} chunk does not begin with one declaration.`);
  const name = head[1];
  const tail = new RegExp(`;\\s*export\\s*\\{\\s*${name.replace(/\$/g, '\\$')}\\s+as\\s+${exportName}\\s*\\}\\s*;?\\s*$`).exec(source);
  if (!tail) throw new KnowledgeError(`The ${exportName} chunk does not end by exporting its one value as ${exportName}.`);
  try {
    return parseLiteral(source.slice(head[0].length, tail.index));
  } catch (error) {
    if (error instanceof KnowledgeError) throw new KnowledgeError(`The ${exportName} chunk is not a plain value: ${error.message.replace(/^it is not a plain value: /, '')}.`);
    throw error;
  }
}
function assertComponents(components) {
  const names = components && typeof components === 'object' && !Array.isArray(components) ? Object.keys(components) : [];
  if (names.length < 20) throw new KnowledgeError(`The component reference names ${names.length} components; a SoftN release has about a hundred.`);
  for (const name of names) {
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name) || typeof components[name] !== 'string' || components[name].length > 64 * 1024) throw new KnowledgeError(`The component reference's entry "${name.slice(0, 40)}" is not a component's name and text.`);
  }
}

function assertDocs(docs) {
  if (!Array.isArray(docs) || docs.length < 5) throw new KnowledgeError('The guides are not a list of pages.');
  for (const page of docs) {
    const ok = page && typeof page.slug === 'string' && /^[a-z0-9-]{1,80}$/.test(page.slug) && typeof page.title === 'string' && typeof page.summary === 'string' && Array.isArray(page.sections)
      && page.sections.every((section) => section && typeof section.id === 'string' && typeof section.title === 'string' && typeof section.text === 'string');
    if (!ok) throw new KnowledgeError(`A guide page is not {slug, title, summary, sections}: ${String(page?.slug).slice(0, 40)}`);
  }
}

/** The knowledge as the installed Studio carries it, with the release it is of and the chunks' digests. */
export async function buildSoftnKnowledge({ root = resolve(HERE, '..') } = {}) {
  const assets = resolve(root, STUDIO_ASSETS);
  const read = async (stem, exportName) => {
    const file = await chunkFile(assets, stem);
    const bytes = await readFile(file);
    if (bytes.length > MAX_CHUNK_BYTES) throw new KnowledgeError(`${stem} chunk is ${bytes.length} bytes; that is not SoftN's reference.`);
    return { value: readDataChunk(bytes.toString('utf8'), exportName), sha256: sha256(bytes) };
  };
  const components = await read('components.generated', 'COMPONENT_REFERENCE');
  const docs = await read('docs.generated', 'DOC_PAGES');
  assertComponents(components.value);
  assertDocs(docs.value);
  let release = null;
  try { release = JSON.parse(await readFile(resolve(root, CURRENT), 'utf8')).tag ?? null; } catch { /* a source build records no release */ }
  return {
    softn: typeof release === 'string' ? release : null,
    source: { components: components.sha256, docs: docs.sha256 },
    components: components.value,
    docs: docs.value.map((page) => ({ slug: page.slug, title: page.title, summary: page.summary, sections: page.sections.map((section) => ({ id: section.id, title: section.title, text: section.text })) })),
  };
}

const encode = (knowledge) => `${JSON.stringify(knowledge)}\n`;

/** Writes formlogic/backend/resources/softn-knowledge.json from the installed Studio (whole, then renamed into place). */
export async function writeSoftnKnowledge({ root = resolve(HERE, '..'), log = () => {} } = {}) {
  const knowledge = await buildSoftnKnowledge({ root });
  const file = resolve(root, KNOWLEDGE_FILE);
  const staged = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(staged, encode(knowledge));
    await rename(staged, file);
  } finally {
    if (existsSync(staged)) await rm(staged, { force: true });
  }
  log(`SoftN's AI reference written for the MCP and chat tools: ${Object.keys(knowledge.components).length} components, ${knowledge.docs.length} guides${knowledge.softn ? ` (Softn ${knowledge.softn})` : ''}.`);
  return knowledge;
}

/** Fails unless the written file is exactly what the installed Studio gives. */
export async function checkSoftnKnowledge({ root = resolve(HERE, '..') } = {}) {
  const expected = encode(await buildSoftnKnowledge({ root }));
  let written;
  try { written = await readFile(resolve(root, KNOWLEDGE_FILE), 'utf8'); }
  catch { throw new KnowledgeMissingError(`${KNOWLEDGE_FILE} is missing: the MCP and chat tools would have no SoftN reference to give. Run node scripts/softn-knowledge.mjs (or fetch-softn-release.mjs, which writes it).`); }
  if (written !== expected) throw new KnowledgeError(`${KNOWLEDGE_FILE} is not what the installed SoftN Studio carries (it is from another release, or was edited). Run node scripts/softn-knowledge.mjs.`);
  return JSON.parse(written);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) {
      const knowledge = await checkSoftnKnowledge();
      console.log(`SoftN's AI reference is the installed Studio's: ${Object.keys(knowledge.components).length} components, ${knowledge.docs.length} guides${knowledge.softn ? ` (Softn ${knowledge.softn})` : ''}.`);
    } else {
      await writeSoftnKnowledge({ log: console.log });
    }
  } catch (error) {
    if (error instanceof KnowledgeError) { console.error(`softn-knowledge: ${error.message}`); process.exit(1); }
    throw error;
  }
}
