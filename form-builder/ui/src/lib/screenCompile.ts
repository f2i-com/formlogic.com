// Compiles a custom-screen's TypeScript source to runnable JS for the sandboxed iframe.
//
// esbuild-wasm is lazy-loaded (a separate chunk + the wasm fetched on first use) so it never weighs on
// the public form pages — those run the already-compiled `js`. We only compile here: (1) in the Studio on
// save, and (2) at render time as a fallback when a screen has `ts` but no precompiled `js` (e.g. one an AI
// wrote over MCP). Plain JavaScript is valid input too (TS is a superset), so this also handles JS screens.

import wasmURL from 'esbuild-wasm/esbuild.wasm?url'; // just a URL string — the wasm is fetched on demand

type Esbuild = typeof import('esbuild-wasm');

let initPromise: Promise<Esbuild> | null = null;

function ensureEsbuild(): Promise<Esbuild> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import('esbuild-wasm');
      await mod.initialize({ wasmURL, worker: true });
      return mod;
    })().catch((e) => {
      initPromise = null; // let a later call retry after a transient failure
      throw e;
    });
  }
  return initPromise;
}

export interface CompileResult {
  /** Compiled JS, or '' on error / empty input. */
  js: string;
  /** A human-readable compile error (type/syntax), if any. */
  error?: string;
}

/**
 * Transpile TypeScript (or JS) custom-screen source to ES2020 JS. Strips types and downlevels syntax;
 * a single self-contained file (no bundling/imports resolution). Never throws — returns { js, error }.
 */
export async function compileScreenCode(source: string): Promise<CompileResult> {
  const src = source ?? '';
  if (src.trim() === '') {
    return { js: '' };
  }
  try {
    const esbuild = await ensureEsbuild();
    const out = await esbuild.transform(src, {
      loader: 'ts',
      target: 'es2020',
      format: 'iife',
      logLevel: 'silent',
    });
    return { js: out.code };
  } catch (e) {
    // esbuild errors carry a structured `errors` array; surface the first message + location.
    const err = e as { errors?: Array<{ text: string; location?: { line: number; column: number } }> };
    if (err?.errors?.length) {
      const first = err.errors[0];
      const loc = first.location ? ` (line ${first.location.line})` : '';
      return { js: '', error: `${first.text}${loc}` };
    }
    return { js: '', error: e instanceof Error ? e.message : 'Compile failed' };
  }
}
