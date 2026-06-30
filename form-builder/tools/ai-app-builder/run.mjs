// AI App Builder — runnable harness.
//   node run.mjs "Create a HR app that manages job applications"
//   node run.mjs --dry "..."   # plan + assemble + validate, but don't create anything
//
// Pipeline: PLAN → (loop) generate each form's fields + script → assemble a Pack → validate →
// import atomically (creates app + forms + linked-record links + roles) → publish.
import { config } from './config.mjs';
import { aiChat, extractJson, createApiClient } from './clients.mjs';
import { PLANNER_SYSTEM, formPrompt, assemblePack, validatePlan, validatePack, slug } from './assemble.mjs';

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

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const prompt = args.filter(a => a !== '--dry').join(' ').trim();
  if (!prompt) { console.error('Usage: node run.mjs [--dry] "<app description>"'); process.exit(1); }

  const api = createApiClient();

  step(1, `Authenticating as ${config.email}`);
  await api.login();
  const status = await api.aiStatus();
  log(`   AI: ${status.available ? 'available' : 'NOT available — aborting'} (${config.aiModel} @ ${config.aiBase})`);
  if (!status.available) process.exit(1);

  step(2, `Planning the app from your prompt…`);
  const planRaw = await withRetry(
    () => aiChat(PLANNER_SYSTEM, `${prompt}\n\nDesign up to ${config.maxForms} forms.`, { maxTokens: 2048 }),
    'planning');
  const plan = extractJson(planRaw);
  // Trim to the form budget + drop relations to dropped forms.
  if (plan.forms.length > config.maxForms) plan.forms = plan.forms.slice(0, config.maxForms);
  const keep = new Set(plan.forms.map(f => f.key));
  plan.relations = (plan.relations || []).filter(r => keep.has(r.from) && keep.has(r.to));

  const planErrors = validatePlan(plan);
  if (planErrors.length) { console.error('Plan invalid:\n - ' + planErrors.join('\n - ')); process.exit(1); }

  log(`\n   App: ${plan.app.name} — ${plan.app.description || ''}`);
  log(`   Forms (${plan.forms.length}):`);
  plan.forms.forEach(f => log(`     • ${f.title} — ${f.purpose}`));
  log(`   Relations (${plan.relations.length}):`);
  plan.relations.forEach(r => log(`     • ${r.from} → ${r.to}  (“${r.label}”)`));
  log(`   Roles: ${(plan.roles || []).map(r => `${r.name} [${r.level}]`).join(', ') || '(none)'}`);

  step(3, `Generating ${plan.forms.length} forms${dry ? '' : ' (this calls the model per form — please wait)'}…`);
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
  const packErrors = validatePack(pack);
  if (packErrors.length) { console.error('Assembled pack invalid:\n - ' + packErrors.join('\n - ')); process.exit(1); }
  log(`   ✓ pack valid — ${pack.forms.length} forms, ${pack.forms.reduce((n, f) => n + f.fields.filter(x => x.type === 'linked_record').length, 0)} links, ${pack.apps[0].roles.length} roles`);

  if (dry) { log('\n--dry: stopping before import. Pack is valid and ready.'); return; }

  step(5, `Creating everything (atomic pack import)…`);
  const result = await api.importPack(pack);
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
  log(`\n   Open it at: ${config.apiBase.replace('api.', '')}/apps  (app id ${appId})`);
}

main().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
