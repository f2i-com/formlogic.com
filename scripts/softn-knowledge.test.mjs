// node --test scripts/softn-knowledge.test.mjs
//
// SoftN's AI reference, read out of the installed Studio's two data chunks for the MCP and chat
// tools: that a chunk is read as data and nothing else, that what is read is held to its shape,
// and that the written file is exactly what the installed Studio gives.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KNOWLEDGE_FILE, KnowledgeError, KnowledgeMissingError, buildSoftnKnowledge, checkSoftnKnowledge, readDataChunk, writeSoftnKnowledge } from './softn-knowledge.mjs';

const COMPONENTS = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Thing${i}`, `## Thing${i} — Number ${i}.\nTag: <Thing${i}> (group: essentials)`]));
const DOCS = Array.from({ length: 6 }, (_, i) => ({ slug: `guide-${i}`, title: `Guide ${i}`, summary: 'About it.', sections: [{ id: 'start', title: 'Start', text: 'Use `backticks` and ${braces} freely.' }], extra: 'dropped' }));
// As Vite writes them: one declaration of a literal (template literals for text) and one export.
const literal = (value) => JSON.stringify(value).replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner) => (/\\n|`|\$\{/.test(inner) ? '`' + JSON.parse(whole).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`' : whole));
const chunk = (value, name) => `var e=${literal(value)};export{e as ${name}};`;

async function site({ components = chunk(COMPONENTS, 'COMPONENT_REFERENCE'), docs = chunk(DOCS, 'DOC_PAGES'), release = 'v9.9.9' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'softn-knowledge-test-'));
  const assets = join(root, 'formlogic/ui/public/app-editors/studio/assets');
  await mkdir(assets, { recursive: true });
  await mkdir(join(root, 'formlogic/backend/resources'), { recursive: true });
  await mkdir(join(root, '.runtime-source/softn-release'), { recursive: true });
  if (components !== null) await writeFile(join(assets, 'components.generated-AbC123.js'), components);
  if (docs !== null) await writeFile(join(assets, 'docs.generated-XyZ789.js'), docs);
  if (release !== null) await writeFile(join(root, '.runtime-source/softn-release/current.json'), JSON.stringify({ tag: release }));
  return root;
}

test('a data chunk is read as the value it exports', () => {
  assert.deepEqual(readDataChunk('var e={A:`one\ntwo`,B:"three"};export{e as COMPONENT_REFERENCE};', 'COMPONENT_REFERENCE'), { A: 'one\ntwo', B: 'three' });
  assert.deepEqual(readDataChunk('const $x=[{slug:`a`}];\nexport { $x as DOC_PAGES };\n', 'DOC_PAGES'), [{ slug: 'a' }]);
  // Text that looks like code stays text.
  assert.deepEqual(readDataChunk('var e={A:`process.exit(1) \\${not} \\`quoted\\``};export{e as X};', 'X'), { A: 'process.exit(1) ${not} `quoted`' });
});

test('anything but one literal and its export is refused, and nothing in the file is run', async () => {
  const refused = [
    ['import x from "y";var e={};export{e as X};', /does not begin with one declaration/],
    ['var e={};export{e as Y};', /does not end by exporting/],
    ['var e={};console.log(1);export{e as X};', /not a plain value: something after the value/],
    // A name, a call, a function, a getter, a spread, a computed key, a template that works something out: none is a literal.
    ['var e=process.env;export{e as X};', /not a plain value/],
    ['var e=require("fs");export{e as X};', /not a plain value/],
    ['var e=(()=>{while(true){}})();export{e as X};', /not a plain value/],
    ['var e={A:`${globalThis.process.pid}`};export{e as X};', /a template literal that works a value out/],
    ['var e={get A(){return 1}};export{e as X};', /a key with no value/],
    ['var e={A(){return 1}};export{e as X};', /a key with no value/],
    ['var e={...Object};export{e as X};', /a key that is not a name/],
    ['var e={[process.pid]:1};export{e as X};', /a key that is not a name/],
    ['var e={A:1+1};export{e as X};', /an object that does not end/],
    ['var e=[function(){}];export{e as X};', /not a plain value/],
    ['var e={A:"\\101"};export{e as X};', /an octal escape/],
    ['var e={A:1e999};export{e as X};', /a number that is not one/],
    // What got out of an evaluation in an "empty" context: import()'s rejection is an error of the host's own realm.
    ["var e=(import('nope').catch(function(e){var F=e.constructor.constructor;F('return globalThis')().__softnEscaped=1;}),{A:'b'});export{e as X};", /not a plain value/],
  ];
  for (const [source, said] of refused) assert.throws(() => readDataChunk(source, 'X'), (error) => error instanceof KnowledgeError && said.test(error.message), source);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(globalThis.__softnEscaped, undefined);
  // A deeply nested value is refused, not followed until the stack runs out.
  assert.throws(() => readDataChunk(`var e=${'['.repeat(200)}${']'.repeat(200)};export{e as X};`, 'X'), /nested too deep/);
});

