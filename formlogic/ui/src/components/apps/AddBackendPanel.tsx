// Adding an API backend to a hosted SoftN app that has none (lib/softnBackend): the starter's (a
// table and two routes, ready to change), or the backend of another file of the same app, for an
// app built in two halves. The result is installed as the app's next version by the caller.
import { useRef, useState } from 'react';
import { FileUp, Server } from 'lucide-react';
import { Button } from '../ui/Button';
import { importNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { backendOf, STARTER_BACKEND, withBackend } from '../../lib/softnBackend';

export function AddBackendPanel({ project, disabled = false, waiting, onAdd }: {
  project: NativeProject;
  disabled?: boolean;
  /** Why it cannot be done just now (unpublished changes open, say), shown instead of the buttons. */
  waiting?: string | null;
  /** Install `next`; `from` says which way it came, for the caller's notice. */
  onAdd: (next: NativeProject, from: 'starter' | 'file') => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const add = async (make: () => Promise<NativeProject>, from: 'starter' | 'file') => {
    setWorking(true); setError('');
    try { await onAdd(await make(), from); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The backend could not be added.'); }
    finally { setWorking(false); }
  };

  const fromFile = (file: File) => add(async () => {
    const backend = backendOf(await importNativeProject(file));
    if (!backend) throw new Error(`${file.name} has no backend either: its manifest.json has no server block. Choose the app's full file, the one with its server/ folder.`);
    return withBackend(project, backend);
  }, 'file');

  return <div className="space-y-3 text-sm">
    <p className="text-slate-600 dark:text-slate-400">A backend is the app&apos;s own API on this server: routes its page calls with <code>softn.net.fetch</code>, and a database whose records you see in this tab.</p>
    <input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Choose the file with the app's backend" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void fromFile(file); }} />
    {waiting ? <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{waiting}</p> : <div className="flex flex-wrap gap-2">
      <Button size="sm" leftIcon={<Server className="h-4 w-4" />} disabled={disabled || working} isLoading={working} onClick={() => void add(async () => withBackend(project, STARTER_BACKEND), 'starter')}>Add a backend</Button>
      <Button size="sm" variant="secondary" leftIcon={<FileUp className="h-4 w-4" />} disabled={disabled || working} onClick={() => input.current?.click()}>Add its backend from a file</Button>
    </div>}
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400"><strong>Add a backend</strong> gives a working start: an <code>items</code> table and <code>GET</code>/<code>POST /api/items</code>, called at <code>https://app.example/api/items</code>. Change it in the source editor (<code>server/main.logic</code>, and the routes in <code>manifest.json</code>), or ask AI Studio. <strong>From a file</strong> is for an app whose backend was built separately: choose the app&apos;s full <code>.softn</code> (with its <code>server/</code> folder); its backend is added, and this app&apos;s page stays as it is.</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
  </div>;
}
