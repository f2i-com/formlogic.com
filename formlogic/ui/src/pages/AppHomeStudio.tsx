import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Sparkles, PanelRightClose, PanelRightOpen, FileCode2, FilePlus2, LayoutTemplate, FolderUp, Atom } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ScreenFilesEditor } from '../components/custom-screen/ScreenFilesEditor';
import { readUploadedScreenFiles } from '../components/custom-screen/screenFileUpload';
import { AppCustomScreenRuntime } from '../components/custom-screen/AppCustomScreenRuntime';
import { bundleScreenFiles, type ScreenFile } from '../lib/screenCompile';
import { toast } from '../stores/toastStore';
import { useAdminActing } from '../components/admin/AdminActingContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import type { CustomScreen } from '../types/form';
import type { AppRuntimeForm } from '../types/app';

const STARTER: ScreenFile[] = [
  { path: 'index.html', content: '<div id="app"></div>' },
  { path: 'styles.css', content: 'body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }' },
  { path: 'index.ts', content: '// window.FormLogic (app SDK): context(), forms(), submit(formId, answers), records(formId), navigate(formId).\n// Import other files with relative paths, e.g. import { Card } from "./components/Card";\nconst app = document.getElementById("app")!;\nFormLogic.context().then((ctx) => {\n  app.innerHTML = "<h1>" + ctx.appName + "</h1>";\n});\n' },
];

// React-style components — no index.html needed (the bundler mounts into a default <div id="root">).
// 'react' imports bundle to Preact inside the sandbox, so hooks and JSX work as usual. Folders of
// components with relative imports are supported — this starter shows the pattern.
const STARTER_TSX: ScreenFile[] = [
  { path: 'styles.css', content: 'body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }\nmain { max-width: 640px; margin: 0 auto; }\n.form-card { display: block; width: 100%; text-align: left; padding: 12px 16px; margin: 0 0 8px; border: 1px solid var(--fl-border); border-radius: 10px; background: var(--fl-surface); cursor: pointer; font: inherit; }\n.form-card:hover { border-color: var(--fl-accent); }\n' },
  {
    path: 'components/FormCard.tsx',
    content: `// A tiny reusable component — add more files/folders and import them with relative paths.
export function FormCard({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button class="form-card" onClick={onOpen}>
      {name}
    </button>
  );
}
`,
  },
  {
    path: 'index.tsx',
    content: `// index.tsx — React-style components. \`import from 'react'\` works (bundled with Preact).
// window.FormLogic (app SDK): context(), forms(), submit(formId, answers), records(formId), navigate(formId).
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FormCard } from './components/FormCard';

function App() {
  const [ctx, setCtx] = useState<{ appName: string; forms: FlFormRef[] } | null>(null);

  useEffect(() => {
    FormLogic.context().then(setCtx);
  }, []);

  if (!ctx) return <p>Loading…</p>;
  return (
    <main>
      <h1>{ctx.appName}</h1>
      {ctx.forms.map((f) => (
        <FormCard key={f.formId} name={f.displayName} onOpen={() => FormLogic.navigate(f.formId)} />
      ))}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
`,
  },
];

const BLANK: ScreenFile[] = [
  { path: 'index.html', content: '<!-- Build your app\'s home screen here — window.FormLogic is the app SDK (context, forms, submit, records, navigate). -->\n' },
];

const START_CARD =
  'rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-left shadow-sm hover:border-primary-400 dark:hover:border-primary-500/60 hover:shadow-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950';

function toFiles(cs: CustomScreen): ScreenFile[] {
  if (cs.files && cs.files.length) return cs.files.map((f) => ({ ...f }));
  const src = cs.ts ?? cs.js ?? '';
  if (!(cs.html || cs.css || src)) return [];
  return [
    { path: 'index.html', content: cs.html ?? '' },
    { path: 'styles.css', content: cs.css ?? '' },
    { path: 'index.ts', content: src },
  ];
}

