#!/usr/bin/env node
// SoftN's own guide to writing a SoftN app, for the AIs that build apps here.
//
// SoftN Studio's agent is taught by one text, "How to build a SoftN app" (softn.com:
// apps/softn-studio/src/lib/agent/guide.ts, Apache-2.0). An AI that reaches FormLogic over MCP, and
// FormLogic's own chat, are given the same text by get_softn_guide (backend/src/Services/
// SoftnKnowledge.php), so that what they write is what SoftN reads. That text is built by a function
// inside Studio and is not a file of a Softn release, so FormLogic keeps a copy:
//
//   formlogic/backend/resources/softn-guide.json     (generated, COMMITTED; says which commit it is of)
//
// Regenerate it when adopting a Softn release, from a checkout of softn.com at that release:
//
//   SOFTN_REPO=/path/to/softn.com node scripts/softn-guide.mjs
//   SOFTN_REPO=/path/to/softn.com node scripts/softn-guide.mjs --check    # fails when the copy is not that checkout's
//
// (The component reference and the published guides are another matter: they ARE in the release,
// and scripts/softn-knowledge.mjs reads them from the installed Studio.)
//
// Where the guide speaks of Studio's own tools and preview, FormLogic's words are put in their
// place (FOR_FORMLOGIC below). Each of those sentences must still be in the guide: when SoftN
// rewrites one, this script stops and says which, so the replacement is looked at again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
export const GUIDE_FILE = 'formlogic/backend/resources/softn-guide.json';
const GUIDE_SOURCE = 'apps/softn-studio/src/lib/agent/guide.ts';

/** [Studio's words, FormLogic's]. Each is in both the JavaScript and the Python guide. */
const FOR_FORMLOGIC = [
  [
    'Without the file, every capability is denied; declare exactly what the logic calls, in the same step you write the call.',
    'Without the file, every capability is denied; declare exactly what the logic calls, in the same step you write the call. (On FormLogic this file is not read at all: FormLogic decides what a hosted app may use, so do not write one there.)',
  ],
  [
    'Keep it when you rewrite the manifest; an .svg is text, so you can redraw it with write_file.',
    'Keep it when you rewrite the manifest; on FormLogic an icon is one of the app\'s media (update_native_app_files `media`).',
  ],
  [
    '**assets/** — images, sounds, fonts (already in the project; you write text files only, which an .svg is).',
    '**assets/** — images, sounds, fonts: the app\'s media. On FormLogic they are sent as base64 (update_native_app_files `media`), an .svg included.',
  ],
  [
    'lookup_components lists each component\'s events.',
    'lookup_softn_components lists each component\'s events.',
  ],
  // Games and 3D scenes (from SoftN v0.0.40): the guide with the complete examples is one of the
  // published guides, read here by its name, and the component reference is FormLogic's tool.
  [
    '`read_docs("threejs-games")` has complete examples',
    '`get_softn_guide` with topic "threejs-games" has complete examples',
  ],
  [
    '`lookup_components` on Scene3D lists every field',
    '`lookup_softn_components` on Scene3D lists every field',
  ],
  [
    'there are no props, no events and no `$emit`. check_app warns at each such use.',
    'there are no props, no events and no `$emit`.',
  ],
  [
    'The preview withholds them until the person presses Allow in preview above the app, so these calls fail there until then; Run opens the app in the runtime.',
    'On FormLogic an app\'s own permission.json grants none of these: FormLogic decides what a hosted app may use (get_softn_guide with no topic says what).',
  ],
  [
    '- **Test the backend by reading it**, and by calling the page\'s functions with run_app_function: a preview shows the page, and a call to the backend may not answer there.',
    '- **Test the backend by reading it, and by publishing it**: FormLogic starts the backend as a version is installed and refuses one that does not start, saying which part to fix. The page itself is checked by opening the app at its address.',
  ],
];

class GuideError extends Error {}

function softnRepo() {
  const repo = process.env.SOFTN_REPO ? resolve(process.env.SOFTN_REPO) : resolve(ROOT, '..', 'softn.com');
  if (!existsSync(join(repo, GUIDE_SOURCE))) throw new GuideError(`No SoftN checkout at ${repo} (looked for ${GUIDE_SOURCE}). Set SOFTN_REPO to a checkout of softn.com at the release being adopted.`);
  return repo;
}

