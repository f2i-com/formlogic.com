// zipp sandbox host (browser side).
//
// Runs untrusted form-author expressions and app-logic hooks inside a zipp VM
// that has an EMPTY global object and NO host bridge. The only thing crossing the
// boundary is the form-data context, and it crosses as a JSON *value* parsed
// inside the sandbox — never concatenated into program source. The trusted
// PRELUDE standard library is the same canonical module the backend and the
// desktop load, so an expression means the same thing in all three.
//
// zipp's synchronous host channel is default-deny: an Engine grants nothing until
// the host calls setSyncHostCapabilities, and this host never calls it. There is
// no db bridge, no localStorage bridge, no clipboard bridge — so the guest has
// nothing to reach for even if it knows the trampoline's name.
//
// LIMITS. Two live inside the engine; the third is deliberately outside it.
//   * instruction budget — the module's built-in lifetime budget (see
//     `renewInstructionBudget` in the vendored d.ts; ~50M steps as built), which
//     a runaway loop exhausts deterministically. A fresh Engine is created per
//     evaluation, so every evaluation gets the whole budget. The module exposes
//     no setter, so `budgetMs` cannot be translated into steps here — it only
//     sizes the wall-clock backstop. NOTE: the backend guest allows 200M steps,
//     so a very heavy expression can succeed at submit and yet return null in
//     the browser; raising the browser side is a zipp-wasm change, not one here.
//   * heap — the engine's own 512 MiB accounting, behind a 1 GiB linked maximum.
//   * wall clock — enforced by TERMINATING THE WORKER, in engine.ts. zipp's
//     browser profile omits cooperative abort polling by design and expects the
//     host to kill the Worker; engine.ts already did exactly that for QuickJS,
//     so the deadline story is unchanged.
import initZipp, { Engine } from '../../../vendor/zipp-wasm/zipp_wasm.js';
// `new URL(..., import.meta.url)` rather than Vite's `?url`: the same module has
// to instantiate in a browser Worker AND under vitest's Node environment, and a
// root-relative `/vendor/...` string is not a URL Node can resolve. Vite still
// fingerprints and emits the asset from this form.
const wasmUrl = new URL('../../../vendor/zipp-wasm/zipp_wasm_bg.wasm', import.meta.url);
// Canonical standard library — single source of truth, shared with the backend
// and the desktop (ui/scripts/sync-prelude.mjs writes the copies).
import PRELUDE from './prelude.js?raw';

export type EvalKind = 'condition' | 'calc' | 'validate' | 'test' | 'syntax' | 'applogic';

const DEFAULT_BUDGET_MS = 1000; // matches the backend's wall-time budget
const MAX_OUTPUT_DEPTH = 8;

let readyPromise: Promise<void> | null = null;

/**
 * Get the wasm bytes in whichever environment we are in.
 *
 * The browser (and the Worker) fetches the emitted asset. Node — which is where
 * the parity suite runs — cannot `fetch` a `file:` URL, so it reads the file. The
 * specifier is held in a variable so the bundler cannot statically see a Node
 * built-in and try to bundle it for the browser.
 */
async function loadWasm(): Promise<ArrayBuffer | Response> {
  const isNode =
    typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
  if (isNode && wasmUrl.protocol === 'file:') {
    const fsSpecifier = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ fsSpecifier);
    const buf = await fs.readFile(wasmUrl);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  return fetch(wasmUrl);
}

/** Instantiate the module once per Worker; compiling 5 MB of wasm per evaluation
 *  would dominate every call.
 *
 *  A load that FAILS is not memoised. It used to be: an offline first use, a
 *  transient network error, or a stale bundle whose wasm URL now hits the SPA
 *  fallback all rejected once and then rejected every later evaluation
 *  instantly for the life of the page — coming back online never recovered
 *  form logic. Now the next evaluation tries the load again. */
function ready(): Promise<void> {
  if (!readyPromise) {
    readyPromise = loadWasm()
      .then((source) => initZipp({ module_or_path: source as never }))
      .then(() => undefined)
      .catch((err: unknown) => {
        readyPromise = null;
        throw err;
      });
  }
  return readyPromise;
}

/**
 * Load the engine without evaluating anything. The Worker calls this as soon as
 * it starts so the 5 MB download and compile happen once, up front, and so
 * engine.ts can tell "still loading" apart from "evaluating" — the per-call
 * watchdog must not count the load, or a cold cache on a slow link kills the
 * Worker mid-download on every attempt and fails every condition open.
 */
export function warmUp(): Promise<void> {
  return ready();
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Deep-copy a value coming OUT of the sandbox into inert, pollution-safe data:
// drop prototype-polluting keys, cap depth, keep only JSON-ish values.
function sanitizeOut(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return value;
  if (depth >= MAX_OUTPUT_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeOut(v, depth + 1));
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = sanitizeOut(v, depth + 1);
    }
    return out;
  }
  // functions, symbols, bigint, etc. are not transferable — drop.
  return null;
}

