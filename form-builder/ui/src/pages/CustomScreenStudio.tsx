import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Play, Sparkles, PanelRightClose, PanelRightOpen, FileCode2, FilePlus2, LayoutTemplate, FolderUp } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ScreenFilesEditor } from '../components/custom-screen/ScreenFilesEditor';
import { readUploadedScreenFiles } from '../components/custom-screen/screenFileUpload';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { bundleScreenFiles, type ScreenFile } from '../lib/screenCompile';
import { toast } from '../stores/toastStore';
import { useAdminActing } from '../components/admin/AdminActingContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import type { CustomScreen } from '../types/form';

const STARTER: ScreenFile[] = [
  { path: 'index.html', content: '<div id="app"></div>' },
  { path: 'styles.css', content: 'body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }' },
  { path: 'index.ts', content: '// window.FormLogic is the SDK: submit(answers), records(), currentUser(), context().\n// Import other files with relative paths, e.g. import { greet } from "./util";\nconst app = document.getElementById("app")!;\napp.innerHTML = "<h1>Hello from TypeScript</h1>";\n' },
];

const BLANK: ScreenFile[] = [
  { path: 'index.html', content: '<!-- Build your screen here — window.FormLogic is the SDK (submit, records, context). -->\n' },
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

export default function CustomScreenStudio() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  // Platform-admin acting mode: the live preview renders no record data.
  const acting = useAdminActing();
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  const [prompt, setPrompt] = useState('');
  const [meta, setMeta] = useState<CustomScreen>({ enabled: true }); // publicRecords + whitelist
  // No auto-seeded starter: an empty list means "no custom code yet" and renders the start screen.
  const [files, setFiles] = useState<ScreenFile[]>([]);
  const [preview, setPreview] = useState<CustomScreen>({ enabled: true });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [screenLoaded, setScreenLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [compileError, setCompileError] = useState<string | null>(null);
  // The AI "Describe the screen" panel is opt-in (default: just the editor), separate from AI_ENABLED.
  const [showAi, setShowAi] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const previewTimer = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const aiAvailable = useAiAvailable();
  useDocumentTitle(`Custom screen — ${title || 'Form'}`);

  useEffect(() => {
    if (!formId) return;
    let cancelled = false;
    // No synchronous state reset here — initial state is already clean, and the
    // "Try again" click handler resets loadError/screenLoaded before bumping loadAttempt.
    api.getForm(formId).then((res) => {
      if (cancelled) return;
      setScreenLoaded(true);
      const form = res.data?.form;
      if (res.error || !form) {
        // A failed load must NOT fall through to the start screen — "Start blank" + Save
        // from there would overwrite a real saved screen.
        setLoadError(typeof res.error === 'string' ? res.error : 'Could not load this form.');
        return;
      }
      setTitle(form.title || '');
      setFields((form.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type })));
      const cs = form.customScreen;
      if (cs && (cs.html || cs.js || cs.ts || cs.files?.length)) {
        setMeta({ enabled: true, publicRecords: cs.publicRecords, publicRecordFields: cs.publicRecordFields, allowNewResponses: cs.allowNewResponses });
        setFiles(toFiles(cs));
        setPreview({ ...cs, enabled: true });
      }
    });
    return () => { cancelled = true; };
  }, [formId, loadAttempt]);

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
      setPreview({ ...meta, enabled: true, files: nextFiles, html: r.html, css: r.css, js: r.error ? '' : r.js });
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
    const res = await api.generateScreen(prompt.trim(), fields, existing);
    setGenerating(false);
    const g = res.data?.data;
    if (res.error || !g) { toast.error(typeof res.error === 'string' ? res.error : 'Could not generate the screen.'); return; }
    const next: ScreenFile[] = [
      { path: 'index.html', content: g.html || '<div id="app"></div>' },
      { path: 'styles.css', content: g.css || '' },
      { path: 'index.ts', content: g.js || '' },
    ];
    setFiles(next); setDirty(true); rebuild(next);
    toast.success('Screen generated — preview on the right.');
  };

  const save = async () => {
    if (!formId || saving) return;
    const r = await bundleScreenFiles(files);
    if (r.error) { setCompileError(r.error); toast.error('Fix the error before saving: ' + r.error); return; }
    setSaving(true);
    const toSave: CustomScreen = { ...meta, enabled: true, files, js: r.js, html: r.html, css: r.css };
    const res = await api.updateForm(formId, { customScreen: toSave });
    setSaving(false);
    if (res.error) { toast.error('Could not save the screen.', typeof res.error === 'string' ? res.error : undefined); return; }
    setCompileError(null);
    setDirty(false);
    toast.success('Custom screen saved.');
  };

  return (
    <div className="h-dvh flex flex-col bg-gray-50 dark:bg-slate-950">
      {acting && (
        <div className="bg-amber-100 dark:bg-amber-500/15 text-amber-900 dark:text-amber-200 text-xs px-4 py-1.5 text-center shrink-0">
          The screen preview shows no data — record data is not visible to platform admins. The code and layout remain fully editable.
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => { if (dirty) setConfirmLeave(true); else navigate(-1); }} className="text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-white truncate">Custom Screen</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
          </div>
          <p className="text-[11px] leading-tight text-gray-400 dark:text-slate-500 truncate hidden sm:block">
            {title ? `A coded frontend for “${title}”` : 'A coded frontend for this form'} — HTML, CSS &amp; TypeScript over the FormLogic SDK
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPreviewOpen((v) => !v)} leftIcon={previewOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />} title={previewOpen ? 'Hide preview' : 'Show preview'}>
            <span className="hidden sm:inline">{previewOpen ? 'Hide preview' : 'Preview'}</span>
          </Button>
          {hasScreen && !dirty && !acting && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/forms/${formId}/screen`)} leftIcon={<Play className="h-4 w-4" />}>Open</Button>
          )}
          <Button size="sm" onClick={save} disabled={!hasScreen || saving || !dirty} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Save</Button>
        </div>
      </div>

      {/* Body: editor | preview */}
      <div className={`flex-1 min-h-0 grid grid-cols-1 ${previewOpen ? 'lg:grid-cols-2' : ''}`}>
        {/* Editor */}
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800">
          {(files.length > 0 || (aiAvailable && showAi)) && (
          <div className="p-4 space-y-3 border-b border-gray-200 dark:border-slate-800">
            {aiAvailable && showAi ? (
              <>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-500 dark:text-slate-400">Describe the screen</label>
                  <button type="button" onClick={() => setShowAi(false)} className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 cursor-pointer">Hide</button>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. A Wordle clone that saves each finished game and shows a leaderboard"
                  className="w-full h-20 px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-400 dark:text-slate-500">Uses the FormLogic SDK (submit/records) over <span className="font-medium">{title || 'this form'}</span>.</p>
                  <Button size="sm" onClick={generate} disabled={!prompt.trim() || generating} leftIcon={generating ? <Loader2 className="h-4 w-4 animate-spin" /> : (hasScreen ? <Wand2 className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />)}>
                    {generating ? 'Generating…' : hasScreen ? 'Regenerate' : 'Generate'}
                  </Button>
                </div>
              </>
            ) : aiAvailable && files.length > 0 ? (
              <button type="button" onClick={() => setShowAi(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">
                <Sparkles className="h-3.5 w-3.5" /> Generate with AI
              </button>
            ) : null}
            {files.length > 0 && (
            <div className="pt-1 space-y-2">
              <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!meta.allowNewResponses}
                  onChange={(e) => { setMeta({ ...meta, allowNewResponses: e.target.checked }); setDirty(true); }}
                  className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
                />
                <span>
                  Allow new records while the screen is shown — viewers get a &ldquo;New record&rdquo; button that opens
                  the real form (your screen can also call <code className="text-[10px]">FormLogic.openForm()</code>).
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!meta.publicRecords}
                  onChange={(e) => { setMeta({ ...meta, publicRecords: e.target.checked }); setDirty(true); }}
                  className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
                />
                <span>Let visitors read submissions on the public link (for a public leaderboard).</span>
              </label>
              {meta.publicRecords && (
                <div className="ml-6 space-y-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 p-2.5">
                  <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    Visitors can read <strong>only</strong> the fields you tick. Never expose names, emails, phone numbers, files, or private/internal fields.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {fields.map((f) => {
                      const on = (meta.publicRecordFields || []).includes(f.id);
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => {
                            const cur = new Set(meta.publicRecordFields || []);
                            if (on) cur.delete(f.id); else cur.add(f.id);
                            setMeta({ ...meta, publicRecordFields: [...cur] });
                            setDirty(true);
                          }}
                          className={`text-[11px] px-2 py-0.5 rounded-md border cursor-pointer transition-colors ${on ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-primary-400'}`}
                        >
                          {on ? '✓ ' : ''}{f.label || f.id}
                        </button>
                      );
                    })}
                    {fields.length === 0 && <span className="text-[11px] text-gray-400 dark:text-slate-500">No fields to expose yet.</span>}
                  </div>
                </div>
              )}
            </div>
            )}
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
                  Replace the standard form page with your own HTML, CSS &amp; TypeScript frontend — it reads
                  and submits this form&apos;s data through the FormLogic SDK.
                </p>
                <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
                  <button type="button" onClick={() => startWith(BLANK.map((f) => ({ ...f })))} className={START_CARD}>
                    <FilePlus2 className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">Start blank</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">An empty index.html — build everything yourself.</span>
                  </button>
                  <button type="button" onClick={() => startWith(STARTER.map((f) => ({ ...f })))} className={START_CARD}>
                    <LayoutTemplate className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">Use starter template</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">A tiny HTML + CSS + TypeScript scaffold wired to the SDK.</span>
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className={START_CARD}>
                    <FolderUp className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                    <span className="mt-2 block text-sm font-medium text-gray-900 dark:text-white">Upload files or folder</span>
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-slate-400">Import existing .html / .css / .ts files.</span>
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
              {/* Multi-file editor */}
              <p className="mx-3 mb-1 mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400/90">
                Custom code screens are <strong>trusted, app-wide frontends</strong>. The SDK only exposes data
                the viewer is permitted to see, but the screen&apos;s own code can contain labels or form IDs you
                author. For strict per-role structure hiding, prefer the no-code widget dashboard.
              </p>
              <ScreenFilesEditor files={files} onChange={onFilesChange} sdk="form" />
              {compileError && (
                <div className="mx-3 mb-3 px-3 py-2 text-xs rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 font-mono">
                  {compileError}
                </div>
              )}
            </>
          )}
        </div>

        {/* Preview */}
        {previewOpen && (
          <div className="min-h-0 flex flex-col bg-white dark:bg-slate-900">
            <div className="px-4 h-9 shrink-0 flex items-center text-xs font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-800">Live preview</div>
            <div className="flex-1 min-h-0">
              {(preview.html || preview.js || preview.files?.length) ? (
                <CustomScreenRuntime key="preview" screen={preview} formId={formId!} formTitle={title} fields={fields} className="w-full h-full border-0" />
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
        message="This screen has unsaved changes. Leaving will discard them."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        variant="danger"
      />
    </div>
  );
}
