import { useId, useRef, useState } from 'react';
import { ArrowRight, Code2, FileUp, LoaderCircle, Network } from 'lucide-react';
import { importNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { backendOf, withBackend } from '../../lib/softnBackend';

const choices = [
  { key: 'design', icon: Network, title: 'Design its database', description: 'Draw your tables or import a schema. FormLogic creates the database and its API routes.' },
  { key: 'write', icon: Code2, title: 'Write a custom API', description: <>Start with an editable <code className="font-mono text-xs">GET /api/status</code> handler. Add routes and tables as you need them.</> },
  { key: 'file', icon: FileUp, title: 'Add its backend from a file', description: <>Import the server code and migrations from this app’s <code className="font-mono text-xs">.zip</code> project archive.</> },
] as const;

export function AddBackendPanel({ project, disabled = false, waiting, onDesign, onWrite, onAdd }: {
  project: NativeProject;
  disabled?: boolean;
  /** Why it cannot be done just now (unpublished changes open, say), shown instead of the buttons. */
  waiting?: string | null;
  /** Open the database designer. */
  onDesign: () => void;
  onWrite: () => void;
  /** Install `next`, the page with the backend of the file chosen. */
  onAdd: (next: NativeProject) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const fromFile = async (file: File) => {
    setWorking(true); setError('');
    try {
      const backend = backendOf(await importNativeProject(file));
      if (!backend) throw new Error(`Choose a bundle that includes the backend. The manifest in ${file.name} has no server block.`);
      await onAdd(withBackend(project, backend));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The backend could not be added.'); }
    finally { setWorking(false); }
  };

  const actions = { design: onDesign, write: onWrite, file: () => input.current?.click() };
  return <div className="space-y-3">
    <input ref={input} type="file" accept=".zip,.softn" className="hidden" aria-label="Choose the file with the app's backend" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void fromFile(file); }} />
    {waiting ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{waiting}</p> :
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        {choices.map(({ key, icon: Icon, title, description }) =>
          <button type="button" key={key} aria-labelledby={`${id}-${key}`} aria-describedby={`${id}-${key}-description`}
            disabled={disabled || working} onClick={actions[key]}
            className="group grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_1rem] content-start items-start gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors enabled:hover:border-primary-500 enabled:hover:bg-primary-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:enabled:hover:bg-primary-500/5 sm:grid-cols-[minmax(0,1fr)_1rem] sm:gap-y-0 sm:p-5">
            <span aria-hidden="true" className="col-start-1 row-span-2 row-start-1 inline-flex size-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300 sm:row-span-1 sm:size-9">
              {key === 'file' && working ? <LoaderCircle className="size-5 motion-safe:animate-spin" /> : <Icon className="size-5" />}
            </span>
            <ArrowRight aria-hidden="true" className="col-start-3 row-start-1 size-4 self-center text-slate-400 group-hover:text-primary-600 dark:group-hover:text-primary-300 sm:col-start-2" />
            <span id={`${id}-${key}`} className="col-start-2 row-start-1 font-semibold tracking-tight text-slate-900 dark:text-white sm:col-span-2 sm:col-start-1 sm:row-start-2 sm:mt-3">{title}</span>
            <span id={`${id}-${key}-description`} className="col-span-2 col-start-2 row-start-2 text-sm leading-5 text-slate-600 dark:text-slate-400 sm:col-start-1 sm:row-start-3 sm:mt-1.5">{description}</span>
          </button>)}
      </div>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
  </div>;
}
