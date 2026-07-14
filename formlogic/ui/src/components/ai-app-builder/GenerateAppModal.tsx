import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Wand2, ArrowRight, ArrowLeft, RefreshCw, Check, GitBranch, Users, Loader2, AlertCircle, Boxes, FileText, MonitorPlay, Image as ImageIcon } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { validatePlan, buildAppFromPlan, type AppPlan, type BuildProgress, type BuildResult } from '../../lib/ai-app-builder';

type Stage = 'prompt' | 'planning' | 'review' | 'building' | 'done' | 'error';

const EXAMPLES = [
  'A HR app that manages job applications, interviews, and offers',
  'An incident reporting app for a manufacturing site',
  'A client onboarding app with intake, documents, and approvals',
];

export function GenerateAppModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('prompt');
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState<AppPlan | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [error, setError] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setStage('prompt'); setPrompt(''); setPlan(null); setProgress(null); setResult(null); setError(''); setImage(null); setImageName(''); };
  const close = () => { if (stage === 'building') return; reset(); onClose(); };

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => { setImage(reader.result as string); setImageName(file.name); };
    reader.readAsDataURL(file);
  };

  const generatePlan = async () => {
    if (!prompt.trim()) return;
    setStage('planning'); setError('');
    const res = await api.generateAppPlan(prompt.trim(), 6, image || undefined);
    const p = res.data?.data;
    if (res.error || !p) { setError(typeof res.error === 'string' ? res.error : 'Could not generate a plan. Try rephrasing.'); setStage('error'); return; }
    const errs = validatePlan(p);
    if (errs.length) { setError(errs[0]); setStage('error'); return; }
    setPlan(p); setStage('review');
  };

  const build = async () => {
    if (!plan) return;
    setStage('building'); setError('');
    try {
      const r = await buildAppFromPlan(plan, setProgress);
      setResult(r); setStage('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The build failed.'); setStage('error');
    }
  };

  const title = (
    <span className="flex items-center gap-2">
      <Wand2 className="h-5 w-5 text-primary-600 dark:text-primary-400" /> Generate app with AI
      <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
    </span>
  );

  return (
    <Modal isOpen={isOpen} onClose={close} title={title} size="lg" showCloseButton={stage !== 'building'}>
      <div className="p-5 sm:p-6">
      {/* PROMPT */}
      {stage === 'prompt' && (
        <div className="space-y-5">
          <p className="text-sm text-gray-600 dark:text-slate-300">Describe the app you want. The AI plans the forms, links them together, writes any backend logic, and builds the whole app.</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
            placeholder="e.g. A HR app that manages job applications, interviews, and offers"
            className="w-full h-28 px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setPrompt(ex)} className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-primary-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors cursor-pointer">{ex}</button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
            {image ? (
              <div className="flex items-center gap-2 min-w-0">
                <img src={image} alt="" className="h-8 w-8 rounded object-cover border border-gray-200 dark:border-slate-700 shrink-0" />
                <span className="text-xs text-gray-500 dark:text-slate-400 truncate max-w-[120px]">{imageName}</span>
                <button type="button" onClick={() => { setImage(null); setImageName(''); }} className="text-xs text-gray-400 hover:text-red-500 cursor-pointer">Remove</button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} leftIcon={<ImageIcon className="h-4 w-4" />}>Attach image</Button>
            )}
            <Button onClick={generatePlan} disabled={!prompt.trim()} leftIcon={<Sparkles className="h-4 w-4" />}>Generate plan</Button>
          </div>
        </div>
      )}

      {/* PLANNING */}
      {stage === 'planning' && (
        <div className="py-12 flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
          <p className="text-sm text-gray-600 dark:text-slate-300">Designing your app…</p>
        </div>
      )}

      {/* REVIEW */}
      {stage === 'review' && plan && (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="h-10 w-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center shrink-0">
              <Boxes className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            </span>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 dark:text-white leading-tight">{plan.app.name}</h3>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">{plan.app.description}</p>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">Forms ({plan.forms.length})</p>
            <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 divide-y divide-gray-100 dark:divide-slate-800 max-h-[38vh] overflow-y-auto">
              {plan.forms.map((f) => (
                <div key={f.key} className="p-3.5 flex items-start gap-2.5">
                  <FileText className="h-4 w-4 text-gray-400 dark:text-slate-500 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
                      {f.title}
                      {f.screen && f.screen.trim() && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300"><MonitorPlay className="h-3 w-3" /> Screen</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 leading-relaxed">{f.purpose}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {plan.relations.length > 0 && (
            <div className="text-xs text-gray-600 dark:text-slate-300">
              <p className="flex items-center gap-1.5 font-medium text-gray-500 dark:text-slate-400 mb-1"><GitBranch className="h-3.5 w-3.5" /> Links</p>
              {plan.relations.map((r, i) => (
                <p key={i} className="ml-5">{titleOf(plan, r.from)} → {titleOf(plan, r.to)} <span className="text-gray-400 dark:text-slate-500">(“{r.label}”)</span></p>
              ))}
            </div>
          )}
          {plan.roles.length > 0 && (
            <p className="text-xs text-gray-600 dark:text-slate-300 flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-gray-400 dark:text-slate-500" /> {plan.roles.map((r) => `${r.name} (${r.level})`).join(' · ')}</p>
          )}
          <p className="text-xs text-gray-400 dark:text-slate-500">Building generates each form with AI — this can take a minute or two.</p>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setStage('prompt')} leftIcon={<ArrowLeft className="h-4 w-4" />}>Edit prompt</Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={generatePlan} leftIcon={<RefreshCw className="h-4 w-4" />}>Regenerate</Button>
              <Button size="sm" onClick={build} leftIcon={<Wand2 className="h-4 w-4" />}>Build app</Button>
            </div>
          </div>
        </div>
      )}

      {/* BUILDING */}
      {stage === 'building' && (
        <div className="py-10 flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
          <p className="text-sm font-medium text-gray-900 dark:text-white">{progress?.message || 'Building your app…'}</p>
          {progress?.total ? <p className="text-xs text-gray-400 dark:text-slate-500 tabular-nums">form {progress.current} of {progress.total}</p> : null}
          <p className="text-xs text-gray-400 dark:text-slate-500">Please keep this open — it takes a minute or two.</p>
        </div>
      )}

      {/* DONE */}
      {stage === 'done' && result && (
        <div className="space-y-5">
          <div className="flex items-center gap-2.5">
            <span className="h-9 w-9 rounded-full bg-emerald-100 dark:bg-emerald-500/15 flex items-center justify-center"><Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" /></span>
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">Created “{result.appName}”</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">{result.forms.length} forms, linked and published.</p>
            </div>
          </div>
          <ul className="space-y-1 text-sm text-gray-600 dark:text-slate-300">
            {result.forms.map((f) => <li key={f.id} className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-500" /> {f.title}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close}>Close</Button>
            <Button size="sm" onClick={() => { const id = result.appId; close(); if (id) navigate(`/apps/${id}/settings`); }} leftIcon={<ArrowRight className="h-4 w-4" />}>Open app</Button>
          </div>
        </div>
      )}

      {/* ERROR */}
      {stage === 'error' && (
        <div className="space-y-5">
          <div className="flex items-start gap-2.5 text-sm">
            <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <p className="text-gray-700 dark:text-slate-200">{error}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={close}>Close</Button>
            <Button size="sm" onClick={() => setStage('prompt')}>Try again</Button>
          </div>
        </div>
      )}
      </div>
    </Modal>
  );
}

function titleOf(plan: AppPlan, key: string): string {
  return plan.forms.find((f) => f.key === key)?.title || key;
}
