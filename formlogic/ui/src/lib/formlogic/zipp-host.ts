// zipp sandbox host (browser side).
//
// Runs untrusted form-author expressions and app-logic hooks inside a zipp VM
// that has an EMPTY global object and NO host bridge. The only thing crossing the
// boundary is the form-data context, and it crosses as a JSON *value* parsed
// inside the sandbox — never concatenated into program source. The trusted
// PRELUDE standard library is the same canonical module the backend guest loads,
// so an expression means the same thing in the browser and on the server. (Runs
// claimed by OAIY Desktop do not load it.)
//
// zipp's synchronous host channel is default-deny: an Engine grants nothing until
// the host calls setSyncHostCapabilities, and this host never calls it. There is
// no db bridge, no localStorage bridge, no clipboard bridge — so the guest has
// nothing to reach for even if it knows the trampoline's name.
//
// LIMITS. Two live inside the engine; the third is deliberately outside it.
//   * instruction budget — set per Engine to INSTRUCTION_BUDGET_STEPS, the same
//     200M the backend guest uses, so a heavy expression cannot succeed at submit
//     and yet return null here (the module's own default is 50M; zipp-wasm exposes
//     `setInstructionBudget` for exactly this alignment, clamped to 2e9 so a host
//     can align but never switch the fuse off). A runaway loop exhausts it
//     deterministically. A fresh Engine is created per evaluation, so every
//     evaluation gets the whole budget. `budgetMs` only sizes the wall-clock
//     backstop — steps and milliseconds are not convertible.
//   * heap — the engine's own 512 MiB accounting, behind a 1 GiB linked maximum.
//   * wall clock — enforced by TERMINATING THE WORKER, in engine.ts. zipp's
//     browser profile omits cooperative abort polling by design and expects the
//     host to kill the Worker; engine.ts already did exactly that for QuickJS,
//     so the deadline story is unchanged.
import initZipp, { Engine, zippInstanceUsage } from '../../../vendor/zipp-wasm/zipp_wasm.js';
// Canonical standard library — single source of truth, shared with the backend
// guest (ui/scripts/sync-prelude.mjs writes the backend copy).
import PRELUDE from './prelude.js?raw';

export type EvalKind = 'condition' | 'calc' | 'validate' | 'test' | 'syntax' | 'applogic' | 'flow';

/** The subset of `zippInstanceUsage()` a host recycles on (audit ZP-01). */
export interface InstanceUsage {
  enginesCreated: number;
  enginesDisposed: number;
  /** Bytes of dynamically compiled functions/classes the instance still holds. */
  retainedBytes: number;
  dynamicCodeCalls: number;
}

/**
 * What THIS WASM instance has accumulated across every engine it disposed.
 * Every evaluation here compiles the expression dynamically, so this grows
 * with use and only a fresh instance (a new Worker) reclaims it. Returns
 * zeros before the engine is loaded or if the artifact cannot answer.
 */
export function instanceUsage(): InstanceUsage {
  try {
    const usage = zippInstanceUsage() as {
      enginesCreated?: number; enginesDisposed?: number;
      retainedFunctionBytes?: number; retainedClassBytes?: number; dynamicCodeCalls?: number;
    };
    return {
      enginesCreated: usage.enginesCreated ?? 0,
      enginesDisposed: usage.enginesDisposed ?? 0,
      retainedBytes: (usage.retainedFunctionBytes ?? 0) + (usage.retainedClassBytes ?? 0),
      dynamicCodeCalls: usage.dynamicCodeCalls ?? 0,
    };
  } catch {
    return { enginesCreated: 0, enginesDisposed: 0, retainedBytes: 0, dynamicCodeCalls: 0 };
  }
}

const DEFAULT_BUDGET_MS = 1000; // matches the backend's wall-time budget
/** Same figure as DEFAULT_MAX_STEPS in formlogic/runtime/guest/src/main.rs. */
const INSTRUCTION_BUDGET_STEPS = 200_000_000;
const MAX_OUTPUT_DEPTH = 8;

let readyPromise: Promise<void> | null = null;

/**
 * Node parity tests read the installed engine (vendor/zipp-wasm, generated from
 * the Softn release by scripts/fetch-softn-release.mjs). Browser workers receive the
 * page's verified bytes and never download another copy themselves. Keep the
 * Node-only URL dynamic so Vite does not emit a second worker-owned WASM asset.
 */
async function loadNodeWasm(): Promise<ArrayBuffer> {
  const isNode =
    typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
  const nodeArtifact = '../../../vendor/zipp-wasm/zipp_wasm_bg.wasm';
  const wasmUrl = new URL(/* @vite-ignore */ nodeArtifact, import.meta.url);
  if (isNode && wasmUrl.protocol === 'file:') {
    const fsSpecifier = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ fsSpecifier);
    const buf = await fs.readFile(wasmUrl);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  throw new Error('The app engine must be supplied by the host before evaluation.');
}

/** Instantiate the module once per Worker; compiling 5 MB of wasm per evaluation
 *  would dominate every call.
 *
 *  A load that FAILS is not memoised. It used to be: an offline first use, a
 *  transient network error, or a stale bundle whose wasm URL now hits the SPA
 *  fallback all rejected once and then rejected every later evaluation
 *  instantly for the life of the page — coming back online never recovered
 *  form logic. Now the next evaluation tries the load again. */
function ready(bytes?: ArrayBuffer): Promise<void> {
  if (!readyPromise) {
    readyPromise = (bytes ? Promise.resolve(bytes) : loadNodeWasm())
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
export function warmUp(bytes?: ArrayBuffer): Promise<void> {
  return ready(bytes);
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

  if (kind === 'flow') {
    // A Flows logic_block node. Authors write it in two styles: an expression, or
    // statements whose completion value is the result (what the eval below has
    // always accepted), and a function body with a top-level `return` (the
    // editor's placeholder). Indirect eval rejects the second with "'return'
    // outside of a function". Flow conditions do not use this kind: the desktop
    // runner evaluates them as expressions only.
    //
    // The style is decided by PARSING, before any author statement runs, so exactly
    // one path executes. The probe is a direct eval inside a throwaway function:
    // `throw 0` is its first statement, so the source is only parsed, and anything
    // it hoists stays in that function. Source that parses as a script takes the
    // unchanged eval path. Source that does not, but parses as a function body,
    // runs as that body over the same globals, so only a `return` gives it a value:
    // a trailing expression after a top-level `return` is ignored. (The OAIY
    // desktop runner parses the block and returns that trailing expression when no
    // `return` fires; there is no parser here to do the same.) Source that parses
    // as neither fails with the parse error that fits it: the function-body error
    // when it mentions `return` (so "'return' outside of a function" never hides
    // the real mistake), otherwise the eval error, as calc reports it.
    //
    // Form conditions and calculations never use this kind: they stay identical to
    // the backend guest (docs/contracts/formlogic-expression-corpus.json).
    return `${PRELUDE}
globalThis.__ctxJson = ${ctxLiteral};
${BOOTSTRAP}
var __out;
try {
  var __asBody = (function (src) {
    try { eval("throw 0;\\n" + src); return null; } catch (e) { if (e === 0) return null; }
    try { return new Function(src); } catch (e) { if (/\\breturn\\b/.test(src)) throw e; return null; }
  })(${exprLiteral});
  __out = {ok: true, value: __asBody ? __asBody() : (0, eval)(${exprLiteral})};
}
catch (e) { __out = {ok: false, error: String((e && e.message) || e)}; }
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
    engine.setInstructionBudget(INSTRUCTION_BUDGET_STEPS);
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
