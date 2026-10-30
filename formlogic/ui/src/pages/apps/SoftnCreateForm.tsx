// "Create app" for a hosted SoftN app: name it, then choose how it starts — AI Studio builds it
// from a description, the Visual Builder opens on a working starter, or a .softn file becomes
// its first version. Every path lands in the app's workspace with the app running.
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileUp, PencilRuler, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { AiConnectNotice } from '../../components/ai/AiConnectNotice';
import { createSoftnApp, projectFromUpload, projectHasBackend, softnWorkspacePath, uploadName, type SoftnStart } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';

type Method = 'ai' | 'builder' | 'upload';

/** What a chosen .softn file holds, read as soon as it is chosen: its app's name, and whether it brings a backend. */
interface FileReview { name: string; backend: boolean }

const isFileDrag = (event: React.DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');

export function SoftnCreateForm({ aiReady, aiReason = null, onAiRecheck, disabled = false }: {
  aiReady: boolean | null;
  aiReason?: string | null;
  /** Check the default AI again (fresh), after the person connects one. */
  onAiRecheck: () => Promise<unknown> | void;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const setSoftnOpen = useUIStore(s => s.setSoftnOpen);
  const [name, setName] = useState('');
  const [method, setMethod] = useState<Method>(aiReady === false ? 'builder' : 'ai');
  // Until the person chooses, the start follows what their AI can do: once the check says it
  // cannot answer, the form moves off building with AI to a start that works.
  const [chosen, setChosen] = useState(false);
  const [seenReady, setSeenReady] = useState(aiReady);
  if (aiReady !== seenReady) {
    setSeenReady(aiReady);
    if (!chosen && aiReady === false && method === 'ai') setMethod('builder');
  }
  const [request, setRequest] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<FileReview | null>(null);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The file most recently chosen: a slower read of an earlier one never replaces its review.
  const latest = useRef<File | null>(null);
  // Building with AI waits for the readiness check: an unknown answer is not a yes.
  const aiBlocked = method === 'ai' && aiReady !== true;
  // An uploaded app is named after itself unless the person names it.
  const named = !!name.trim() || (method === 'upload' && !!review);
  const canCreate = named && !creating && !disabled && !aiBlocked
    && (method !== 'ai' || !!request.trim()) && (method !== 'upload' || (!!file && !!review && !fileError));

  /** Take a chosen or dropped file: the start becomes the upload, and the file is read at once, so a problem shows before anything is created. */
  const takeFile = async (picked: File | null) => {
    latest.current = picked;
    setFile(picked); setReview(null); setFileError(''); setError('');
    if (!picked) return;
    setChosen(true); setMethod('upload');
    try {
      const project = await projectFromUpload(picked);
      if (latest.current === picked) setReview({ name: uploadName(project, picked), backend: projectHasBackend(project) });
    } catch (reason) {
      if (latest.current === picked) setFileError(reason instanceof Error ? reason.message : 'That file could not be read as a SoftN app.');
    }
  };

  const create = async () => {
    if (!canCreate || lock.current) return;
    lock.current = true; setCreating(true); setError('');
    try {
      const start: SoftnStart = method === 'upload' && file ? { kind: 'upload', file } : { kind: 'starter' };
      const created = await createSoftnApp({ name, description: method === 'ai' ? request.slice(0, 500) : undefined, start });
      if (created.error) toast.info('Your app was created', created.error);
      if (created.project && method !== 'upload') {
        setSoftnOpen({ appId: created.app.id, editor: method === 'ai' ? 'studio' : 'builder', ...(method === 'ai' ? { brief: { prompt: request.trim(), kind: 'build' as const } } : {}) });
      } else if (!created.project && method === 'ai') {
        // Kept for the workspace's setup, which asks again once the app can be installed.
        setSoftnOpen({ appId: created.app.id, editor: 'studio', brief: { prompt: request.trim(), kind: 'build' } });
      }
      navigate(softnWorkspacePath(created.app.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the app. Please try again.');
    } finally { lock.current = false; setCreating(false); }
  };

  const option = (value: Method, icon: React.ReactNode, title: string, hint: string, extra?: string) =>
    <label className={cn('flex cursor-pointer gap-3 rounded-xl border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary-500', method === value ? 'border-primary-400 bg-primary-50/70 ring-2 ring-primary-500/10 dark:border-primary-500/60 dark:bg-primary-500/[0.08]' : 'border-gray-200 hover:border-gray-300 dark:border-white/10 dark:hover:border-white/20')}>
      <input type="radio" name="softn-start" value={value} checked={method === value} disabled={creating} onChange={() => { setChosen(true); setMethod(value); }} className="sr-only" />
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-primary-600 shadow-sm ring-1 ring-gray-200 dark:bg-slate-800 dark:text-primary-300 dark:ring-white/10">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-slate-400">{hint}</span>
        {extra && <span className="mt-1 block text-xs font-medium text-amber-700 dark:text-amber-300">{extra}</span>}
      </span>
    </label>;

  // A .softn file dropped anywhere on the form is the start: no need to find the option first.
  return <div className="space-y-5"
    onDragOver={event => { if (!isFileDrag(event) || creating || disabled) return; event.preventDefault(); setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!isFileDrag(event) || creating || disabled) return;
      event.preventDefault(); setDragging(false);
      void takeFile(event.dataTransfer.files?.[0] ?? null);
    }}>
    <div>
      <label htmlFor="softn-app-name" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
        App name{method === 'upload' && <span className="font-normal text-gray-400 dark:text-slate-500"> (optional: an uploaded app keeps its own)</span>}
      </label>
      <Input id="softn-app-name" value={name} onChange={event => setName(event.target.value)} placeholder={method === 'upload' && review ? review.name : 'e.g. Recipe Box, Team Directory, Booking Site'} maxLength={120} disabled={creating || disabled} autoFocus />
    </div>
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold text-gray-600 dark:text-slate-300">How do you want to start?</legend>
      <div className="grid gap-3">
        {option('ai', <Sparkles className="h-4 w-4" />, 'Describe it, and AI builds it', 'AI Studio builds your app from your description while you watch: its pages, its database and how it looks.', aiReady === false ? 'Needs an AI connection first.' : undefined)}
        {option('builder', <PencilRuler className="h-4 w-4" />, 'Start from a working app and edit it visually', 'A small app with a page, a backend and a database table, opened in the Visual Builder. No AI needed.')}
        {option('upload', <FileUp className="h-4 w-4" />, 'Upload a .softn file', 'An app you already have, with or without a backend of its own. It becomes the first version, and you can edit it here.')}
      </div>
    </fieldset>
    {method === 'ai' && <div>
      <label htmlFor="softn-app-request" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">What should it do?</label>
      <Textarea id="softn-app-request" value={request} onChange={event => { setChosen(true); setRequest(event.target.value); }} rows={5} maxLength={8000} disabled={creating || disabled || aiBlocked} className="min-h-32 resize-y"
        placeholder="e.g. A recipe box: add recipes with ingredients and steps, mark favourites, search by ingredient, and a shopping list. Warm, friendly style." />
      {aiReady === false && <AiConnectNotice lead="Building with AI needs an AI connection" reason={aiReason} onConnected={onAiRecheck} />}
    </div>}
    {method === 'upload' && <div data-testid="softn-drop-zone" className={cn('rounded-xl border-2 border-dashed p-5 text-center transition-colors', dragging ? 'border-primary-400 bg-primary-50/70 dark:border-primary-500/60 dark:bg-primary-500/10' : 'border-gray-300 dark:border-white/15')}>
      <input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Choose a .softn file" onChange={event => { void takeFile(event.target.files?.[0] ?? null); event.target.value = ''; }} />
      <p className="text-sm text-gray-600 dark:text-slate-300">{dragging ? 'Drop it to use it' : 'Drop a .softn file here, or'}</p>
      <Button className="mt-2" variant="secondary" size="sm" disabled={creating || disabled} onClick={() => input.current?.click()} leftIcon={<FileUp className="h-4 w-4" />}>{file ? 'Choose another file' : 'Choose a file'}</Button>
      {file && <p className="mt-3 break-words text-sm text-gray-700 dark:text-slate-300">
        <span className="font-medium">{file.name}</span>
        {review && <span className="text-gray-500 dark:text-slate-400"> · {review.name} · {review.backend ? 'with its own backend and database' : 'runs in the browser, no backend'}</span>}
      </p>}
      {fileError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-left text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{fileError}</p>}
    </div>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="flex items-center justify-end">
      <Button onClick={() => void create()} isLoading={creating} disabled={!canCreate} rightIcon={<ArrowRight className="h-4 w-4" />}>
        {method === 'ai' ? 'Create and build with AI' : method === 'builder' ? 'Create and start editing' : 'Create from this file'}
      </Button>
    </div>
  </div>;
}
