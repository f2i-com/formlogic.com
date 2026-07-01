import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Sparkles, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { ScreenFilesEditor } from '../components/custom-screen/ScreenFilesEditor';
import { AppCustomScreenRuntime } from '../components/custom-screen/AppCustomScreenRuntime';
import { bundleScreenFiles, type ScreenFile } from '../lib/screenCompile';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import type { CustomScreen } from '../types/form';
import type { AppRuntimeForm } from '../types/app';

const STARTER: ScreenFile[] = [
  { path: 'index.html', content: '<div id="app"></div>' },
  { path: 'styles.css', content: 'body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }' },
  { path: 'index.ts', content: '// window.FormLogic (app SDK): context(), forms(), submit(formId, answers), records(formId), navigate(formId).\n// Import other files with relative paths, e.g. import { Card } from "./components/Card";\nconst app = document.getElementById("app")!;\nFormLogic.context().then((ctx) => {\n  app.innerHTML = "<h1>" + ctx.appName + "</h1>";\n});\n' },
];

function toFiles(cs: CustomScreen): ScreenFile[] {
  if (cs.files && cs.files.length) return cs.files.map((f) => ({ ...f }));
  const src = cs.ts ?? cs.js ?? '';
  if (!(cs.html || cs.css || src)) return STARTER.map((f) => ({ ...f }));
  return [
    { path: 'index.html', content: cs.html ?? '' },
    { path: 'styles.css', content: cs.css ?? '' },
    { path: 'index.ts', content: src },
  ];
}

