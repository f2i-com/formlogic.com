// Generate the leaf-script PROFILE FormLogic serves: the document that tells another host
// (OAIY Desktop) what FormLogic's logic MEANS, as data rather than as a second implementation.
//
// WHY THIS EXISTS. A flow condition, a logic block and an app-logic script are author-written
// code, and FormLogic already runs them in the browser on ZIPP with a standard library
// (prelude.js) in scope and a Python contract (formlogic-python/1) behind them. When a Desktop
// claims that work instead, it has to mean the same thing by it. The alternative to serving the
// semantics is shipping a copy of them in the Desktop, and a copy drifts silently: the day
// `validators.abn` changes, an automation keeps passing on one machine and starts failing on the
// other, with nothing raising. So FormLogic serves the bytes and the Desktop runs exactly them.
//
// WHAT THE DOCUMENT IS. Precisely OAIY's `ScriptProfile`
// (oaiy.com protocol/v1/script-profile.schema.json, vendored at
// src/lib/oaiy/vendored/script-profile.schema.json), nothing wrapped around it. That schema is
// `additionalProperties: false` at the top level AND inside `python`, so there is no room for an
// envelope: a document carrying an `id`, a `revision` or a `budgetsMs` is REFUSED by the
// consumer, not tolerated. Those three still exist, outside the body:
//   * id       -> the endpoint path (GET /api/v1/script-profile). One provider, one document.
//   * revision -> the ETag, computed by the server over the served bytes.
//   * budgets  -> the requester's connector descriptor, which is where a timeout belongs:
//                 a budget is a property of the machine running the work, not of the semantics.
//
// WHAT IS NOT IN IT, DELIBERATELY:
//   * `hooks`. The schema's `hooks` names per-lane `prepare` functions THE PREAMBLE DEFINES.
//     FormLogic's preamble is the prelude and defines none, and nothing in OAIY reads
//     `profile.hooks` today (a job carries its own `prepare`). Naming functions that do not
//     exist would make every job that used them fail with "prepare hook '…' is not a function".
//
// WHAT `python.modes` IS, AND WHY IT IS THE POINT. A profile carrying the shared contract alone
// was readable and useless: `entry` says `main` and `files` carries `formlogic.py`, so nothing
// in the document was the entry module, nothing said that a flow block is wrapped as one
// parenthesised expression and retried as a module, and nothing said how many generated lines
// precede the author's first - so no consumer could report the author's own line numbers. The
// schema now carries `modes`, and this emits all five (pythonContract.ts ENTRIES,
// BLOCK_WRAPPERS, LINE_OFFSETS): per wrapping, the entry module it adds, the text before and
// after the author's source in the block file, and that line count. A job names the modes to try
// and carries the author's text unwrapped; the runner merges, wraps, runs, and subtracts
// `lineOffset` from any line the engine blames before the result leaves (src/lib/oaiy/scriptJob.ts
// builds such a job). The `syntax` mode also names its own `call`, because its entry module
// deliberately defines a function that is not the shared one. Nothing is transformed on the way
// out: a served mode is the bytes the browser host wraps with, and scriptProfile.test.ts holds
// the document to the `?raw` modules themselves.
//
// THE FAULTS A JSON SCHEMA CANNOT STATE are refused here instead: two modes of one name, a
// `block` that collides with a file of the project, a mode file that shadows a contract file,
// and an `entry` that is not a Python module name. The consumer refuses each at run time WITH
// THE WHOLE REQUEST, so this is the last place they can be caught before the document is served.
// Its fifth - a mode whose project has no entry module - cannot arise here, because a mode's one
// file IS `${entry}.py`; scriptProfile.test.ts asserts that of the served document rather than
// this asserting it of itself.
//
// EVERY BYTE COMES FROM A SOURCE A HOST ALREADY RUNS. The preamble is prelude.js, the file
// zipp-host.ts:39 imports as `?raw` and sync-prelude.mjs copies to the backend guest.
// `python.files['formlogic.py']` is the file pythonContract.ts:23 imports as `?raw`.
// `contract`, `entry` and `call` are read out of pythonContract.ts itself (:30, :35, :36) and
// `instructionSteps` out of zipp-host.ts (:109), by pattern, so a change to either constant
// moves the served document with it instead of leaving a second copy behind. Nothing here is a
// literal restatement of a value that lives somewhere else.
//
// LINE ENDINGS ARE LOAD-BEARING. .gitattributes declares no `text=auto`, and this repository is
// developed with core.autocrlf=true, so prelude.js checks out CRLF on Windows and LF on Linux
// (`git ls-files --eol` says `i/lf w/crlf` today). `preambleSha256` is a hash of those bytes and
// the consumer REFUSES a profile whose digest does not match, so an un-normalised generator
// would produce a document that is valid on the machine that built it and invalid everywhere
// else - or, worse, two byte-different documents that both "work" and disagree about what a
// program is. pythonContract.ts:42 already normalises for the same reason. Everything this
// script emits is LF, and nothing it emits is read without normalising first.
//
// USAGE
//   node scripts/build-script-profile.mjs            write the artifact
//   node scripts/build-script-profile.mjs --check    regenerate in memory, exit 1 on any drift
//   --prelude/--python/--python-dir/--zipp-host/--contract/--out   override an input (tests)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The one normalisation, applied to every source before it is hashed or served. */
export const lf = (text) => text.replace(/\r\n?/g, '\n');

