import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Database, FileCheck2, FileUp, KeyRound } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { declaredAppId, readKeyFile } from '../../lib/appKeyFile';
import { formlogicAsks, importNativeProject, phoneCodeProvider } from '../../lib/nativeHosting';
import { holdsSignInSettings } from '../../lib/signInCodes';
import { backendOf, withBackend } from '../../lib/softnBackend';
import { api } from '../../lib/api';
import { createSoftnApp, projectFromUpload, projectHasBackend, softnWorkspacePath, uploadName } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';

type FileSlot = 'app' | 'backend' | 'database' | 'key';

/** What a chosen .softn file holds, read as soon as it is chosen: its app's name, and whether it brings a backend. */
/** `asks`: what the app asks of FormLogic itself (its AI, its payments), said before it is created. */
/** `codes`: its manifest names a provider for the sign-in codes it sends by text. */
interface FileReview { name: string; backend: boolean; backendId?: string; asks: string[]; codes: boolean }

const isFileDrag = (event: React.DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
const dropSlot = (target: EventTarget): FileSlot => {
  const slot = target instanceof Element ? target.closest('[data-file-slot]')?.getAttribute('data-file-slot') : null;
  return slot === 'backend' || slot === 'database' || slot === 'key' ? slot : 'app';
};
const fileKinds: Record<FileSlot, { accepts: RegExp; hint: string }> = {
  app: { accepts: /\.(softn|zip)$/i, hint: 'Drop a project or build ZIP to replace the app.' },
  backend: { accepts: /\.(softn|zip)$/i, hint: 'Drop a project ZIP that contains the backend.' },
  database: { accepts: /\.(sqlite3?|db)$/i, hint: 'Drop a SQLite database (.sqlite, .sqlite3 or .db) here.' },
  key: { accepts: /\.json$/i, hint: 'Drop the app’s JSON key file here.' },
};

export function SoftnCreateForm({ disabled = false }: { disabled?: boolean }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<FileReview | null>(null);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState<FileSlot | null>(null);
  const [refusedDrop, setRefusedDrop] = useState<FileSlot | null>(null);
  // Its data from where it ran before, optional: the database, and the key file it was kept under.
  const [data, setData] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  // The key file's configuration, and whether to give the plugin that sends the app's sign-in codes
  // what it takes from such a file: known only once the app is made (lib/signInCodes).
  const [keyConfig, setKeyConfig] = useState<Record<string, unknown> | null>(null);
  const latestKey = useRef<File | null>(null);
  const [useCodes, setUseCodes] = useState(true);
  // The chosen file's backend names a provider for its sign-in codes (with the page's own, below).
  const [attachedBackend, setAttachedBackend] = useState<{ id?: string; codes: boolean } | null>(null);
  const [dataError, setDataError] = useState('');
  // A file with no backend of its own, and the app's full file to take one from (optional).
  const [backendFile, setBackendFile] = useState<File | null>(null);
  const [backendError, setBackendError] = useState('');
  const [readingBackend, setReadingBackend] = useState(false);
  const backendInput = useRef<HTMLInputElement>(null);
  const chooseKey = async (picked: File | null) => {
    setRefusedDrop(null);
    latestKey.current = picked;
    setKeyFile(picked); setKeyConfig(null); setDataError(''); setUseCodes(true);
    if (!picked) return;
    const info = await readKeyFile(picked, attachedBackend?.id ?? review?.backendId);
    if (latestKey.current !== picked) return;
    if ('error' in info) setDataError(info.error);
    else setKeyConfig(info.config);
  };
  const chooseDatabase = (picked: File | null) => {
    setData(picked);
    void chooseKey(null);
  };
  // The backend file most recently chosen, as `latest` is for the app's file.
  const latestBackend = useRef<File | null>(null);
  /** Read the backend file and put it with the page at once, so what would refuse it shows now, not at Create. */
  const takeBackend = async (picked: File | null, page: File | null) => {
    latestBackend.current = picked;
    setBackendFile(null); setBackendError(''); setAttachedBackend(null); setReadingBackend(!!picked && !!page);
    chooseDatabase(null);
    if (!picked || !page) return;
    try {
      const backend = backendOf(await importNativeProject(picked));
      if (!backend) throw new Error(`${picked.name} has no backend either: its manifest.json has no server block. Choose the app's full file, the one with its server/ folder.`);
      const together = withBackend(await projectFromUpload(page), backend);
      if (latestBackend.current === picked && latest.current === page) {
        setBackendFile(picked);
        setAttachedBackend({ id: declaredAppId(together.files['manifest.json']), codes: !!phoneCodeProvider(together) });
      }
    } catch (reason) {
      if (latestBackend.current === picked) setBackendError(reason instanceof Error ? reason.message : 'That file could not be read as an app project.');
    } finally { if (latestBackend.current === picked) setReadingBackend(false); }
  };
  const withItsBackend = !!review?.backend || !!backendFile;
  // The app, as it will be, sends sign-in codes by text: its own backend's manifest says so, or the one added to it.
  const sendsCodes = attachedBackend?.codes ?? !!review?.codes;
  const dataInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The file most recently chosen: a slower read of an earlier one never replaces its review.
  const latest = useRef<File | null>(null);
  const canCreate = !creating && !disabled && !!file && !!review && !fileError && !backendError && !readingBackend && (!keyFile || !!keyConfig);

  /** Take a chosen or dropped file: the start becomes the upload, and the file is read at once, so a problem shows before anything is created. */
  const takeFile = async (picked: File | null) => {
    latest.current = picked;
    setFile(picked); setReview(null); setFileError(''); setError('');
    chooseDatabase(null);
    // A backend chosen for the last file is not this one's.
    latestBackend.current = null; setBackendFile(null); setBackendError(''); setReadingBackend(false); setAttachedBackend(null);
    if (!picked) return;
    try {
      const project = await projectFromUpload(picked);
      if (latest.current === picked) setReview({ name: uploadName(project, picked), backend: projectHasBackend(project), backendId: declaredAppId(project.files['manifest.json']), asks: formlogicAsks(project), codes: !!phoneCodeProvider(project) });
    } catch (reason) {
      if (latest.current === picked) setFileError(reason instanceof Error ? reason.message : 'That file could not be read as an app project.');
    }
  };

  const dropFile = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDragging(null);
    const picked = event.dataTransfer.files[0];
    if (creating || disabled || !picked) return;
    const slot = dropSlot(event.target);
    // Once an app is selected, a misplaced attachment must leave the existing choices intact.
    if (review && !fileKinds[slot].accepts.test(picked.name)) { setRefusedDrop(slot); return; }
    switch (slot) {
      case 'backend': void takeBackend(picked, file); break;
      case 'database': chooseDatabase(picked); break;
      case 'key': void chooseKey(picked); break;
      case 'app': void takeFile(picked); break;
    }
  };

  const create = async () => {
    if (!file || !canCreate || lock.current) return;
    lock.current = true; setCreating(true); setError('');
    try {
      const created = await createSoftnApp({ name, start: { kind: 'upload', file, ...(backendFile && !review?.backend ? { backendFile } : {}) } });
      if (created.error) toast.info('Your app was created', created.error);
      // Its data, once its first version is in: installed as the next version, or not at all.
      if (created.project && withItsBackend && data) {
        // What the key file holds for the app's sign-in codes is given to the plugin on this site
        // that sends them, where there is one and it takes those settings from such a file.
        let codes = false;
        if (keyConfig && useCodes && sendsCodes) {
          const signIn = await api.getAppSignInCodes(created.app.id);
          codes = !!signIn.data?.plugin && holdsSignInSettings(keyConfig, signIn.data.imports);
          if (signIn.data && !signIn.data.plugin) toast.info('Sign-in codes are not set up', 'No plugin on this site sends this app’s sign-in codes yet: an administrator adds one in Admin → Platform → Plugins.');
        }
        const brought = await api.importNativeData(created.app.id, data, keyFile, codes);
        if (brought.error) toast.error('Your app was created, without its data', `${brought.error} You can bring it from Import, in the app's Data section.`);
        else toast.success('Its data came with it', brought.data?.keyImported ? 'With the key it was kept under.' : 'The app has a key of its own here.');
        if (brought.data?.verificationProblem) toast.warning('Sign-in codes are not set up', brought.data.verificationProblem);
      }
      // A new app opens on its Edit section: the app running, with the ways to change it.
      navigate(softnWorkspacePath(created.app.id, 'edit'), created.warnings?.length ? { state: { siteWarnings: created.warnings } } : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the app. Please try again.');
    } finally { lock.current = false; setCreating(false); }
  };

  const nameField = <div>
    <label htmlFor="softn-app-name" className="mb-1.5 block text-xs font-semibold text-gray-600 dark:text-slate-300">
      App name<span className="font-normal text-gray-400 dark:text-slate-500"> (optional)</span>
    </label>
    <Input id="softn-app-name" value={name} onChange={event => setName(event.target.value)} placeholder={review?.name || 'Use the app’s name'} maxLength={120} disabled={creating || disabled} />
  </div>;

  const dropHighlight = 'border-primary-400 bg-primary-50/70 dark:border-primary-500/60 dark:bg-primary-500/10';
  const dropHint = (slot: FileSlot) => refusedDrop === slot && <p role="alert" className="mt-2 text-left text-xs text-amber-800 dark:text-amber-300">{fileKinds[slot].hint}</p>;
  const dropZone = <div data-testid="softn-drop-zone" className={cn('min-w-0 rounded-xl border transition-colors', file ? 'p-4' : 'border-dashed px-4 py-6 text-center', dragging === 'app' ? dropHighlight : 'border-gray-300 dark:border-white/15')}>
    <input ref={input} type="file" accept=".zip,.softn" className="hidden" aria-label="Choose an app ZIP" onChange={event => { void takeFile(event.target.files?.[0] ?? null); event.target.value = ''; }} />
    <div className={cn(file && 'flex flex-col items-start gap-3 sm:flex-row sm:items-center')}>
      {!file ? <div>
        <FileUp className="mx-auto mb-2 h-7 w-7 text-primary-500 dark:text-primary-400" aria-hidden="true" />
        <p className="text-sm text-gray-600 dark:text-slate-300">{dragging === 'app' ? 'Drop it to use it' : 'Drop an app ZIP here, or'}</p>
      </div> : <div className="flex min-w-0 max-w-full flex-1 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">{review ? <FileCheck2 className="h-5 w-5" aria-hidden="true" /> : <FileUp className="h-5 w-5" aria-hidden="true" />}</span>
        <div role="status" className="min-w-0 break-words text-sm">
          <span className="font-semibold text-gray-900 dark:text-white">{review?.name ?? file.name}</span>
          {review && <>
            <span className="text-xs text-gray-600 dark:text-slate-300"> · {review.backend ? 'with its own backend and database' : backendFile ? 'with the attached backend and database' : 'runs in the browser, no backend'}</span>
            <span className="mt-0.5 block break-all text-xs leading-5 text-gray-500 dark:text-slate-400">{file.name}</span>
          </>}
          {!review && !fileError && <span className="block text-xs text-gray-500 dark:text-slate-400">Reading app…</span>}
        </div>
      </div>}
      <Button className={file ? undefined : 'mt-2'} variant="secondary" size="sm" disabled={creating || disabled} onClick={() => input.current?.click()}>{file ? 'Choose another file' : 'Choose a file'}</Button>
    </div>
    {review && review.asks.length > 0 && <ul className="mt-3 list-disc space-y-1 border-t border-gray-200 pt-3 pl-5 text-left text-xs text-gray-600 dark:border-white/10 dark:text-slate-300" data-testid="softn-asks">{review.asks.map(ask => <li key={ask}>{ask}</li>)}</ul>}
    {fileError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-left text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{fileError}</p>}
    {dropHint('app')}
  </div>;

  return <div className="space-y-5"
    onDragOver={event => { if (!isFileDrag(event)) return; event.preventDefault(); if (!creating && !disabled) setDragging(dropSlot(event.target)); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(null); }}
    onDrop={dropFile}>
    {dropZone}
    {review && !review.backend && <div data-file-slot="backend" className={cn('rounded-xl border p-4 transition-colors', dragging === 'backend' ? dropHighlight : 'border-gray-200 dark:border-white/10')}>
      <p className="text-sm font-semibold text-gray-900 dark:text-white">Add its backend <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span></p>
      <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">Choose or drop the same app’s complete project ZIP here to import its API and database schema from the <code>server/</code> folder. You can also create a custom API in the Data tab after import.</p>
      <input ref={backendInput} type="file" accept=".zip,.softn" className="hidden" aria-label="Choose the file with its backend" onChange={event => { const picked = event.target.files?.[0] ?? null; event.target.value = ''; void takeBackend(picked, file); }} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={creating || disabled} isLoading={readingBackend} onClick={() => backendInput.current?.click()} leftIcon={<FileUp className="h-4 w-4" />}>{backendFile ? 'Another file' : 'Choose the file with its backend'}</Button>
        {backendFile && <span className="break-all text-xs text-gray-600 dark:text-slate-300">{backendFile.name} · its backend will be added</span>}
        {(backendFile || backendError) && <Button size="sm" variant="ghost" disabled={creating || disabled} onClick={() => void takeBackend(null, file)}>Skip separate backend</Button>}
      </div>
      {backendError && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{backendError}</p>}
      {dropHint('backend')}
    </div>}
    {withItsBackend && <div data-file-slot="database" className={cn('rounded-xl border p-4 transition-colors', dragging === 'database' ? dropHighlight : 'border-gray-200 dark:border-white/10')}>

      <p className="text-sm font-semibold text-gray-900 dark:text-white">Bring its data too <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span></p>
      <p className="mt-1 break-words text-xs leading-5 text-gray-500 dark:text-slate-400">To bring existing records, stop the old site and choose or drop <code>private/data/application.sqlite</code> here.</p>
      <input ref={dataInput} type="file" accept=".sqlite,.db,.sqlite3" className="hidden" aria-label="Choose its database" onChange={event => { chooseDatabase(event.target.files?.[0] ?? null); event.target.value = ''; }} />
      <input ref={keyInput} type="file" accept=".json,application/json" className="hidden" aria-label="Choose its key file" onChange={event => {
        const picked = event.target.files?.[0] ?? null;
        event.target.value = '';
        void chooseKey(picked);
      }} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={creating || disabled} onClick={() => dataInput.current?.click()} leftIcon={<Database className="h-4 w-4" />}>{data ? 'Another database' : 'Choose its database'}</Button>
        {data && <span className="break-all text-xs text-gray-600 dark:text-slate-300">{data.name}</span>}
        {data && <Button size="sm" variant="ghost" disabled={creating || disabled} onClick={() => chooseDatabase(null)}>Remove database</Button>}
      </div>
      {dropHint('database')}
      {data && <div data-file-slot="key" className={cn('mt-3 rounded-lg border border-dashed p-3 transition-colors', dragging === 'key' ? dropHighlight : 'border-gray-300 dark:border-white/15')}>
        <p className="mb-2 break-words text-xs leading-5 text-gray-600 dark:text-slate-300">To keep reading data protected by the old key, choose or drop <code>private/config.json</code> here.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={creating || disabled} onClick={() => keyInput.current?.click()} leftIcon={<KeyRound className="h-4 w-4" />}>{keyFile ? 'Another key file' : 'Add its key file'}</Button>
          {keyFile && <span className="break-all text-xs text-gray-600 dark:text-slate-300">{keyFile.name}</span>}
          {keyFile && <Button size="sm" variant="ghost" disabled={creating || disabled} onClick={() => void chooseKey(null)}>Remove key file</Button>}
        </div>
        {dropHint('key')}
      </div>}
      {keyConfig && sendsCodes && <label className="mt-2 flex items-start gap-2 text-xs leading-5 text-gray-600 dark:text-slate-300">
        <input type="checkbox" className="mt-0.5" checked={useCodes} onChange={event => setUseCodes(event.target.checked)} disabled={creating || disabled} />
        <span>Where it holds the details this app&apos;s sign-in codes were sent with, use them here: they go to the plugin that sends the codes on this site.</span>
      </label>}
      {dataError && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{dataError}</p>}
    </div>}

    {nameField}
    {error &&<p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="flex items-center justify-end">
      <Button className="w-full sm:w-auto" onClick={() => void create()} isLoading={creating} disabled={!canCreate} rightIcon={<ArrowRight className="h-4 w-4" />}>
        Create from this file
      </Button>
    </div>
  </div>;
}
