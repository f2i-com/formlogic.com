import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppEngineSelect } from './AppEngineSelect';
import { importNativeProject, exportNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { useAiReady } from '../../hooks/useAiReady';
import { DRAFT_KEEPING, useNativeProjectDraft } from './useNativeProjectDraft';
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
  const [tab, setTab] = useState<'project'|'screens'|'backend'|'records'>(initialTab);
  const [sourceFile, setSourceFile] = useState('');
  const [screenFile, setScreenFile] = useState('');
  const aiReady = useAiReady();
  const input = useRef<HTMLInputElement>(null);
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  // The editor is mounted anew for each chosen entry tab.
  const draft = useNativeProjectDraft(app, { onInstalled: installed => onInstalled?.(!!installed.home), reloadKey: `${initialTab}:${initialTable}` });
  const { project, version, ready, available, preflight, readOnly, engine, enginePolicy, busy, dirty, error, notice, conflict, base, recoverable, edit } = draft;
  const firstBackend = (files: Record<string, string>) => Object.keys(files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '';
  // The chosen backend file while it exists, else the first backend file of the open project.
  const activeSource = project && project.files[sourceFile] !== undefined ? sourceFile : firstBackend(project?.files ?? {});
  const recoverDraft = () => {
    const recovered = draft.recoverDraft();
    if (recovered) setSourceFile(current => recovered.files[current] !== undefined ? current : firstBackend(recovered.files));
  };
  const discardDraft = draft.discardDraft;
  async function importFile(file: File | undefined) {
    const imported = await draft.importFile(file);
    if (imported) setSourceFile(firstBackend(imported.files));
  }
  const save = () => draft.save();
  const manifest = (() => { try { return project ? JSON.parse(project.files['manifest.json']) : null; } catch { return null; } })();
  const screenFiles = Object.keys(project?.files ?? {}).filter(path => /\.(ui|logic)$/.test(path) && !path.startsWith('server/'));
  const activeScreen = screenFiles.includes(screenFile) ? screenFile : screenFiles[0] || '';
  const backendFiles = Object.keys(project?.files ?? {}).filter(path => path.startsWith('server/'));
  if (editor && project) return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} onClose={() => setEditor(null)} onApply={async bytes => {
    const returned = await importNativeProject(new File([new Uint8Array(bytes)], `${app.slug}.softn`));
    edit({ ...returned, version, home: project.home, access: project.access });
    setSourceFile(current => returned.files[current] !== undefined ? current : firstBackend(returned.files));
    draft.setNotice('Editor changes returned to your draft. Review the source, then publish when ready.');
  }} />;
  // Closing keeps the checkpoint: discarding a draft is its own explicit action.
  // What leaving is said to keep is read after the pending checkpoint is written.
  const keeping = draft.keeping;
  const leaveMessage = () => draft.leaveMessage();
  const close = () => { if (!draft.isLocked() && (!dirty || window.confirm(leaveMessage()))) onClose(); };
  return <Modal isOpen title="Native app hosting" size={tab === 'screens' || tab === 'backend' ? 'full' : '2xl'} onClose={close} footer={<div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-500 dark:text-slate-400">{version ? `Installed version ${version}` : 'No native app installed'}{dirty ? ` · Unpublished draft${keeping ? ` (${DRAFT_KEEPING[keeping][0]})` : ''}` : ''}</span>{tab === 'records' || readOnly ? <Button variant="secondary" onClick={close}>Done</Button> : <Button disabled={!ready || !available || !project || !dirty || busy} isLoading={busy} onClick={() => void save()}>{version ? 'Publish changes' : 'Install app project'}</Button>}</div>}>
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
      {project && !readOnly && <div className="flex flex-wrap gap-2">{(['builder', 'studio'] as const).map(kind => <Button key={kind} variant="secondary" disabled={busy || (kind === 'studio' && aiReady === false)} title={kind === 'studio' && aiReady === false ? 'Connect an AI in Settings → AI to edit with AI Studio.' : undefined} onClick={() => { try { setEditor({ kind, bundle: exportNativeProject(project) }); } catch { draft.setError('Could not prepare this project for the editor.'); } }}>{kind === 'builder' ? 'Open Visual Builder' : 'Open AI Studio'}</Button>)}{aiReady === false && <p className="basis-full text-xs text-slate-500 dark:text-slate-400">AI Studio needs an AI connection: choose one in Settings → AI. The Visual Builder works without one.</p>}</div>}
      <div role="tablist" aria-label="Native app sections" className="grid grid-cols-2 gap-1 sm:grid-cols-4 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">{(['project','screens','backend','records'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} className={`min-h-11 rounded-lg text-sm font-medium capitalize ${tab === value ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-600 dark:text-slate-300'}`} onClick={() => { setTab(value); }}>{value}</button>)}</div>
      {tab === 'project' && <div className="space-y-4">
        {!readOnly && <><input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Import native app" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
        <Button variant="secondary" disabled={!ready || busy} onClick={() => input.current?.click()}>Import .softn project</Button></>}
        {project && <><div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"><h3 className="break-words font-semibold text-slate-900 dark:text-white">{manifest?.name || app.name}</h3><p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{Object.keys(project.files).length} source files · {Object.keys(project.assets).length} media files · {manifest?.server?.routes?.length || 0} backend routes</p></div>
          <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-700"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={!!project.home} disabled={busy || readOnly} onChange={event => edit({ ...project, home: event.target.checked })} /><span><span className="block font-medium text-slate-900 dark:text-white">Use this app as the website home</span><span className="mt-1 block leading-6 text-slate-600 dark:text-slate-400">Open this interface at the app’s normal address. Connected domains use it too when set to open the app directly.</span></span></label>
          <label className="block text-sm font-medium text-slate-800 dark:text-slate-200">Visitor access<select aria-label="Visitor access" className={`${control} mt-2`} disabled={busy || readOnly} value={project.access} onChange={event => edit({ ...project, access: event.target.value as NativeProject['access'] })}><option value="application">Use the app’s own sign-in</option><option value="members">Require FormLogic membership</option></select></label>
          <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">The app’s own sign-in keeps its account system intact. FormLogic membership adds a gate for apps without sign-in; configure registration and invitations in Users &amp; roles.</p>
        </>}
        {engine && enginePolicy && <AppEngineSelect appId={app.id} engine={engine} policy={enginePolicy} disabled={busy || readOnly} onChanged={() => void draft.refreshEngine()} />}
        {project && <Button variant="secondary" onClick={() => {
          try {
            const bytes = exportNativeProject(project);
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
            const link = document.createElement('a'); link.href = url; link.download = `${app.slug}.softn`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch { draft.setError('The project copy could not be prepared. Your draft is still here.'); }
        }}>Download editable project</Button>}
        {project && <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{readOnly ? 'The download includes this project’s interface, private backend and migrations. It excludes records and server credentials.' : 'The download includes this draft’s interface, private backend and migrations. It excludes records and server credentials. Open it in your app editor and import the updated project here.'}</p>}
        {/* The installed app's runtime is not served to the shared demo: the link would only open its refusal. */}
        {version > 0 && !readOnly && <a href={`/app/${encodeURIComponent(app.slug)}/native`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-indigo-600 dark:text-indigo-300">Open installed app</a>}
        <Link className="block text-sm font-medium text-indigo-600 dark:text-indigo-300" to={`/apps/${app.id}/studio/access`} onClick={event => { if (draft.isLocked() || (dirty && !window.confirm(leaveMessage()))) event.preventDefault(); }}>Manage users &amp; roles</Link>
      </div>}
      {tab === 'screens' && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the interface and its client logic.' : 'Edit the interface and its client logic here, or use Open Visual Builder and Open AI Studio above. Your changes remain a draft until you publish.'}</p>{project && <><select aria-label="Interface file" className={control} value={activeScreen} onChange={event => setScreenFile(event.target.value)}>{screenFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={activeScreen} label="Interface source" readOnly={busy || readOnly} value={project.files[activeScreen] || ''} onChange={value => edit({ ...project, files: { ...project.files, [activeScreen]: value } })} /></>}</div>}
      {tab === 'backend'  && <div className="space-y-3"><p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the app’s private .logic source and its migrations.' : 'Edit the app’s private .logic source. Installed migrations are read-only; import a new numbered migration to change the schema. Publishing preserves existing records.'}</p>{project && <><select aria-label="Private backend file" className={control} value={activeSource} onChange={event => setSourceFile(event.target.value)}>{backendFiles.map(path => <option key={path}>{path}</option>)}</select><NativeSourceEditor appId={app.id} file={activeSource} label="Private backend source" readOnly={busy || readOnly || !activeSource.endsWith('.logic')} value={project.files[activeSource] || ''} onChange={value => edit({ ...project, files: { ...project.files, [activeSource]: value } })} /></>}</div>}
      {tab === 'records' && ready && (version > 0 ? <NativeRecordsBrowser key={app.id} appId={app.id} version={version} initialTable={initialTable} readOnly={readOnly} /> : <p className="text-sm text-slate-500 dark:text-slate-400">{readOnly ? 'No native app is installed, so there is no database to browse.' : 'Install the project to create its database.'}</p>)}
    </div>
  </Modal>;
}
