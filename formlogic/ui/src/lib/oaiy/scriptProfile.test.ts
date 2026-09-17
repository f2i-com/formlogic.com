// @vitest-environment node
//
// The served leaf-script profile, held to the consumer's own rules.
//
// FormLogic serves `formlogic/backend/resources/formlogic-script-profile.json` to an OAIY
// Desktop, which validates it before it runs a single line of a user's logic and refuses the
// whole document on any fault. This file is the place that refusal is caught instead: it
// validates the committed bytes against a VENDORED copy of OAIY's schema, proves the digest
// matches the preamble byte for byte, and proves the served sources are byte-identical to the
// `?raw` modules the browser host itself runs. Nothing here imports across repositories - the
// schema is a copy, with its provenance recorded beside it.
//
// The negative controls matter as much as the positives. The plans this work came from
// described a body with `id`, `revision`, `budgetsMs` and a `python` section carrying `kinds`
// and `lineOffsets`; the schema is `additionalProperties: false` in both places, so every one of
// those is a refusal. `rejects the shapes the earlier plans described` is the test that would
// have caught it before anything was written.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import PRELUDE from '../formlogic/prelude.js?raw';
import FORMLOGIC_PY from '../formlogic/python/formlogic.py?raw';
import {
  BLOCK_WRAPPERS,
  CONTRACT_FILES,
  CONTRACT_ID,
  ENTRIES,
  ENTRY_FUNCTION,
  ENTRY_MODULE,
  LINE_OFFSETS,
  type PythonMode,
} from '../formlogic/python/pythonContract';
import provenance from './vendored/provenance.json';
import schema from './vendored/script-profile.schema.json';

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const PROFILE_FILE = at('../../../../backend/resources/formlogic-script-profile.json');
const SCHEMA_FILE = at('./vendored/script-profile.schema.json');

const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The wrappings the document carries, as a consumer reads them. */
interface ServedMode {
  name: string;
  files: Record<string, string>;
  block: string;
  before: string;
  after: string;
  lineOffset: number;
  call?: string;
}

const servedBytes = readFileSync(PROFILE_FILE);
const servedText = servedBytes.toString('utf8');
const profile = JSON.parse(servedText) as Record<string, unknown>;
const servedModes = ((profile.python as { modes?: ServedMode[] } | undefined)?.modes ?? []) as ServedMode[];

// ---------------------------------------------------------------------------
// A validator for exactly the schema that is vendored.
// ---------------------------------------------------------------------------

/**
 * Walk a JSON Schema document and report why a value fails it.
 *
 * Purpose-built rather than a dependency, and deliberately FAIL-CLOSED: an unrecognised keyword
 * throws instead of being skipped. A validator that quietly ignores what it does not understand
 * is worse than none, because refreshing the vendored schema with a new constraint would leave
 * this test green while the consumer started refusing the document. Only the keywords the
 * vendored schema actually uses are implemented; the day it uses another one, this throws and
 * names it.
 */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', '$defs', 'examples', 'default']);