// Installs the form-data context as globals by parsing an injected JSON value.
// Keys must be valid identifiers (the only kind expressions reference).
const BOOTSTRAP = `;(function(){
  var __c;
  try { __c = JSON.parse(globalThis.__ctxJson || "{}"); } catch (e) { __c = {}; }
  for (var __k in __c) {
    if (Object.prototype.hasOwnProperty.call(__c, __k)
        && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(__k)
        && __k !== "__proto__" && __k !== "constructor" && __k !== "prototype"
        && __k.indexOf("__") !== 0) {
      globalThis[__k] = __c[__k];
    }
  }
})();
`;

/**
 * The program compiled for one evaluation.
 *
 * The expression is NOT part of this source. It is passed as a string and run
 * through indirect eval, for two reasons: it reproduces the browser's previous
 * `evalCode` semantics exactly (a program in global scope, seeing the prelude and
 * the injected context but no wrapper locals), and it keeps a malformed
 * expression a catchable SyntaxError rather than a compile failure that would
 * take the whole program — zipp rejects bad syntax when a script is compiled.
 */
function buildProgram(kind: EvalKind, expression: string, contextJson: string): string {
  const ctxLiteral = JSON.stringify(contextJson);
  const exprLiteral = JSON.stringify(expression);

  if (kind === 'syntax') {
    // Parse-only, and actually parse-only. The previous form concatenated the
    // expression into a program string for indirect eval, so an expression of
    // the shape `1); })(); <anything>; (function(){ return (1` closed the
    // wrapper and ran <anything>. `new Function` parses its body standalone —
    // an unbalanced `}` is a SyntaxError, not an escape — and the function is
    // never invoked, so a side-effecting expression stays inert. Same
    // single-expression contract validateExpression has always had.
    return `${PRELUDE}
var __out;
try { new Function("return (" + ${exprLiteral} + "\\n);"); __out = {ok: true, value: null}; }
catch (e) { __out = {ok: false, error: String((e && e.message) || e)}; }
__emit(__out);`;
  }

  if (kind === 'applogic') {
    // A full script declaring `function run(ctx) {…}`. It gets ZERO IO; it can
    // only return an effects/ui object the trusted host applies after permission
    // checks.
    return `${PRELUDE}
var __out;
try {
  var __ctx;
  try { __ctx = JSON.parse(${ctxLiteral}); } catch (e) { __ctx = {}; }
  var __run = new Function(${exprLiteral} + "\\nreturn typeof run === 'function' ? run : null;")();
  __out = {ok: true, value: (typeof __run === 'function') ? __run(__ctx) : undefined};
} catch (e) { __out = {ok: false, error: String((e && e.message) || e)}; }
__emit(__out);`;
  }

  return `${PRELUDE}
globalThis.__ctxJson = ${ctxLiteral};
${BOOTSTRAP}
var __out;
try { __out = {ok: true, value: (0, eval)(${exprLiteral})}; }
catch (e) { __out = {ok: false, error: String((e && e.message) || e)}; }
__emit(__out);`;
}

/** The reply channel, plus stubs so a guest cannot write anywhere the host reads. */
const EMIT_PREAMBLE = `var __replies = [];
function __emit(o) { __replies.push(o); }
globalThis.print = function () {};
globalThis.console = { log: function(){}, warn: function(){}, error: function(){}, info: function(){}, debug: function(){} };
`;

export interface EvalOptions {
  budgetMs?: number;
}

/**
 * The guest raised — a syntax error, a reference error, an explicit `throw`.
 *
 * This is a legitimate RESULT for some expressions, not a malfunction, and a
 * caller must be able to tell it apart from the host itself failing (wasm did not
 * instantiate, the Worker died). Previously that discrimination borrowed a type
 * from quickjs-emscripten's internals; owning it here means the distinction
 * survives an engine change.
 */
export class SandboxGuestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxGuestError';
  }
}

/**
 * Evaluate an expression inside a fresh, disposed-after zipp VM.
 * Throws on guest error (syntax/runtime).
 */
export async function runEval(
  kind: EvalKind,
  expression: string,
  context: Record<string, unknown>,
  options: EvalOptions = {}
): Promise<unknown> {
  await ready();
  void (options.budgetMs ?? DEFAULT_BUDGET_MS); // the deadline is the Worker's; see the header

  const contextJson = kind === 'syntax' ? '{}' : JSON.stringify(context ?? {});
  const program = EMIT_PREAMBLE + buildProgram(kind, expression, contextJson);

  // A fresh Engine per evaluation, with no capabilities granted and no bridges
  // installed: one expression can never observe or influence another.
  const engine = new Engine();
  try {
    engine.initScript(program);
    const replies = engine.evalInContext('__replies.length ? __replies[__replies.length - 1] : null');
    if (!replies || typeof replies !== 'object') {
      throw new Error('FormLogic sandbox produced no result');
    }
    const outcome = replies as { ok?: boolean; value?: unknown; error?: string };
    if (outcome.ok !== true) {
      throw new SandboxGuestError(outcome.error || 'evaluation failed');
    }
    return sanitizeOut(outcome.value);
  } finally {
    engine.dispose();
  }
}
