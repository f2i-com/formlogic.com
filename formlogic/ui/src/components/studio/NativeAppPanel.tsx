import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { importNativeProject, exportNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { nativeDraftStore, type NativeDraftCheckpoint } from '../../lib/nativeDraft';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { NativeSourceEditor } from './NativeSourceEditor';
import { NativeRecordsBrowser } from './NativeRecordsBrowser';
import { AppEditorDialog, type AppEditorKind } from './AppEditorDialog';

export function NativeAppPanel({ app, onInstalled }: { app: { id: string; slug: string; name: string }; onInstalled?: (home: boolean) => void }) {
  const [open, setOpen] = useState<'project'|'backend'|'records'|null>(null);
  return <section className="rounded-2xl border border-slate-200 p-5 dark:border-slate-700">
    <h3 className="font-semibold text-slate-900 dark:text-white">App backend &amp; database</h3>
    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">Bring an existing interface, private .logic backend and SQLite migrations. Manage its source and records together.</p>
    <div className="mt-4 flex flex-wrap gap-2"><Button className="min-h-11" variant="secondary" onClick={() => setOpen('backend')}>Backend code</Button><Button className="min-h-11" variant="secondary" onClick={() => setOpen('records')}>Database records</Button><Button className="min-h-11" variant="secondary" onClick={() => setOpen('project')}>Native app hosting</Button></div>
    {open && <NativeEditor app={app} initialTab={open} onInstalled={onInstalled} onClose={() => setOpen(null)} />}
  </section>;
}
export function NativeEditor({ app, onClose, onInstalled, initialTab = 'project', initialTable = '' }: { app: { id: string; slug: string; name: string }; onClose: () => void; onInstalled?: (home: boolean) => void; initialTab?: 'project'|'backend'|'records'; initialTable?: string }) {
  const [editor, setEditor] = useState<{ kind: AppEditorKind; bundle: Uint8Array } | null>(null);
  const [project, setProject] = useState<NativeProject | null>(null);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  // Runtime preflight (audit FL-03): artifacts can be prepared while the runtime still cannot start.
  const [preflight, setPreflight] = useState<import('../../lib/api').NativeRuntimePreflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'project'|'screens'|'backend'|'records'>(initialTab);
  const [sourceFile, setSourceFile] = useState('');
  const [screenFile, setScreenFile] = useState('');
  // Audit FL-S08: the unpublished draft is checkpointed in this browser for
  // this account and app, and offered back on reopen; never published alone.
  const userId = useAuthStore(state => state.user?.id);
  const drafts = useMemo(() => nativeDraftStore(userId, app.id), [userId, app.id]);
  const [recoverable, setRecoverable] = useState<NativeDraftCheckpoint | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  useEffect(() => {
    let cancelled = false; alive.current = true;
    void api.getNativeProject(app.id).then(result => {
      if (cancelled) return;
      setReady(!result.error); setAvailable(!!result.data?.available && result.data?.ready !== false); setPreflight(result.data?.preflight ?? null);
      if (result.error) setError(result.error);
      if (result.data?.project) { setProject(result.data.project); setVersion(result.data.project.version); setSourceFile(Object.keys(result.data.project.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || ''); }
      if (!result.error) setRecoverable(drafts.read());
    });
    return () => { cancelled = true; alive.current = false; };
  // The editor is mounted anew for each chosen entry tab.
  }, [app.id, initialTab, initialTable, drafts]);
  // Every change to a dirty draft refreshes its checkpoint; leaving the page
  // with one still dirty is asked about, as every other editor in the app does.
  useEffect(() => {
    if (!dirty || !project) return;
    drafts.write({ baseVersion: version, savedAt: new Date().toISOString(), project });
  }, [dirty, project, version, drafts]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const recoverDraft = () => {
    if (!recoverable) return;
    const conflict = recoverable.baseVersion !== version;
    setProject({ ...recoverable.project, version });
    setSourceFile(current => recoverable.project.files[current] !== undefined ? current : Object.keys(recoverable.project.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
    setDirty(true); setRecoverable(null); setError('');
    setNotice(conflict ? `Recovered your draft from version ${recoverable.baseVersion}. Version ${version} was published after it, so review the differences before you publish: publishing replaces version ${version}.` : 'Recovered your unpublished draft. Review it, then publish when ready.');
  };
  const discardDraft = () => { drafts.clear(); setRecoverable(null); setNotice('The unpublished draft was discarded.'); };
  async function importFile(file: File | undefined) {
    if (!file || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const imported = await importNativeProject(file);
      if (!alive.current) return;
      setProject({ ...imported, home: project?.home ?? false, access: project?.access ?? imported.access }); setDirty(true);
      setSourceFile(Object.keys(imported.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
      setNotice('Imported as a draft. Review its backend and access mode before installing.');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Could not import the project.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!project || lock.current || !ready) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.saveNativeProject(app.id, project, version);
      if (!alive.current) return;
      if (result.error || !result.data) { setError(result.error || 'Installation failed. Your draft is still here.'); return; }
      setProject(result.data.project); setVersion(result.data.project.version); setDirty(false); drafts.clear(); setRecoverable(null);
      setNotice('Installed. The app uses its private SQLite database and ZIPP backend. Existing records were preserved.');
      onInstalled?.(!!result.data.project.home);
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const manifest = (() => { try { return project ? JSON.parse(project.files['manifest.json']) : null; } catch { return null; } })();
  const screenFiles = Object.keys(project?.files ?? {}).filter(path => /\.(ui|logic)$/.test(path) && !path.startsWith('server/'));
  const activeScreen = screenFiles.includes(screenFile) ? screenFile : screenFiles[0] || '';
  const backendFiles = Object.keys(project?.files ?? {}).filter(path => path.startsWith('server/'));
  if (editor && project) return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} onClose={() => setEditor(null)} onApply={async bytes => {
    const draft = await importNativeProject(new File([new Uint8Array(bytes)], `${app.slug}.softn`));
    setProject({ ...draft, version, home: project.home, access: project.access });
    setSourceFile(current => draft.files[current] !== undefined ? current : Object.keys(draft.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
    setDirty(true); setNotice('Editor changes returned to your draft. Review the source, then publish when ready.');
  }} />;
  // Closing keeps the checkpoint: discarding a draft is its own explicit action.
  const LEAVE_MESSAGE = 'Close without publishing? Your draft is kept in this browser and offered again when you reopen native hosting for this app.';
  const close = () => { if (!lock.current && (!dirty || window.confirm(LEAVE_MESSAGE))) onClose(); };
  return <Modal isOpen title="Native app hosting" size={tab === 'screens' || tab === 'backend' ? 'full' : '2xl'} onClose={close} footer={<div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-500 dark:text-slate-400">{version ? `Installed version ${version}` : 'No native app installed'}{dirty ? (drafts.scoped ? ' · Unpublished draft (kept in this browser)' : ' · Unpublished draft') : ''}</span>{tab === 'records' ? <Button variant="secondary" onClick={close}>Done</Button> : <Button disabled={!ready || !available || !project || !dirty || busy} isLoading={busy} onClick={() => void save()}>{version ? 'Publish changes' : 'Install app project'}</Button>}</div>}>
    <div className="space-y-5 p-4 sm:p-6">
      {tab !== 'records' && <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">FormLogic manages this project. Its private .logic code runs in ZIPP and its records stay in one app database. Importing does not publish the parent app or configure external SMS providers.</p>}
      {!ready && !error && <p role="status">Loading native hosting…</p>}
      {ready && !available && !preflight && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The server needs the native app runtime installed before it can run this project.</p>}
      {ready && preflight && !preflight.ok && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="font-medium">The native runtime is prepared but cannot start on this server yet.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.checks.filter(check => !check.ok).map(check => <li key={check.id}><span className="font-mono text-xs">{check.id}</span> — {check.message}</li>)}</ul>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
      {recoverable && !dirty && <div role="region" aria-label="Unpublished draft" className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 text-sm dark:border-indigo-500/40 dark:bg-indigo-950/20">
        <p className="font-medium text-slate-900 dark:text-white">An unpublished draft from {new Date(recoverable.savedAt).toLocaleString()} is kept in this browser.</p>
        <p className="mt-1 leading-6 text-slate-600 dark:text-slate-400">{recoverable.baseVersion !== version ? `It was based on version ${recoverable.baseVersion}; version ${version} has been published since. Recovering it does not publish anything: review the differences, then publish to replace version ${version}.` : 'It has not been published. Recover it to keep editing, or discard it.'}</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy} onClick={recoverDraft}>Recover draft</Button><Button className="min-h-11" variant="secondary" disabled={busy} onClick={discardDraft}>Discard draft</Button></div>
      </div>}
      {project && <div className="flex flex-wrap gap-2">{(['builder', 'studio'] as const).map(kind => <Button key={kind} variant="secondary" disabled={busy} onClick={() => { try { setEditor({ kind, bundle: exportNativeProject(project) }); } catch { setError('Could not prepare this project for the editor.'); } }}>{kind === 'builder' ? 'Open Visual Builder' : 'Open AI Studio'}</Button>)}</div>}
      <div role="tablist" aria-label="Native app sections" className="grid grid-cols-2 gap-1 sm:grid-cols-4 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">{(['project','screens','backend','records'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} className={`min-h-11 rounded-lg text-sm font-medium capitalize ${tab === value ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-600 dark:text-slate-300'}`} onClick={() => { setTab(value); }}>{value}</button>)}</div>
      {tab === 'project' && <div className="space-y-4">
        <input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Import native app" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        <Button variant="secondary" disabled={!ready || busy} onClick={() => input.current?.click()}>Import .softn project</Button>
        {project && <><div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"><h3 className="break-words font-semibold text-slate-900 dark:text-white">{manifest?.name || app.name}</h3><p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{Object.keys(project.files).length} source files · {Object.keys(project.assets).length} media files · {manifest?.server?.routes?.length || 0} backend routes</p></div>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-700"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={!!project.home} disabled={busy} onChange={event => { setProject({ ...project, home: event.target.checked }); setDirty(true); }} /><span><span className="block font-medium text-slate-900 dark:text-white">Use this app as the website home</span><span className="mt-1 block leading-6 text-slate-600 dark:text-slate-400">Open this interface at the app’s normal address. Connected domains use it too when set to open the app directly.</span></span></label>
          <label className="block text-sm font-medium text-slate-800 dark:text-slate-200">Visitor access<select aria-label="Visitor access" className={`${control} mt-2`} disabled={busy} value={project.access} onChange={event => { setProject({ ...project, access: event.target.value as NativeProject['access'] }); setDirty(true); }}><option value="application">Use the app’s own sign-in</option><option value="members">Require FormLogic membership</option></select></label>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">The app’s own sign-in keeps its account system intact. FormLogic membership adds a gate for apps without sign-in; configure registration and invitations in Users &amp; roles.</p>
        </>}
        {project && <Button variant="secondary" onClick={() => {
          try {
            const bytes = exportNativeProject(project);
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
            const link = document.createElement('a'); link.href = url; link.download = `${app.slug}.softn`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch { setError('The project copy could not be prepared. Your draft is still here.'); }
        }}>Download editable project</Button>}
        {project && <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">The download includes this draft’s interface, private backend and migrations. It excludes records and server credentials. Open it in your app editor and import the updated project here.</p>}
        {version > 0 && <a href={`/app/${encodeURIComponent(app.slug)}/native`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-indigo-600 dark:text-indigo-300">Open installed app</a>}
        <Link className="block text-sm font-medium text-indigo-600 dark:text-indigo-300" to={`/apps/${app.id}/studio/access`} onClick={event => { if (lock.current || (dirty && !window.confirm(LEAVE_MESSAGE))) event.preventDefault(); }}>Manage users &amp; roles</Link>
      </div>}
      {tab === 'screens' && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">Edit the interface and its client logic here, or use Open Visual Builder and Open AI Studio above. Your changes remain a draft until you publish.</p>{project && <><select aria-label="Interface file" className={control} value={activeScreen} onChange={event => setScreenFile(event.target.value)}>{screenFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={activeScreen} label="Interface source" readOnly={busy} value={project.files[activeScreen] || ''} onChange={value => { setProject({ ...project, files: { ...project.files, [activeScreen]: value } }); setDirty(true); }} /></>}</div>}
      {tab === 'backend'  && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">Edit the app’s private .logic source. Installed migrations are read-only; import a new numbered migration to change the schema. Publishing preserves existing records.</p>{project && <><select aria-label="Private backend file" className={control} value={sourceFile} onChange={event => setSourceFile(event.target.value)}>{backendFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={sourceFile} label="Private backend source" readOnly={busy || !sourceFile.endsWith('.logic')} value={project.files[sourceFile] || ''} onChange={value => { setProject({ ...project, files: { ...project.files, [sourceFile]: value } }); setDirty(true); }} /></>}</div>}
      {tab === 'records' && ready && (version > 0 ? <NativeRecordsBrowser key={app.id} appId={app.id} version={version} initialTable={initialTable} /> : <p className="text-sm text-slate-500 dark:text-slate-400">Install the project to create its database.</p>)}
    </div>
  </Modal>;
}