function validate(value: unknown, node: unknown, where = 'profile', root: unknown = schema): string[] {
  if (typeof node === 'boolean') return node ? [] : [`${where}: schema forbids any value here`];
  if (typeof node !== 'object' || node === null) throw new Error(`${where}: schema node is not an object`);
  const rules = node as Record<string, unknown>;
  const errors: string[] = [];

  for (const keyword of Object.keys(rules)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case '$ref': {
        const ref = rules.$ref as string;
        const m = /^#\/\$defs\/(.+)$/.exec(ref);
        if (!m) throw new Error(`${where}: unsupported $ref ${ref}`);
        const defs = (root as { $defs?: Record<string, unknown> }).$defs ?? {};
        if (!(m[1] in defs)) throw new Error(`${where}: $ref ${ref} does not resolve`);
        errors.push(...validate(value, defs[m[1]], where, root));
        break;
      }
      case 'not':
        if (validate(value, rules.not, where, root).length === 0) errors.push(`${where}: must not match the forbidden schema`);
        break;
      case 'const':
        if (value !== rules.const) errors.push(`${where}: must be ${JSON.stringify(rules.const)}`);
        break;
      case 'enum':
        if (!(rules.enum as unknown[]).includes(value)) errors.push(`${where}: must be one of ${JSON.stringify(rules.enum)}`);
        break;
      case 'type': {
        const kind = rules.type as string;
        const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
        const ok = kind === 'integer' ? Number.isInteger(value) : kind === 'object' ? actual === 'object' : actual === kind;
        if (!ok) errors.push(`${where}: must be ${kind}, got ${actual}`);
        break;
      }
      case 'required':
        for (const key of rules.required as string[]) {
          if (!isObject(value) || !(key in value)) errors.push(`${where}: missing required property ${JSON.stringify(key)}`);
        }
        break;
      case 'properties':
        if (isObject(value)) {
          for (const [key, sub] of Object.entries(rules.properties as Record<string, unknown>)) {
            if (key in value) errors.push(...validate(value[key], sub, `${where}.${key}`, root));
          }
        }
        break;
      case 'additionalProperties':
        if (isObject(value)) {
          const named = new Set(Object.keys((rules.properties as Record<string, unknown>) ?? {}));
          for (const key of Object.keys(value)) {
            if (named.has(key)) continue;
            if (rules.additionalProperties === false) errors.push(`${where}: unknown property ${JSON.stringify(key)}`);
            else errors.push(...validate(value[key], rules.additionalProperties, `${where}[${JSON.stringify(key)}]`, root));
          }
        }
        break;
      case 'propertyNames':
        if (isObject(value)) {
          for (const key of Object.keys(value)) errors.push(...validate(key, rules.propertyNames, `${where}: property name ${JSON.stringify(key)}`, root));
        }
        break;
      case 'items':
        if (Array.isArray(value)) {
          value.forEach((item, index) => errors.push(...validate(item, rules.items, `${where}[${index}]`, root)));
        }
        break;
      case 'minItems':
        if (Array.isArray(value) && value.length < (rules.minItems as number)) {
          errors.push(`${where}: needs at least ${rules.minItems} items`);
        }
        break;
      case 'maxItems':
        if (Array.isArray(value) && value.length > (rules.maxItems as number)) {
          errors.push(`${where}: has more than ${rules.maxItems} items`);
        }
        break;
      case 'minProperties':
        if (isObject(value) && Object.keys(value).length < (rules.minProperties as number)) {
          errors.push(`${where}: needs at least ${rules.minProperties} properties`);
        }
        break;
      case 'pattern':
        if (typeof value === 'string' && !new RegExp(rules.pattern as string).test(value)) {
          errors.push(`${where}: must match ${rules.pattern}`);
        }
        break;
      case 'minLength':
        if (typeof value === 'string' && value.length < (rules.minLength as number)) errors.push(`${where}: shorter than ${rules.minLength}`);
        break;
      case 'maxLength':
        if (typeof value === 'string' && value.length > (rules.maxLength as number)) errors.push(`${where}: longer than ${rules.maxLength}`);
        break;
      case 'minimum':
        if (typeof value === 'number' && value < (rules.minimum as number)) errors.push(`${where}: below ${rules.minimum}`);
        break;
      case 'maximum':
        if (typeof value === 'number' && value > (rules.maximum as number)) errors.push(`${where}: above ${rules.maximum}`);
        break;
      default:
        throw new Error(
          `${where}: the vendored schema uses the keyword ${JSON.stringify(keyword)}, which this validator does not implement - ` +
            'implement it rather than letting the document go unchecked',
        );
    }
  }
  return errors;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('the vendored copy of OAIY script-profile.schema.json', () => {
  it('is byte-identical to the oaiy.com blob its provenance names', () => {
    // A git blob hash is sha1("blob <bytes>\0" + content), so recomputing it here and comparing
    // it to the recorded id proves the copy is the named revision of the real file - not a
    // reformatted, hand-edited or half-refreshed version of it. `git -C ../oaiy.com rev-parse
    // <commit>:protocol/v1/script-profile.schema.json` is the other half of the check.
    const content = Buffer.from(lf(readFileSync(SCHEMA_FILE, 'utf8')), 'utf8');
    const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
    const blob = createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
    expect(blob).toBe(provenance.schema.blobSha1);
  });

  it('still refuses every extra key, which is the whole reason the profile is bare', () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.python.additionalProperties).toBe(false);
  });
});

