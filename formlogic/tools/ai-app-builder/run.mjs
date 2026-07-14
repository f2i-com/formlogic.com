// AI App Builder — runnable harness.
//   node run.mjs "Create a HR app that manages job applications"
//   node run.mjs --dry-run "..."             # build + validate, write the pack JSON, create nothing
//   node run.mjs --dry-run --out my.json "..."
//
// Pipeline: PLAN → (loop) generate each form's fields + script → design the widget DASHBOARD →
// assemble a Pack → validate → import atomically (creates app + forms + linked-record links +
// roles + the dashboard home) → publish.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.mjs';
import { aiJson, createApiClient } from './clients.mjs';
import {
  PLANNER_SYSTEM, DASHBOARD_SYSTEM, formPrompt, dashboardPrompt,
  assemblePack, attachAppDashboard, sanitizeDashboard, buildFallbackDashboard,
  validatePlan, validatePack, APP_KINDS,
} from './assemble.mjs';

const log = (...a) => console.log(...a);
const step = (n, msg) => log(`\n[${n}] ${msg}`);

async function withRetry(fn, label, tries = 2) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (e.status === 429 && i < tries) { log(`   rate-limited, waiting 20s…`); await new Promise(r => setTimeout(r, 20000)); continue; }
      if (i >= tries) throw new Error(`${label} failed: ${e.message}`);
      log(`   ${label} retry (${e.message})`);
    }
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = { dry: false, out: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry' || a === '--dry-run') opts.dry = true;
    else if (a === '--out') {
      opts.out = args[++i];
      if (!opts.out) { console.error('--out needs a file path'); process.exit(1); }
    } else rest.push(a);
  }
  opts.prompt = rest.join(' ').trim();
  return opts;
}

function writePack(pack, outPath) {
  const file = resolve(outPath || `${pack.packMeta.id}.formlogic.json`);
  writeFileSync(file, JSON.stringify(pack, null, 2) + '\n');
  return file;
}

