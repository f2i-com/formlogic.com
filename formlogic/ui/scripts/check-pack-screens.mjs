/**
 * Coverage + policy gate for the marketplace packs' custom screens.
 *
 * Asserts, for every official pack (src/data/packs/*Pack.ts) and every bundled sample app
 * (backend/resources/sample-apps/*.json):
 *   - every APP has an enabled custom home screen (kit-based dashboard);
 *   - every FORM has an enabled section screen with allowNewResponses set EXPLICITLY:
 *     true plus a New-record affordance (data-open / FormLogic.openForm), or false for
 *     forms whose records are written exclusively by flows/app logic (e.g. Calls) —
 *     an absent flag is treated as the forgotten-lockout bug this gate exists to catch;
 *   - all screen JS parses (new Function), CSS braces balance, and screens follow the design
 *     rules: no emoji, no hardcoded hex colors (tokens only), form screens never use the
 *     app-scoped SDK (no data-nav / FL.navigate / FL.forms).
 *
 * Run from formlogic/ui:  node scripts/check-pack-screens.mjs
 * Exits non-zero on any violation — wired into CI so a pack edit can't silently ship a form
 * without its section screen.
 */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require2 = createRequire(path.join(process.cwd(), 'package.json'));
const { build } = require2('esbuild');

let fail = 0;
let apps = 0;
let forms = 0;

// Vite-style `?raw` imports (pack modules import screen .tsx/.css sources as strings) for the
// node-side esbuild bundle of the pack TS.
const rawPlugin = {
  name: 'vite-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

// Sandbox-bundle a files-based screen the same way the runtime does (screenCompile.ts vfs +
// embedded preact vendors + automatic JSX) — proves the sources COMPILE. Vendor resolution
// mirrors src/lib/screenVendorModules.ts; keep the two in lock-step.
const preactRoot = path.dirname(require2.resolve('preact/package.json'));
const VENDOR_PATHS = {
  'preact': path.join(preactRoot, 'dist/preact.mjs'),
  'preact/hooks': path.join(preactRoot, 'hooks/dist/hooks.mjs'),
  'preact/compat': path.join(preactRoot, 'compat/dist/compat.mjs'),
  'preact/compat/client': path.join(preactRoot, 'compat/client.mjs'),
  'preact/jsx-runtime': path.join(preactRoot, 'jsx-runtime/dist/jsxRuntime.mjs'),
  // The built-in screen component kit is a first-party vendor module (TSX on disk —
  // esbuild infers the loader; its 'preact' imports resolve via node_modules to the
  // same files as above, so it shares the runtime).
  'formlogic/kit': path.resolve('src/lib/screen-kit/kit.tsx'),
};
const VENDOR_ALIASES = {
  'react': 'preact/compat',
  'react-dom': 'preact/compat',
  'react-dom/client': 'preact/compat/client',
  'react/jsx-runtime': 'preact/jsx-runtime',
  'react/jsx-dev-runtime': 'preact/jsx-runtime',
  'preact/jsx-dev-runtime': 'preact/jsx-runtime',
  '@formlogic/kit': 'formlogic/kit',
};
const ENTRY_CANDIDATES = ['index.tsx', 'index.ts', 'main.tsx', 'main.ts', 'app.tsx', 'app.ts'];

async function bundleFilesScreen(files, entry) {
  const map = new Map(files.map((f) => [f.path, f.content ?? '']));
  const entryPath = (entry && map.has(entry) ? entry : null) ?? ENTRY_CANDIDATES.find((c) => map.has(c));
  if (!entryPath) return { error: 'no entry file (index.tsx / index.ts)' };
  try {
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2020',
      logLevel: 'silent',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      plugins: [{
        name: 'screen-vfs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return { path: args.path, namespace: 'vfs' };
            if (args.namespace !== 'vfs') return null; // vendor-internal imports resolve normally on disk
            if (args.path.startsWith('.')) {
              // JS-side css imports are no-ops (css is injected separately) — mirror screenCompile.
              if (/\.css$/i.test(args.path)) return { path: '\0css-stub', namespace: 'css-stub' };
              const dir = args.importer.includes('/') ? args.importer.slice(0, args.importer.lastIndexOf('/')) : '';
              const segs = [];
              for (const s of `${dir}/${args.path}`.split('/')) {
                if (s === '' || s === '.') continue;
                if (s === '..') segs.pop(); else segs.push(s);
              }
              const base = segs.join('/');
              const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`,
                `${base}/index.ts`, `${base}/index.tsx`].find((c) => map.has(c));
              return hit ? { path: hit, namespace: 'vfs' } : { errors: [{ text: `Cannot find module '${args.path}' (imported by ${args.importer})` }] };
            }
            const id = VENDOR_PATHS[args.path] ? args.path : VENDOR_ALIASES[args.path];
            if (id) return { path: VENDOR_PATHS[id] };
            // PACK screens must stay hermetic + deterministic (they are signed and run for every
            // installer): no esm.sh here even though user-authored Studio screens get it.
            return { errors: [{ text: `npm import not allowed in PACK screens: '${args.path}' (pack screens are hermetic — built-ins only)` }] };
          });
          b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
            const contents = map.get(args.path);
            // Image assets import as data: URI strings — mirror screenCompile's loader.
            if (/\.(png|jpe?g|gif|webp|ico|bmp|avif|svg)$/i.test(args.path)) {
              const uri = contents.startsWith('data:')
                ? contents
                : /\.svg$/i.test(args.path)
                  ? 'data:image/svg+xml;utf8,' + encodeURIComponent(contents)
                  : null;
              if (uri === null) return { errors: [{ text: `${args.path}: binary images must be data: URIs` }] };
              return { contents: `export default ${JSON.stringify(uri)};`, loader: 'js' };
            }
            const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
            return { contents, loader: ext === 'tsx' ? 'tsx' : ext === 'ts' ? 'ts' : ext === 'jsx' ? 'jsx' : ext === 'json' ? 'json' : ext === 'css' ? 'css' : 'js' };
          });
          b.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
        },
      }],
    });
    const out = result.outputFiles?.find((o) => o.path.endsWith('.js')) ?? result.outputFiles?.[0];
    return { js: out?.text ?? '' };
  } catch (e) {
    const first = e?.errors?.[0];
    return { error: first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ''}` : String(e.message || e) };
  }
}

// Trusted SDK screen ids — collected from every registerSdkScreen('<id>', …) call in the
// custom-screen sources, so a pack can never reference a screen the bundle doesn't register.
const sdkScreenIds = (() => {
  const ids = new Set();
  const dir = path.resolve('src/components/custom-screen');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/registerSdkScreen\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
      }
    }
  };
  walk(dir);
  return ids;
})();