/** Lower-case hex sha256 of UTF-8 text - how `preambleSha256` is computed on both sides. */
export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export const DEFAULT_PATHS = Object.freeze({
  prelude: resolve(here, '../src/lib/formlogic/prelude.js'),
  python: resolve(here, '../src/lib/formlogic/python/formlogic.py'),
  // The entry modules a mode adds (`entry-*.py`), read from beside pythonContract.ts by the
  // specifiers it imports them with - never listed here, so a renamed module is a refusal.
  pythonDir: resolve(here, '../src/lib/formlogic/python'),
  zippHost: resolve(here, '../src/lib/formlogic/zipp-host.ts'),
  contract: resolve(here, '../src/lib/formlogic/python/pythonContract.ts'),
  vendored: resolve(here, '../src/lib/oaiy/vendored/provenance.json'),
  out: resolve(here, '../../backend/resources/formlogic-script-profile.json'),
});

class ProfileBuildError extends Error {}

const read = (file, what) => {
  if (!existsSync(file)) throw new ProfileBuildError(`${what}: ${file} does not exist`);
  return lf(readFileSync(file, 'utf8'));
};

/**
 * Pull one constant out of a TypeScript source by pattern. A miss is a refusal, never a
 * default: a renamed constant must stop the build, because the silent alternative is a served
 * document that says `main` while the code says something else.
 */
function constantFrom(source, file, pattern, what) {
  const m = source.match(pattern);
  if (!m) {
    throw new ProfileBuildError(
      `${what}: ${file} no longer matches ${pattern} - the constant moved or was renamed, and the profile cannot be generated from a guess`,
    );
  }
  return m[1];
}

/**
 * Names the preamble may not declare, as OAIY's two consumers see them. The browser envelope
 * (`detectPreambleCollision`) and the CLI (`parseScriptProfile`) use different lists; a profile
 * must satisfy both, so the generator refuses on the union.
 */
function reservedNames(vendored) {
  const r = vendored.reservedPreambleNames;
  return new Set([...r.zippPreambleGlobals, ...r.scriptEnvelopeGlobals, ...r.wrapperGlobals]);
}