describe('the served profile document', () => {
  it('validates against the vendored schema', () => {
    expect(validate(profile, schema)).toEqual([]);
  });

  it('rejects the shapes the earlier plans described', () => {
    // These are not hypotheticals: both were written down as the body to serve, and both would
    // have been refused by the consumer on arrival.
    const withEnvelope = { ...profile, id: 'formlogic', revision: 3, budgetsMs: { condition: 1000 } };
    expect(validate(withEnvelope, schema)).toEqual(
      expect.arrayContaining([
        'profile: unknown property "id"',
        'profile: unknown property "revision"',
        'profile: unknown property "budgetsMs"',
      ]),
    );

    const python = profile.python as Record<string, unknown>;
    const withPythonExtras = { ...profile, python: { ...python, kinds: { flow: { attempts: 2 } }, lineOffsets: { flowExpression: 3 } } };
    expect(validate(withPythonExtras, schema)).toEqual(
      expect.arrayContaining(['profile.python: unknown property "kinds"', 'profile.python: unknown property "lineOffsets"']),
    );
  });

  it('is refused when the digest, the version or a required field is wrong', () => {
    expect(validate({ ...profile, preambleSha256: 'NOT-A-DIGEST' }, schema)).toContain(
      'profile.preambleSha256: must match ^[0-9a-f]{64}$',
    );
    expect(validate({ ...profile, v: 2 }, schema)).toContain('profile.v: must be 1');
    const withoutPreamble = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== 'preamble'));
    expect(validate(withoutPreamble, schema)).toContain('profile: missing required property "preamble"');
    const python = profile.python as Record<string, unknown>;
    expect(validate({ ...profile, python: { ...python, files: {} } }, schema)).toContain(
      'profile.python.files: needs at least 1 properties',
    );
  });

  it('carries exactly the keys the schema allows, and no envelope', () => {
    expect(Object.keys(profile).sort()).toEqual(['instructionSteps', 'preamble', 'preambleSha256', 'python', 'v']);
    expect(Object.keys(profile.python as object).sort()).toEqual(['call', 'contract', 'entry', 'files', 'modes']);
    // `hooks` is absent on purpose: the schema's hooks name `prepare` functions THE PREAMBLE
    // DEFINES, FormLogic's preamble is the prelude and defines none, and a job carries its own
    // `prepare` anyway. Naming one here would make every job that used it fail with
    // "prepare hook '…' is not a function".
    expect(profile.hooks).toBeUndefined();
  });
});

