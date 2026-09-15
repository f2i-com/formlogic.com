import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { importNativeProject, exportNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { nativeDraftStore, type NativeDraftCheckpoint, type NativeDraftWrite } from '../../lib/nativeDraft';
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
/** A checkpoint is written this long after the last change, so typing does not serialise the project per keystroke. */
const CHECKPOINT_DELAY = 400;
/**
 * Audit FL-S08: the footer label and leave prompt for a dirty draft, from what
 * its last checkpoint actually did. 'waiting' is an open draft held back while
 * an earlier stored draft awaits Recover or Discard.
 */
const KEEPING: Record<NativeDraftWrite | 'waiting', readonly [label: string, leave: string]> = {
  kept: ['kept in this browser', 'Your draft is kept in this browser and offered again when you reopen native hosting for this app.'],
  waiting: ['not kept until the earlier draft is recovered or discarded', 'Your current changes are not kept in this browser until the earlier draft is recovered or discarded, so they will be lost if you leave.'],
  'too-large': ['not kept in this browser: too large', 'This draft is too large to keep in this browser, so your latest changes will be lost if you leave.'],
  full: ['not kept in this browser: no room left for drafts', 'Unpublished drafts for other apps or accounts already fill the room this browser keeps for drafts, so your latest changes will be lost if you leave. Publishing or discarding those drafts makes room.'],
  unavailable: ['not kept in this browser: storage refused it', 'This browser refused to store the draft, so your latest changes will be lost if you leave.'],
  unscoped: ['not kept in this browser', 'This draft is not kept in this browser, so your changes will be lost if you leave.'],
};
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
  // The shared demo browses the project, source and records read-only: the server says so, and
  // until it has (or if it could not) the account does. Nothing can be imported, edited or
  // published, so nothing is ever dirty, checkpointed or asked about when leaving.
  const isDemo = useAuthStore(state => !!state.user?.isDemo);
  const [serverReadOnly, setServerReadOnly] = useState<boolean | null>(null);
  const readOnly = serverReadOnly ?? isDemo;
  // Audit FL-S08: the unpublished draft is checkpointed in this browser for
  // this account and app, and offered back on reopen; never published alone.
  const userId = useAuthStore(state => state.user?.id);
  const drafts = useMemo(() => nativeDraftStore(userId, app.id), [userId, app.id]);
  const [recoverable, setRecoverable] = useState<NativeDraftCheckpoint | null>(null);
  // The version the open draft is based on (a recovered draft keeps its own),
  // and what its last checkpoint write did: rendered in the footer, and read
  // at once by the leave prompt, which can run before that render commits.
  const [base, setBase] = useState<number | null>(null);
  const [kept, setKept] = useState<NativeDraftWrite | null>(null);
  const lastWrite = useRef<NativeDraftWrite | null>(null);
  const pending = useRef<NativeDraftCheckpoint | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lock = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  useEffect(() => {
    let cancelled = false; alive.current = true;
    void api.getNativeProject(app.id).then(result => {
      if (cancelled) return;
      setReady(!result.error); setAvailable(!!result.data?.available && result.data?.ready !== false); setPreflight(result.data?.preflight ?? null);
      if (typeof result.data?.readOnly === 'boolean') setServerReadOnly(result.data.readOnly);
      if (result.error) setError(result.error);
      if (result.data?.project) { setProject(result.data.project); setVersion(result.data.project.version); setSourceFile(Object.keys(result.data.project.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || ''); }
      // A read-only editor has no draft to offer back.
      if (!result.error && !(result.data?.readOnly ?? isDemo)) setRecoverable(drafts.read());
    });
    return () => { cancelled = true; alive.current = false; };
  // The editor is mounted anew for each chosen entry tab.
  }, [app.id, initialTab, initialTable, drafts, isDemo]);
  // A pending checkpoint is written at once before anything that could lose
  // it (leaving, closing, unmounting); the result says what was really kept.
  const flush = useCallback((): NativeDraftWrite | null => {
    clearTimeout(timer.current);
    const checkpoint = pending.current;
    if (!checkpoint) return null;
    pending.current = null;
    const result = lastWrite.current = drafts.write(checkpoint);
    if (alive.current) setKept(result);
    return result;
  }, [drafts]);
  // Changes to a dirty draft refresh its checkpoint shortly after the last one,
  // except while an earlier stored draft awaits Recover or Discard: that draft
  // is never overwritten by edits made before the owner decides. Leaving the
  // page with a dirty draft is asked about, as every other editor in the app does.
  useEffect(() => {
    if (!dirty || !project || recoverable || readOnly) { pending.current = null; return; }
    pending.current = { baseVersion: base ?? version, savedAt: new Date().toISOString(), project };
    timer.current = setTimeout(flush, CHECKPOINT_DELAY);
    return () => clearTimeout(timer.current);
  }, [dirty, project, base, version, recoverable, readOnly, flush]);
  useEffect(() => () => { flush(); }, [flush]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { flush(); event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('pagehide', flush); };
  }, [dirty, flush]);
  /** Every change to the open draft; the first on a clean editor bases the draft on the installed version. */
  const edit = (next: NativeProject) => { if (readOnly) return; setProject(next); setBase(current => current ?? version); setDirty(true); };
  const conflict = dirty && base !== null && base !== version;
  const recoverDraft = () => {
    if (!recoverable) return;
    if (dirty && !window.confirm('Recover the earlier draft? It replaces your current changes, which are not kept in this browser.')) return;
    setProject({ ...recoverable.project, version });
    setSourceFile(current => recoverable.project.files[current] !== undefined ? current : Object.keys(recoverable.project.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
    setBase(recoverable.baseVersion); setDirty(true); setRecoverable(null); setError('');
    setNotice('Recovered your unpublished draft. Review it, then publish when ready.');
  };
  // The open draft waited on this decision, so it is checkpointed now rather than after its next change.
  const discardDraft = () => {
    drafts.clear(); setRecoverable(null); setNotice('The unpublished draft was discarded.');
    if (dirty && project) { pending.current = { baseVersion: base ?? version, savedAt: new Date().toISOString(), project }; flush(); }
  };
  async function importFile(file: File | undefined) {
    if (!file || lock.current || readOnly) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const imported = await importNativeProject(file);
      if (!alive.current) return;
      // An import into a dirty draft keeps that draft's base: it may be the draft's own download, edited and brought back.
      edit({ ...imported, home: project?.home ?? false, access: project?.access ?? imported.access });
      setSourceFile(Object.keys(imported.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
      setNotice('Imported as a draft. Review its backend and access mode before installing.');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Could not import the project.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!project || lock.current || !ready || readOnly) return;
    if (conflict && !window.confirm(`Publish this draft? It is based on version ${base}, so publishing replaces version ${version}, which was published after it.`)) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.saveNativeProject(app.id, project, version);
      if (!alive.current) return;
      if (result.error || !result.data) { setError(result.error || 'Installation failed. Your draft is still here.'); return; }
      // The published draft's checkpoint is spent; an earlier one still awaiting Recover or Discard is not it, and stays.
      clearTimeout(timer.current); pending.current = null; lastWrite.current = null;
      if (!recoverable) drafts.clear();
      setProject(result.data.project); setVersion(result.data.project.version); setDirty(false); setBase(null); setKept(null);
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
    edit({ ...draft, version, home: project.home, access: project.access });
    setSourceFile(current => draft.files[current] !== undefined ? current : Object.keys(draft.files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '');
    setNotice('Editor changes returned to your draft. Review the source, then publish when ready.');
  }} />;
  // Closing keeps the checkpoint: discarding a draft is its own explicit action.
  // What leaving is said to keep is read after the pending checkpoint is written.
  const keeping = recoverable ? 'waiting' : kept;
  const leaveMessage = () => `Close without publishing? ${KEEPING[recoverable ? 'waiting' : flush() ?? lastWrite.current ?? 'unscoped'][1]}`;
  const close = () => { if (!lock.current && (!dirty || window.confirm(leaveMessage()))) onClose(); };
  return <Modal isOpen title="Native app hosting" size={tab === 'screens' || tab === 'backend' ? 'full' : '2xl'} onClose={close} footer={<div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-500 dark:text-slate-400">{version ? `Installed version ${version}` : 'No native app installed'}{dirty ? ` · Unpublished draft${keeping ? ` (${KEEPING[keeping][0]})` : ''}` : ''}</span>{tab === 'records' || readOnly ? <Button variant="secondary" onClick={close}>Done</Button> : <Button disabled={!ready || !available || !project || !dirty || busy} isLoading={busy} onClick={() => void save()}>{version ? 'Publish changes' : 'Install app project'}</Button>}</div>}>
    <div className="space-y-5 p-4 sm:p-6">
      {tab !== 'records' && <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">FormLogic manages this project. Its private .logic code runs in ZIPP and its records stay in one app database. Importing does not publish the parent app or configure external SMS providers.</p>}
      {readOnly && <p role="note" className="rounded-xl bg-slate-100 p-3 text-sm leading-6 text-slate-700 dark:bg-slate-800 dark:text-slate-300">This is the shared demo, so this app’s backend and database are read-only. Browse the project, its source and its records; importing, editing and publishing are disabled.</p>}
      {!ready && !error && <p role="status">Loading native hosting…</p>}
      {/* The demo never runs the runtime preflight: it cannot install anything, so it is not told what the server lacks. */}
      {ready && !readOnly && !available && !preflight && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The server needs the native app runtime installed before it can run this project.</p>}
      {ready && !readOnly && preflight && !preflight.ok && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="font-medium">The native runtime is prepared but cannot start on this server yet.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.checks.filter(check => !check.ok).map(check => <li key={check.id}><span className="font-mono text-xs">{check.id}</span> — {check.message}</li>)}</ul>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
      {conflict && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">This draft is based on version {base}; version {version} was published after it. Review the differences before you publish: publishing replaces version {version}.</p>}
      {recoverable && <div role="region" aria-label="Unpublished draft" className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 text-sm dark:border-indigo-500/40 dark:bg-indigo-950/20">
        <p className="font-medium text-slate-900 dark:text-white">An unpublished draft from {new Date(recoverable.savedAt).toLocaleString()} is kept in this browser.</p>
        <p className="mt-1 leading-6 text-slate-600 dark:text-slate-400">{recoverable.baseVersion !== version ? `It was based on version ${recoverable.baseVersion}; version ${version} has been published since. Recovering it does not publish anything: review the differences, then publish to replace version ${version}.` : 'It has not been published. Recover it to keep editing, or discard it.'}{dirty ? ' Until you do, your current changes are not kept in this browser; recovering replaces them.' : ''}</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy} onClick={recoverDraft}>Recover draft</Button><Button className="min-h-11" variant="secondary" disabled={busy} onClick={discardDraft}>Discard draft</Button></div>
      </div>}
      {/* The editors only return a draft to publish. */}
      {project && !readOnly && <div className="flex flex-wrap gap-2">{(['builder', 'studio'] as const).map(kind => <Button key={kind} variant="secondary" disabled={busy} onClick={() => { try { setEditor({ kind, bundle: exportNativeProject(project) }); } catch { setError('Could not prepare this project for the editor.'); } }}>{kind === 'builder' ? 'Open Visual Builder' : 'Open AI Studio'}</Button>)}</div>}
      <div role="tablist" aria-label="Native app sections" className="grid grid-cols-2 gap-1 sm:grid-cols-4 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">{(['project','screens','backend','records'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} className={`min-h-11 rounded-lg text-sm font-medium capitalize ${tab === value ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-600 dark:text-slate-300'}`} onClick={() => { setTab(value); }}>{value}</button>)}</div>
      {tab === 'project' && <div className="space-y-4">
        {!readOnly && <><input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Import native app" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        <Button variant="secondary" disabled={!ready || busy} onClick={() => input.current?.click()}>Import .softn project</Button></>}
        {project && <><div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"><h3 className="break-words font-semibold text-slate-900 dark:text-white">{manifest?.name || app.name}</h3><p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{Object.keys(project.files).length} source files · {Object.keys(project.assets).length} media files · {manifest?.server?.routes?.length || 0} backend routes</p></div>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-700"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={!!project.home} disabled={busy || readOnly} onChange={event => edit({ ...project, home: event.target.checked })} /><span><span className="block font-medium text-slate-900 dark:text-white">Use this app as the website home</span><span className="mt-1 block leading-6 text-slate-600 dark:text-slate-400">Open this interface at the app’s normal address. Connected domains use it too when set to open the app directly.</span></span></label>
          <label className="block text-sm font-medium text-slate-800 dark:text-slate-200">Visitor access<select aria-label="Visitor access" className={`${control} mt-2`} disabled={busy || readOnly} value={project.access} onChange={event => edit({ ...project, access: event.target.value as NativeProject['access'] })}><option value="application">Use the app’s own sign-in</option><option value="members">Require FormLogic membership</option></select></label>
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
        {project && <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{readOnly ? 'The download includes this project’s interface, private backend and migrations. It excludes records and server credentials.' : 'The download includes this draft’s interface, private backend and migrations. It excludes records and server credentials. Open it in your app editor and import the updated project here.'}</p>}
        {/* The installed app's runtime is not served to the shared demo: the link would only open its refusal. */}
        {version > 0 && !readOnly && <a href={`/app/${encodeURIComponent(app.slug)}/native`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-indigo-600 dark:text-indigo-300">Open installed app</a>}
        <Link className="block text-sm font-medium text-indigo-600 dark:text-indigo-300" to={`/apps/${app.id}/studio/access`} onClick={event => { if (lock.current || (dirty && !window.confirm(leaveMessage()))) event.preventDefault(); }}>Manage users &amp; roles</Link>
      </div>}
      {tab === 'screens' && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the interface and its client logic.' : 'Edit the interface and its client logic here, or use Open Visual Builder and Open AI Studio above. Your changes remain a draft until you publish.'}</p>{project && <><select aria-label="Interface file" className={control} value={activeScreen} onChange={event => setScreenFile(event.target.value)}>{screenFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={activeScreen} label="Interface source" readOnly={busy || readOnly} value={project.files[activeScreen] || ''} onChange={value => edit({ ...project, files: { ...project.files, [activeScreen]: value } })} /></>}</div>}
      {tab === 'backend'  && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the app’s private .logic source and its migrations.' : 'Edit the app’s private .logic source. Installed migrations are read-only; import a new numbered migration to change the schema. Publishing preserves existing records.'}</p>{project && <><select aria-label="Private backend file" className={control} value={sourceFile} onChange={event => setSourceFile(event.target.value)}>{backendFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={sourceFile} label="Private backend source" readOnly={busy || readOnly || !sourceFile.endsWith('.logic')} value={project.files[sourceFile] || ''} onChange={value => edit({ ...project, files: { ...project.files, [sourceFile]: value } })} /></>}</div>}
      {tab === 'records' && ready && (version > 0 ? <NativeRecordsBrowser key={app.id} appId={app.id} version={version} initialTable={initialTable} readOnly={readOnly} /> : <p className="text-sm text-slate-500 dark:text-slate-400">{readOnly ? 'No native app is installed, so there is no database to browse.' : 'Install the project to create its database.'}</p>)}
    </div>
  </Modal>;
}
