/**
 * Coverage + policy gate for the marketplace packs' custom screens.
 *
 * Asserts, for every official pack (src/data/packs/*Pack.ts) and every bundled sample app
 * (backend/resources/sample-apps/*.json):
 *   - every APP has an enabled custom home screen (kit-based dashboard);
 *   - every FORM has an enabled section screen with allowNewResponses: true and a New-record
 *     affordance (data-open / FormLogic.openForm);
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

function checkScreen(label, cs, { isForm }) {
  if (!cs || cs.enabled !== true) {
    console.error(`[${label}] missing/disabled customScreen`);
    fail = 1;
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
    if (cs.allowNewResponses !== true) { console.error(`[${label}] allowNewResponses must be true on section screens`); fail = 1; }
    if (!/data-open|openForm/.test(js)) { console.error(`[${label}] no New-record affordance (data-open / openForm)`); fail = 1; }
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
