import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Wand2, Loader2, Save, Play, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { CustomScreenRuntime } from '../components/custom-screen/CustomScreenRuntime';
import { toast } from '../stores/toastStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import type { CustomScreen } from '../types/form';

const EMPTY: CustomScreen = { enabled: true, html: '', css: '', js: '' };
const EXAMPLES = [
  'A Wordle clone that saves each finished game (word, guesses, won) and shows a leaderboard',
  'A reaction-time test: tap when the box turns green, save the best time, show fastest players',
  'A kanban board backed by this form, with drag-and-drop columns',
];

type CodeTab = 'html' | 'css' | 'js';

export default function CustomScreenStudio() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  const [prompt, setPrompt] = useState('');
  const [screen, setScreen] = useState<CustomScreen>(EMPTY);
  const [preview, setPreview] = useState<CustomScreen>(EMPTY);
  const [tab, setTab] = useState<CodeTab>('html');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const previewTimer = useRef<number | undefined>(undefined);
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
      if (form.customScreen && (form.customScreen.html || form.customScreen.js)) {
        const cs = { enabled: true, ...form.customScreen };
        setScreen(cs);
        setPreview(cs);
      }
    });
    return () => { cancelled = true; };
  }, [formId]);

  const hasScreen = !!(screen.html || screen.js);

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    const existing = hasScreen ? JSON.stringify({ html: screen.html, css: screen.css, js: screen.js }) : undefined;
    const res = await api.generateScreen(prompt.trim(), fields, existing);
    setGenerating(false);
    const g = res.data?.data;
    if (res.error || !g) { toast.error(typeof res.error === 'string' ? res.error : 'Could not generate the screen.'); return; }
    const next = { enabled: true, html: g.html, css: g.css, js: g.js };
    setScreen(next);
    setPreview(next);
    setDirty(true);
    toast.success('Screen generated — preview on the right.');
  };

  const editCode = (part: CodeTab, value: string) => {
    const next = { ...screen, [part]: value };
    setScreen(next);
    setDirty(true);
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => setPreview(next), 400);
  };

  const save = async () => {
    if (!formId || saving) return;
    setSaving(true);
    const res = await api.updateForm(formId, { customScreen: { ...screen, enabled: true } });
    setSaving(false);
    if (res.error) { toast.error('Could not save the screen.'); return; }
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
        <div className="min-h-0 flex flex-col border-r border-gray-200 dark:border-slate-800 overflow-y-auto">
          <div className="p-4 space-y-3 border-b border-gray-200 dark:border-slate-800">
            <label className="text-xs font-medium text-gray-500 dark:text-slate-400">Describe the screen</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. A Wordle clone that saves each finished game and shows a leaderboard"
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
              <p className="text-xs text-gray-400 dark:text-slate-500">Uses the FormLogic SDK (submit/records) over <span className="font-medium">{title || 'this form'}</span>.</p>
              <Button size="sm" onClick={generate} disabled={!prompt.trim() || generating} leftIcon={generating ? <Loader2 className="h-4 w-4 animate-spin" /> : (hasScreen ? <Wand2 className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />)}>
                {generating ? 'Generating…' : hasScreen ? 'Regenerate' : 'Generate'}
              </Button>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={!!screen.publicRecords}
                onChange={(e) => { setScreen({ ...screen, publicRecords: e.target.checked }); setDirty(true); }}
                className="mt-0.5 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500/30"
              />
              <span>Let visitors read submissions on the public link (answers only — needed for a public leaderboard).</span>
            </label>
          </div>

          {/* Code tabs */}
          <div className="flex items-center gap-1 px-3 pt-3">
            {(['html', 'css', 'js'] as CodeTab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer transition-colors ${tab === t ? 'bg-gray-200 dark:bg-slate-700 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'}`}>{t.toUpperCase()}</button>
            ))}
          </div>
          <textarea
            value={screen[tab] || ''}
            onChange={(e) => editCode(tab, e.target.value)}
            spellCheck={false}
            placeholder={hasScreen ? '' : 'Generate a screen above, or write code here. The FormLogic SDK is injected automatically.'}
            className="flex-1 m-3 mt-2 p-3 text-xs font-mono leading-relaxed bg-gray-900 text-gray-100 border border-gray-200 dark:border-slate-700 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500/30 min-h-[200px]"
          />
        </div>

        {/* Preview */}
        <div className="min-h-0 flex flex-col bg-white dark:bg-slate-900">
          <div className="px-4 h-9 shrink-0 flex items-center text-xs font-medium text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-800">Live preview</div>
          <div className="flex-1 min-h-0">
            {(preview.html || preview.js) ? (
              <CustomScreenRuntime key="preview" screen={preview} formId={formId!} formTitle={title} fields={fields} className="w-full h-full border-0" />
            ) : (
              <div className="h-full flex items-center justify-center text-center px-6">
                <p className="text-sm text-gray-400 dark:text-slate-500">Describe what you want and hit <span className="font-medium text-gray-600 dark:text-slate-300">Generate</span> — the live preview appears here.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