async function main() {
  const { dry, out, prompt } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('Usage: node run.mjs [--dry-run] [--out pack.json] "<app description>"');
    process.exit(1);
  }

  const api = createApiClient();

  step(1, `Authenticating as ${config.email}`);
  await api.login();
  const status = await api.aiStatus();
  log(`   AI: ${status.available ? 'available' : 'NOT available'} (${config.aiModel} @ ${config.aiBase})`);
  if (!status.available) {
    console.error('   The backend reports its AI provider is unavailable. Check AI_BASE_URL / AI_API_KEY /'
      + ' AI_ENABLED in formlogic/backend/.env (a keyless local server like http://localhost:8001/v1 works).');
    process.exit(1);
  }

  step(2, `Planning the app from your prompt…`);
  const plan = await withRetry(
    () => aiJson(PLANNER_SYSTEM, `${prompt}\n\nDesign up to ${config.maxForms} forms.`, { maxTokens: 2048 }),
    'planning');
  // Trim to the form budget + drop relations to dropped forms; normalize the optional app kind.
  plan.forms = (plan.forms || []).slice(0, config.maxForms);
  const keep = new Set(plan.forms.map(f => f.key));
  plan.relations = (plan.relations || []).filter(r => keep.has(r.from) && keep.has(r.to));
  if (plan.app && !APP_KINDS.includes(plan.app.kind)) delete plan.app.kind;

  const planErrors = validatePlan(plan);
  if (planErrors.length) { console.error('Plan invalid:\n - ' + planErrors.join('\n - ')); process.exit(1); }

  log(`\n   App: ${plan.app.name} — ${plan.app.description || ''}${plan.app.kind ? `  [${plan.app.kind}]` : ''}`);
  log(`   Forms (${plan.forms.length}):`);
  plan.forms.forEach(f => log(`     • ${f.title} — ${f.purpose}`));
  log(`   Relations (${plan.relations.length}):`);
  plan.relations.forEach(r => log(`     • ${r.from} → ${r.to}  (“${r.label}”)`));
  log(`   Roles: ${(plan.roles || []).map(r => `${r.name} [${r.level}]`).join(', ') || '(none)'}`);

  step(3, `Generating ${plan.forms.length} forms (this calls the model per form — please wait)…`);
  const generated = {};
  for (const f of plan.forms) {
    const res = await withRetry(() => api.generateForm(formPrompt(plan, f)), `generate "${f.title}"`);
    const data = res.data || {};
    generated[f.key] = { fields: data.fields || [] };
    let scriptNote = '';
    if (data.needsScript && (data.suggestedScript || '').trim()) {
      try {
        const sres = await withRetry(
          () => api.generateScript(data.suggestedScript, (data.fields || []).map(x => ({ id: x.id, label: x.label, type: x.type }))),
          `script for "${f.title}"`);
        if (sres.data?.script) { generated[f.key].logicScript = sres.data.script; scriptNote = ' + onSubmit script'; }
      } catch (e) { log(`   (script skipped for ${f.title}: ${e.message})`); }
    }
    log(`   ✓ ${f.title}: ${generated[f.key].fields.length} fields${scriptNote}`);
  }

  step(4, `Assembling the app pack…`);
  const pack = assemblePack(plan, generated);

  step(5, `Designing the dashboard…`);
  // Ask the model to design the widget dashboard from the FINAL field ids, then sanitize it against
  // the pack (mirroring the server's AppReportService rules). Anything invalid is dropped with a
  // reason; if nothing chartable survives, fall back to the deterministic built-in template.
  let dashboard = null, fromAI = false;
  try {
    const raw = await withRetry(
      () => aiJson(DASHBOARD_SYSTEM, dashboardPrompt(plan, pack), { maxTokens: 3072 }),
      'dashboard design');
    const { dashboard: clean, dropped } = sanitizeDashboard(raw, pack);
    dropped.forEach(d => log(`   (dropped ${d})`));
    if (clean.widgets.some(w => w.kind === 'report')) { dashboard = clean; fromAI = true; }
    else log('   AI dashboard had no usable data widgets — using the built-in template.');
  } catch (e) {
    log(`   Dashboard design skipped (${e.message}) — using the built-in template.`);
  }
  if (!dashboard) {
    const { dashboard: fallback, dropped } = sanitizeDashboard(buildFallbackDashboard(pack), pack);
    dropped.forEach(d => log(`   (template dropped ${d})`)); // should never happen — template is valid by construction
    dashboard = fallback;
  }
  attachAppDashboard(pack, dashboard);
  log(`   ✓ dashboard: ${dashboard.widgets.length} widgets (${fromAI ? 'AI-designed' : 'built-in template'})`);

  step(6, `Validating the pack…`);
  const packErrors = validatePack(pack);
  if (packErrors.length) {
    const file = writePack(pack, out || `${pack.packMeta.id}.invalid.formlogic.json`);
    console.error('Assembled pack invalid:\n - ' + packErrors.join('\n - '));
    console.error(`(the pack was written to ${file} for inspection)`);
    process.exit(1);
  }
  log(`   ✓ pack valid — ${pack.forms.length} forms, `
    + `${pack.forms.reduce((n, f) => n + f.fields.filter(x => x.type === 'linked_record').length, 0)} links, `
    + `${pack.apps[0].roles.length} roles, ${dashboard.widgets.length} dashboard widgets`);

  if (dry) {
    const file = writePack(pack, out);
    log(`\n--dry-run: nothing was created. Pack written to:\n   ${file}`);
    log(`   Import it later via the Apps dashboard → Import, or POST /api/packs/import {"pack": …}.`);
    return;
  }

  step(7, `Creating everything (atomic pack import)…`);
  let result;
  try {
    result = await api.importPack(pack);
  } catch (e) {
    const file = writePack(pack, out || `${pack.packMeta.id}.failed.formlogic.json`);
    console.error(`Import failed: ${e.message}`);
    console.error(`(the pack was written to ${file} — fix and re-import via the Apps dashboard)`);
    process.exit(1);
  }
  const appId = result.apps?.[0]?.id;
  for (const fm of result.forms || []) { try { await api.publishForm(fm.id); } catch { /* keep going */ } }
  if (appId) { try { await api.publishApp(appId); } catch { /* keep going */ } }

  step('✓', `Done — created “${result.apps?.[0]?.name}”`);
  log(`   Forms:`);
  (result.forms || []).forEach(f => log(`     ✓ ${f.title}`));
  log(`   Links:`);
  plan.relations.forEach(r => log(`     ✓ ${r.from} → ${r.to}`));
  const scripted = plan.forms.filter(f => generated[f.key]?.logicScript);
  if (scripted.length) { log(`   Scripts:`); scripted.forEach(f => log(`     ✓ ${f.title}`)); }
  log(`   Dashboard: ${dashboard.widgets.length} widgets on the app home`);
  log(`\n   Open it at: ${config.apiBase.replace('api.', '')}/apps  (app id ${appId})`);
}

main().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
