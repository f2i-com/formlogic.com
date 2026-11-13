// "Create app" for a JavaScript app: a web app someone has already built. Name it, choose the
// .zip of the folder its build made, and it lands in the app's workspace with the app running.
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileUp } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { createSiteApp } from '../../lib/siteApps';
import { softnWorkspacePath } from '../../lib/softnApps';
import { cn } from '../../lib/utils';

const isFileDrag = (event: React.DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');

export function SiteCreateForm({ disabled = false }: { disabled?: boolean }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const canCreate = !!name.trim() && !!file && !creating && !disabled;

  const takeFile = (picked: File | null) => { setFile(picked); setError(''); };

  const create = async () => {
    if (!canCreate || !file || lock.current) return;
    lock.current = true; setCreating(true); setError('');
    try {
      // The zip is read before anything is created: one this host cannot take creates no app.
      const { app, warnings } = await createSiteApp(name, file);
      // A new app opens on its Edit section: the app running. What in the build will not work
      // when hosted goes with it, for that page to show.
      navigate(softnWorkspacePath(app.id, 'edit'), warnings.length ? { state: { siteWarnings: warnings } } : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the app. Please try again.');
    } finally { lock.current = false; setCreating(false); }
  };

  // A .zip dropped anywhere on the form is the build.
  return <div className="space-y-5"
    onDragOver={event => { if (!isFileDrag(event) || creating || disabled) return; event.preventDefault(); setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => {
      if (!isFileDrag(event) || creating || disabled) return;
      event.preventDefault(); setDragging(false);
      takeFile(event.dataTransfer.files?.[0] ?? null);
    }}>
    <div>
      <label htmlFor="site-app-name" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">App name</label>
      <Input id="site-app-name" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create(); }} placeholder="e.g. Recipe Box, Team Directory, Booking Site" maxLength={120} disabled={creating || disabled} autoFocus />
    </div>
    <div>
      <label htmlFor="site-app-build" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">Your build (.zip)</label>
      <div data-testid="site-drop-zone" className={cn('rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors', dragging ? 'border-primary-400 bg-primary-50/70 dark:border-primary-500/60 dark:bg-primary-500/10' : 'border-gray-300 dark:border-white/15')}>
        <input id="site-app-build" ref={input} type="file" accept=".zip" className="hidden" disabled={creating || disabled} onChange={event => { takeFile(event.target.files?.[0] ?? null); event.target.value = ''; }} />
        {!file && <FileUp className="mx-auto mb-2 h-8 w-8 text-gray-400 dark:text-slate-500" aria-hidden="true" />}
        <p className="text-sm text-gray-600 dark:text-slate-300">{dragging ? 'Drop it to use it' : 'Drop your build\'s .zip here, or'}</p>
        <Button className="mt-2" variant="secondary" size="sm" disabled={creating || disabled} onClick={() => input.current?.click()} leftIcon={<FileUp className="h-4 w-4" />}>{file ? 'Choose another file' : 'Choose a file'}</Button>
        {file && <p className="mt-3 break-words text-sm text-gray-700 dark:text-slate-300"><span className="font-medium">{file.name}</span></p>}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-gray-500 dark:text-slate-400">Zip the folder your build made, the one with index.html in it (dist or build). An app made with React, Vue, Svelte, Angular or plain HTML and JavaScript works as it was built.</p>
    </div>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="flex items-center justify-end">
      <Button onClick={() => void create()} isLoading={creating} disabled={!canCreate} rightIcon={<ArrowRight className="h-4 w-4" />}>
        Create from this build
      </Button>
    </div>
  </div>;
}
