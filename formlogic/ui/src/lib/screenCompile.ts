// Compiles a custom-screen's TypeScript/TSX source to runnable JS for the sandboxed iframe.
//
// esbuild-wasm is lazy-loaded (a separate chunk + the wasm fetched on first use) so it never weighs on
// the public form pages — those run the already-compiled `js`. We only compile here: (1) in the Studio on
// save, and (2) at render time as a fallback when a screen has `ts`/`files` but no precompiled `js`
// (e.g. one an AI wrote over MCP). Plain JavaScript is valid input too (TS is a superset).
//
// TSX/JSX: components run on PREACT, bundled into the output from an embedded module table
// (screenVendorModules — lazy chunk). 'react' / 'react-dom/client' alias to preact/compat, so normal
// React-style code (`import { useState } from 'react'` + `createRoot(...)`) works unchanged inside the
// sandbox. JSX uses the automatic runtime (jsxImportSource: 'preact') — no pragma needed.

import wasmURL from 'esbuild-wasm/esbuild.wasm?url'; // just a URL string — the wasm is fetched on demand
import type { Plugin } from 'esbuild-wasm';

type Esbuild = typeof import('esbuild-wasm');
/** The slice of the esbuild API the bundler needs — lets tests inject the native `esbuild` package. */
export type EsbuildLike = Pick<Esbuild, 'build'>;
type Vendors = typeof import('./screenVendorModules');

let initPromise: Promise<Esbuild> | null = null;
let esbuildOverride: EsbuildLike | null = null;

/** Tests only: inject the native `esbuild` package so bundling runs without the wasm loader. */
export function __setEsbuildForTests(impl: EsbuildLike | null): void {
  esbuildOverride = impl;
}

function ensureEsbuild(): Promise<EsbuildLike> {
  if (esbuildOverride) return Promise.resolve(esbuildOverride);
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

let vendorsPromise: Promise<Vendors> | null = null;

/** The embedded preact/react module table — its ~30KB of sources load lazily with the compiler. */
function ensureVendors(): Promise<Vendors> {
  if (!vendorsPromise) vendorsPromise = import('./screenVendorModules');
  return vendorsPromise;
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

/** The virtual-filesystem + embedded-vendor resolver shared by every screen bundle. */
function screenVfsPlugin(map: Map<string, string>, vendors: Vendors): Plugin {
  return {
    name: 'formlogic-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: normalizePath(args.path), namespace: 'vfs' };
        // Imports INSIDE an embedded vendor module (e.g. compat → 'preact') stay in the table.
        if (args.namespace === 'vendor') {
          const id = vendors.resolveVendorId(args.path);
          return id
            ? { path: id, namespace: 'vendor' }
            : { errors: [{ text: `Unresolvable built-in import '${args.path}'` }] };
        }
        if (args.path.startsWith('.')) {
          // CSS is injected into the page separately (all .css files concatenate into the shell),
          // so a JS-side `import './styles.css'` — a habit AI/React authors bring — is a no-op.
          if (/\.css$/i.test(args.path)) return { path: '\0css-stub', namespace: 'css-stub' };
          const resolved = resolveRelative(args.importer, args.path, map);
          return resolved ? { path: resolved, namespace: 'vfs' } : { errors: [{ text: `Cannot find module '${args.path}' (imported by ${args.importer})` }] };
        }
        const id = vendors.resolveVendorId(args.path);
        if (id) return { path: id, namespace: 'vendor' };
        return { errors: [{ text: `npm imports aren't supported here: '${args.path}'. Built-ins: ${vendors.VENDOR_IMPORT_HINT} (JSX components run on Preact). Use relative imports for your own files.` }] };
      });
      build.onLoad({ filter: /.*/, namespace: 'vendor' }, (args) => ({
        contents: vendors.VENDOR_MODULES[args.path] ?? '',
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
        const contents = map.get(args.path);
        if (contents === undefined) return { errors: [{ text: `Missing file: ${args.path}` }] };
        const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
        const loader = ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : ext === 'json' ? 'json' : ext === 'css' ? 'css' : 'js';
        return { contents, loader };
      });
    },
  };
}

/** Bundle one entry against a virtual file map. All screen compilation funnels through here. */
async function runBundle(map: Map<string, string>, entryPath: string): Promise<{ js: string; error?: string }> {
  try {
    const [esbuild, vendors] = await Promise.all([ensureEsbuild(), ensureVendors()]);
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2020',
      logLevel: 'silent',
      // TSX/JSX → the automatic runtime on preact (aliased from react too). No effect on .ts/.js files.
      jsx: 'automatic',
      jsxImportSource: 'preact',
      plugins: [screenVfsPlugin(map, vendors)],
    });
    // esbuild-wasm names the in-memory output '<stdout>', so match .js OR fall back to the first output.
    const jsOut = result.outputFiles?.find((o) => o.path.endsWith('.js')) ?? result.outputFiles?.[0];
    return { js: jsOut?.text ?? '' };
  } catch (e) {
    const err = e as { errors?: Array<{ text: string; location?: { line: number } | null }> };
    if (err?.errors?.length) {
      const f = err.errors[0];
      return { js: '', error: `${f.text}${f.location ? ` (line ${f.location.line})` : ''}` };
    }
    return { js: '', error: e instanceof Error ? e.message : 'Bundle failed' };
  }
}

/**
 * Bundle a multi-file screen project (TypeScript/TSX/JS with relative imports) into one runnable JS via
 * esbuild-wasm + a virtual filesystem. Returns the shell html, concatenated css, and the bundled js.
 * npm imports resolve only against the embedded built-ins (react/preact) — the sandbox has no network.
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
  const r = await runBundle(map, entryPath);
  return { html, css, js: r.js, error: r.error };
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
 * Compile single-file TypeScript/TSX (or JS) custom-screen source to ES2020 JS. Runs through the
 * bundler so JSX and the embedded react/preact built-ins work in single-file screens too. Tries the
 * TSX dialect first (it parses plain TS identically, apart from angle-bracket type assertions —
 * `<Foo>value` — which fall back to a plain-TS pass). Never throws — returns { js, error }.
 */
export async function compileScreenCode(source: string): Promise<CompileResult> {
  const src = source ?? '';
  if (src.trim() === '') {
    return { js: '' };
  }
  const tsx = await runBundle(new Map([['index.tsx', src]]), 'index.tsx');
  if (!tsx.error) return { js: tsx.js };
  const ts = await runBundle(new Map([['index.ts', src]]), 'index.ts');
  if (!ts.error) return { js: ts.js };
  return { js: '', error: tsx.error };
}
