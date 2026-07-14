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

export interface ScreenFile {
  path: string;
  content: string;
}

/** Normalize a POSIX-ish path, resolving '.' and '..' segments. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Resolve a relative import (from `importer`) against the file map, trying common extensions/index files. */
function resolveRelative(importer: string, spec: string, map: Map<string, string>): string | null {
  const dir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '';
  const base = normalizePath(`${dir}/${spec}`);
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  return candidates.find((c) => map.has(c)) ?? null;
}

const ENTRY_CANDIDATES = ['index.tsx', 'index.ts', 'main.tsx', 'main.ts', 'app.tsx', 'app.ts'];

/**
 * Bundle a multi-file screen project (TypeScript/JS with relative imports) into one runnable JS via
 * esbuild-wasm + a virtual filesystem. Returns the shell html, concatenated css, and the bundled js.
 * npm/bare imports are not supported (the sandbox has no network) — only relative imports between files.
 */
export async function bundleScreenFiles(files: ScreenFile[], entry?: string): Promise<{ html: string; css: string; js: string; error?: string }> {
  const map = new Map(files.map((f) => [normalizePath(f.path), f.content]));
  const html = map.get('index.html') ?? '<div id="root"></div>';
  const css = files.filter((f) => /\.css$/i.test(f.path)).map((f) => f.content).join('\n');
  const entryPath = (entry && map.has(normalizePath(entry)) ? normalizePath(entry) : null)
    ?? ENTRY_CANDIDATES.find((c) => map.has(c));
  if (!entryPath) {
    return { html, css, js: '', error: 'No entry file — add an index.ts (or index.tsx).' };
  }
  try {
    const esbuild = await ensureEsbuild();
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2020',
      logLevel: 'silent',
      plugins: [{
        name: 'formlogic-vfs',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return { path: normalizePath(args.path), namespace: 'vfs' };
            if (args.path.startsWith('.')) {
              const resolved = resolveRelative(args.importer, args.path, map);
              return resolved ? { path: resolved, namespace: 'vfs' } : { errors: [{ text: `Cannot find module '${args.path}' (imported by ${args.importer})` }] };
            }
            return { errors: [{ text: `Bare/npm imports aren't supported here: '${args.path}'. Use relative imports between your files.` }] };
          });
          build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
            const contents = map.get(args.path);
            if (contents === undefined) return { errors: [{ text: `Missing file: ${args.path}` }] };
            const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
            const loader = ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : ext === 'json' ? 'json' : ext === 'css' ? 'css' : 'js';
            return { contents, loader };
          });
        },
      }],
    });
    // esbuild-wasm names the in-memory output '<stdout>', so match .js OR fall back to the first output.
    const jsOut = result.outputFiles.find((o) => o.path.endsWith('.js')) ?? result.outputFiles[0];
    return { html, css, js: jsOut?.text ?? '' };
  } catch (e) {
    const err = e as { errors?: Array<{ text: string; location?: { line: number } | null }> };
    if (err?.errors?.length) {
      const f = err.errors[0];
      return { html, css, js: '', error: `${f.text}${f.location ? ` (line ${f.location.line})` : ''}` };
    }
    return { html, css, js: '', error: e instanceof Error ? e.message : 'Bundle failed' };
  }
}

/**
 * Resolve a screen (single-file OR multi-file) to the { html, css, js } the sandbox iframe runs.
 * Prefers a multi-file `files` project; else precompiled `js`; else compiles single-file `ts`.
 */
export async function resolveScreenAssets(screen: { html?: string; css?: string; js?: string; ts?: string; files?: ScreenFile[]; entry?: string }): Promise<{ html: string; css: string; js: string; error?: string }> {
  // Prefer the precompiled artifact (the Studio bundles/compiles on save + stores derived html/css), so
  // public/runtime pages never load esbuild. Only bundle/compile on the fly when there's no `js`.
  if (screen.js) {
    return { html: screen.html || '', css: screen.css || '', js: screen.js };
  }
  if (screen.files && screen.files.length > 0) {
    return bundleScreenFiles(screen.files, screen.entry);
  }
  if (screen.ts && screen.ts.trim()) {
    const r = await compileScreenCode(screen.ts);
    return { html: screen.html || '', css: screen.css || '', js: r.js, error: r.error };
  }
  return { html: screen.html || '', css: screen.css || '', js: '' };
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
