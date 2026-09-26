// The SoftN app workspace (/apps/:appId/softn): where the owner of a hosted SoftN app sees it
// running, changes it — with AI Studio, the Visual Builder or a new .softn file — manages the
// data in its database, and publishes it. One page for what used to take the App Studio's
// Screens step, a collapsed "Hosting & app tools" section and the native hosting dialog.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Code2, Copy, Database, Download, ExternalLink, Globe, Lock, Monitor, PencilRuler, RefreshCw, Rocket, Settings as SettingsIcon, Smartphone, Sparkles, Upload, Users, Wand2 } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Textarea';
import { Switch } from '../../components/ui/Switch';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { AppEditorDialog, type AppEditorKind } from '../../components/studio/AppEditorDialog';
import type { EditorBrief } from '../../components/studio/editorAgent';
import { AppEngineSelect } from '../../components/studio/AppEngineSelect';
import { NativeEditor } from '../../components/studio/NativeAppPanel';
import { NativeRecordsBrowser } from '../../components/studio/NativeRecordsBrowser';
import { DRAFT_KEEPING, useNativeProjectDraft } from '../../components/studio/useNativeProjectDraft';
import { useAiReady } from '../../hooks/useAiReady';
import { api } from '../../lib/api';
import { exportNativeProject, importNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { projectFromUpload } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { useUIStore, type SoftnOpen } from '../../stores/uiStore';
import type { App } from '../../types/app';

type Tab = 'app' | 'data' | 'settings';
type Opened = { kind: AppEditorKind; bundle: Uint8Array; brief?: EditorBrief };

export function SoftnAppWorkspace() {
  const { appId = '' } = useParams();
  const navigate = useNavigate();
  const app = useAppStore(s => s.apps.find(candidate => candidate.id === appId));
  const fetchApps = useAppStore(s => s.fetchApps);
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    if (app || looked) return;
    void fetchApps().finally(() => setLooked(true));
  }, [app, looked, fetchApps]);
  if (!app) {
    return <div className="min-h-screen">
      <Header title="SoftN app" back={{ onClick: () => navigate('/apps'), label: 'Back to apps' }} />
      <main className="mx-auto max-w-3xl px-4 py-10 text-sm text-slate-600 dark:text-slate-400">
        {looked ? <p role="alert">This app was not found, or it is not yours to manage.</p> : <p role="status">Loading your app…</p>}
      </main>
    </div>;
  }
  return <Workspace key={app.id} app={app} />;
}