test('every kind of literal the chunks are written in is read as written', () => {
  const read = (literal) => readDataChunk(`var e=${literal};export{e as X};`, 'X');
  assert.deepEqual(read('{a:1,"b c":-2.5,3:!0,d:!1,e:null,f:true,g:[1,[2,{h:"i"}],],}'), { a: 1, 'b c': -2.5, 3: true, d: false, e: null, f: true, g: [1, [2, { h: 'i' }]] });
  assert.deepEqual(read('["\\u00e9\\u{1F600}\\x41\\n\\t\\\\\\"", \'it\\\'s\', `a\nb \\` \\${c} \\\nd`]'), ['é😀A\n\t\\"', "it's", 'a\nb ` ${c} d']);
  assert.deepEqual(read('[0x1F,1e3,.5,5.]'), [31, 1000, 0.5, 5]);
  // `__proto__` is a key like any other: it becomes the object's own, and no prototype is touched.
  const own = read('{"__proto__":{polluted:true},constructor:"x"}');
  assert.deepEqual(Object.keys(own), ['__proto__', 'constructor']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(own), Object.prototype);
});

test('the reference is built from the installed Studio and written whole', async () => {
  const root = await site();
  try {
    const built = await buildSoftnKnowledge({ root });
    assert.equal(built.softn, 'v9.9.9');
    assert.equal(Object.keys(built.components).length, 24);
    assert.equal(built.components.Thing3, '## Thing3 — Number 3.\nTag: <Thing3> (group: essentials)');
    // A page is kept to what the tools read; text with backticks and braces comes through as written.
    assert.deepEqual(built.docs[0], { slug: 'guide-0', title: 'Guide 0', summary: 'About it.', sections: [{ id: 'start', title: 'Start', text: 'Use `backticks` and ${braces} freely.' }] });
    assert.match(built.source.components, /^[a-f0-9]{64}$/);

    await assert.rejects(checkSoftnKnowledge({ root }), KnowledgeMissingError);
    const lines = [];
    await writeSoftnKnowledge({ root, log: (line) => lines.push(line) });
    assert.match(lines[0], /24 components, 6 guides \(Softn v9\.9\.9\)/);
    assert.deepEqual(await checkSoftnKnowledge({ root }), built);
    assert.deepEqual(JSON.parse(await readFile(join(root, KNOWLEDGE_FILE), 'utf8')), built);

    // Another release's reference, or an edited one, is not the installed Studio's.
    await writeFile(join(root, KNOWLEDGE_FILE), JSON.stringify({ ...built, softn: 'v0.0.1' }) + '\n');
    await assert.rejects(checkSoftnKnowledge({ root }), (error) => error instanceof KnowledgeError && !(error instanceof KnowledgeMissingError) && /not what the installed SoftN Studio carries/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Studio that is missing, or whose chunks are not the reference, is said by name', async () => {
  const cases = [
    [{ components: null }, /0 files named components\.generated-\*\.js/],
    [{ docs: chunk([{ slug: 'Not A Slug', title: 't', summary: 's', sections: [] }, ...DOCS], 'DOC_PAGES') }, /A guide page is not/],
    [{ components: chunk({ Button: 'only one' }, 'COMPONENT_REFERENCE') }, /names 1 components/],
    [{ components: chunk({ ...COMPONENTS, 'not a name': 'x' }, 'COMPONENT_REFERENCE') }, /is not a component's name and text/],
    [{ docs: 'var e=[];fetch("https://example.com");export{e as DOC_PAGES};' }, /not a plain value/],
  ];
  for (const [options, said] of cases) {
    const root = await site(options);
    try { await assert.rejects(buildSoftnKnowledge({ root }), (error) => error instanceof KnowledgeError && said.test(error.message), String(said)); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
  const bare = await mkdtemp(join(tmpdir(), 'softn-knowledge-test-'));
  try { await assert.rejects(buildSoftnKnowledge({ root: bare }), /SoftN Studio is not installed/); }
  finally { await rm(bare, { recursive: true, force: true }); }
});

test('a source build records no release, and the reference says none', async () => {
  const root = await site({ release: null });
  try { assert.equal((await buildSoftnKnowledge({ root })).softn, null); }
  finally { await rm(root, { recursive: true, force: true }); }
});