export default function AppHomeStudio() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  // Platform-admin acting mode: widget previews render no record data.
  const acting = useAdminActing();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [forms, setForms] = useState<AppRuntimeForm[]>([]);
  const [prompt, setPrompt] = useState('');
  // No auto-seeded starter: an empty list means "no custom code yet" and renders the start screen.
  const [files, setFiles] = useState<ScreenFile[]>([]);
  const [preview, setPreview] = useState<CustomScreen>({ enabled: true });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [screenLoaded, setScreenLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [compileError, setCompileError] = useState<string | null>(null);
  // AI panel is opt-in (default: just the editor), independent of whether the local AI is enabled.
  const [showAi, setShowAi] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const previewTimer = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const aiAvailable = useAiAvailable();
  useDocumentTitle(`Custom app — ${name || 'App'}`);

  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    // No synchronous state reset here — initial state is already clean, and the
    // "Try again" click handler resets loadError/screenLoaded before bumping loadAttempt.
    (async () => {
      const appRes = await api.getApp(appId);
      if (cancelled) return;
      setScreenLoaded(true);
      const app = appRes.data?.app as { name?: string; slug?: string; customScreen?: CustomScreen } | undefined;
      if (appRes.error || !app) {
        // A failed load must NOT fall through to the start screen — "Start blank" + Save
        // from there would overwrite a real saved home screen.
        setLoadError(typeof appRes.error === 'string' ? appRes.error : 'Could not load this app.');
        return;
      }
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
  }, [appId, loadAttempt]);

  // Guard page navigation/refresh while there are unsaved editor changes (mirrors DashboardBuilder).
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

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

  /** An explicit starting choice (blank / starter / upload) — drops the user into the normal editor. */
  const startWith = (next: ScreenFile[]) => { setFiles(next); setDirty(true); rebuild(next); };

  const onUpload = async (picked: File[]) => {
    if (!picked.length) return;
    try {
      const { files: uploaded, skipped } = await readUploadedScreenFiles(picked);
      if (!uploaded.length) {
        toast.error('No usable files found', skipped.length ? skipped.slice(0, 4).join('; ') : 'Pick text files such as index.html, styles.css or index.ts.');
        return;
      }
      if (skipped.length) toast.info(`Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}`, skipped.slice(0, 4).join('; ') + (skipped.length > 4 ? ' …' : ''));
      startWith(uploaded);
    } catch {
      toast.error('Could not read the selected files.');
    }
  };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    const existing = hasScreen ? JSON.stringify(files) : undefined;
    const appForms = forms.map((f) => ({ formId: f.formId, title: f.displayName, fields: f.fields }));
    const res = await api.generateScreen(prompt.trim(), undefined, existing, appForms);
    setGenerating(false);
    const g = res.data?.data;
    if (res.error || !g) { toast.error(typeof res.error === 'string' ? res.error : 'Could not generate the app.'); return; }
    // Preferred: a multi-file TSX project straight from the model; legacy triple as fallback.
    const next: ScreenFile[] = g.files?.length
      ? g.files.map((f) => ({ path: f.path, content: f.content }))
      : [
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
    if (res.error) { toast.error('Could not save.', typeof res.error === 'string' ? res.error : undefined); return; }
    setCompileError(null);
    setDirty(false);
    toast.success('Custom app saved.');
  };

  return (
    <div className="h-[calc(100dvh-var(--fl-demo-banner-h,0px))] flex flex-col bg-gray-50 dark:bg-slate-950">
      {acting && (
        <div className="bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 text-xs px-4 py-1.5 text-center shrink-0 border-b border-slate-200 dark:border-slate-700">
          Widget previews show no data — record data is not visible to platform admins. Layout, widgets and code remain fully editable.
        </div>
      )}
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => { if (dirty) setConfirmLeave(true); else navigate(-1); }} className="text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white truncate">Custom App</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
          </div>
          <p className="text-[11px] leading-tight text-gray-400 dark:text-slate-500 truncate hidden sm:block">
            {name ? `A coded home screen for “${name}”` : 'A coded home screen for this app'} — HTML, CSS &amp; TypeScript over the app SDK
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen((v) => !v)} leftIcon={previewOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />} title={previewOpen ? 'Hide preview' : 'Show preview'}>
            <span className="hidden sm:inline">{previewOpen ? 'Hide preview' : 'Preview'}</span>
          </Button>
          {hasScreen && !dirty && slug && !acting && (
            <Button variant="outline" size="sm" onClick={() => window.open(`/app/${slug}`, '_blank', 'noopener,noreferrer')}>Open app</Button>
          )}
          <Button size="sm" onClick={save} disabled={!hasScreen || saving || !dirty} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Save</Button>
        </div>
      </div>

      <div className={`flex-1 min-h-0 grid grid-cols-1 ${previewOpen ? 'lg:grid-cols-2' : ''}`}>
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800">
          {(files.length > 0 || (aiAvailable && showAi)) && (
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
            ) : aiAvailable && files.length > 0 ? (
              <button type="button" onClick={() => setShowAi(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">
                <Sparkles className="h-3.5 w-3.5" /> Generate with AI
              </button>
            ) : files.length > 0 ? (
              <p className="text-xs text-gray-500 dark:text-slate-400">Build the app across files (HTML / CSS / TypeScript) on the left — it uses the app SDK over this app's {forms.length} form{forms.length === 1 ? '' : 's'}. Or connect an external AI via MCP (Settings → Connect an AI).</p>
            ) : null}
          </div>
          )}

          {!screenLoaded ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            </div>
          ) : loadError ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16 text-center px-4">
              <p className="text-sm text-gray-600 dark:text-slate-300">{loadError}</p>
              <Button variant="outline" size="sm" onClick={() => { setLoadError(null); setScreenLoaded(false); setLoadAttempt((n) => n + 1); }}>Try again</Button>
            </div>
          ) : files.length === 0 ? (
            /* Empty state: load succeeded but nothing saved yet — pick an explicit starting point. */
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="max-w-xl mx-auto px-6 py-12 text-center">
                <div className="mx-auto mb-4 h-14 w-14 rounded-2xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                  <FileCode2 className="h-7 w-7 text-primary-600 dark:text-primary-400" />
                </div>
                <h2 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">No custom code yet</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  Replace the app&apos;s home screen with your own HTML, CSS &amp; TypeScript frontend —
                  including React-style TSX components — reading, submitting and navigating across all of
                  this app&apos;s forms through the FormLogic SDK.
                </p>
                <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
                  <button type="button" onClick={() => startWith(STARTER_TSX.map((f) => ({ ...f })))} className={START_CARD}>
                    <Atom className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">React-style TSX</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">Components with hooks — <code>import</code> from &lsquo;react&rsquo;, rendered by Preact. No index.html needed.</span>
                  </button>
                  <button type="button" onClick={() => startWith(STARTER.map((f) => ({ ...f })))} className={START_CARD}>
                    <LayoutTemplate className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">HTML + TypeScript</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">A tiny HTML + CSS + TypeScript scaffold wired to the app SDK.</span>
                  </button>
                  <button type="button" onClick={() => startWith(BLANK.map((f) => ({ ...f })))} className={START_CARD}>
                    <FilePlus2 className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">Start blank</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">An empty index.html — build everything yourself.</span>
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className={START_CARD}>
                    <FolderUp className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">Upload files or folder</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">Import existing .html / .css / .ts / .tsx files.</span>
                  </button>
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
                  <button type="button" onClick={() => folderInputRef.current?.click()} className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
                    <FolderUp className="h-3.5 w-3.5" aria-hidden="true" /> Upload a whole folder
                  </button>
                  {aiAvailable && !showAi && (
                    <button type="button" onClick={() => setShowAi(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Generate with AI
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".html,.htm,.css,.js,.ts,.tsx,.jsx,.json,.svg,.md,.txt"
                  className="hidden"
                  onChange={(e) => { const picked = e.currentTarget.files ? Array.from(e.currentTarget.files) : []; e.currentTarget.value = ''; void onUpload(picked); }}
                />
                {/* webkitdirectory is not in React's input typings — set it via the ref. */}
                <input
                  ref={(el) => { folderInputRef.current = el; el?.setAttribute('webkitdirectory', ''); }}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => { const picked = e.currentTarget.files ? Array.from(e.currentTarget.files) : []; e.currentTarget.value = ''; void onUpload(picked); }}
                />
              </div>
            </div>
          ) : (
            <>
              <p className="mx-3 mb-1 mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400/90">
                Custom code screens are <strong>trusted, app-wide frontends</strong>. The SDK only exposes data
                the viewer is permitted to see, but the screen&apos;s own code can contain labels or form IDs you
                author. For strict per-role structure hiding, prefer the no-code widget dashboard.
              </p>
              <ScreenFilesEditor files={files} onChange={onFilesChange} sdk="app" />
              {compileError && (
                <div className="mx-3 mb-3 px-3 py-2 text-xs rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 font-mono">
                  {compileError}
                </div>
              )}
            </>
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
                  <p className="text-sm text-gray-400 dark:text-slate-500">
                    {files.length === 0 ? 'Pick a starting point on the left — the live preview appears here.' : 'Edit the files on the left — the live preview appears here.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Unsaved-changes guard for the header Back exit (mirrors DashboardBuilder). */}
      <ConfirmDialog
        isOpen={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => { setConfirmLeave(false); navigate(-1); }}
        title="Discard unsaved changes?"
        message="This home screen has unsaved changes. Leaving will discard them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        variant="danger"
      />
    </div>
  );
}
