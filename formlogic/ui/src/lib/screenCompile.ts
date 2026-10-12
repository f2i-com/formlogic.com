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

// ---- npm imports via esm.sh (COMPILE-time only) --------------------------------------------
// Bare imports beyond the embedded react/preact built-ins resolve against https://esm.sh: the
// bundler (running in the HOST page, which has network) fetches the module graph and inlines it,
// so the compiled bundle stays fully self-contained and the sandbox iframe stays network-free
// (its CSP is unchanged). Pack-owned screens deliberately do NOT get this — they must stay
// hermetic/deterministic (check-pack-screens keeps refusing npm imports for them).

/** Minimal fetch shape the resolver needs — lets tests inject an offline fake registry. `url` is
 *  where the answer came from once redirects were followed (Response.url). `body` is read as a
 *  stream when there is one (a real Response), so an answer is never held whole before its size
 *  is known; `text()` is for a fake without one. */
export type EsmFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  url?: string;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

/** A fetched module: its source, and its size in bytes as it came over the network. */
interface EsmModule {
  code: string;
  bytes: number;
}

let esmFetchOverride: EsmFetch | null = null;

const ESM_ORIGIN = 'https://esm.sh';
const ESM_MAX_MODULES = 64;
/** What one screen's npm modules may come to in all; one module alone is read no further than this. */
const ESM_MAX_BYTES = 4 * 1024 * 1024;

// Fetched modules are kept for later builds (the Studio rebuilds on every edit), least recently
// used first in the map's order. Bounded, or a long editing session would keep every module it
// ever fetched: a few builds' worth of modules at most.
const ESM_CACHE_LIMITS = { modules: 256, bytes: 16 * 1024 * 1024 };
let esmCacheLimits = ESM_CACHE_LIMITS;
const esmCache = new Map<string, Promise<EsmModule>>();
/** Sizes of the cached modules that have arrived; a module still on its way counts as 0. */
const esmCacheSizes = new Map<string, number>();
let esmCacheBytes = 0;

/** Tests only: replace the network fetch for esm.sh modules (null restores; clears the cache). */
export function __setEsmFetchForTests(impl: EsmFetch | null): void {
  esmFetchOverride = impl;
  esmCache.clear();
  esmCacheSizes.clear();
  esmCacheBytes = 0;
}

/** Tests only: set the cache's bounds (null restores the defaults). */
export function __setEsmCacheLimitsForTests(limits: { modules: number; bytes: number } | null): void {
  esmCacheLimits = limits ?? ESM_CACHE_LIMITS;
  trimEsmCache();
}

/** Tests only: what the cache holds, and its bounds. */
export function __esmCacheStatsForTests(): { modules: number; bytes: number; limits: { modules: number; bytes: number } } {
  return { modules: esmCache.size, bytes: esmCacheBytes, limits: esmCacheLimits };
}

function dropEsmCacheEntry(url: string): void {
  esmCache.delete(url);
  const size = esmCacheSizes.get(url);
  if (size !== undefined) {
    esmCacheBytes -= size;
    esmCacheSizes.delete(url);
  }
}

/** Let go of the least recently used modules until the cache is within its bounds. */
function trimEsmCache(): void {
  for (const url of esmCache.keys()) {
    if (esmCache.size <= esmCacheLimits.modules && esmCacheBytes <= esmCacheLimits.bytes) return;
    dropEsmCacheEntry(url);
  }
}

/** A module larger than ESM_MAX_BYTES: reported as a size error, not as a network failure. */
class EsmTooLargeError extends Error {}

/**
 * Read an answer's body, giving up as soon as it passes `cap` bytes. A body that is a stream is
 * read chunk by chunk and cancelled at the cap, so nothing past it is downloaded or held.
 */
async function readCapped(res: Awaited<ReturnType<EsmFetch>>, cap: number): Promise<EsmModule> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let code = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        void reader.cancel().catch(() => undefined);
        throw new EsmTooLargeError();
      }
      code += decoder.decode(value, { stream: true });
    }
    return { code: code + decoder.decode(), bytes };
  }
  const code = await res.text();
  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > cap) throw new EsmTooLargeError();
  return { code, bytes };
}

function esmFetchModule(url: string): Promise<EsmModule> {
  const cached = esmCache.get(url);
  if (cached) {
    // Most recently used goes last.
    esmCache.delete(url);
    esmCache.set(url, cached);
    return cached;
  }
  // No credentials: the request is made by the host page, and nothing of the person's session
  // belongs on it, wherever a redirect leads.
  const f: EsmFetch = esmFetchOverride ?? ((u) => fetch(u, { credentials: 'omit' }));
  const p = f(url).then(async (res) => {
    // fetch follows redirects, and esm.sh uses them (an unpinned version to the pinned one).
    // toEsm checks the URL that is asked for; this checks the one that answered, so the origin
    // rule holds without leaning on the shell's CSP, which lists other origins too (the app,
    // the API, the desktop bridges on loopback) and is not sent by a dev server.
    const from = res.url ? new URL(res.url).origin : ESM_ORIGIN;
    if (from !== ESM_ORIGIN) throw new Error(`esm.sh redirected to another site, ${from}`);
    if (!res.ok) throw new Error(`esm.sh returned ${res.status}`);
    return readCapped(res, ESM_MAX_BYTES);
  });
  esmCache.set(url, p);
  p.then(
    (mod) => {
      if (esmCache.get(url) !== p) return; // let go of while it was on its way
      esmCacheSizes.set(url, mod.bytes);
      esmCacheBytes += mod.bytes;
      trimEsmCache();
    },
    () => {
      if (esmCache.get(url) === p) dropEsmCacheEntry(url); // a transient failure may retry on the next build
    },
  );
  trimEsmCache();
  return p;
}