export default function AppHomeStudio() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [forms, setForms] = useState<AppRuntimeForm[]>([]);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<ScreenFile[]>(() => STARTER.map((f) => ({ ...f })));
  const [preview, setPreview] = useState<CustomScreen>({ enabled: true });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  // AI panel is opt-in (default: just the editor), independent of whether the local AI is enabled.
  const [showAi, setShowAi] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const previewTimer = useRef<number | undefined>(undefined);
  const aiAvailable = useAiAvailable();
  useDocumentTitle(`Custom app — ${name || 'App'}`);

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    (async () => {
      const appRes = await api.getApp(appId);
      const app = appRes.data?.app as { name?: string; slug?: string; customScreen?: CustomScreen } | undefined;
      if (!app || cancelled) return;
      setName(app.name || '');
      setSlug(app.slug || '');
      const cs = app.customScreen;
      if (cs && (cs.html || cs.js || cs.ts || cs.files?.length)) {
        setFiles(toFiles(cs));
        setPreview({ ...cs, enabled: true });
      }
      const afRes = await api.getAppForms(appId);
      const appForms = (afRes.data?.forms || []) as Array<{ formId: string; displayName: string }>;
      const enriched = await Promise.all(appForms.map(async (af) => {
        const fr = await api.getForm(af.formId);
        return {
          formId: af.formId,
          displayName: af.displayName,
          fields: (fr.data?.form?.fields || []) as unknown[],
          settings: {} as Record<string, unknown>,
        };
      }));
      if (!cancelled) { setForms(enriched); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [appId]);

  const hasScreen = files.some((f) => f.content.trim());

  const rebuild = (nextFiles: ScreenFile[]) => {
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(async () => {
      const r = await bundleScreenFiles(nextFiles);
      setCompileError(r.error || null);
      setPreview({ enabled: true, files: nextFiles, html: r.html, css: r.css, js: r.error ? '' : r.js });
    }, 450);
  };

  const onFilesChange = (nextFiles: ScreenFile[]) => { setFiles(nextFiles); setDirty(true); rebuild(nextFiles); };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    const existing = hasScreen ? JSON.stringify(files) : undefined;
    const appForms = forms.map((f) => ({ formId: f.formId, title: f.displayName, fields: f.fields }));
    const res = await api.generateScreen(prompt.trim(), undefined, existing, appForms);
    setGenerating(false);
    const g = res.data?.data;
    if (res.error || !g) { toast.error(typeof res.error === 'string' ? res.error : 'Could not generate the app.'); return; }
    const next: ScreenFile[] = [
      { path: 'index.html', content: g.html || '<div id="app"></div>' },
      { path: 'styles.css', content: g.css || '' },
      { path: 'index.ts', content: g.js || '' },
    ];
    setFiles(next); setDirty(true); rebuild(next);
    toast.success('App generated — preview on the right.');
  };

  const save = async () => {
    if (!appId || saving) return;
    const r = await bundleScreenFiles(files);
    if (r.error) { setCompileError(r.error); toast.error('Fix the error before saving: ' + r.error); return; }
    setSaving(true);
    const toSave: CustomScreen = { enabled: true, files, js: r.js, html: r.html, css: r.css };
    const res = await api.updateApp(appId, { customScreen: toSave });
    setSaving(false);
    if (res.error) { toast.error('Could not save.'); return; }
    setCompileError(null);
    setDirty(false);
    toast.success('Custom app saved.');
  };

  return (
    <div className="h-dvh flex flex-col bg-gray-50 dark:bg-slate-950">
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => navigate(-1)} className="text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white truncate">Custom App</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
          <span className="text-sm text-gray-400 dark:text-slate-500 truncate hidden sm:inline">· {name}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen((v) => !v)} leftIcon={previewOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />} title={previewOpen ? 'Hide preview' : 'Show preview'}>
            <span className="hidden sm:inline">{previewOpen ? 'Hide preview' : 'Preview'}</span>
          </Button>
          {hasScreen && !dirty && slug && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/app/${slug}`, '_blank', 'noopener,noreferrer')}>Open app</Button>
          )}
          <Button size="sm" onClick={save} disabled={!hasScreen || saving || !dirty} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Save</Button>
        </div>
      </div>

      <div className={`flex-1 min-h-0 grid grid-cols-1 ${previewOpen ? 'lg:grid-cols-2' : ''}`}>
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800">
          <div className="p-4 space-y-3 border-b border-gray-200 dark:border-slate-800">
            {aiAvailable && showAi ? (
              <>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-500 dark:text-slate-400">Describe the app</label>
                  <button type="button" onClick={() => setShowAi(false)} className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 cursor-pointer">Hide</button>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. A home dashboard with a card per form and a high-score leaderboard"
                  className="w-full h-20 px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-400 dark:text-slate-500">Spans this app's {forms.length} form{forms.length === 1 ? '' : 's'} via the app SDK (submit/records/navigate).</p>
                  <Button size="sm" onClick={generate} disabled={!prompt.trim() || generating} leftIcon={generating ? <Loader2 className="h-4 w-4 animate-spin" /> : (hasScreen ? <Wand2 className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />)}>
                    {generating ? 'Generating…' : hasScreen ? 'Regenerate' : 'Generate'}
                  </Button>
                </div>
              </>
            ) : aiAvailable ? (
              <button type="button" onClick={() => setShowAi(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">
                <Sparkles className="h-3.5 w-3.5" /> Generate with AI
              </button>
            ) : (
              <p className="text-xs text-gray-500 dark:text-slate-400">Build the app across files (HTML / CSS / TypeScript) on the left — it uses the app SDK over this app's {forms.length} form{forms.length === 1 ? '' : 's'}. Or connect an external AI via MCP (Settings → Connect an AI).</p>
            )}
          </div>

          <ScreenFilesEditor files={files} onChange={onFilesChange} sdk="app" />
          {compileError && (
            <div className="mx-3 mb-3 px-3 py-2 text-xs rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 font-mono">
              {compileError}
            </div>
          )}
        </div>

        {previewOpen && (
          <div className="min-h-0 flex flex-col bg-white dark:bg-slate-900">
            <div className="px-4 h-9 shrink-0 flex items-center text-xs font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-800">Live preview</div>
            <div className="flex-1 min-h-0">
              {!loaded ? (
                <div className="h-full flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary-500" /></div>
              ) : (preview.html || preview.js || preview.files?.length) ? (
                <AppCustomScreenRuntime key={forms.map((f) => f.formId).join(',')} screen={preview} appSlug={slug} appName={name} forms={forms} className="w-full h-full border-0" />
              ) : (
                <div className="h-full flex items-center justify-center text-center px-6">
                  <p className="text-sm text-gray-400 dark:text-slate-500">Edit the files on the left — the live preview appears here.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