// The declaration scan OAIY runs on a preamble, character for character
// (oaiy.com ui/vendor/oaiy-core/src/zipp-script.ts `detectPreambleCollision`). It leads with
// `^[ \t]*`, so it sees declarations at ANY indentation, not just at the top level - a nested
// `var host = …` is a refusal there and so must be a refusal here.
const DECLARATION = /^[ \t]*(?:var|let|const|class|async[ \t]+function|function)\b[ \t*]*([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const LEXICAL_DECLARATION = /^[ \t]*(?:let|const|class)\b[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)/gm;

/**
 * Refuse a preamble OAIY would refuse. Two rules, both OAIY's:
 *   1. any declaration of a name the engine preamble, the script envelope or the workflow
 *      wrapper binds - a redeclaration there is a SyntaxError that takes the whole program, or
 *      (for `__emit`) a guest that could forge replies;
 *   2. a let/const/class redeclaring one of the guest shims, which is the same SyntaxError. A
 *      `var` or `function` of that name legally replaces the stub, and OAIY allows it.
 * Called on the generated preamble, not on the source file, so it judges exactly what crosses.
 */
export function preambleCollision(preamble, vendored) {
  const reserved = reservedNames(vendored);
  for (const m of preamble.matchAll(DECLARATION)) {
    if (reserved.has(m[1])) {
      return `the preamble declares ${JSON.stringify(m[1])}, a name the engine, the script envelope or the workflow wrapper binds`;
    }
  }
  const shims = new Set(vendored.guestShimNames.names);
  for (const m of preamble.matchAll(LEXICAL_DECLARATION)) {
    if (shims.has(m[1])) {
      return `the preamble redeclares the guest shim ${JSON.stringify(m[1])} with let/const/class, a SyntaxError at program top level (a var or function of that name replaces the shim instead)`;
    }
  }
  return null;
}

/**
 * The escapes pythonContract.ts writes its wrapper literals with. Anything else is a refusal:
 * a generator that guessed at `A` would serve a wrapper the browser host does not use.
 */
const ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$' };

function decodeEscapes(text, where) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    const escape = ESCAPES[text[i + 1]];
    if (escape === undefined) {
      throw new ProfileBuildError(`${where}: the escape \\${text[i + 1] ?? '<end>'} is not one this generator decodes`);
    }
    out += escape;
    i++;
  }
  return out;
}

/**
 * Read ONE JavaScript string literal at `i` and return it with the index after it.
 *
 * Three forms, which are the three pythonContract.ts uses: a quoted literal, a template literal
 * whose only interpolations are `${NAME}` of an already-read constant, and a bare NAME. A
 * literal that spans lines, interpolates an expression or names something unknown stops the
 * build - the wrappers are load-bearing bytes and a half-understood one is worse than none.
 */
function readLiteral(text, i, names, where) {
  const quote = text[i];
  if (quote === "'" || quote === '"' || quote === '`') {
    let out = '';
    let j = i + 1;
    while (j < text.length && text[j] !== quote) {
      if (text[j] === '\\') {
        out += decodeEscapes(text.slice(j, j + 2), where);
        j += 2;
        continue;
      }
      if (quote === '`' && text[j] === '$' && text[j + 1] === '{') {
        const end = text.indexOf('}', j);
        const name = end === -1 ? '' : text.slice(j + 2, end).trim();
        if (!(name in names)) {
          throw new ProfileBuildError(`${where}: the literal interpolates ${JSON.stringify(name)}, which is not a constant this generator read`);
        }
        out += names[name];
        j = end + 1;
        continue;
      }
      if (text[j] === '\n') throw new ProfileBuildError(`${where}: a wrapper literal must be written on one line`);
      out += text[j];
      j++;
    }
    if (j >= text.length) throw new ProfileBuildError(`${where}: unterminated literal`);
    return [out, j + 1];
  }
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
  if (identifier && identifier[0] in names) return [names[identifier[0]], i + identifier[0].length];
  throw new ProfileBuildError(`${where}: expected a string literal or a constant this generator read, at ${JSON.stringify(text.slice(i, i + 40))}`);
}

/** The body of an `export const X … = Object.freeze({` … `});` declaration, or a refusal. */
function frozenObjectBody(source, file, opening, what) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => opening.test(line));
  if (start === -1) {
    throw new ProfileBuildError(
      `${what}: ${file} no longer matches ${opening} - the declaration moved or was renamed, and the profile cannot be generated from a guess`,
    );
  }
  const end = lines.indexOf('});', start);
  if (end === -1) throw new ProfileBuildError(`${what}: ${file} never closes the declaration with '});'`);
  return lines.slice(start + 1, end).join('\n');
}