describe('the served bytes', () => {
  it('are LF only, on every checkout', () => {
    // .gitattributes has no `text=auto` and this repository is developed with core.autocrlf=true,
    // so prelude.js checks out CRLF on Windows and LF on Linux. The digest below is taken over
    // these bytes and the consumer refuses a profile whose digest does not match, so a CR that
    // survived to here would make the document valid on one machine and invalid on every other.
    expect(servedText).not.toMatch(/\r/);
    expect(servedText).not.toContain('\\r');
    expect(profile.preamble as string).not.toMatch(/\r/);
    for (const [name, source] of Object.entries((profile.python as { files: Record<string, string> }).files)) {
      expect(source, `${name} must be LF-only`).not.toMatch(/\r/);
    }
    for (const mode of servedModes) {
      for (const [name, source] of Object.entries(mode.files)) expect(source, `${mode.name}/${name} must be LF-only`).not.toMatch(/\r/);
      expect(mode.before, `${mode.name} before must be LF-only`).not.toMatch(/\r/);
      expect(mode.after, `${mode.name} after must be LF-only`).not.toMatch(/\r/);
    }
  });

  it('hash to the preambleSha256 the document declares', () => {
    expect(sha256(profile.preamble as string)).toBe(profile.preambleSha256);
    // …and the digest is of the preamble alone, not of the document: a consumer recomputing it
    // over anything else would refuse every profile FormLogic ever serves.
    expect((profile.preambleSha256 as string)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('what crosses is what the browser host itself runs', () => {
  it("serves the prelude zipp-host.ts imports, byte for byte", () => {
    // zipp-host.ts:39 `import PRELUDE from './prelude.js?raw'` - the same module specifier, so
    // this is a comparison against the bytes the browser evaluates, not against a copy of them.
    expect(profile.preamble).toBe(lf(PRELUDE));
  });

  it("serves the formlogic.py pythonContract.ts imports, byte for byte", () => {
    // pythonContract.ts:23 `import FORMLOGIC_PY from './formlogic.py?raw'`, re-exported at :45-47
    // as CONTRACT_FILES. Both are asserted: the raw file, and the frozen map the host passes to
    // initPythonProject.
    const files = (profile.python as { files: Record<string, string> }).files;
    expect(Object.keys(files)).toEqual(['formlogic.py']);
    expect(files['formlogic.py']).toBe(lf(FORMLOGIC_PY));
    expect(files['formlogic.py']).toBe(CONTRACT_FILES['formlogic.py']);
  });

  it('names the contract, entry and call the host uses', () => {
    // The generator reads these out of pythonContract.ts by pattern; this pins the pattern to
    // the real exported constants, so a rename that the generator silently mis-read fails here.
    const python = profile.python as Record<string, unknown>;
    expect(python.contract).toBe(CONTRACT_ID);
    expect(python.entry).toBe(ENTRY_MODULE);
    expect(python.call).toBe(ENTRY_FUNCTION);
  });

  it("declares the browser host's own instruction budget", () => {
    // zipp-host.ts:109 INSTRUCTION_BUDGET_STEPS. Read from the source rather than restated, for
    // the same reason the generator reads it: a second copy of a budget is a budget that drifts.
    const host = readFileSync(at('../formlogic/zipp-host.ts'), 'utf8');
    const declared = /^const INSTRUCTION_BUDGET_STEPS = ([\d_]+);/m.exec(host);
    expect(declared, 'zipp-host.ts no longer declares INSTRUCTION_BUDGET_STEPS').not.toBeNull();
    expect(profile.instructionSteps).toBe(Number(declared![1].replace(/_/g, '')));
  });
});

describe('the wrappings a consumer unfolds (python.modes)', () => {
  it('carries one mode per wrapping the browser host uses, in the order the host declares them', () => {
    // Not a second list: the modes ARE BLOCK_WRAPPERS' keys, which are the PythonMode union, so
    // a wrapping added to the host without a served mode fails here rather than on a Desktop.
    expect(servedModes.map((mode) => mode.name)).toEqual(Object.keys(BLOCK_WRAPPERS));
  });

  it('serves the wrapper text, the entry module and the line offset the host wraps with, byte for byte', () => {
    for (const mode of servedModes) {
      const name = mode.name as PythonMode;
      const [before, after] = BLOCK_WRAPPERS[name];
      expect(mode.before, `${name} before`).toBe(before);
      expect(mode.after, `${name} after`).toBe(after);
      expect(mode.files, `${name} files`).toEqual({ [`${ENTRY_MODULE}.py`]: ENTRIES[name] });
      expect(mode.block, `${name} block`).toBe('logic_block.py');
      // The number a consumer SUBTRACTS. It is LINE_OFFSETS, and it is the newline count of
      // `before` - the two are asserted separately because the consumer derives nothing: a
      // lineOffset one out reports every error against the wrong line of the author's code.
      expect(mode.lineOffset, `${name} lineOffset`).toBe(LINE_OFFSETS[name]);
      expect(mode.lineOffset, `${name} lineOffset is the wrapper's newline count`).toBe(before.split('\n').length - 1);
    }
  });

  it('names its own call only where the entry module defines one that is not the shared call', () => {
    // `syntax`'s entry defines __formlogic_compiled__ on purpose: the block is compiled when the
    // project initialises, so the function a consumer calls has nothing to do and - the point -
    // does not import the block, which would run it. Every other entry answers __formlogic_run__,
    // and the schema asks for `call` to be omitted where that is so.
    for (const mode of servedModes) {
      const entry = ENTRIES[mode.name as PythonMode];
      const defines = [...entry.matchAll(/^def (__formlogic_[A-Za-z0-9_]*)\(/gm)].map((m) => m[1]);
      expect(defines, `${mode.name} entry module`).toHaveLength(1);
      expect(mode.call ?? (profile.python as { call: string }).call, `${mode.name} call`).toBe(defines[0]);
    }
    expect(servedModes.filter((mode) => 'call' in mode).map((mode) => mode.name)).toEqual(['syntax']);
  });

  it('unfolds to a project the consumer can actually run', () => {
    // The four faults `pythonMode`'s own description says a JSON Schema cannot state, and which
    // the consumer refuses at run time WITH THE WHOLE REQUEST. The generator refuses them too;
    // this proves the served document is not one of them.
    const python = profile.python as { files: Record<string, string>; entry: string };
    const contractFiles = Object.keys(python.files);
    expect(new Set(servedModes.map((mode) => mode.name)).size).toBe(servedModes.length);
    for (const mode of servedModes) {
      const files = Object.keys(mode.files);
      expect(files.filter((file) => contractFiles.includes(file)), `${mode.name} shadows a contract file`).toEqual([]);
      expect([...contractFiles, ...files]).not.toContain(mode.block);
      expect(
        [...contractFiles, ...files].some((file) => file === python.entry || file === `${python.entry}.py`),
        `${mode.name} has no ${python.entry} module`,
      ).toBe(true);
    }
  });

  it('is refused when a mode carries an unknown key or drops a required one', () => {
    // The negative controls that matter for a widening: `modes` is `additionalProperties: false`
    // like the rest of the document, so a field invented here is a refusal, not an ignored extra.
    const python = profile.python as Record<string, unknown>;
    const [first, ...rest] = servedModes;
    const withExtra = { ...profile, python: { ...python, modes: [{ ...first, kind: 'flow' }, ...rest] } };
    expect(validate(withExtra, schema)).toContain('profile.python.modes[0]: unknown property "kind"');
    const withoutOffset = { ...first } as Record<string, unknown>;
    delete withoutOffset.lineOffset;
    expect(validate({ ...profile, python: { ...python, modes: [withoutOffset, ...rest] } }, schema)).toContain(
      'profile.python.modes[0]: missing required property "lineOffset"',
    );
    expect(validate({ ...profile, python: { ...python, modes: [] } }, schema)).toContain('profile.python.modes: needs at least 1 items');
    expect(validate({ ...profile, python: { ...python, modes: [{ ...first, name: 'not a name' }, ...rest] } }, schema)).toContain(
      'profile.python.modes[0].name: must match ^[A-Za-z][A-Za-z0-9_-]*$',
    );
  });
});

describe("the protocols FormLogic tells a release it speaks", () => {
  it('claims script and profile, and not run', async () => {
    const { OAIY_PROTOCOLS, PROFILE_PROTOCOL, SCRIPT_PROTOCOL } = await import('./protocol');
    expect(Object.keys(OAIY_PROTOCOLS).sort()).toEqual(['profile', 'script']);
    expect(SCRIPT_PROTOCOL).toBe(1);
    expect(PROFILE_PROTOCOL).toBe(1);
    // `run` is OAIY's own workflow runner. FormLogic never invokes it, and claiming it would
    // make PR-D's fetcher refuse a release over a protocol FormLogic does not exercise.
    expect('run' in OAIY_PROTOCOLS).toBe(false);
  });
});
