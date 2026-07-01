import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { CodeEditor } from '../components/ui/CodeEditor';
import { AppCustomScreenRuntime } from '../components/custom-screen/AppCustomScreenRuntime';
import { compileScreenCode } from '../lib/screenCompile';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import type { CustomScreen } from '../types/form';
import type { AppRuntimeForm } from '../types/app';

const EMPTY: CustomScreen = { enabled: true, html: '', css: '', js: '', ts: '' };
const EXAMPLES = [
  'A colourful home dashboard with a card per form showing its record count, that opens the form on click',
  'A game launcher hub: big tiles for each form, plus a live high-score leaderboard',
  'A staff portal landing: quick-submit the most-used form inline, recent submissions below',
];
type CodeTab = 'html' | 'css' | 'code';

export default function AppHomeStudio() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [forms, setForms] = useState<AppRuntimeForm[]>([]);
  const [prompt, setPrompt] = useState('');
  const [screen, setScreen] = useState<CustomScreen>(EMPTY);
  const [preview, setPreview] = useState<CustomScreen>(EMPTY);
  const [tab, setTab] = useState<CodeTab>('code');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  // AI panel is opt-in (default: just the editor), independent of whether the local AI is enabled.
  const [showAi, setShowAi] = useState(false);
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
      if (app.customScreen && (app.customScreen.html || app.customScreen.js || app.customScreen.ts)) {
        const cs = { enabled: true, ...app.customScreen, ts: app.customScreen.ts ?? app.customScreen.js ?? '' };
        setScreen(cs);
        setPreview(cs);
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

  const hasScreen = !!(screen.html || screen.js || screen.ts);

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    const existing = hasScreen ? JSON.stringify({ html: screen.html, css: screen.css, js: screen.ts || screen.js }) : undefined;
    const appForms = forms.map((f) => ({ formId: f.formId, title: f.displayName, fields: f.fields }));
    const res = await api.generateScreen(prompt.trim(), undefined, existing, appForms);
    setGenerating(false);
    const g = res.data?.data;
    if (res.error || !g) { toast.error(typeof res.error === 'string' ? res.error : 'Could not generate the app.'); return; }
    const next = { ...screen, enabled: true, html: g.html, css: g.css, ts: g.js, js: g.js };
    setScreen(next);
    setPreview(next);
    setCompileError(null);
    setDirty(true);
    toast.success('App generated — preview on the right.');
  };

  const editCode = (part: CodeTab, value: string) => {
    const key = part === 'code' ? 'ts' : part;
    const next = { ...screen, [key]: value };
    setScreen(next);
    setDirty(true);
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(async () => {
      if (part === 'code') {
        const r = await compileScreenCode(next.ts || '');
        setCompileError(r.error || null);
        const merged = { ...next, js: r.error ? next.js : r.js };
        setScreen(merged);
        setPreview(merged);
      } else {
        setPreview(next);
      }
    }, 450);
  };

  const save = async () => {
    if (!appId || saving) return;
    const r = await compileScreenCode(screen.ts || '');
    if (r.error) { setCompileError(r.error); toast.error('Fix the error before saving: ' + r.error); return; }
    setSaving(true);
    const toSave: CustomScreen = { ...screen, ts: screen.ts || '', js: r.js, enabled: true };
    const res = await api.updateApp(appId, { customScreen: toSave });
    setSaving(false);
    if (res.error) { toast.error('Could not save.'); return; }
    setScreen(toSave);
    setCompileError(null);
    setDirty(false);
    toast.success('Custom app saved.');
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-slate-950">
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
          {hasScreen && !dirty && slug && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/app/${slug}`, '_blank', 'noopener,noreferrer')}>Open app</Button>
          )}
          <Button size="sm" onClick={save} disabled={!hasScreen || saving || !dirty} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Save</Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800 overflow-y-auto">
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
                {!hasScreen && (
                  <div className="flex flex-wrap gap-1.5">
                    {EXAMPLES.map((ex) => (
                      <button key={ex} type="button" onClick={() => setPrompt(ex)} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors cursor-pointer text-left">{ex}</button>
                    ))}
                  </div>
                )}
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
              <p className="text-xs text-gray-500 dark:text-slate-400">Build the app in the tabs below (HTML / CSS / TypeScript) — it uses the app SDK over this app's {forms.length} form{forms.length === 1 ? '' : 's'}. Or connect an external AI via MCP (Settings → Connect an AI).</p>
            )}
          </div>

          <div className="flex items-center gap-1 px-3 pt-3">
            {([['html', 'HTML'], ['css', 'CSS'], ['code', 'TypeScript']] as [CodeTab, string][]).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} className={`text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer transition-colors ${tab === t ? 'bg-gray-200 dark:bg-slate-700 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'}`}>{label}</button>
            ))}
          </div>
          <div className="flex-1 m-3 mt-2 min-h-[260px] rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700">
            <CodeEditor
              value={tab === 'code' ? (screen.ts || '') : (screen[tab] || '')}
              onChange={(v) => editCode(tab, v)}
              language={tab === 'code' ? 'typescript' : tab}
              sdk="app"
            />
          </div>
          {compileError && (
            <div className="mx-3 mb-3 px-3 py-2 text-xs rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 font-mono">
              {compileError}
            </div>
          )}
        </div>

        <div className="min-h-0 flex flex-col bg-white dark:bg-slate-900">
          <div className="px-4 h-9 shrink-0 flex items-center text-xs font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-800">Live preview</div>
          <div className="flex-1 min-h-0">
            {!loaded ? (
              <div className="h-full flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary-500" /></div>
            ) : (preview.html || preview.js || preview.ts) ? (
              // key on form ids so the preview re-mounts once forms resolve (records() needs them).
              <AppCustomScreenRuntime key={forms.map((f) => f.formId).join(',')} screen={preview} appSlug={slug} appName={name} forms={forms} className="w-full h-full border-0" />
            ) : (
              <div className="h-full flex items-center justify-center text-center px-6">
                <p className="text-sm text-gray-400 dark:text-slate-500">Describe the home page and hit <span className="font-medium text-gray-600 dark:text-slate-300">Generate</span> — the live preview appears here.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