/**
 * The five wrappings, read out of pythonContract.ts and the entry modules beside it.
 *
 * `before`/`after` come from BLOCK_WRAPPERS, `lineOffset` is the newline count of `before` (which
 * is how LINE_OFFSETS derives it), `files` carries the mode's entry module under the same name
 * projectFiles gives it, and `call` is the function that module actually defines - emitted only
 * where it differs from the contract's shared call, as the schema asks. Every byte is read from
 * the sources the browser host imports; nothing here is restated.
 */
function pythonModes(source, paths, python) {
  const where = `python.modes: ${paths.contract}`;
  const header = decodeEscapes(
    constantFrom(source, paths.contract, /^const HEADER = '((?:[^'\\]|\\.)*)';/m, 'python.modes (HEADER)'),
    where,
  );
  const block = constantFrom(source, paths.contract, /^const BLOCK_FILE = '([^']+)';/m, 'python.modes (BLOCK_FILE)');
  const entryFile = `${python.entry}.py`;

  const imports = new Map();
  for (const m of source.matchAll(/^import ([A-Za-z_$][A-Za-z0-9_$]*) from '\.\/([A-Za-z0-9._-]+\.py)\?raw';$/gm)) {
    imports.set(m[1], m[2]);
  }

  // Which entry module each mode's main.py is, as ENTRIES names it.
  const entriesBody = frozenObjectBody(source, paths.contract, /^export const ENTRIES\b.*= Object\.freeze\(\{$/, 'python.modes (ENTRIES)');
  const entries = new Map();
  for (const m of entriesBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*): lf\(([A-Za-z_$][A-Za-z0-9_$]*)\),$/gm)) {
    const file = imports.get(m[2]);
    if (!file) throw new ProfileBuildError(`${where}: ENTRIES names ${m[2]}, which is not imported as a ?raw .py module`);
    entries.set(m[1], file);
  }
  const declared = entriesBody.split('\n').filter((line) => line.trim() !== '').length;
  if (entries.size !== declared) {
    throw new ProfileBuildError(`${where}: ENTRIES has ${declared} lines and ${entries.size} of them are 'mode: lf(MODULE),' - the rest cannot be read`);
  }

  const wrappers = frozenObjectBody(source, paths.contract, /^export const BLOCK_WRAPPERS\b.*= Object\.freeze\(\{$/, 'python.modes (BLOCK_WRAPPERS)');
  const names = { HEADER: header };
  const modes = [];
  const seen = new Set();
  let i = 0;
  const skipSpace = () => { while (i < wrappers.length && /\s/.test(wrappers[i])) i++; };
  const expect = (char) => {
    if (wrappers[i] !== char) throw new ProfileBuildError(`${where}: expected ${JSON.stringify(char)} at ${JSON.stringify(wrappers.slice(i, i + 40))}`);
    i++;
  };
  for (skipSpace(); i < wrappers.length; skipSpace()) {
    const key = /^([A-Za-z][A-Za-z0-9_]*):\s*/.exec(wrappers.slice(i));
    if (!key) throw new ProfileBuildError(`${where}: expected a mode name at ${JSON.stringify(wrappers.slice(i, i + 40))}`);
    const name = key[1];
    i += key[0].length;
    expect('[');
    skipSpace();
    const [before, afterBefore] = readLiteral(wrappers, i, names, `${where} (${name} before)`);
    i = afterBefore;
    skipSpace();
    expect(',');
    skipSpace();
    const [after, afterAfter] = readLiteral(wrappers, i, names, `${where} (${name} after)`);
    i = afterAfter;
    skipSpace();
    expect(']');
    skipSpace();
    if (wrappers[i] === ',') i++;

    const entry = entries.get(name);
    if (!entry) throw new ProfileBuildError(`${where}: BLOCK_WRAPPERS has a mode ${JSON.stringify(name)} that ENTRIES does not`);
    if (seen.has(name)) throw new ProfileBuildError(`${where}: two modes are named ${JSON.stringify(name)}; a consumer refuses the whole profile`);
    seen.add(name);
    const files = { [entryFile]: read(resolve(paths.pythonDir, entry), `python.modes (${name} entry module)`) };
    const mode = { name, files, block, before, after, lineOffset: before.split('\n').length - 1 };
    // What this wrapping's entry module DEFINES. `syntax`'s is deliberately not the shared call:
    // a syntax check compiles the block and a caller of __formlogic_run__ would find nothing.
    const defines = [...files[entryFile].matchAll(/^def (__formlogic_[A-Za-z0-9_]*)\(/gm)].map((m) => m[1]);
    if (defines.length !== 1) {
      throw new ProfileBuildError(
        `${where}: ${entry} defines ${defines.length} top-level __formlogic_ functions (${defines.join(', ') || 'none'}); a mode's call must be exactly one`,
      );
    }
    if (defines[0] !== python.call) mode.call = defines[0];
    modes.push(mode);
  }
  for (const name of entries.keys()) {
    if (!seen.has(name)) throw new ProfileBuildError(`${where}: ENTRIES has a mode ${JSON.stringify(name)} that BLOCK_WRAPPERS does not wrap`);
  }
  checkModes(modes, python, where);
  return modes;
}

/**
 * The faults a JSON Schema cannot state, refused here.
 *
 * The consumer refuses each of these at run time, with the whole request and every other job in
 * it; the schema cannot express any of them (they are relations between fields, not shapes), so
 * the generator is the last place they can be caught before the document is served.
 */
function checkModes(modes, python, where) {
  if (modes.length === 0) throw new ProfileBuildError(`${where}: a profile with no modes is a profile no consumer can unfold`);
  if (modes.length > 32) throw new ProfileBuildError(`${where}: ${modes.length} modes; a consumer accepts at most 32`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(python.entry)) {
    throw new ProfileBuildError(`${where}: entry must be a Python module name to unfold a mode, not ${JSON.stringify(python.entry)}`);
  }
  const contractFiles = Object.keys(python.files);
  for (const mode of modes) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(mode.name) || mode.name.length > 64) {
      throw new ProfileBuildError(`${where}: ${JSON.stringify(mode.name)} is not a name a job can carry`);
    }
    const modeFiles = Object.keys(mode.files);
    for (const file of modeFiles) {
      if (contractFiles.includes(file)) {
        throw new ProfileBuildError(`${where}: mode ${JSON.stringify(mode.name)} carries ${JSON.stringify(file)}, which would shadow the contract's own file of that name`);
      }
    }
    if (contractFiles.includes(mode.block) || modeFiles.includes(mode.block)) {
      throw new ProfileBuildError(`${where}: mode ${JSON.stringify(mode.name)} writes the author's source to ${JSON.stringify(mode.block)}, which is already a file of the project`);
    }
  }
}

