// Adding an API backend to a hosted SoftN app that has none: designed in the database designer
// (components/design), or the backend of another file of the same app, for an app built in two
// halves (lib/softnBackend). The result is installed as the app's next version by the caller.
import { useRef, useState } from 'react';
import { FileUp, Network } from 'lucide-react';
import { Button } from '../ui/Button';
import { importNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { backendOf, withBackend } from '../../lib/softnBackend';

export function AddBackendPanel({ project, disabled = false, waiting, onDesign, onAdd }: {
  project: NativeProject;
  disabled?: boolean;
  /** Why it cannot be done just now (unpublished changes open, say), shown instead of the buttons. */
  waiting?: string | null;
  /** Open the database designer. */
  onDesign: () => void;
  /** Install `next`, the page with the backend of the file chosen. */
  onAdd: (next: NativeProject) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const fromFile = async (file: File) => {
    setWorking(true); setError('');
    try {
      const backend = backendOf(await importNativeProject(file));
      if (!backend) throw new Error(`${file.name} has no backend either: its manifest.json has no server block. Choose the app's full file, the one with its server/ folder.`);
      await onAdd(withBackend(project, backend));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The backend could not be added.'); }
    finally { setWorking(false); }
  };

  return <div className="space-y-3 text-sm">
    <p className="text-slate-600 dark:text-slate-400">A backend is the app&apos;s own API on this server: routes its page calls with <code>softn.net.fetch</code>, and a database whose rows you see in this tab.</p>
    <input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Choose the file with the app's backend" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void fromFile(file); }} />
    {waiting ? <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{waiting}</p> : <div className="flex flex-wrap gap-2">
      <Button size="sm" className="max-sm:min-h-11" leftIcon={<Network className="h-4 w-4" />} disabled={disabled || working} onClick={onDesign}>Design its database</Button>
      <Button size="sm" variant="secondary" className="max-sm:min-h-11" leftIcon={<FileUp className="h-4 w-4" />} disabled={disabled || working} isLoading={working} onClick={() => input.current?.click()}>Add its backend from a file</Button>
    </div>}
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400"><strong>Design its database</strong> starts from an empty diagram: add a table for each thing the app keeps, its details, and how they connect, or paste a schema from MySQL, SQL Server or SQLite, or a Mermaid ER diagram. Its tables and an API for them are made from your design. <strong>From a file</strong> is for an app whose backend was built separately: choose the app&apos;s full <code>.softn</code> (with its <code>server/</code> folder); its backend is added, and this app&apos;s page stays as it is.</p>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
  </div>;
}
