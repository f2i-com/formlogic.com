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
 * Run from form-builder/ui:  node scripts/check-pack-screens.mjs
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

function checkScreen(label, cs, { isForm }) {
  if (!cs || cs.enabled !== true) {
    console.error(`[${label}] missing/disabled customScreen`);
    fail = 1;
    return;
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
  // Multi-file TS screens (sample-app homes) compile at runtime — the js-string heuristics don't
  // apply. Run only the content policy checks over their sources.
  if (!cs.js && cs.files?.length) {
    const all = cs.files.map((f) => f.content || '').join('\n');
    const emoji = all.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    if (emoji) { console.error(`[${label}] emoji found: ${emoji[0]}`); fail = 1; }
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

function checkPack(name, pack) {
  for (const app of pack.apps || []) {
    checkScreen(`${name} app:${app.packAppId || app.name}`, app.customScreen, { isForm: false });
    apps++;
  }
  for (const form of pack.forms || []) {
    checkScreen(`${name} form:${form.packFormId || form.title}`, form.customScreen, { isForm: true });
    forms++;
  }
}

// Official packs (TS sources — bundle each, import, find the export with .apps)
const packDir = path.resolve('src/data/packs');
for (const f of fs.readdirSync(packDir).filter((x) => x.endsWith('Pack.ts')).sort()) {
  const out = path.join(os.tmpdir(), `pack-screens-${f}-${process.pid}.mjs`);
  try {
    await build({ entryPoints: [path.join(packDir, f)], bundle: true, format: 'esm', outfile: out, platform: 'node', logLevel: 'silent' });
    const mod = await import(pathToFileURL(out).href);
    const pack = Object.values(mod).find((v) => v && typeof v === 'object' && Array.isArray(v.apps));
    if (!pack) { console.error(`[${f}] no pack export with .apps`); fail = 1; continue; }
    checkPack(f, pack);
  } catch (e) {
    console.error(`[${f}] bundle/import failed: ${e.message}`);
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
    checkPack(f, pack);
  } catch (e) {
    console.error(`[${f}] parse failed: ${e.message}`);
    fail = 1;
  }
}

console.log(`${fail ? 'FAIL' : 'OK'} — ${apps} app screens, ${forms} form section screens checked`);
process.exit(fail);