/** Build the profile document from the sources on disk. Pure: no writes, no process exit. */
export function buildProfile(paths = DEFAULT_PATHS) {
  const preamble = read(paths.prelude, 'preamble source');
  const formlogicPy = read(paths.python, 'python contract source');
  const zippHost = read(paths.zippHost, 'zipp-host');
  const contract = read(paths.contract, 'python contract module');
  const vendored = JSON.parse(read(paths.vendored, 'vendored OAIY names'));

  const collision = preambleCollision(preamble, vendored);
  if (collision) {
    throw new ProfileBuildError(
      `${paths.prelude}: ${collision}. OAIY refuses such a profile outright (script-profile.schema.json, detectPreambleCollision), so the Desktop would run no FormLogic logic at all - rename it in the prelude.`,
    );
  }

  const steps = Number(
    constantFrom(
      zippHost,
      paths.zippHost,
      /^const INSTRUCTION_BUDGET_STEPS = ([\d_]+);/m,
      'instructionSteps',
    ).replace(/_/g, ''),
  );
  if (!Number.isInteger(steps) || steps < 1) {
    throw new ProfileBuildError(`instructionSteps: ${paths.zippHost} yielded ${steps}, which is not a usable budget`);
  }

  const python = {
    contract: constantFrom(contract, paths.contract, /^export const CONTRACT_ID = '([^']+)';/m, 'python.contract'),
    files: { 'formlogic.py': formlogicPy },
    entry: constantFrom(contract, paths.contract, /^export const ENTRY_MODULE = '([^']+)';/m, 'python.entry'),
    call: constantFrom(contract, paths.contract, /^export const ENTRY_FUNCTION = '([^']+)';/m, 'python.call'),
  };
  // Read last, because a mode is checked against the contract it extends: the entry module it
  // must contain, the files it may not shadow, the call it may override.
  python.modes = pythonModes(contract, paths, python);

  return {
    v: 1,
    preamble,
    preambleSha256: sha256Hex(preamble),
    instructionSteps: steps,
    python,
  };
}

