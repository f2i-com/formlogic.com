// Offline self-test: assembles a full pack from a CANNED plan + canned "AI" output (no network, no
// AI, no backend) and asserts the engine produces exactly what the current importer accepts —
// field-id sanitizing, @pack: links, appKind, dashboard sanitizing (good widgets survive, bad ones
// drop with reasons), the fallback template, and validatePack catching broken packs.
//   node selftest.mjs
import {
  assemblePack, attachAppDashboard, sanitizeDashboard, buildFallbackDashboard,
  validatePlan, validatePack, safeFieldId, slug,
} from './assemble.mjs';
import { extractJson } from './clients.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Canned plan (what the planner AI returns) ──────────────────────────────────
const plan = {
  app: { name: 'Field Service HQ', description: 'Track clients, jobs, and invoices.', kind: 'admin' },
  forms: [
    { key: 'clients', title: 'Client', purpose: 'A customer record.' },
    { key: 'jobs', title: 'Job', purpose: 'A unit of work for a client.' },
    { key: 'invoices', title: 'Invoice', purpose: 'A bill for a completed job.' },
  ],
  relations: [
    { from: 'jobs', to: 'clients', label: 'Client' },
    { from: 'invoices', to: 'jobs', label: 'Job' },
  ],
  roles: [
    { name: 'Manager', level: 'admin' },
    { name: 'Technician', level: 'contributor' },
  ],
};

// ── Canned per-form generation output, including messy ids the assembler must fix ──
const generated = {
  clients: {
    fields: [
      { id: 'name', type: 'short_text', label: 'Name', required: true },
      { id: 'email', type: 'email', label: 'Email' },
      { id: 'sum', type: 'short_text', label: 'Notes' },            // reserved id → must be re-derived
    ],
  },
  jobs: {
    fields: [
      { id: 'title', type: 'short_text', label: 'Job Title', required: true },
      { id: 'status', type: 'dropdown', label: 'Status', properties: { options: [{ id: 'o1', label: 'Open', value: 'open' }] } },
      { id: '1st visit', type: 'date', label: 'First Visit' },      // invalid id → must be re-derived
      { id: 'title', type: 'long_text', label: 'Details' },         // duplicate id → must be re-derived
      { id: 'hours', type: 'number', label: 'Hours' },
    ],
    logicScript: 'function onSubmit(ctx) { return { allow: true }; }',
  },
  invoices: {
    fields: [
      { id: 'amount', type: 'number', label: 'Amount', required: true },
      { id: 'due_date', type: 'date', label: 'Due Date' },
    ],
  },
};

console.log('\n[1] plan validation');
check('canned plan validates', validatePlan(plan).length === 0, validatePlan(plan).join('; '));

console.log('\n[2] pack assembly');
const pack = assemblePack(plan, generated);
const jobs = pack.forms.find((f) => f.packFormId === 'jobs');
const clients = pack.forms.find((f) => f.packFormId === 'clients');
const invoices = pack.forms.find((f) => f.packFormId === 'invoices');
check('3 forms + 1 app', pack.forms.length === 3 && pack.apps.length === 1);
check('appKind lands in app settings', pack.apps[0].settings.appKind === 'admin');
check('reserved field id re-derived', !clients.fields.some((f) => f.id === 'sum')
  && clients.fields.some((f) => f.label === 'Notes' && /^[a-zA-Z_]/.test(f.id)));
check('invalid field id re-derived', jobs.fields.every((f) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.id)));
check('duplicate field id de-duplicated', new Set(jobs.fields.map((f) => f.id)).size === jobs.fields.length);
const jobLink = jobs.fields.find((f) => f.type === 'linked_record');
check('relation became a @pack: linked_record', jobLink?.properties?.targetFormId === '@pack:clients');
check('invoice links to jobs', invoices.fields.some((f) => f.type === 'linked_record' && f.properties.targetFormId === '@pack:jobs'));
check('logicScript carried', typeof jobs.logicScript === 'string');
check('roles expanded per form', pack.apps[0].roles.length === 2
  && pack.apps[0].roles[0].permissions.length === 3 * 5 /* admin level × 3 forms */);