/**
 * Map a react-family esm.sh path onto the embedded preact vendors, so a fetched package shares
 * ONE component runtime with the screen — bundling a second real React would break hooks.
 */
function esmReactVendorId(pathname: string): string | null {
  const m = pathname.match(/^\/(?:stable\/|v\d+\/)?react(-dom)?@[^/]+(\/.*)?$/);
  if (!m) return null;
  const sub = m[2] ?? '';
  if (sub.includes('jsx-runtime')) return 'preact/jsx-runtime';
  if (m[1] && sub.includes('client')) return 'preact/compat/client';
  return 'preact/compat';
}

/** Image assets: imported from JS/TSX they resolve to a data: URI string (default export). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|avif|svg)$/i;

/** The virtual-filesystem + embedded-vendor + esm.sh resolver shared by every screen bundle. */
function screenVfsPlugin(map: Map<string, string>, vendors: Vendors): Plugin {
  // Per-build budgets so one screen can't quietly pull a huge dependency graph.
  let esmModules = 0;
  let esmBytes = 0;
  // Every route to the network ends here, so the origin is checked here: a specifier that starts
  // with a slash ('//host/x', or '/host/x' after the bare-name prefix) parses as another host.
  const toEsm = (url: URL): { path: string; namespace: string } | { errors: Array<{ text: string }> } =>
    url.origin !== ESM_ORIGIN
      ? { errors: [{ text: `Only ${ESM_ORIGIN} URL imports are allowed (got ${url.origin}).` }] }
      : /\.css$/i.test(url.pathname)
      ? { path: '\0css-stub', namespace: 'css-stub' } // package css can't inject into the shell — no-op
      : (() => {
          const reactId = esmReactVendorId(url.pathname);
          return reactId ? { path: reactId, namespace: 'vendor' } : { path: url.href, namespace: 'esm' };
        })();
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
        // Inside a fetched esm.sh module: relative + root-absolute specifiers stay on esm.sh;
        // react-family bares fold into the embedded vendors.
        if (args.namespace === 'esm') {
          if (args.path.startsWith('.')) return toEsm(new URL(args.path, args.importer));
          if (args.path.startsWith('/')) return toEsm(new URL(args.path, ESM_ORIGIN));
          const id = vendors.resolveVendorId(args.path);
          if (id) return { path: id, namespace: 'vendor' };
          if (/^https?:\/\//i.test(args.path)) return toEsm(new URL(args.path));
          return toEsm(new URL('/' + args.path, ESM_ORIGIN));
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
        // Full-URL imports: esm.sh only (anything else would be an uncontrolled code source).
        if (/^https?:\/\//i.test(args.path)) return toEsm(new URL(args.path));
        // Any other bare specifier = an npm package, resolved via esm.sh at compile time.
        return toEsm(new URL('/' + args.path, ESM_ORIGIN));
      });
      build.onLoad({ filter: /.*/, namespace: 'vendor' }, (args) => ({
        contents: vendors.VENDOR_MODULES[args.path] ?? '',
        loader: vendors.VENDOR_LOADERS[args.path] ?? 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'esm' }, async (args) => {
        if (++esmModules > ESM_MAX_MODULES) {
          return { errors: [{ text: `This screen pulls more than ${ESM_MAX_MODULES} npm modules — trim its dependencies.` }] };
        }
        const tooLarge = { errors: [{ text: `This screen's npm dependencies exceed ${Math.round(ESM_MAX_BYTES / 1048576)}MB — trim its dependencies.` }] };
        try {
          const mod = await esmFetchModule(args.path);
          esmBytes += mod.bytes;
          if (esmBytes > ESM_MAX_BYTES) return tooLarge;
          return { contents: mod.code, loader: 'js' };
        } catch (e) {
          if (e instanceof EsmTooLargeError) return tooLarge;
          const why = e instanceof Error ? e.message : 'network error';
          return { errors: [{ text: `Could not fetch '${args.path}' (${why}). npm imports are downloaded from esm.sh when the screen COMPILES, so the editor needs internet — and pin versions (e.g. canvas-confetti@1.9.3) for reproducible builds. Built-ins that never need network: ${vendors.VENDOR_IMPORT_HINT}.` }] };
        }
      });
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
        const contents = map.get(args.path);
        if (contents === undefined) return { errors: [{ text: `Missing file: ${args.path}` }] };
        // Images import as a data: URI string (default export) for <img src={...}>. Binary
        // formats are STORED as data: URIs (the Studio upload converts); .svg text is wrapped.
        if (IMAGE_EXT_RE.test(args.path)) {
          const uri = contents.startsWith('data:')
            ? contents
            : /\.svg$/i.test(args.path)
              ? 'data:image/svg+xml;utf8,' + encodeURIComponent(contents)
              : null;
          if (uri === null) {
            return { errors: [{ text: `${args.path}: binary images must be stored as data: URIs — upload the image through the Studio's file upload.` }] };
          }
          return { contents: `export default ${JSON.stringify(uri)};`, loader: 'js' };
        }
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
 * npm imports resolve against the embedded built-ins (react/preact) first, then via esm.sh at
 * COMPILE time (fetched by the host and inlined — the sandbox itself stays network-free).
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
