// AI App Builder — the build pipeline (the only part with I/O). Given a reviewed plan, it generates
// each form (+ scripts), assembles a Pack, validates it, imports it atomically, and publishes.
import { api, type PackData, type FormField } from '../api';
import type { AppPlan, GeneratedForm, BuildProgress, BuildResult } from './types';
import { formPrompt, assemblePack, validatePack } from './engine';

export async function buildAppFromPlan(
  plan: AppPlan,
  onProgress: (p: BuildProgress) => void,
): Promise<BuildResult> {
  const generated: Record<string, GeneratedForm> = {};
  const total = plan.forms.length;

  // 1. Generate each form's fields (+ an onSubmit script when the form needs logic).
  for (let i = 0; i < plan.forms.length; i++) {
    const f = plan.forms[i];
    onProgress({ stage: 'generating', message: `Generating “${f.title}”…`, current: i + 1, total });
    const res = await api.generateFormFromPrompt(formPrompt(plan, f));
    const data = res.data?.data;
    if (res.error || !data) {
      throw new Error(`Couldn't generate “${f.title}”${res.error ? `: ${res.error}` : ''}`);
    }
    generated[f.key] = { fields: (data.fields || []) as GeneratedForm['fields'] };
    const fieldProjection = (data.fields || []).map((x) => ({ id: x.id, label: x.label, type: x.type }));
    if (data.needsScript && (data.suggestedScript || '').trim()) {
      try {
        const sres = await api.generateScript(data.suggestedScript as string, fieldProjection as unknown as FormField[]);
        if (sres.data?.data?.script) generated[f.key].logicScript = sres.data.data.script;
      } catch { /* script is best-effort — never block the build */ }
    }
    // Generate a custom screen when the plan flagged this form for one (best-effort).
    if (f.screen && f.screen.trim()) {
      try {
        onProgress({ stage: 'generating', message: `Designing the “${f.title}” screen…`, current: i + 1, total });
        const sc = await api.generateScreen(f.screen.trim(), fieldProjection);
        const g = sc.data?.data;
        if (g && (g.html || g.js)) generated[f.key].customScreen = { enabled: true, html: g.html, css: g.css, js: g.js };
      } catch { /* screen is best-effort — never block the build */ }
    }
  }

  // 2. Assemble + validate the Pack.
  onProgress({ stage: 'assembling', message: 'Assembling the app…' });
  const pack = assemblePack(plan, generated);
  const packErrors = validatePack(pack);
  if (packErrors.length) throw new Error(`Generated app failed validation: ${packErrors[0]}`);

  // 3. Import atomically — creates app + forms + linked-record links + roles in one transaction.
  // SAFE-001: the server requires an explicit reviewed-grant array. The builder's assemblePack
  // emits only form-level role permissions (never connector grants), so [] is exact — and if a
  // future generator ever emitted one, failing closed here is the correct outcome.
  onProgress({ stage: 'importing', message: 'Creating forms, links, and the app…' });
  const imp = await api.importPack(pack as unknown as PackData, { approvedConnectorGrants: [] });
  if (imp.error || !imp.data) throw new Error(`Couldn't create the app${imp.error ? `: ${imp.error}` : ''}`);
  const appId = imp.data.apps?.[0]?.id || '';
  const appName = imp.data.apps?.[0]?.name || plan.app.name;

  // 4. Publish (import creates everything as draft).
  onProgress({ stage: 'publishing', message: 'Publishing…' });
  for (const fm of imp.data.forms || []) {
    try { await api.updateForm(fm.id, { status: 'published' }); } catch { /* keep going */ }
  }
  if (appId) { try { await api.updateApp(appId, { status: 'published' }); } catch { /* keep going */ } }

  onProgress({ stage: 'done', message: 'Done' });
  return { appId, appName, forms: imp.data.forms || [] };
}