console.log('\n[3] dashboard sanitizer — a messy "AI" dashboard');
const aiDashboard = {
  cols: 12,
  widgets: [
    // valid: KPI count
    { id: 'w1', title: 'Jobs', layout: { x: 0, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:jobs', viz: 'kpi', measure: { fn: 'count' } } },
    // valid: sum over a real number field
    { id: 'w2', title: 'Billed', layout: { x: 3, y: 0, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:invoices', viz: 'kpi', measure: { fn: 'sum', field: 'amount' } } },
    // valid: bar grouped by a real dropdown
    { id: 'w3', title: 'By status', layout: { x: 0, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:jobs', viz: 'bar', groupBy: { field: 'status', bucket: 'none' }, measure: { fn: 'count' }, sort: 'desc', limit: 8 } },
    // valid: join through the injected linked_record field, grouped by the parent's name
    { id: 'w4', title: 'Jobs per client', layout: { x: 6, y: 1, w: 6, h: 3 }, kind: 'report', spec: { formId: '@pack:jobs', viz: 'bar', joins: [{ via: jobLink.id, formId: '@pack:clients', type: 'left' }], groupBy: { field: '@pack:clients::name' }, measure: { fn: 'count' }, limit: 10 } },
    // valid: list + activity + actions; layout w overflows and must be clamped
    { id: 'w5', title: 'Recent jobs', layout: { x: 0, y: 4, w: 99, h: 3 }, kind: 'list', list: { formId: '@pack:jobs', titleField: 'title', subtitleField: 'nope', limit: 999 } },
    { id: 'w6', title: 'Activity', layout: { x: 6, y: 4, w: 6, h: 3 }, kind: 'activity' },
    { id: 'w7', layout: { x: 0, y: 7, w: 12, h: 1 }, kind: 'actions' },
    // INVALID: unknown form
    { id: 'b1', title: 'Ghost', layout: { x: 0, y: 8, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:nope', viz: 'kpi', measure: { fn: 'count' } } },
    // INVALID: hallucinated groupBy field
    { id: 'b2', title: 'Bad group', layout: { x: 3, y: 8, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:jobs', viz: 'bar', groupBy: { field: 'made_up' }, measure: { fn: 'count' } } },
    // INVALID: sum without a field
    { id: 'b3', title: 'Bad sum', layout: { x: 6, y: 8, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:jobs', viz: 'kpi', measure: { fn: 'sum' } } },
    // INVALID: join not backed by a linked_record field
    { id: 'b4', title: 'Bad join', layout: { x: 9, y: 8, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:clients', viz: 'bar', joins: [{ via: 'name', formId: '@pack:jobs' }], groupBy: { field: '@pack:jobs::status' }, measure: { fn: 'count' } } },
    // INVALID: unknown widget kind
    { id: 'b5', layout: { x: 0, y: 9, w: 3, h: 1 }, kind: 'iframe' },
  ],
};
const { dashboard: cleanDash, dropped } = sanitizeDashboard(aiDashboard, pack);
check('7 valid widgets survive', cleanDash.widgets.length === 7, `got ${cleanDash.widgets.length}`);
check('5 invalid widgets dropped with reasons', dropped.length === 5, dropped.join(' | '));
const w5 = cleanDash.widgets.find((w) => w.id === 'w5');
check('overflowing layout clamped to the grid', w5.layout.w <= 12 && w5.layout.x + w5.layout.w <= 12);
check('list limit clamped to 25', w5.list.limit === 25);
check('bad list subtitleField dropped, good titleField kept', w5.list.titleField === 'title' && !('subtitleField' in w5.list));
check('join widget kept intact', cleanDash.widgets.find((w) => w.id === 'w4')?.spec.joins[0].formId === '@pack:clients');
check('no non-pack-safe spec keys leak', cleanDash.widgets.every((w) => !w.spec || !('dateRange' in w.spec || 'filterMode' in w.spec || 'color' in w.spec)));

console.log('\n[4] fallback template');
const fb = buildFallbackDashboard(pack);
const fbClean = sanitizeDashboard(fb, pack);
check('fallback has KPIs + chart + trend + list + activity + actions',
  fb.widgets.length === Math.min(pack.forms.length, 4) + 5, `got ${fb.widgets.length}`);
check('fallback survives sanitizing losslessly', fbClean.dropped.length === 0 && fbClean.dashboard.widgets.length === fb.widgets.length,
  fbClean.dropped.join(' | '));
check('fallback picks the busiest form (jobs) for its charts', fb.widgets.some((w) => w.id === 'c1' && w.spec.formId === '@pack:jobs'));
check('fallback groups by the real dropdown, not __status', fb.widgets.find((w) => w.id === 'c1')?.spec.groupBy.field === 'status');

console.log('\n[5] final pack validation');
attachAppDashboard(pack, cleanDash);
check('app customScreen is a widget dashboard', pack.apps[0].customScreen?.enabled === true
  && pack.apps[0].customScreen.kind === 'dashboard');
const errors = validatePack(pack);
check('assembled pack validates against the importer rules', errors.length === 0, errors.join('; '));

console.log('\n[6] validatePack catches broken packs');
const broken = JSON.parse(JSON.stringify(pack));
broken.forms[1].fields.find((f) => f.type === 'linked_record').properties.targetFormId = '@pack:ghost';
broken.apps[0].roles[0].permissions.push({ packFormId: 'ghost', permission: 'view_all_responses' });
broken.apps[0].customScreen.dashboard.widgets.push({ id: 'x', layout: { x: 0, y: 9, w: 3, h: 1 }, kind: 'report', spec: { formId: '@pack:ghost', viz: 'kpi' } });
const brokenErrors = validatePack(broken);
check('dangling link is an error', brokenErrors.some((e) => e.includes('targets unknown form')));
check('dangling role permission is an error', brokenErrors.some((e) => e.includes('unknown form "ghost"')));
check('dangling dashboard widget is an error', brokenErrors.some((e) => e.includes('dashboard:')));

console.log('\n[7] helpers');
check('extractJson: fenced', extractJson('Sure!\n```json\n{"a":1}\n```').a === 1);
check('extractJson: prose-wrapped', extractJson('Here you go {"a":{"b":2}} hope it helps').a.b === 2);
check('extractJson: braces inside strings', extractJson('{"s":"a } b { c"}').s === 'a } b { c');
let threw = false; try { extractJson('{"a": 1'); } catch { threw = true; }
check('extractJson: unbalanced throws', threw);
check('slug', slug('  Hello,  World! ') === 'hello_world');
const used = new Set(['field']);
check('safeFieldId avoids collisions + leading digits', safeFieldId('123 Field', used) !== 'field' && /^[a-zA-Z_]/.test(safeFieldId('456', used)));

console.log(failures ? `\nSELF-TEST FAILED — ${failures} check(s) failed.` : '\nSELF-TEST PASSED — the engine assembles importer-valid packs offline.');
process.exit(failures ? 1 : 0);
