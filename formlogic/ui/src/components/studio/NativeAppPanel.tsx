import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Database, Download, ExternalLink, Package, Upload } from 'lucide-react';
import { ToolRow } from './ToolRow';
import { AppEngineSelect } from './AppEngineSelect';
import { AppTorchSwitch } from './AppTorchSwitch';
import { importNativeProject, exportNativeProject, type NativeProject, type NativeProjectBytes } from '../../lib/nativeHosting';
import { withMediaBytes } from '../../lib/nativeMedia';
import { projectHasBackend } from '../../lib/softnApps';
import { useAiReady } from '../../hooks/useAiReady';
import { AiConnectNotice } from '../ai/AiConnectNotice';
import { DRAFT_KEEPING, useNativeProjectDraft } from './useNativeProjectDraft';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ProjectSourcePane } from './ProjectSourcePane';
import { NativeRecordsBrowser } from './NativeRecordsBrowser';
import { AppEditorDialog, type AppEditorKind } from './AppEditorDialog';

/**
 * A forms app's own project, in the App Studio: an interface, a private backend and a database
 * brought in beside its forms. `installed` is whether the app has one (unsaid: not known, so every
 * way in is offered). With none, the code and the records are not offered: there is nothing in
 * either until a project is brought in, and the one way to do that is the hosting dialog.
 */
export function NativeAppPanel({ app, installed, onInstalled }: { app: { id: string; slug: string; name: string }; installed?: boolean; onInstalled?: (home: boolean) => void }) {
  const [open, setOpen] = useState<'project'|'backend'|'records'|null>(null);
  return <>
    <ToolRow icon={Database} title="App backend & database"
      description={installed === false
        ? 'Bring in a finished app you already have (a .softn file) with its own pages, private backend and database; it can keep its own sign-in.'
        : 'A finished app you bring in (a .softn file) keeps its own pages, private backend and database here: edit its code, browse its records or bring in a new version.'}
      actions={<>{installed !== false && <><Button variant="secondary" onClick={() => setOpen('backend')}>Backend code</Button><Button variant="secondary" onClick={() => setOpen('records')}>Database records</Button></>}<Button variant="secondary" onClick={() => setOpen('project')}>Native app hosting</Button></>} />
    {open && <NativeEditor app={app} initialTab={open} onInstalled={onInstalled} onClose={() => setOpen(null)} />}
  </>;
}
/**
 * A hosted project in a dialog, in one of two shapes.
 * `source` (a SoftN app's own page): its files and nothing else. Everything else about such an app
 * is on its page: who can use it, its engine, its data, uploading and downloading it, the editors.
 * `hosting` (the App Studio, for a forms app that carries a project): the project's settings, its
 * source and its records, since the studio has no other place for them.
 */
