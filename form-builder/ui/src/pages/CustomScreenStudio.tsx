import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Play, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { ScreenFilesEditor } from '../components/custom-screen/ScreenFilesEditor';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { bundleScreenFiles, type ScreenFile } from '../lib/screenCompile';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAiAvailable } from '../hooks/useAiAvailable';
import type { CustomScreen } from '../types/form';

const STARTER: ScreenFile[] = [
  { path: 'index.html', content: '<div id="app"></div>' },
  { path: 'styles.css', content: 'body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }' },
  { path: 'index.ts', content: '// window.FormLogic is the SDK: submit(answers), records(), currentUser(), context().\n// Import other files with relative paths, e.g. import { greet } from "./util";\nconst app = document.getElementById("app")!;\napp.innerHTML = "<h1>Hello from TypeScript</h1>";\n' },
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

export default function CustomScreenStudio() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  const [prompt, setPrompt] = useState('');
  const [meta, setMeta] = useState<CustomScreen>({ enabled: true }); // publicRecords + whitelist
  const [files, setFiles] = useState<ScreenFile[]>(() => STARTER.map((f) => ({ ...f })));
  const [preview, setPreview] = useState<CustomScreen>({ enabled: true });
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  // The AI "Describe the screen" panel is opt-in (default: just the editor), separate from AI_ENABLED.
  const [showAi, setShowAi] = useState(false);
  const previewTimer = useRef<number | undefined>(undefined);
  const aiAvailable = useAiAvailable();
  useDocumentTitle(`Custom screen — ${title || 'Form'}`);

  useEffect(() => {
    if (!formId) return;
    let cancelled = false;
    api.getForm(formId).then((res) => {
      if (cancelled) return;
      const form = res.data?.form;
      if (!form) return;
      setTitle(form.title || '');
      setFields((form.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type })));
      const cs = form.customScreen;
      if (cs && (cs.html || cs.js || cs.ts || cs.files?.length)) {
        setMeta({ enabled: true, publicRecords: cs.publicRecords, publicRecordFields: cs.publicRecordFields });
        setFiles(toFiles(cs));
        setPreview({ ...cs, enabled: true });
      }
    });
    return () => { cancelled = true; };
  }, [formId]);

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
    if (res.error) { toast.error('Could not save the screen.'); return; }
    setCompileError(null);
    setDirty(false);
    toast.success('Custom screen saved.');
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => navigate(-1)} className="text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white truncate">Custom Screen</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
          <span className="text-sm text-gray-400 dark:text-slate-500 truncate hidden sm:inline">· {title}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {hasScreen && !dirty && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/forms/${formId}/screen`)} leftIcon={<Play className="h-4 w-4" />}>Open</Button>
          )}
          <Button size="sm" onClick={save} disabled={!hasScreen || saving || !dirty} leftIcon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}>Save</Button>
        </div>
      </div>

      {/* Body: editor | preview */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2">
        {/* Editor */}
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800">
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
            ) : aiAvailable ? (
              <button type="button" onClick={() => setShowAi(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">
                <Sparkles className="h-3.5 w-3.5" /> Generate with AI
              </button>
            ) : null}
            <div className="pt-1 space-y-2">
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
          </div>

          {/* Multi-file editor */}
          <ScreenFilesEditor files={files} onChange={onFilesChange} sdk="form" />
          {compileError && (
            <div className="mx-3 mb-3 px-3 py-2 text-xs rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 font-mono">
              {compileError}
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="min-h-0 flex flex-col bg-white dark:bg-slate-900">
          <div className="px-4 h-9 shrink-0 flex items-center text-xs font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-800">Live preview</div>
          <div className="flex-1 min-h-0">
            {(preview.html || preview.js || preview.files?.length) ? (
              <CustomScreenRuntime key="preview" screen={preview} formId={formId!} formTitle={title} fields={fields} className="w-full h-full border-0" />
            ) : (
              <div className="h-full flex items-center justify-center text-center px-6">
                <p className="text-sm text-gray-400 dark:text-slate-500">Edit the files on the left — the live preview appears here.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
