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
//   * The per-mode Python wrappers, entries and line offsets (pythonContract.ts BLOCK_WRAPPERS,
//     ENTRIES, LINE_OFFSETS). The landed schema has no carrier for them and inventing one here
//     would serve a document no consumer can read. See docs/FORMLOGIC_DESKTOP.md for what a
//     consumer consequently cannot do.
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
//   --prelude/--python/--zipp-host/--contract/--out  override an input or the output (tests)
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

  return {
    v: 1,
    preamble,
    preambleSha256: sha256Hex(preamble),
    instructionSteps: steps,
    python: {
      contract: constantFrom(contract, paths.contract, /^export const CONTRACT_ID = '([^']+)';/m, 'python.contract'),
      files: { 'formlogic.py': formlogicPy },
      entry: constantFrom(contract, paths.contract, /^export const ENTRY_MODULE = '([^']+)';/m, 'python.entry'),
      call: constantFrom(contract, paths.contract, /^export const ENTRY_FUNCTION = '([^']+)';/m, 'python.call'),
    },
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
  const keys = { '--prelude': 'prelude', '--python': 'python', '--zipp-host': 'zippHost', '--contract': 'contract', '--vendored': 'vendored', '--out': 'out' };
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