function Workspace({ app }: { app: App }) {
  const navigate = useNavigate();
  const fetchApps = useAppStore(s => s.fetchApps);
  const updateApp = useAppStore(s => s.updateApp);
  const softnOpen = useUIStore(s => s.softnOpen);
  const setSoftnOpen = useUIStore(s => s.setSoftnOpen);
  const [reloadKey, setReloadKey] = useState(0);
  const [previewKey, setPreviewKey] = useState(0);
  const draft = useNativeProjectDraft(app, { reloadKey, onInstalled: () => setPreviewKey(key => key + 1) });
  const { project, version, ready, readOnly, busy, dirty } = draft;
  const ai = useAiReady({ withRecheck: true });
  const [tab, setTab] = useState<Tab>('app');
  const [editor, setEditor] = useState<Opened | null>(null);
  const [advanced, setAdvanced] = useState<'backend' | 'project' | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [change, setChange] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [copied, setCopied] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const published = app.status === 'published';
  const liveUrl = `${window.location.origin}/app/${encodeURIComponent(app.slug)}${project?.home ? '' : '/native'}`;

  const openEditor = (kind: AppEditorKind, brief?: EditorBrief, from: NativeProject | null = project) => {
    if (!from) return;
    if (kind === 'studio' && ai.ready !== true) { toast.info('Connect an AI first', 'AI Studio uses your AI connection. Choose one in Settings → AI, or edit visually instead.'); return; }
    try { setEditor({ kind, bundle: exportNativeProject(from), brief }); }
    catch { draft.setError('Could not prepare this app for the editor.'); }
  };

  // Arriving from "Create app" or from the chat: open the editor it asked for, once. The
  // setup choices come first for an app with nothing installed; the request waits for them.
  const [taken, setTaken] = useState<SoftnOpen | null>(null);
  const seed = softnOpen && softnOpen.appId === app.id && ready && project && !editor ? softnOpen : null;
  if (seed && seed !== taken) {
    setTaken(seed);
    try { setEditor({ kind: seed.editor, bundle: exportNativeProject(project!), brief: seed.brief }); }
    catch { draft.setError('Could not prepare this app for the editor.'); }
  }
  useEffect(() => { if (taken && softnOpen === taken) setSoftnOpen(null); }, [taken, softnOpen, setSoftnOpen]);

  // The editor's changes. While the app is not published nobody else can see it, so they are
  // installed at once and the preview shows them; a published app keeps them as a draft to publish.
  const applyEditorChanges = async (bytes: Uint8Array) => {
    if (!project) return;
    const returned = await importNativeProject(new File([new Uint8Array(bytes)], `${app.slug}.softn`));
    const next: NativeProject = { ...returned, version, home: project.home, access: project.access };
    draft.edit(next);
    if (!published) {
      await draft.save({ project: next, confirmConflict: false, notice: 'Saved. The preview shows your changes.' });
    } else {
      draft.setNotice('Your changes are ready. Publish them to update the live app.');
    }
  };

  const publish = async () => {
    if (!project || publishing) return;
    setPublishing(true);
    try {
      if (dirty && !(await draft.save({ notice: 'Published.' }))) return;
      if (!published) {
        const result = await api.publishApp(app.id);
        if (result.error) { draft.setError(result.error); return; }
        await fetchApps();
        toast.success('Your app is live', liveUrl);
      } else {
        toast.success('Live app updated', 'Visitors now get the latest version.');
      }
    } finally { setPublishing(false); }
  };

  const unpublish = async () => {
    setConfirmUnpublish(false);
    if (await updateApp(app.id, { status: 'draft' })) toast.success('App unpublished', 'Nobody but you can open it until you publish again.');
  };

  const changeSetting = async (next: NativeProject, notice: string) => {
    if (dirty) { draft.edit(next); draft.setNotice('Changed in your draft. Publish to apply it.'); return; }
    draft.edit(next);
    await draft.save({ project: next, confirmConflict: false, notice });
  };

  const uploadVersion = async (file: File | undefined) => {
    const imported = await draft.importFile(file, published ? 'Uploaded as a draft. Publish it to update the live app.' : 'Uploaded.');
    if (imported && !published) await draft.save({ project: imported, confirmConflict: false, notice: 'Uploaded. The preview shows the new version.' });
  };

  const download = () => {
    if (!project) return;
    try {
      const url = URL.createObjectURL(new Blob([new Uint8Array(exportNativeProject(project))], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = `${app.slug}.softn`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { draft.setError('The download could not be prepared.'); }
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(liveUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined);
  };

  const leave = (to: string) => { if (!dirty || window.confirm(draft.leaveMessage('Leave without publishing?'))) navigate(to); };

  if (editor) {
    return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} brief={editor.brief}
      applyLabel={published ? 'Keep changes' : 'Save changes'}
      onClose={() => setEditor(null)} onApply={applyEditorChanges} />;
  }
  if (advanced) {
    return <NativeEditor app={app} initialTab={advanced} onClose={() => { setAdvanced(null); setReloadKey(key => key + 1); setPreviewKey(key => key + 1); }} />;
  }

  const actions = project && !readOnly ? <div className="flex items-center gap-2">
    <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="hidden min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5 sm:inline-flex"><ExternalLink className="h-4 w-4" />Open</a>
    {(!published || dirty) && <Button size="sm" onClick={() => void publish()} isLoading={publishing || busy} disabled={!ready} leftIcon={<Rocket className="h-4 w-4" />}>{published ? 'Publish changes' : 'Publish'}</Button>}
  </div> : undefined;

  return <div className="min-h-screen">
    <Header title={app.name} back={{ onClick: () => leave('/apps'), label: 'Back to apps' }} actions={actions} />
    <main className="mx-auto max-w-6xl px-4 pb-24 pt-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill live={published} />
        {project && <span className="text-xs text-slate-500 dark:text-slate-400">Version {version}{dirty ? ` · unpublished changes${draft.keeping ? ` (${DRAFT_KEEPING[draft.keeping][0]})` : ''}` : ''}</span>}
        {published && project && <button type="button" onClick={copyLink} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Link copied' : liveUrl.replace(/^https?:\/\//, '')}</button>}
      </div>

      <Messages draft={draft} />

      {!ready && !draft.error && <p role="status" className="mt-8 text-sm text-slate-500">Loading your app…</p>}
      {ready && !project && !readOnly && <Setup app={app} aiReady={ai.ready} initialRequest={softnOpen?.appId === app.id ? softnOpen.brief?.prompt ?? '' : ''}
        onInstalled={open => { setSoftnOpen(open); setReloadKey(key => key + 1); }} />}
      {ready && !project && readOnly && <p className="mt-8 text-sm text-slate-500">This app has nothing installed yet.</p>}

      {project && <>
        <div role="tablist" aria-label="App sections" className="mt-5 inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {([['app', 'App', Globe], ['data', 'Data', Database], ['settings', 'Settings', SettingsIcon]] as const).map(([value, label, Icon]) =>
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={cn('inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium', tab === value ? 'bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200' : 'text-slate-600 dark:text-slate-300')}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </button>)}
        </div>

        {tab === 'app' && <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-label="Preview" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
              <span className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{published ? 'Live app' : 'Preview — only you can see it until you publish'}</span>
              <div className="flex items-center gap-1">
                <IconButton label="Desktop width" active={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor className="h-4 w-4" /></IconButton>
                <IconButton label="Phone width" active={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone className="h-4 w-4" /></IconButton>
                <IconButton label="Reload preview" onClick={() => setPreviewKey(key => key + 1)}><RefreshCw className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <div className="flex justify-center bg-slate-50 p-3 dark:bg-slate-950">
              <iframe key={`${previewKey}:${version}`} title="App preview" src={`/app/${encodeURIComponent(app.slug)}/native?v=${version}`}
                className={cn('h-[70vh] min-h-[28rem] rounded-xl border border-slate-200 bg-white dark:border-slate-700', device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full')} />
            </div>
          </section>

          {!readOnly && <aside className="space-y-4">
            <Panel title="Change your app" icon={<Wand2 className="h-4 w-4" />}>
              <label htmlFor="softn-change" className="text-xs font-medium text-slate-600 dark:text-slate-300">Describe a change for AI Studio</label>
              <Textarea id="softn-change" rows={4} value={change} onChange={event => setChange(event.target.value)} disabled={ai.ready !== true}
                placeholder={ai.ready === false ? 'Connect an AI to describe changes.' : 'e.g. Add a page for favourites, and a search box on the list.'} className="mt-1.5 min-h-24 resize-none" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" disabled={ai.ready !== true || busy || !change.trim()} leftIcon={<Sparkles className="h-4 w-4" />}
                  onClick={() => { openEditor('studio', { prompt: change.trim(), kind: 'edit' }); setChange(''); }}>Make this change</Button>
                <Button size="sm" variant="secondary" disabled={ai.ready !== true || busy} onClick={() => openEditor('studio')}>Open AI Studio</Button>
              </div>
              {ai.ready === false && <AiNotConnected reason={ai.reason} onRecheck={() => void ai.recheck()} />}
              <div className="mt-4 border-t border-slate-100 pt-4 dark:border-white/5">
                <Button variant="secondary" className="w-full justify-start" disabled={busy} leftIcon={<PencilRuler className="h-4 w-4" />} onClick={() => openEditor('builder')}>Edit visually</Button>
                <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Drag in components and change text and styles in the Visual Builder. No AI needed.</p>
              </div>
            </Panel>
            <Panel title="Files" icon={<Code2 className="h-4 w-4" />}>
              <input ref={upload} type="file" accept=".softn,.zip" className="hidden" aria-label="Upload a new version" onChange={event => { void uploadVersion(event.target.files?.[0]); event.target.value = ''; }} />
              <div className="flex flex-col gap-2">
                <Button size="sm" variant="secondary" className="justify-start" disabled={busy} leftIcon={<Upload className="h-4 w-4" />} onClick={() => upload.current?.click()}>Upload a new version (.softn)</Button>
                <Button size="sm" variant="secondary" className="justify-start" leftIcon={<Download className="h-4 w-4" />} onClick={download}>Download as .softn</Button>
                <Button size="sm" variant="ghost" className="justify-start" leftIcon={<Code2 className="h-4 w-4" />} onClick={() => setAdvanced('backend')}>Edit the source code</Button>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">Records stay in the app&apos;s database when you upload a new version. Downloads hold the source only.</p>
            </Panel>
          </aside>}
        </div>}

        {tab === 'data' && <section aria-label="Data" className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5">
          <p className="mb-4 text-sm leading-6 text-slate-600 dark:text-slate-400">Everything your app stores, table by table. Add, edit and delete records here; your app sees the changes at once. To add a table or a column, ask AI Studio.</p>
          <NativeRecordsBrowser key={`${app.id}:${version}`} appId={app.id} version={version} readOnly={readOnly} openFirstTable />
        </section>}

        {tab === 'settings' && <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Who can use it" icon={<Users className="h-4 w-4" />}>
            <fieldset disabled={busy || readOnly} className="space-y-2">
              <legend className="sr-only">Who can use it</legend>
              {([['members', 'Only people you invite', 'Visitors sign in to FormLogic as members of this app. Invite them in Members & roles.', Lock], ['application', 'Anyone with the link', 'The app is open to everyone. If it has its own sign-in, that is what protects it.', Globe]] as const).map(([value, label, hint, Icon]) =>
                <label key={value} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3', project.access === value ? 'border-indigo-400 bg-indigo-50/60 dark:border-indigo-500/60 dark:bg-indigo-500/10' : 'border-slate-200 dark:border-slate-700')}>
                  <input type="radio" name="softn-access" className="mt-1" checked={project.access === value}
                    onChange={() => void changeSetting({ ...project, access: value }, value === 'members' ? 'Now only invited members can use it.' : 'Now anyone with the link can use it.')} />
                  <span><span className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-white"><Icon className="h-4 w-4" aria-hidden="true" />{label}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span></span>
                </label>)}
            </fieldset>
            <Link to={`/apps/${app.id}/studio/access`} className="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-indigo-600 dark:text-indigo-300">Members &amp; roles</Link>
          </Panel>
          <Panel title="Address" icon={<Globe className="h-4 w-4" />}>
            <Switch label="Open this app at its address" description={`Visitors to /app/${app.slug} get this app. Off: it opens at /app/${app.slug}/native.`}
              checked={!!project.home} disabled={busy || readOnly} onChange={checked => void changeSetting({ ...project, home: checked }, 'Address updated.')} />
            {published ? <Button className="mt-4" variant="secondary" size="sm" disabled={readOnly} onClick={() => setConfirmUnpublish(true)}>Unpublish</Button>
              : <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">Not published yet: only you can open it. Publish from the top of the page when it is ready.</p>}
          </Panel>
          {draft.engine && draft.enginePolicy && <Panel title="Engine" icon={<SettingsIcon className="h-4 w-4" />}>
            <AppEngineSelect appId={app.id} engine={draft.engine} policy={draft.enginePolicy} disabled={busy || readOnly} onChanged={() => void draft.refreshEngine()} />
          </Panel>}
          <Panel title="More tools" icon={<Code2 className="h-4 w-4" />}>
            <div className="flex flex-col items-start gap-1">
              <Button variant="ghost" size="sm" onClick={() => setAdvanced('backend')} leftIcon={<Code2 className="h-4 w-4" />}>Edit the source code</Button>
              <Button variant="ghost" size="sm" onClick={() => leave(`/apps/${app.id}/studio`)} leftIcon={<SettingsIcon className="h-4 w-4" />}>Open the App Studio (forms, automations, access)</Button>
            </div>
          </Panel>
        </div>}
      </>}
    </main>
    <ConfirmDialog isOpen={confirmUnpublish} onClose={() => setConfirmUnpublish(false)} onConfirm={() => void unpublish()}
      title="Unpublish this app?" message="Nobody but you can open it until you publish again. Its data is kept." confirmLabel="Unpublish" />
  </div>;
}

/** An app with nothing installed: the three ways to start, as on "Create app". */
function Setup({ app, aiReady, initialRequest, onInstalled }: { app: App; aiReady: boolean | null; initialRequest: string; onInstalled: (open: import('../../stores/uiStore').SoftnOpen | null) => void }) {
  const [request, setRequest] = useState(initialRequest);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const start = async (open: import('../../stores/uiStore').SoftnOpen | null) => {
    setWorking(true); setError('');
    try {
      const result = await api.installNativeStarter(app.id);
      if (result.error) { setError(result.error); return; }
      onInstalled(open);
    } finally { setWorking(false); }
  };
  const fromFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setWorking(true); setError('');
    try {
      const result = await api.saveNativeProject(app.id, await projectFromUpload(chosen), 0);
      if (result.error) { setError(result.error); return; }
      onInstalled(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not read that file.'); }
    finally { setWorking(false); }
  };
  return <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-6">
    <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Set up {app.name}</h2>
    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Your app has nothing in it yet. Choose how to start; you can change everything later.</p>
    {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    <div className="mt-4 grid gap-3 md:grid-cols-3">
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Sparkles className="h-4 w-4 text-indigo-500" />Build it with AI</p>
        <Textarea aria-label="What should the app do?" rows={3} value={request} onChange={event => setRequest(event.target.value)} disabled={aiReady !== true || working} className="mt-2 min-h-20 resize-none" placeholder="Describe the app: its pages, what it stores, how it looks." />
        <Button size="sm" className="mt-2" disabled={aiReady !== true || working || !request.trim()} isLoading={working} onClick={() => void start({ appId: app.id, editor: 'studio', brief: { prompt: request.trim(), kind: 'build' } })}>Build it</Button>
        {aiReady === false && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Needs an AI connection (Settings → AI).</p>}
      </div>
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><PencilRuler className="h-4 w-4 text-indigo-500" />Start from a working app</p>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">A small app with a page, a backend and a database table, opened in the Visual Builder.</p>
        <Button size="sm" variant="secondary" className="mt-3" disabled={working} onClick={() => void start({ appId: app.id, editor: 'builder' })}>Start building</Button>
      </div>
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Upload className="h-4 w-4 text-indigo-500" />Upload a .softn file</p>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">A SoftN app you already have, with its interface and backend.</p>
        <input ref={file} type="file" accept=".softn,.zip" className="hidden" aria-label="Upload a .softn file" onChange={event => { void fromFile(event.target.files?.[0]); event.target.value = ''; }} />
        <Button size="sm" variant="secondary" className="mt-3" disabled={working} onClick={() => file.current?.click()}>Choose a file</Button>
      </div>
    </div>
  </section>;
}

function Messages({ draft }: { draft: ReturnType<typeof useNativeProjectDraft> }) {
  const { ready, readOnly, available, preflight, error, notice, conflict, base, version, recoverable, busy } = draft;
  return <div className="mt-4 space-y-3 empty:hidden">
    {readOnly && <p role="note" className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300">This is the shared demo, so this app is read-only.</p>}
    {ready && !readOnly && !available && !preflight && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">This server needs the app runtime installed before it can run SoftN apps. Ask your administrator.</p>}
    {ready && !readOnly && preflight && !preflight.ok && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">The app runtime is installed but cannot start on this server yet.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.checks.filter(check => !check.ok).map(check => <li key={check.id}>{check.message}</li>)}</ul>
    </div>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
    {conflict && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">These changes started from version {base}; version {version} was published since. Publishing replaces version {version}.</p>}
    {draft.dirty && !busy && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-100">
      <span className="min-w-0 flex-1">You have changes that are not live yet.</span>
      <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Discard your unpublished changes?')) draft.revert(); }}>Discard</Button>
    </div>}
    {recoverable && <div role="region" aria-label="Unpublished draft" className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 text-sm dark:border-indigo-500/40 dark:bg-indigo-950/20">
      <p className="font-medium text-slate-900 dark:text-white">Unpublished changes from {new Date(recoverable.savedAt).toLocaleString()} are kept in this browser.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => draft.recoverDraft()}>Recover them</Button><Button size="sm" variant="secondary" disabled={busy} onClick={draft.discardDraft}>Discard them</Button></div>
    </div>}
  </div>;
}

function AiNotConnected({ reason, onRecheck }: { reason: string | null; onRecheck: () => void }) {
  return <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
    AI Studio needs an AI connection{reason ? ` (${reason})` : ''}. <Link className="font-medium text-indigo-600 dark:text-indigo-300" to="/settings#ai">Connect one</Link>, then <button type="button" className="font-medium text-indigo-600 dark:text-indigo-300" onClick={onRecheck}>check again</button>.
  </p>;
}

function StatusPill({ live }: { live: boolean }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', live ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')}>
    <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />{live ? 'Live' : 'Not published'}
  </span>;
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
    <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><span className="text-indigo-500" aria-hidden="true">{icon}</span>{title}</h2>
    {children}
  </section>;
}

function IconButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick}
    className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/5', active && 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white')}>{children}</button>;
}

export default SoftnAppWorkspace;