function headCommit(repo) {
  try {
    const gitDir = join(repo, '.git');
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    if (existsSync(join(gitDir, ref))) return readFileSync(join(gitDir, ref), 'utf8').trim();
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8').split('\n').find((line) => line.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0] : null;
  } catch { return null; }
}

/** The guide as Studio builds it, for each logic language, in FormLogic's words where Studio's were about itself. */
export async function buildSoftnGuide({ repo = softnRepo(), root = ROOT } = {}) {
  // TypeScript from the UI's own install: this script has no dependencies of its own.
  const ts = createRequire(join(root, 'formlogic/ui/package.json'))('typescript');
  const composer = readFileSync(join(repo, 'packages/@softn/core/src/bundle/source-composer.ts'), 'utf8');
  const stdlib = /export const SOFTN_PY_STDLIB_IMPORTS[^=]*=\s*(\[[^\]]*\])/.exec(composer)?.[1];
  if (!stdlib) throw new GuideError('SOFTN_PY_STDLIB_IMPORTS was not found in @softn/core: the guide\'s one import cannot be given.');
  let source = readFileSync(join(repo, GUIDE_SOURCE), 'utf8');
  source = source.replace(/import\s*\{\s*SOFTN_PY_STDLIB_IMPORTS\s*\}\s*from\s*'@softn\/core';/, `const SOFTN_PY_STDLIB_IMPORTS = ${stdlib};`);
  if (/^\s*import\s[^\n]*from\s+'/m.test(source)) throw new GuideError(`${GUIDE_SOURCE} imports something this script does not know how to give it.`);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const guide = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  if (typeof guide.buildGuide !== 'function') throw new GuideError(`${GUIDE_SOURCE} no longer exports buildGuide.`);
  const forFormLogic = (text, which) => FOR_FORMLOGIC.reduce((out, [studio, formlogic]) => {
    if (!out.includes(studio)) throw new GuideError(`The ${which} guide no longer says "${studio.slice(0, 90)}…": look at what it says now and at FormLogic's words for it (FOR_FORMLOGIC in scripts/softn-guide.mjs).`);
    return out.replaceAll(studio, formlogic);
  }, text);
  // With the backend section: an app here may have one, and the section says what it is.
  const variant = (python, which) => {
    const text = guide.buildGuide({ python, torch: false, backend: true, style: 'clean' });
    if (typeof text !== 'string' || text.length < 5000 || !text.startsWith('# ')) throw new GuideError(`The ${which} guide is not the text it was (${String(text).length} characters).`);
    return forFormLogic(text, which);
  };
  return {
    source: { repository: 'f2i-com/softn.com', file: GUIDE_SOURCE, commit: headCommit(repo), license: 'Apache-2.0' },
    javascript: variant(false, 'JavaScript'),
    python: variant(true, 'Python'),
  };
}

const encode = (guide) => `${JSON.stringify(guide, null, 1)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const guide = await buildSoftnGuide();
    const file = resolve(ROOT, GUIDE_FILE);
    if (process.argv.includes('--check')) {
      const written = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      // The commit is where it was read from, not what it says: two commits with the same guide agree.
      if (!written || written.javascript !== guide.javascript || written.python !== guide.python) throw new GuideError(`${GUIDE_FILE} is not the guide of the SoftN checkout at ${softnRepo()}. Run SOFTN_REPO=… node scripts/softn-guide.mjs and commit it.`);
      console.log(`${GUIDE_FILE} is that checkout's guide (${guide.javascript.length} and ${guide.python.length} characters).`);
    } else {
      writeFileSync(file, encode(guide));
      console.log(`wrote ${GUIDE_FILE} from softn.com ${String(guide.source.commit).slice(0, 12)} (JavaScript ${guide.javascript.length} characters, Python ${guide.python.length}).`);
    }
  } catch (error) {
    if (error instanceof GuideError) { console.error(`softn-guide: ${error.message}`); process.exit(1); }
    throw error;
  }
}