export function NativeEditor({ app, onClose, onInstalled, initialTab = 'project', initialTable = '', surface = 'hosting', saveLabel }: {
  app: { id: string; slug: string; name: string }; onClose: () => void; onInstalled?: (home: boolean) => void;
  /** The tab the hosting dialog opens on; `backend` opens the source on the backend's first file. */
  initialTab?: 'project'|'backend'|'records'; initialTable?: string;
  surface?: 'hosting'|'source';
  /** What the button that installs the draft says on the source surface. */
  saveLabel?: string;
}) {
  const sourceOnly = surface === 'source';
  const [editor, setEditor] = useState<{ kind: AppEditorKind; bundle: Uint8Array } | null>(null);
  const [tab, setTab] = useState<'project'|'source'|'records'>(sourceOnly || initialTab === 'backend' ? 'source' : initialTab);
  // The chosen file; none chosen opens the first one listed, or the backend's first for an entry on the backend.
  const [sourceFile, setSourceFile] = useState('');
  // A file is being held over the place it is dropped to bring an app in.
  const [dropping, setDropping] = useState(false);
  const ai = useAiReady({ withRecheck: true });
  const aiReady = ai.ready;
  const input = useRef<HTMLInputElement>(null);
  // The dialog's content, to bring its top back into view when another tab is opened.
  const body = useRef<HTMLDivElement>(null);
  const control = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  // The editor is mounted anew for each chosen entry tab.
  const draft = useNativeProjectDraft(app, { onInstalled: installed => onInstalled?.(!!installed.home), reloadKey: `${initialTab}:${initialTable}` });
  const { project, version, installedFiles, ready, available, preflight, readOnly, engine, enginePolicy, busy, dirty, error, notice, conflict, base, recoverable, edit } = draft;
  // Only a backend runs on the server's runtime: an app with none publishes and runs without it.
  const needsRuntime = !project || projectHasBackend(project);
  const firstBackend = (files: Record<string, string>) => Object.keys(files).find(path => path.startsWith('server/') && path.endsWith('.logic')) || '';
  const activeSource = project && project.files[sourceFile] !== undefined ? sourceFile : !sourceOnly && initialTab === 'backend' ? firstBackend(project?.files ?? {}) : '';
  const recoverDraft = () => {
    const recovered = draft.recoverDraft();
    if (recovered) setSourceFile(current => recovered.files[current] !== undefined ? current : '');
  };
  const discardDraft = draft.discardDraft;
  // The dialog holds the project's media by name (lib/nativeMedia): an editor and a download are
  // given their bytes first, read from the server once, and nothing else starts on them meanwhile.
  const [preparing, setPreparing] = useState<'editor' | 'download' | null>(null);
  const preparingNow = useRef(false);
  // The project as it is now, and whether the dialog is still open: read once the media have come.
  const projectNow = useRef(project);
  useLayoutEffect(() => { projectNow.current = project; }, [project]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function withBytes(what: 'editor' | 'download', then: (project: NativeProjectBytes) => void, failed: string) {
    const from = project;
    if (!from || preparingNow.current) return;
    preparingNow.current = true; setPreparing(what);
    try {
      const bytes = await withMediaBytes(app.id, from);
      if (!mounted.current) return;
      // An editor opened on the draft as it was, once it changed meanwhile, would put those changes back.
      if (what === 'editor' && projectNow.current !== from) { draft.setNotice('The project changed while it was being opened for the editor. Open the editor again.'); return; }
      then(bytes);
    }
    catch (reason) { if (mounted.current) draft.setError(reason instanceof Error && reason.message ? reason.message : failed); }
    finally { preparingNow.current = false; if (mounted.current) setPreparing(null); }
  }
  async function importFile(file: File | undefined) {
    const imported = await draft.importFile(file);
    if (imported) setSourceFile('');
  }
  // The source surface says what saving did in its own words: the hosting dialog's speak of a backend an app may not have.
  const save = () => draft.save(sourceOnly ? { notice: needsRuntime ? 'Saved as the next version. Existing records were kept.' : 'Saved as the next version.' } : undefined);
  const manifest = (() => { try { return project ? JSON.parse(project.files['manifest.json']) : null; } catch { return null; } })();
  // The manifest is typed in here, so nothing of it is trusted to be what it should: a name that
  // is not text, or routes that are not a list, are passed over rather than drawn.
  const projectName = typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name : app.name;
  const routeCount = Array.isArray(manifest?.server?.routes) ? manifest.server.routes.length : 0;
  if (editor && project) return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} onClose={() => setEditor(null)} onApply={async bytes => {
    const returned = await importNativeProject(new File([new Uint8Array(bytes)], `${app.slug}.softn`));
    edit({ ...returned, version, home: project.home, access: project.access });
    setSourceFile(current => returned.files[current] !== undefined ? current : '');
    draft.setNotice('Editor changes returned to your draft. Review the source, then publish when ready.');
  }} />;
  // Closing keeps the checkpoint: discarding a draft is its own explicit action.
  // What leaving is said to keep is read after the pending checkpoint is written.
  const keeping = draft.keeping;
  const leaveMessage = () => draft.leaveMessage();
  const close = () => { if (!draft.isLocked() && (!dirty || window.confirm(leaveMessage()))) onClose(); };
  const discard = () => { if (!draft.isLocked() && window.confirm('Discard your unpublished changes?')) { draft.revert(); setSourceFile(''); } };
  const status = sourceOnly
    // Nothing is said of a version until one is known: "Version 0" stood here while it loaded.
    ? version > 0 ? `Version ${version}${dirty ? ` · Unpublished changes${keeping ? ` (${DRAFT_KEEPING[keeping][0]})` : ''}` : ''}` : ''
    : `${version ? `Installed version ${version}` : 'No native app installed'}${dirty ? ` · Unpublished draft${keeping ? ` (${DRAFT_KEEPING[keeping][0]})` : ''}` : ''}`;
  // Nothing brought in yet, and an owner who can: the dialog is the one step that starts everything,
  // whichever of its buttons opened it. Its other tabs have nothing in them until then.
  const starting = !sourceOnly && ready && !project && !readOnly;
  const shown = starting ? 'project' : tab;
  const card = 'rounded-2xl border border-slate-200 p-4 dark:border-slate-700';
  const cardTitle = 'text-sm font-semibold text-slate-900 dark:text-white';
  const hint = 'text-sm leading-6 text-slate-600 dark:text-slate-400';
  return <Modal isOpen title={sourceOnly ? 'Source code' : 'Native app hosting'} size={shown === 'project' ? '2xl' : 'window'} onClose={close}
    description={sourceOnly ? (readOnly ? `Every file of ${app.name}, shown as they are.` : `Every file of ${app.name}. Your changes are kept as a draft until you press ${saveLabel ?? 'Publish changes'}.`) : 'An app of your own inside this one: its pages, a private backend and its database, brought in as a .softn file.'}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-slate-500 dark:text-slate-400">{status}</span>
      <div className="flex flex-wrap items-center gap-2">
        {dirty && !readOnly && shown !== 'records' && <Button variant="ghost" disabled={busy} onClick={discard}>Discard changes</Button>}
        {shown === 'records' || readOnly
          ? <Button variant="secondary" onClick={close}>Done</Button>
          : <Button disabled={!ready || (needsRuntime && !available) || !project || !dirty || busy} isLoading={busy} onClick={() => void save()}>{sourceOnly && saveLabel ? saveLabel : version ? 'Publish changes' : 'Install app project'}</Button>}
      </div>
    </div>}>
    <div ref={body} className={sourceOnly ? 'space-y-3 p-4' : 'space-y-4 p-4 sm:p-6'}>
      {readOnly && <p role="note" className="rounded-xl bg-slate-100 p-3 text-sm leading-6 text-slate-700 dark:bg-slate-800 dark:text-slate-300">{sourceOnly
        ? 'This is the shared demo, so the app’s files are shown as they are and cannot be changed.'
        : 'This is the shared demo, so this app’s backend and database are read-only. Browse the project, its source and its records; importing, editing and publishing are disabled.'}</p>}
      {!ready && !error && <p role="status">{sourceOnly ? 'Loading the app’s files…' : 'Loading native hosting…'}</p>}
      {/* The demo never runs the runtime preflight: it cannot install anything, so it is not told what the server lacks. */}
      {ready && !readOnly && needsRuntime && !available && !preflight && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The server needs the native app runtime installed before it can run this project.</p>}
      {ready && !readOnly && needsRuntime && preflight && !preflight.ok && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="font-medium">The native runtime is prepared but cannot start on this server yet.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.checks.filter(check => !check.ok && !check.warning).map(check => <li key={check.id}><span className="font-mono text-xs">{check.id}</span> — {check.message}</li>)}</ul>
      </div>}
      {/* A warning limits something without stopping the runtime: Publish and Install stay available. */}
      {ready && !readOnly && !!preflight?.warnings?.length && <div role="note" aria-label="Native runtime warnings" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="font-medium">The native runtime works here, with a limit.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </div>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
      {conflict && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">This draft is based on version {base}; version {version} was published after it. Review the differences before you publish: publishing replaces version {version}.</p>}
      {recoverable && <div role="region" aria-label="Unpublished draft" className="rounded-xl border border-primary-200 bg-primary-50/60 p-4 text-sm dark:border-primary-500/40 dark:bg-primary-950/20">
        <p className="font-medium text-slate-900 dark:text-white">An unpublished draft from {new Date(recoverable.savedAt).toLocaleString()} is kept in this browser.</p>
        <p className="mt-1 leading-6 text-slate-600 dark:text-slate-400">{recoverable.baseVersion !== version ? `It was based on version ${recoverable.baseVersion}; version ${version} has been published since. Recovering it does not publish anything: review the differences, then publish to replace version ${version}.` : 'It has not been published. Recover it to keep editing, or discard it.'}{dirty ? ' Until you do, your current changes are not kept in this browser; recovering replaces them.' : ''}</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy} onClick={recoverDraft}>Recover draft</Button><Button className="min-h-11" variant="secondary" disabled={busy} onClick={discardDraft}>Discard draft</Button></div>
      </div>}

      {/* The file chooser serves the first import and every later one. */}
      {!sourceOnly && !readOnly && <input ref={input} type="file" accept=".softn,.zip" className="hidden" aria-label="Import native app" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />}

      {/* What is open, and the two editors that work on all of it: one strip above the tabs, on every tab.
          The editors only return a draft to publish. A SoftN app's page opens them itself. */}
      {!sourceOnly && project && <section aria-label="Project" className={`${card} flex flex-col gap-3 sm:flex-row sm:items-center`}>
        <span aria-hidden="true" className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300"><Package className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-semibold text-slate-900 dark:text-white">{projectName}</h3>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{Object.keys(project.files).length} source files · {Object.keys(project.assets).length} media files · {routeCount} backend routes</p>
          {/* Where it runs and where its data is, in a line: what an owner asks first of an app they brought in. */}
          <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{needsRuntime ? 'Its backend runs on this server, and its records are kept in a database of its own.' : 'It has no backend: it runs in each visitor’s browser and keeps its data there.'}</p>
        </div>
        {!readOnly && <div className="flex flex-wrap gap-2">{(['builder', 'studio'] as const).map(kind => <Button key={kind} variant="secondary" disabled={busy || !!preparing || (kind === 'studio' && aiReady === false)} title={kind === 'studio' && aiReady === false ? 'Connect an AI in Settings → AI to edit with AI Studio.' : undefined} onClick={() => void withBytes('editor', bytes => setEditor({ kind, bundle: exportNativeProject(bytes) }), 'Could not prepare this project for the editor.')}>{kind === 'builder' ? 'Open Visual Builder' : 'Open AI Studio'}</Button>)}</div>}
      </section>}
      {!sourceOnly && project && !readOnly && aiReady === false && <AiConnectNotice className="text-xs leading-5 text-slate-500 dark:text-slate-400" lead="AI Studio needs an AI connection; the Visual Builder works without one" reason={ai.reason} onConnected={ai.recheck} />}

      {!sourceOnly && !starting && <div role="tablist" aria-label="Native app sections" className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">{(['project','source','records'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} className={`min-h-11 rounded-lg text-sm font-medium capitalize ${tab === value ? 'bg-white text-primary-700 shadow-sm dark:bg-slate-700 dark:text-primary-200' : 'text-slate-600 dark:text-slate-300'}`} onClick={() => { setTab(value); body.current?.scrollIntoView?.({ block: 'start' }); }}>{value}</button>)}</div>}

      {/* Nothing brought in yet: one thing to do, said plainly, with the file dropped here or chosen. */}
      {starting && <section aria-label="Bring in your app"
        onDragOver={event => { event.preventDefault(); setDropping(true); }} onDragLeave={() => setDropping(false)}
        onDrop={event => { event.preventDefault(); setDropping(false); void importFile(event.dataTransfer.files?.[0]); }}
        className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-4 py-10 text-center transition-colors ${dropping ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10' : 'border-slate-300 dark:border-slate-700'}`}>
        <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300"><Upload className="h-6 w-6" /></span>
        <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">Bring in your app</h3>
        <p className={`mt-1 max-w-xl ${hint}`}>Drop its <span className="font-mono text-[13px]">.softn</span> file here or choose it. You see what is in it first: nothing is installed until you press <span className="font-medium text-slate-900 dark:text-white">Install app project</span>.</p>
        <Button className="mt-5" disabled={busy} isLoading={busy} leftIcon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>Import .softn project</Button>
        <ul className="mt-6 grid max-w-2xl gap-x-6 gap-y-2 text-left text-sm text-slate-600 dark:text-slate-400 sm:grid-cols-3">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Its own pages, as it was built</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400" aria-hidden="true" />A private backend and its database</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-none text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Its own sign-in, or this app’s members</li>
        </ul>
        <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">A <span className="font-mono">.zip</span> holding one app works too. Bringing it in does not publish this app.</p>
      </section>}

      {shown === 'project' && !starting && <div className="space-y-4">
        {!project && readOnly && <p className={hint}>No native app is installed.</p>}
        {/* Two columns of cards, each as tall as what it holds: where it opens and its files, who uses it and what runs it. */}
        {project && <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
          <section aria-label="Where it opens" className={card}>
            <h3 className={cardTitle}>Where it opens</h3>
            <label className="mt-3 flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={!!project.home} disabled={busy || readOnly} onChange={event => edit({ ...project, home: event.target.checked })} /><span><span className="block font-medium text-slate-900 dark:text-white">Use this app as the website home</span><span className="mt-1 block leading-6 text-slate-600 dark:text-slate-400">Open this interface at the app’s normal address. Connected domains use it too when set to open the app directly.</span></span></label>
            {/* The installed app's runtime is not served to the shared demo: the link would only open its refusal. */}
            {version > 0 && !readOnly && <a href={`/app/${encodeURIComponent(app.slug)}/native`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary-600 dark:text-primary-300"><ExternalLink className="h-4 w-4" aria-hidden="true" />Open installed app</a>}
          </section>
          <section aria-label="Files" className={card}>
            <h3 className={cardTitle}>Files</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {!readOnly && <Button variant="secondary" disabled={!ready || busy || !!preparing} leftIcon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>Import .softn project</Button>}
              <Button variant="secondary" disabled={!!preparing} isLoading={preparing === 'download'} leftIcon={<Download className="h-4 w-4" />} onClick={() => void withBytes('download', project => {
                const url = URL.createObjectURL(new Blob([new Uint8Array(exportNativeProject(project))], { type: 'application/octet-stream' }));
                const link = document.createElement('a'); link.href = url; link.download = `${app.slug}.softn`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }, 'The project copy could not be prepared. Your draft is still here.')}>Download editable project</Button>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{readOnly ? 'The download includes this project’s interface, private backend and migrations. It excludes records and server credentials.' : 'The download includes this draft’s interface, private backend and migrations. It excludes records and server credentials. Open it in your app editor and import the updated project here.'}</p>
          </section>
          </div>
          <div className="space-y-4">
          <section aria-label="Who can use it" className={card}>
            <h3 className={cardTitle}>Who can use it</h3>
            <label className="mt-3 block text-sm font-medium text-slate-800 dark:text-slate-200">Visitor access<select aria-label="Visitor access" className={`${control} mt-2`} disabled={busy || readOnly} value={project.access} onChange={event => edit({ ...project, access: event.target.value as NativeProject['access'] })}><option value="application">Use the app’s own sign-in</option><option value="members">Require FormLogic membership</option></select></label>
            <p className={`mt-2 ${hint}`}>The app’s own sign-in keeps its account system intact. FormLogic membership adds a gate for apps without sign-in; configure registration and invitations in Users &amp; roles.</p>
            <Link className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-primary-600 dark:text-primary-300" to={`/apps/${app.id}/studio/access`} onClick={event => { if (draft.isLocked() || (dirty && !window.confirm(leaveMessage()))) event.preventDefault(); }}>Manage users &amp; roles</Link>
          </section>
          {engine && enginePolicy && <section aria-label="Engine" className={card}>
            <h3 className={cardTitle}>Engine</h3>
            <div className="mt-3 space-y-4">
              <AppEngineSelect appId={app.id} engine={engine} policy={enginePolicy} disabled={busy || readOnly} onChanged={() => void draft.refreshEngine()} />
              {!readOnly && <AppTorchSwitch appId={app.id} policy={enginePolicy} disabled={busy} />}
            </div>
          </section>}
          </div>
        </div>}
      </div>}
      {/* With nothing brought in yet the engine is still the app's to choose: it sits under the one step, out of its way. */}
      {starting && engine && enginePolicy && <details className={`${card} group`}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-900 dark:text-white [&::-webkit-details-marker]:hidden">Engine<span className="text-xs font-normal text-slate-500 group-open:hidden dark:text-slate-400">The default suits most apps</span></summary>
        <div className="mt-3 space-y-4">
          <AppEngineSelect appId={app.id} engine={engine} policy={enginePolicy} disabled={busy} onChanged={() => void draft.refreshEngine()} />
          <AppTorchSwitch appId={app.id} policy={enginePolicy} disabled={busy} />
        </div>
      </details>}
      {shown === 'source' && <div className="space-y-3">
        {!sourceOnly && <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">{readOnly ? 'Browse the project’s files: its pages, their logic and its private backend.' : 'Every file of the project: its pages, their logic and its private backend. Your changes remain a draft until you publish, and publishing preserves existing records.'}</p>}
        {project
          ? <ProjectSourcePane appId={app.id} project={project} installed={installedFiles} readOnly={busy || readOnly} file={activeSource} onFile={setSourceFile} onEdit={edit} onNotice={draft.setNotice} />
          : ready && <p className="text-sm text-slate-500 dark:text-slate-400">{readOnly ? 'No native app is installed, so there is no source to browse.' : 'Import a project first: its files are edited here.'}</p>}
      </div>}
      {shown === 'records' && ready && (version > 0 ? <NativeRecordsBrowser key={app.id} appId={app.id} appSlug={app.slug} version={version} initialTable={initialTable} readOnly={readOnly} /> : <p className="text-sm text-slate-500 dark:text-slate-400">{readOnly ? 'No native app is installed, so there is no database to browse.' : 'Install the project to create its database.'}</p>)}
    </div>
  </Modal>;
}
