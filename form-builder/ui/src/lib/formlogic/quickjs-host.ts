// QuickJS sandbox host (browser side).
//
// Runs untrusted form-author expressions/formulas inside a QuickJS WASM VM that
// has an EMPTY global object and ZERO host bindings — the only thing injected is
// the form-data context, and that crosses the boundary as a JSON *value* (parsed
// by JSON.parse inside the sandbox), never concatenated into program source. The
// trusted PRELUDE standard library is the same canonical module used by the
// backend qjs harness, so client/server results match by construction.
//
// Hard limits enforced here: memory cap, stack cap, and a wall-clock interrupt
// deadline (kills infinite loops). A coarser worker-terminate watchdog lives in
// engine.ts as a backstop for the rare case QuickJS can't interrupt (e.g. a
// pathological regex match).
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
// Canonical standard library — single source of truth, shared with the backend.
import PRELUDE from './prelude.js?raw';

export type EvalKind = 'condition' | 'calc' | 'validate' | 'test' | 'syntax' | 'applogic';

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MiB
const MAX_STACK_BYTES = 512 * 1024; // 512 KiB
const DEFAULT_BUDGET_MS = 1000; // matches backend FormLogicService wall-time
const MAX_OUTPUT_DEPTH = 8;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return modulePromise;
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
// Keys must be valid identifiers (the only kind expressions reference); this
// mirrors the previous engine's buildContextSource filtering.
const BOOTSTRAP = `;(function(){
  var __c;
  try { __c = JSON.parse(globalThis.__ctxJson || "{}"); } catch (e) { __c = {}; }
  for (var __k in __c) {
    if (Object.prototype.hasOwnProperty.call(__c, __k)
        && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(__k)
        && __k !== "__proto__" && __k !== "constructor" && __k !== "prototype") {
      globalThis[__k] = __c[__k];
    }
  }
})();
`;

function buildSource(kind: EvalKind, expression: string): string {
  if (kind === 'syntax') {
    // Parse-only: define-but-never-call so syntax is validated without executing
    // the (potentially side-effecting) expression.
    return `${PRELUDE}\n0 && (function(){ return (\n${expression}\n); });`;
  }
  if (kind === 'applogic') {
    // Custom app-logic hook. The `expression` is a full script that declares
    // `function run(ctx) { ... }`. We parse the injected JSON ctx (never string
    // concatenation) and return the result of run(ctx) as a plain JSON value.
    // Same empty-global / no-host-binding sandbox as everything else here — the
    // script gets ZERO IO; it can only return an effects/ui object that the
    // trusted host applies after permission checks.
    return `${PRELUDE}\n(function(){\n  var __ctx;\n  try { __ctx = JSON.parse(globalThis.__ctxJson || "{}"); } catch (e) { __ctx = {}; }\n  ${expression}\n  ;\n  return (typeof run === 'function') ? run(__ctx) : undefined;\n})();`;
  }
  return `${PRELUDE}\n${BOOTSTRAP}\n${expression}`;
}

export interface EvalOptions {
  budgetMs?: number;
}

/**
 * Evaluate an expression inside a fresh, disposed-after QuickJS VM.
 * Throws on guest error (syntax/runtime) or when the wall-clock budget is hit.
 */
export async function runEval(
  kind: EvalKind,
  expression: string,
  context: Record<string, unknown>,
  options: EvalOptions = {}
): Promise<unknown> {
  const mod = await getModule();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + budgetMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  const ctx = runtime.newContext();
  try {
    if (kind !== 'syntax') {
      const jsonHandle = ctx.newString(JSON.stringify(context ?? {}));
      ctx.setProp(ctx.global, '__ctxJson', jsonHandle);
      jsonHandle.dispose();
    }

    const source = buildSource(kind, expression);
    const result = ctx.evalCode(source, 'formlogic-expression.js');
    // unwrapResult throws a QuickJSError (with the guest message) on failure and
    // disposes the error handle for us.
    const handle = ctx.unwrapResult(result);
    try {
      const dumped = ctx.dump(handle);
      return sanitizeOut(dumped);
    } finally {
      handle.dispose();
    }
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