async function checkScreen(label, cs, { isForm }) {
  if (!cs || cs.enabled !== true) {
    console.error(`[${label}] missing/disabled customScreen`);
    fail = 1;
    return;
  }
  // Optional per-record widget: an sdk kind must reference a registered screen; a code kind
  // must at least parse. (Rendered on the record detail view with the record context.)
  if (isForm && cs.recordScreen) {
    const rs = cs.recordScreen;
    if (rs.kind === 'sdk') {
      if (!rs.screenId || !sdkScreenIds.has(rs.screenId)) {
        console.error(`[${label}] recordScreen sdk id '${rs.screenId}' is not registered in sdkScreenRegistry`); fail = 1;
      }
    } else if (rs.kind === 'code') {
      if (!rs.js && rs.files?.length) {
        const all = rs.files.map((f) => f.content || '').join('\n');
        const emoji = all.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u);
        if (emoji) { console.error(`[${label}] recordScreen emoji/symbol found: ${emoji[0]}`); fail = 1; }
        const r = await bundleFilesScreen(rs.files, rs.entry);
        if (r.error) { console.error(`[${label}] recordScreen files do not compile: ${r.error}`); fail = 1; }
      } else {
        try { new Function(rs.js || ''); } catch (e) { console.error(`[${label}] recordScreen JS SYNTAX ERROR: ${e.message}`); fail = 1; }
      }
    } else {
      console.error(`[${label}] recordScreen has unknown kind '${rs.kind}'`); fail = 1;
    }
  }
  // Host-rendered SDK screens are trusted first-party React components — validate the
  // registry reference (and the New-record affordance policy for form sections).
  if (cs.kind === 'sdk') {
    const id = cs.sdkScreen && cs.sdkScreen.screenId;
    if (!id || typeof id !== 'string') {
      console.error(`[${label}] sdk screen missing sdkScreen.screenId`); fail = 1; return;
    }
    if (!sdkScreenIds.has(id)) {
      console.error(`[${label}] sdk screen '${id}' is not registered in sdkScreenRegistry`); fail = 1;
    }
    if (isForm && typeof cs.allowNewResponses !== 'boolean') {
      console.error(`[${label}] allowNewResponses must be set explicitly on section screens (true, or false for flow-written forms)`); fail = 1;
    }
    return;
  }
  // Host-rendered widget dashboards are declarative config (no user JS/CSS) — validate the widget
  // structure + grid layout instead of the code-screen heuristics below.
  if (cs.kind === 'dashboard') {
    const d = cs.dashboard;
    if (!d || !Array.isArray(d.widgets) || d.widgets.length === 0) {
      console.error(`[${label}] dashboard has no widgets`); fail = 1; return;
    }
    const cols = d.cols || 12;
    const occ = new Set();
    for (const w of d.widgets) {
      if (!w || !['report', 'list', 'text', 'actions', 'activity'].includes(w.kind)) {
        console.error(`[${label}] invalid widget kind: ${w && w.kind}`); fail = 1; continue;
      }
      const L = w.layout || {};
      if (![L.x, L.y, L.w, L.h].every((n) => Number.isInteger(n)) || L.x < 0 || L.y < 0 || L.w < 1 || L.h < 1 || L.x + L.w > cols) {
        console.error(`[${label}] widget ${w.id || w.kind} layout out of bounds`); fail = 1; continue;
      }
      for (let yy = L.y; yy < L.y + L.h; yy++) for (let xx = L.x; xx < L.x + L.w; xx++) {
        const k = `${xx},${yy}`;
        if (occ.has(k)) { console.error(`[${label}] widgets overlap at cell ${k}`); fail = 1; }
        occ.add(k);
      }
      if (w.kind === 'report' && (!w.spec || !w.spec.formId || !w.spec.viz)) { console.error(`[${label}] report widget ${w.id} missing spec.formId/viz`); fail = 1; }
      if (w.kind === 'list' && (!w.list || !w.list.formId)) { console.error(`[${label}] list widget ${w.id} missing list.formId`); fail = 1; }
      if (isForm && (w.kind === 'actions' || w.kind === 'activity')) { console.error(`[${label}] section screens can't use app-scope widget '${w.kind}'`); fail = 1; }
    }
    if (isForm && typeof cs.allowNewResponses !== 'boolean') { console.error(`[${label}] allowNewResponses must be set explicitly on section screens (true, or false for flow-written forms)`); fail = 1; }
    return;
  }
  // Multi-file TS/TSX screens compile at runtime (sandbox bundler) — prove the sources COMPILE
  // with the same vfs+vendor+JSX semantics, then apply the content policies to the sources.
  if (!cs.js && cs.files?.length) {
    // data: URI assets (uploaded images) are excluded from the text policies — base64 payloads
    // are huge and can't carry emoji/hex-color violations anyway.
    const textFiles = cs.files.filter((f) => !String(f.content || '').startsWith('data:'));
    const all = textFiles.map((f) => f.content || '').join('\n');
    const emoji = all.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u);
    if (emoji) { console.error(`[${label}] emoji/symbol found: ${emoji[0]}`); fail = 1; }
    const cssText = textFiles.filter((f) => /\.css$/i.test(f.path)).map((f) => f.content || '').join('\n');
    const hexes = [...new Set((cssText.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((x) => !/^#(fff|ffffff)$/i.test(x)))];
    if (hexes.length) { console.error(`[${label}] hardcoded hex in css: ${hexes.join(' ')} (use --fl-* vars)`); fail = 1; }
    const r = await bundleFilesScreen(cs.files, cs.entry);
    if (r.error) { console.error(`[${label}] files screen does not compile: ${r.error}`); fail = 1; }
    if (isForm) {
      if (typeof cs.allowNewResponses !== 'boolean') { console.error(`[${label}] allowNewResponses must be set explicitly on section screens (true, or false for flow-written forms)`); fail = 1; }
      if (cs.allowNewResponses === true && !/openForm/.test(all)) { console.error(`[${label}] no New-record affordance (openForm)`); fail = 1; }
      if (/FormLogic\.navigate|FL\.navigate|data-nav/.test(all)) { console.error(`[${label}] section screens are form-scoped — no navigate/data-nav`); fail = 1; }
    } else if (!/navigate\(|data-nav/.test(all)) {
      console.error(`[${label}] app home screen has no navigation (FormLogic.navigate)`); fail = 1;
    }
    return;
  }
  const css = cs.css || '', js = cs.js || '', html = cs.html || '';
  try {
    new Function(js);
  } catch (e) {
    console.error(`[${label}] JS SYNTAX ERROR: ${e.message}`);
    fail = 1;
  }
  const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
  if (open !== close) { console.error(`[${label}] CSS braces unbalanced ${open} vs ${close}`); fail = 1; }
  const all = css + js + html;
  const emoji = all.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u);
  if (emoji) { console.error(`[${label}] emoji/symbol found: ${emoji[0]} (use kit SVG icons)`); fail = 1; }
  const hexes = [...new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((x) => !/^#(fff|ffffff)$/i.test(x)))];
  if (hexes.length) { console.error(`[${label}] hardcoded hex in css: ${hexes.join(' ')} (use --fl-* vars)`); fail = 1; }
  const jsHexes = [...new Set(js.match(/#[0-9a-fA-F]{6}\b/g) || [])];
  if (jsHexes.length) { console.error(`[${label}] hardcoded hex in js: ${jsHexes.join(' ')} (use --fl-* vars)`); fail = 1; }
  if (!/wire\(/.test(js)) { console.error(`[${label}] kit wire() not called`); fail = 1; }
  if (isForm) {
    if (typeof cs.allowNewResponses !== 'boolean') { console.error(`[${label}] allowNewResponses must be set explicitly on section screens (true, or false for flow-written forms)`); fail = 1; }
    if (cs.allowNewResponses === true && !/data-open|openForm/.test(js)) { console.error(`[${label}] no New-record affordance (data-open / openForm)`); fail = 1; }
    if (/data-nav|FL\.navigate|FL\.forms\(/.test(js)) { console.error(`[${label}] section screens are form-scoped — no navigate/forms/data-nav`); fail = 1; }
  } else {
    if (!/data-nav/.test(js)) { console.error(`[${label}] app home screen has no data-nav targets`); fail = 1; }
  }
}

async function checkPack(name, pack) {
  for (const app of pack.apps || []) {
    await checkScreen(`${name} app:${app.packAppId || app.name}`, app.customScreen, { isForm: false });
    apps++;
  }
  for (const form of pack.forms || []) {
    await checkScreen(`${name} form:${form.packFormId || form.title}`, form.customScreen, { isForm: true });
    forms++;
  }
}

// Official packs: one FOLDER per pack (<id>/manifest.json + <id>/pack.ts) — bundle each pack.ts,
// import, take the default export (falling back to any export with .apps).
const packDir = path.resolve('src/data/packs');
const packFolders = fs.readdirSync(packDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(packDir, e.name, 'pack.ts')))
  .map((e) => e.name)
  .sort();
if (packFolders.length === 0) { console.error('no pack folders found under src/data/packs'); fail = 1; }
for (const folder of packFolders) {
  const out = path.join(os.tmpdir(), `pack-screens-${folder}-${process.pid}.mjs`);
  try {
    if (!fs.existsSync(path.join(packDir, folder, 'manifest.json'))) {
      console.error(`[${folder}] missing manifest.json`); fail = 1;
    }
    await build({ entryPoints: [path.join(packDir, folder, 'pack.ts')], bundle: true, format: 'esm', outfile: out, platform: 'node', logLevel: 'silent', plugins: [rawPlugin] });
    const mod = await import(pathToFileURL(out).href);
    const pack = (mod.default && Array.isArray(mod.default.apps) ? mod.default : null)
      ?? Object.values(mod).find((v) => v && typeof v === 'object' && Array.isArray(v.apps));
    if (!pack) { console.error(`[${folder}] no pack export with .apps`); fail = 1; continue; }
    await checkPack(folder, pack);
  } catch (e) {
    console.error(`[${folder}] bundle/import failed: ${e.message}`);
    fail = 1;
  } finally {
    try { fs.unlinkSync(out); } catch { /* already gone */ }
  }
}

// Bundled sample apps (plain JSON packs)
const sampleDir = path.resolve('../backend/resources/sample-apps');
for (const f of fs.readdirSync(sampleDir).filter((x) => x.endsWith('.json')).sort()) {
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(sampleDir, f), 'utf8'));
    await checkPack(f, pack);
  } catch (e) {
    console.error(`[${f}] parse failed: ${e.message}`);
    fail = 1;
  }
}

console.log(`${fail ? 'FAIL' : 'OK'} — ${apps} app screens, ${forms} form section screens checked`);
process.exit(fail);