/**
 * The served bytes. JSON.stringify escapes every newline inside a string as `\n`, so the
 * payload is LF whatever the file's own line endings become; the file is pinned to LF as well
 * (.gitattributes) so the ETag the server computes over these bytes is the same everywhere.
 */
export const serialize = (profile) => `${JSON.stringify(profile, null, 2)}\n`;

function parseArgs(argv) {
  const paths = { ...DEFAULT_PATHS };
  let check = false;
  const keys = { '--prelude': 'prelude', '--python': 'python', '--python-dir': 'pythonDir', '--zipp-host': 'zippHost', '--contract': 'contract', '--vendored': 'vendored', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (keys[arg]) {
      const value = argv[++i];
      if (value === undefined) throw new ProfileBuildError(`${arg} needs a path`);
      paths[keys[arg]] = resolve(value);
    } else {
      throw new ProfileBuildError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { paths, check };
}

export function main(argv) {
  const { paths, check } = parseArgs(argv);
  const text = serialize(buildProfile(paths));

  if (check) {
    if (!existsSync(paths.out)) {
      throw new ProfileBuildError(
        `${paths.out} has not been generated - run 'node scripts/build-script-profile.mjs' and commit the result`,
      );
    }
    // The committed file's OWN line endings may be CRLF on a Windows checkout; its payload
    // never is (JSON escapes it). Normalise the container before comparing so the check reports
    // semantic drift and not the checkout.
    const committed = lf(readFileSync(paths.out, 'utf8'));
    if (committed !== text) {
      throw new ProfileBuildError(
        `${paths.out} is stale: ${describeDrift(committed, text)}. Run 'node scripts/build-script-profile.mjs' and commit the result.`,
      );
    }
    console.log(`build-script-profile: ${paths.out} is current (${text.length} bytes)`);
    return;
  }

  mkdirSync(dirname(paths.out), { recursive: true });
  if (existsSync(paths.out) && lf(readFileSync(paths.out, 'utf8')) === text) {
    console.log(`build-script-profile: ${paths.out} already current (${text.length} bytes)`);
    return;
  }
  writeFileSync(paths.out, text, 'utf8');
  console.log(`build-script-profile: wrote ${paths.out} (${text.length} bytes)`);
}

/** Name what changed, so a failing --check does not send anyone diffing a 30 KB JSON file. */
function describeDrift(committed, fresh) {
  let was;
  try {
    was = JSON.parse(committed);
  } catch {
    return 'the committed file is not valid JSON';
  }
  const now = JSON.parse(fresh);
  const differing = [];
  const walk = (a, b, path) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
      const at = path ? `${path}.${key}` : key;
      const left = a?.[key];
      const right = b?.[key];
      if (left && right && typeof left === 'object' && typeof right === 'object') walk(left, right, at);
      else if (JSON.stringify(left) !== JSON.stringify(right)) differing.push(at);
    }
  };
  walk(was, now, '');
  if (differing.length === 0) return 'the fields agree but the serialisation differs (formatting or key order)';
  return `${differing.join(', ')} ${differing.length === 1 ? 'differs' : 'differ'} from the sources`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`build-script-profile: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
