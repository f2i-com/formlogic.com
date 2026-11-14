// The SoftN app's page (/apps/:appId/softn): where the owner of a hosted SoftN app manages it.
// Its sections, each at its own address so a link or the back button lands where it was:
//   (the page itself)  Overview: what the app is doing, at a glance; nothing is started
//   …/data[/<table>[/<view>]]  its database, table by table (components/data)
//   …/api              its backend's routes, trying one, and the calls it has had lately
//   …/members          who can use it, and what each of them is
//   …/edit             the app running, AI Studio, the Visual Builder and its files
//   …/automations      the flows that run when its records change
//   …/history[/<n>]    every version a later one replaced, what differs, and going back to one
//   …/domains          its address and its own domains
//   …/settings         who can use it, what it may do, how it looks
// One page for everything a SoftN app's owner does: the App Studio is for forms apps, and an
// address of it that names a SoftN app comes here (lib/softnApps: softnPathForStudio).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Braces, Check, Code2, Copy, Database, Download, ExternalLink, FolderOpen, Globe, History as HistoryIcon, LayoutDashboard, Lock, MessageSquare, Palette, Monitor, PencilRuler, RefreshCw, Rocket, Settings as SettingsIcon, Smartphone, Sparkles, Upload, Users, Wallet, Wand2, Workflow } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Textarea';
import { Switch } from '../../components/ui/Switch';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SectionNav } from '../../components/ui/SectionNav';
import { Panel, PANEL_COLUMNS } from '../../components/ui/Panel';
import { PAGE_GUTTER } from '../../components/layout/PageBody';
import { CustomDomainsPanel } from '../../components/apps/CustomDomainsPanel';
import { SoftnLookPanel } from '../../components/apps/SoftnLookPanel';
import { PhoneSignInPanel } from '../../components/apps/PhoneSignInPanel';
import { AppAiPanel } from '../../components/apps/AppAiPanel';
import { AppAiPrompt } from '../../components/apps/AppAiPrompt';
import { AppTile } from '../../components/apps/AppTile';
import { SoftnMembers } from '../../components/apps/SoftnMembers';
import { SoftnAutomations } from '../../components/apps/SoftnAutomations';
import { SoftnHistory } from '../../components/apps/SoftnHistory';
import { SoftnApi } from '../../components/apps/SoftnApi';
import { AppPaymentsPanel } from '../../components/apps/AppPaymentsPanel';
import { BringDataPanel } from '../../components/apps/BringDataPanel';
import { AddBackendPanel } from '../../components/apps/AddBackendPanel';
import { RequirementsSetting } from '../../components/apps/RequirementsSetting';
import { AppEditorDialog, type AppEditorKind } from '../../components/studio/AppEditorDialog';
import type { EditorBrief } from '../../components/studio/editorAgent';
import { AppEngineSelect } from '../../components/studio/AppEngineSelect';
import { AppTorchSwitch } from '../../components/studio/AppTorchSwitch';
import { NativeEditor } from '../../components/studio/NativeAppPanel';
import { NativeAppView } from '../../components/studio/NativeAppView';
import type { SiteProblem } from '../../components/studio/SiteAppFrame';
import { importSiteBuild, siteBuildWarnings, siteOf, siteOutsideOf, withNewBuild, withOutsideSites } from '../../lib/siteApps';
import { SiteOutsidePanel } from '../../components/apps/SiteOutsidePanel';
import { DataManager, type DataView } from '../../components/data';
import { SoftnOverview } from '../../components/apps/SoftnOverview';
import { DRAFT_KEEPING, useNativeProjectDraft } from '../../components/studio/useNativeProjectDraft';
import { useAiReady } from '../../hooks/useAiReady';
import { AiConnectNotice } from '../../components/ai/AiConnectNotice';
import { api } from '../../lib/api';
import { apiOf } from '../../lib/appApi';
import { declaresFormlogicAi, declaresFormlogicPayments, exportNativeProject, importNativeProject, type NativeProject, type NativeProjectBytes } from '../../lib/nativeHosting';
import { withMediaBytes } from '../../lib/nativeMedia';
import { isSoftnApp, projectFromUpload, projectHasBackend, SOFTN_SECTIONS, softnWorkspacePath, type SoftnSection } from '../../lib/softnApps';
import { cn, copyToClipboard } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { useUIStore, type SoftnOpen } from '../../stores/uiStore';
import type { App, AppRequirement, SoftnLook } from '../../types/app';

const SECTIONS: readonly (readonly [SoftnSection, string, typeof Globe])[] = [
  ['overview', 'Overview', LayoutDashboard], ['data', 'Data', Database], ['api', 'API', Braces], ['members', 'Members', Users], ['edit', 'Edit', PencilRuler],
  ['automations', 'Automations', Workflow], ['history', 'History', HistoryIcon], ['domains', 'Domains', Globe], ['settings', 'Settings', SettingsIcon],
];
const DATA_VIEWS: readonly DataView[] = ['browse', 'structure', 'export', 'import'];
/** The parts of the address after /softn/, decoded; a part that is not valid text is dropped. */
const addressParts = (rest: string) => rest.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
type Opened = { kind: AppEditorKind; bundle: Uint8Array; brief?: EditorBrief };

export function SoftnAppWorkspace() {
  const { appId = '' } = useParams();
  const navigate = useNavigate();
  const app = useAppStore(s => s.apps.find(candidate => candidate.id === appId));
  const fetchApps = useAppStore(s => s.fetchApps);
  // Which app was looked for on the server: moving to another app's workspace looks again.
  const [lookedFor, setLookedFor] = useState<string | null>(null);
  const looked = lookedFor === appId;
  useEffect(() => {
    if (app || looked) return;
    void fetchApps().finally(() => setLookedFor(appId));
  }, [app, looked, appId, fetchApps]);
  if (!app) {
    return <div className="min-h-screen">
      <Header title="SoftN app" back={{ onClick: () => navigate('/apps'), label: 'Back to apps' }} />
      <div className="px-4 py-10 text-sm text-slate-600 dark:text-slate-400 sm:px-6">
        {looked ? <p role="alert">This app was not found, or it is not yours to manage.</p> : <p role="status">Loading your app…</p>}
      </div>
    </div>;
  }
  // A forms app is managed in its App Studio; this page would install a SoftN starter over it.
  if (!isSoftnApp(app)) return <Navigate to={`/apps/${app.id}/studio`} replace />;
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
  // A JavaScript app's owner is shown what the browser stopped the app from doing while it ran
  // here, and errors in it (SiteAppFrame): the few first, each once, until the app is loaded again.
  const [siteProblems, setSiteProblems] = useState<SiteProblem[]>([]);
  const onSiteProblem = useCallback((problem: SiteProblem) => {
    setSiteProblems(list => list.length >= 8 || list.some(seen => seen.kind === problem.kind && seen.text === problem.text) ? list : [...list, problem]);
  }, []);
  const reloadPreview = () => { setSiteProblems([]); setPreviewKey(key => key + 1); };
  const draft = useNativeProjectDraft(app, { reloadKey, onInstalled: reloadPreview });
  const { project, version, ready, readOnly, busy, dirty } = draft;
  const ai = useAiReady({ withRecheck: true });
  // The section, and what is open inside it, come from the address: /softn/data/<table>/<view>.
  const location = useLocation();
  const parts = addressParts(useParams()['*'] ?? '');
  const known = (SOFTN_SECTIONS as readonly string[]).includes(parts[0] ?? 'overview');
  const section: SoftnSection = known ? (parts[0] ?? 'overview') as SoftnSection : 'overview';
  const dataTable = section === 'data' ? parts[1] : undefined;
  const dataView: DataView = section === 'data' && (DATA_VIEWS as readonly string[]).includes(parts[2] ?? '') ? parts[2] as DataView : 'browse';
  // The version History has open (…/history/7), and the file open in it (?file=ui/main.ui).
  const historyOpen = section === 'history' && /^[1-9]\d{0,8}$/.test(parts[1] ?? '') ? Number(parts[1]) : undefined;
  const historyFile = section === 'history' ? new URLSearchParams(location.search).get('file') ?? undefined : undefined;
  const hasProject = !!project;
  // The page stays mounted from one section to the next, so a section is opened from its top, as
  // a page is. A link into a section may name one of its panels (…/settings#settings-look): that
  // is brought into view instead, once the section has drawn it.
  const sectionShown = useRef(section);
  useEffect(() => {
    const moved = sectionShown.current !== section;
    sectionShown.current = section;
    if (!location.hash) {
      if (moved) document.documentElement.scrollTop = 0;
      return;
    }
    if (!hasProject) return;
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }), 60);
    return () => window.clearTimeout(timer);
  }, [location.hash, section, hasProject]);
  const [editor, setEditor] = useState<Opened | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [change, setChange] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [copied, setCopied] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const buildUpload = useRef<HTMLInputElement>(null);
  // A JavaScript app: its pages are someone's built site, not SoftN source. Its page offers a
  // new build to upload where a SoftN app's offers its editors, and says how the build is hosted.
  const isSite = !!project && siteOf(project) !== null;
  // What was left out of the build last uploaded and what in it will not work everywhere
  // (importSiteBuild, siteBuildWarnings): from the create form on arriving, then from an upload here.
  const [buildNotes, setBuildNotes] = useState<string[]>(() => {
    const from = (location.state as { siteWarnings?: unknown } | null)?.siteWarnings;
    return Array.isArray(from) ? from.filter((note): note is string => typeof note === 'string') : [];
  });
  const published = app.status === 'published';
  const userId = useAuthStore(s => s.user?.id);
  const isOwner = app.ownerId === userId;
  // How many forms the app also holds. Almost none do; one that does keeps its App Studio for
  // them (pages/apps/AppStudio), and Settings then says where that is. Asked once Settings is open.
  const [heldForms, setHeldForms] = useState(0);
  useEffect(() => {
    if (section !== 'settings' || !isOwner) return;
    let current = true;
    void api.getAppForms(app.id).then(result => { if (current && !result.error) setHeldForms(result.data?.forms?.length ?? 0); });
    return () => { current = false; };
  }, [app.id, section, isOwner]);
  // Who can use the app is its owner's to decide, and not while the page only shows it (readOnly).
  const managesMembers = isOwner && !readOnly;
  const liveUrl = `${window.location.origin}/app/${encodeURIComponent(app.slug)}${project?.home ? '' : '/native'}`;
  // An app without a backend of its own runs in the browser alone: it has no database here.
  const backend = project ? projectHasBackend(project) : true;

  // The live app's backend (its installed manifest.json), which answers calls whatever the draft holds: the API
  // section is there while the live app or the draft has one, and shows the live app's.
  const liveBackend = useMemo(() => apiOf(draft.installedFiles?.['manifest.json']) !== null, [draft.installedFiles]);

  // The page holds the app's media by name (lib/nativeMedia): an editor and a download are given
  // their bytes first, read from the server once. Nothing else starts on them while they are read.
  const [preparing, setPreparing] = useState<'editor' | 'download' | null>(null);
  const preparingNow = useRef(false);
  // The project as it is now, and whether the page is still here: read once the media have come.
  const projectNow = useRef(project);
  useLayoutEffect(() => { projectNow.current = project; }, [project]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const withBytes = async <T,>(what: 'editor' | 'download', from: NativeProject, then: (project: NativeProjectBytes) => T, failed: string): Promise<T | null> => {
    if (preparingNow.current) return null;
    preparingNow.current = true; setPreparing(what);
    try {
      const bytes = await withMediaBytes(app.id, from);
      if (!mounted.current) return null;
      // An editor opened on the project as it was, once it changed meanwhile (an upload, a setting), would put those changes back on Apply.
      if (what === 'editor' && projectNow.current !== from) { draft.setNotice('The app changed while it was being opened for the editor. Open the editor again.'); return null; }
      return then(bytes);
    }
    catch (reason) { if (mounted.current) draft.setError(reason instanceof Error && reason.message ? reason.message : failed); return null; }
    finally { preparingNow.current = false; if (mounted.current) setPreparing(null); }
  };
  /** Opens the editor once the app's media are read; true when it opened. */
  const prepareEditor = (kind: AppEditorKind, from: NativeProject, brief?: EditorBrief) =>
    withBytes('editor', from, bytes => { setEditor({ kind, bundle: exportNativeProject(bytes), brief }); return true; }, 'Could not prepare this app for the editor.');
  const openEditor = (kind: AppEditorKind, brief?: EditorBrief, from: NativeProject | null = project): Promise<boolean | null> | undefined => {
    if (!from) return;
    if (kind === 'studio' && ai.ready !== true) { toast.info('Connect an AI first', 'AI Studio uses your AI connection. Choose one in Settings → AI, or edit visually instead.'); return; }
    return prepareEditor(kind, from, brief);
  };

  // Arriving from "Create app" or from the chat: open the editor it asked for, once. The
  // setup choices come first for an app with nothing installed; the request waits for them.
  // The editor opens once the app's media are read (prepareEditor), so the request is taken here.
  const taken = useRef<SoftnOpen | null>(null);
  const seed = softnOpen && softnOpen.appId === app.id && ready && project && !editor ? softnOpen : null;
  useEffect(() => {
    if (!seed || seed === taken.current || !project) return;
    taken.current = seed;
    setSoftnOpen(null);
    void prepareEditor(seed.editor, project, seed.brief);
    // Once for each request; prepareEditor is the page's own and reads what it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, project, setSoftnOpen]);

  // The editor's changes. While the app is not published nobody else can see it, so they are
  // installed at once and the preview shows them; a published app keeps them as a draft to publish.
  const applyEditorChanges = async (bytes: Uint8Array) => {
    if (!project) return;
    const returned = await importNativeProject(new File([new Uint8Array(bytes)], `${app.slug}.softn`));
    const next: NativeProject = { ...returned, version, home: project.home, access: project.access };
    draft.edit(next);
    if (!published) {
      // A change that did not install is refused to the editor, which stays open and says why.
      await draft.save({ project: next, confirmConflict: false, notice: 'Saved. The preview shows your changes.', raise: true });
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

  // What the app requires is the app's setting, not the project's: it applies at once, published or
  // not. Merged onto a fresh read, because the server writes settings whole.
  const [gateBusy, setGateBusy] = useState(false);
  const changeRequirements = async (next: AppRequirement[] | undefined) => {
    setGateBusy(true);
    try {
      await fetchApps();
      const settings = { ...(useAppStore.getState().apps.find(candidate => candidate.id === app.id)?.settings ?? app.settings) };
      if (next) settings.requires = next; else delete settings.requires;
      if (await updateApp(app.id, { settings })) {
        toast.success(next ? 'Saved' : 'Nothing is asked before it opens', next ? 'Members are asked before it opens.' : undefined);
      }
    } finally { setGateBusy(false); }
  };

  // Whether the app may use files on the person's device, the owner's choice like what it requires.
  const [filesBusy, setFilesBusy] = useState(false);
  const changeFiles = async (next: 'ask' | 'allow' | undefined) => {
    setFilesBusy(true);
    try {
      await fetchApps();
      const settings = { ...(useAppStore.getState().apps.find(candidate => candidate.id === app.id)?.settings ?? app.settings) };
      if (next) settings.softnFiles = next; else delete settings.softnFiles;
      if (await updateApp(app.id, { settings })) {
        toast.success('Saved', next === 'ask' ? 'Each person is asked before the app opens.' : next === 'allow' ? 'The app may use files without asking.' : 'The app cannot open or save files.');
      }
    } finally { setFilesBusy(false); }
  };

  // The app's look and sharing (AppLookService), with the browser bar colour, merged as the rest is.
  const changeLook = async (look: SoftnLook, themeColor: string | undefined) => {
    await fetchApps();
    const settings = { ...(useAppStore.getState().apps.find(candidate => candidate.id === app.id)?.settings ?? app.settings) };
    if (Object.keys(look).length) settings.softnLook = look; else delete settings.softnLook;
    if (themeColor) settings.pwaThemeColor = themeColor; else delete settings.pwaThemeColor;
    if (await updateApp(app.id, { settings })) toast.success('Saved', 'The app’s look is updated where it is opened, installed and shared.');
  };

  const changeSetting = async (next: NativeProject, notice: string) => {
    if (dirty) { draft.edit(next); draft.setNotice('Changed in your draft. Publish to apply it.'); return; }
    draft.edit(next);
    await draft.save({ project: next, confirmConflict: false, notice });
  };

  // An API backend added to an app with none (AddBackendPanel): installed at once while the app is
  // a draft, kept in the draft for the owner to publish once it is live, as an uploaded version is.
  // Installed from `next` without editing the draft first: the draft having a backend is what
  // swaps the panel for the records, so a refused install would take the panel, and the reason
  // it shows, away with it.
  const addBackend = async (next: NativeProject, from: 'starter' | 'file') => {
    const said = from === 'starter'
      ? 'Backend added: an items table, and GET and POST /api/items. Change it in the source code, or ask AI Studio.'
      : 'Its backend is added: this page as it was, with the routes and database of the file you chose.';
    if (published) { draft.edit(next); draft.setNotice(`${said} Publish to make it live.`); return; }
    await draft.save({ project: next, confirmConflict: false, notice: said, raise: true });
  };

  const uploadVersion = async (file: File | undefined) => {
    const imported = await draft.importFile(file, published ? 'Uploaded as a draft. Publish it to update the live app.' : 'Uploaded.');
    if (imported && !published) await draft.save({ project: imported, confirmConflict: false, notice: 'Uploaded. The preview shows the new version.' });
  };

  // A new build of a JavaScript app, from the .zip of its build folder: in place of the old one,
  // with the app's backend and settings kept (withNewBuild). Installed at once while the app is a
  // draft, kept as a draft to publish once it is live, as an uploaded SoftN version is.
  const uploadBuild = async (file: File | undefined) => {
    if (!file || !project) return;
    const notes: string[] = [];
    let next: NativeProject;
    try { next = withNewBuild(project, await importSiteBuild(file, app.name, notes)); }
    catch (reason) { draft.setError(reason instanceof Error && reason.message ? reason.message : 'The build could not be read.'); return; }
    draft.setError('');
    setBuildNotes([...notes, ...siteBuildWarnings(next)]);
    draft.edit(next, 'upload');
    if (published) { draft.setNotice('Uploaded as a draft. Publish it to update the live app.'); return; }
    await draft.save({ project: next, confirmConflict: false, notice: 'Uploaded. The preview shows the new build.' });
  };

  const download = () => {
    if (!project) return;
    void withBytes('download', project, bytes => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(exportNativeProject(bytes))], { type: 'application/octet-stream' }));
      // A JavaScript app's download is the zip its upload takes back; a SoftN app's is a .softn file.
      const link = document.createElement('a'); link.href = url; link.download = `${app.slug}.${isSite ? 'zip' : 'softn'}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'The download could not be prepared.');
  };

  const copyLink = async () => {
    if (await copyToClipboard(liveUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed', 'Select the link and copy it manually.');
    }
  };

  const leave = (to: string) => { if (!dirty || window.confirm(draft.leaveMessage('Leave without publishing?'))) navigate(to); };

  // "This app can use AI. Set it up": the Settings section, at its AI panel.
  const openAiSettings = () => navigate(`${softnWorkspacePath(app.id, 'settings')}#app-ai-settings`);

  // An address that names no section of this page (an old link, a typing slip): the overview.
  if (!known) return <Navigate to={softnWorkspacePath(app.id)} replace />;

  if (editor) {
    return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} brief={editor.brief}
      applyLabel={published ? 'Keep changes' : 'Save changes'}
      // Back from an editor, the page shows the app running, with what was changed: its Edit section.
      onClose={() => { setEditor(null); if (section !== 'edit') navigate(softnWorkspacePath(app.id, 'edit'), { replace: true }); }} onApply={applyEditorChanges} />;
  }
  if (advanced) {
    // The app's files and nothing else: everything else the hosting dialog held is on this page.
    return <NativeEditor app={app} surface="source" saveLabel={published ? 'Publish changes' : 'Save changes'}
      onClose={() => { setAdvanced(false); setReloadKey(key => key + 1); setPreviewKey(key => key + 1); }} />;
  }

  const actions = project && !readOnly ? <div className="flex items-center gap-2">
    <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="hidden min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5 sm:inline-flex"><ExternalLink className="h-4 w-4" />Open</a>
    {/* Its words show where the header has room for them, as every page's header actions do
        (Header's @container): on a phone they took the room the app's name needs, and the name
        was cut to its first letter. The button says what it is to a screen reader either way. */}
    {(!published || dirty) && <Button size="sm" onClick={() => void publish()} isLoading={publishing || busy} disabled={!ready}
      aria-label={published ? 'Publish changes' : 'Publish'} title={published ? 'Publish changes' : 'Publish'}>
      <Rocket className="h-4 w-4" aria-hidden="true" /><span className="ml-2 hidden @md/header:inline">{published ? 'Publish changes' : 'Publish'}</span>
    </Button>}
  </div> : undefined;

  // The app's state in a line: live or a draft, its version, and its link to copy.
  const statusLine = <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <StatusPill live={published} />
    {project && <span className="text-xs text-slate-500 dark:text-slate-400">Version {version}{dirty ? ` · unpublished changes${draft.keeping ? ` (${DRAFT_KEEPING[draft.keeping][0]})` : ''}` : ''}</span>}
    {published && project && <button type="button" onClick={copyLink} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary-600 hover:bg-primary-50 max-sm:min-h-11 dark:text-primary-300 dark:hover:bg-primary-500/10">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Link copied' : liveUrl.replace(/^https?:\/\//, '')}</button>}
  </div>;

  return <div className="min-h-screen">
    <Header title={app.name} mark={<AppTile app={app} size="sm" className="h-7 w-7 rounded-md" />} back={{ onClick: () => leave('/apps'), label: 'Back to apps' }} actions={actions} />
    {/* Every section starts at the left and takes the page's whole width: its panels flow into
        more columns as the screen widens, and stack on a phone.
        On a wide screen the data section is the rest of the window below the page's header: the
        page does not scroll, the table list and the rows scroll inside it, and the pager stays in
        view. Narrower, it flows with the page as the other sections do. */}
    <div className={cn('w-full pb-24 pt-3', PAGE_GUTTER, section === 'data' &&'lg:flex lg:h-[calc(100dvh-4rem-var(--fl-demo-banner-h,0px))] lg:flex-col lg:pb-3')}>
      {/* An app with nothing installed has no sections yet: its state stands alone. */}
      {!project && statusLine}

      <Messages draft={draft} />

      {!ready && !draft.error && <p role="status" className="mt-8 text-sm text-slate-500">Loading your app…</p>}
      {ready && !project && !readOnly && <Setup app={app} aiReady={ai.ready} aiReason={ai.reason} onAiRecheck={ai.recheck} initialRequest={softnOpen?.appId === app.id ? softnOpen.brief?.prompt ?? '' : ''}
        onInstalled={open => { setSoftnOpen(open); setReloadKey(key => key + 1); }} />}
      {ready && !project && readOnly && <p className="mt-8 text-sm text-slate-500">This app has nothing installed yet.</p>}

      {project && <>
        {/* An app that can use AI, with its AI off: one line for its owner, never for anyone else. */}
        {app.ownerId === userId && backend && !readOnly && section !== 'settings' && declaresFormlogicAi(project) && <AppAiPrompt appId={app.id} onSetUp={openAiSettings} />}
        {/* One row for the page's sections and its state, so the section itself starts higher.
            Links, not tabs: each section is an address, so it opens in a new tab and the back button returns to it. */}
        <SectionNav label="App sections" className="mt-2" current={section}
          // Members are the owner's to manage: nobody else is shown the section. Automations start
          // from the app's own tables, so they are the owner's too, of an app that has a backend.
          // The app's earlier versions are its source: the owner's alone to see and to go back to.
          // Its API is its backend's, and the owner's alone: an app with none has no API.
          items={SECTIONS.filter(([value]) => (value !== 'members' || managesMembers) && (value !== 'automations' || (managesMembers && backend)) && (value !== 'history' || isOwner) && (value !== 'api' || (isOwner && (backend || liveBackend))))
            .map(([value, label, icon]) => ({ value, label, icon, to: softnWorkspacePath(app.id, value) }))}
          // On a phone the Data section keeps the screen for the rows: the status is on every other section.
          end={<div className={cn('py-0.5', section === 'data' && 'max-sm:hidden')}>{statusLine}</div>} />

        {section === 'overview' && <SoftnOverview app={app} project={project} version={version} published={published} dirty={dirty} readOnly={readOnly} backend={backend}
          isOwner={app.ownerId === userId} liveUrl={liveUrl} busy={publishing || busy} onPublish={() => void publish()} />}

        {section === 'members' && (managesMembers
          ? <SoftnMembers app={app} project={project} onReloadApp={fetchApps} />
          : <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Only the app&rsquo;s owner manages who can use it.</p>)}

        {section === 'automations' && (!managesMembers
          ? <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Only the app&rsquo;s owner manages its automations.</p>
          : backend
            ? <SoftnAutomations key={app.id} app={app} />
            : <p className="mt-6 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-white">This app has no database on the server yet.</span> Automations run when a record in the app&rsquo;s own database changes, so they start once it has a backend.{' '}
              <Link to={softnWorkspacePath(app.id, 'data')} className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">Add a backend</Link>
            </p>)}

        {/* Every version a later one replaced, for SoftN and JavaScript apps alike. Going back makes a
            new version, as a publish does: the page reads its project again, and the preview under
            Edit shows the app as it now is. */}
        {section === 'history' && (isOwner
          ? <SoftnHistory key={app.id} app={app} version={version} open={historyOpen} file={historyFile} backend={backend} readOnly={readOnly}
            waiting={dirty ? 'Publish or discard your unpublished changes first: going back makes a new version.' : busy ? 'The app is being saved. Try again in a moment.' : null}
            onRestored={() => { setReloadKey(key => key + 1); reloadPreview(); }} />
          : <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Only the app&rsquo;s owner sees its earlier versions and goes back to one.</p>)}

        {/* The app's API, for SoftN and JavaScript apps alike: the routes of the app as it is live
            (the installed version's manifest, not an unpublished draft), trying one as its owner,
            and the calls it has had lately. */}
        {section === 'api' && (!isOwner
          ? <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Only the app&rsquo;s owner sees its API and the calls it has had.</p>
          : backend || liveBackend
            ? <SoftnApi key={app.id} app={app} access={project.access} manifest={draft.installedFiles?.['manifest.json']} version={version} dirty={dirty} readOnly={readOnly} />
            : <p className="mt-6 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-white">This app has no backend, so it has no API.</span> What its pages save stays in each visitor&rsquo;s browser.{' '}
              <Link to={softnWorkspacePath(app.id, 'data')} className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">Add a backend</Link>
            </p>)}

        {/* Each column is as tall as what it holds: the preview's card does not stretch to the tools beside it. */}
        {section === 'edit' && <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-label="Preview" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
              <span className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{published ? 'Live app' : 'Preview — only you can see it until you publish'}</span>
              <div className="flex items-center gap-1">
                {/* On a phone the frame is a phone's width whichever is chosen, so the choice is not offered there. */}
                <span className="hidden items-center gap-1 sm:flex">
                  <IconButton label="Desktop width" active={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor className="h-4 w-4" /></IconButton>
                  <IconButton label="Phone width" active={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone className="h-4 w-4" /></IconButton>
                </span>
                <IconButton label="Reload preview" onClick={reloadPreview}><RefreshCw className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <div className="flex justify-center bg-slate-50 p-3 dark:bg-slate-950">
              {/* The app itself, in place: its frame is as wide as the device chosen, so its page
                  lays out for that width. Not the app's own page in a frame of ours — a FormLogic
                  page may not be framed, and the browser refuses it on a real server.
                  On a phone it is shorter, so the ways to change the app under it are a short scroll away. */}
              <div key={`${previewKey}:${version}`} data-testid="softn-app-preview"
                className={cn('h-[70vh] min-h-[28rem] overflow-hidden rounded-xl max-sm:h-[55vh] max-sm:min-h-[20rem]', device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full')}>
                <NativeAppView slug={app.slug} onSiteProblem={isSite ? onSiteProblem : undefined} />
              </div>
            </div>
            {/* For a JavaScript app's owner: what was left out of the build, what in it will not
                work everywhere, and what the browser stopped it from doing while it ran above. */}
            {isSite && !readOnly && (buildNotes.length > 0 || siteProblems.length > 0) && <div role="status" className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-700">
              {buildNotes.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">About the build you uploaded</p>
                  <button type="button" onClick={() => setBuildNotes([])} className="-my-1 inline-flex min-h-8 shrink-0 items-center rounded-md px-2 font-medium underline-offset-2 hover:underline max-sm:min-h-11">Dismiss</button>
                </div>
                <ul className="mt-1 list-disc space-y-1 pl-4">{buildNotes.map(note => <li key={note}>{note}</li>)}</ul>
              </div>}
              {siteProblems.length > 0 && <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
                <p className="font-semibold text-slate-900 dark:text-white">While the app ran here</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">{siteProblems.map(problem => <li key={`${problem.kind}:${problem.text}`} className="break-words">{problem.text}</li>)}</ul>
              </div>}
            </div>}
          </section>

          {!readOnly && isSite && <aside className="space-y-4">
            <Panel title="Update your app" icon={<Upload className="h-4 w-4" />}>
              <input ref={buildUpload} type="file" accept=".zip,application/zip" className="hidden" aria-label="Upload a new build" onChange={event => { void uploadBuild(event.target.files?.[0]); event.target.value = ''; }} />
              <Button className="w-full justify-start" disabled={busy || !!preparing} leftIcon={<Upload className="h-4 w-4" />} onClick={() => buildUpload.current?.click()}>Upload a new build (.zip)</Button>
              <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Build your app, zip the folder the build made (dist or build) and upload it. {backend ? 'Its backend and its records stay as they are.' : 'What visitors saved in their browsers stays.'}</p>
              <div className="mt-4 border-t border-slate-100 pt-4 dark:border-white/5">
                <Button variant="secondary" className="w-full justify-start" leftIcon={<Code2 className="h-4 w-4" />} onClick={() => setAdvanced(true)}>{backend ? 'Edit the backend code' : 'Edit the app’s manifest'}</Button>
                <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{backend
                  ? 'The app’s API routes, server code and database changes in a code editor.'
                  : <>The file that names the app and its first page. This app has no backend yet. <Link to={softnWorkspacePath(app.id, 'data')} className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">Add a backend</Link></>}</p>
              </div>
            </Panel>
            <Panel title="Files" icon={<FolderOpen className="h-4 w-4" />}>
              <Button size="sm" variant="secondary" className="w-full justify-start max-sm:min-h-11" disabled={!!preparing} isLoading={preparing === 'download'} leftIcon={<Download className="h-4 w-4" />} onClick={download}>Download as .zip</Button>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">The build as it is hosted{backend ? ', with its backend code' : ''}. Upload it again here or as a new app. Records are not in it.</p>
            </Panel>
            <Panel title="How it is hosted" icon={<Lock className="h-4 w-4" />}>
              <ul className="list-disc space-y-1.5 pl-4 text-xs leading-5 text-slate-600 dark:text-slate-300">
                <li>It runs in a sandbox of its own: it cannot read FormLogic, your account or another app.</li>
                <li><code className="rounded bg-slate-100 px-1 dark:bg-white/10">fetch(&apos;/api/…&apos;)</code> reaches this app&rsquo;s own backend, as whoever is using the app.</li>
                <li><code className="rounded bg-slate-100 px-1 dark:bg-white/10">localStorage</code> works and is kept for each visitor in their browser.</li>
                <li>Other sites (an outside API, a font service, a script from a CDN) are reachable only when you name them: <Link to={{ pathname: softnWorkspacePath(app.id, 'settings'), hash: '#settings-outside' }} className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">Settings, Outside sites</Link>.</li>
              </ul>
            </Panel>
          </aside>}

          {!readOnly && !isSite && <aside className="space-y-4">
            <Panel title="Change your app" icon={<Wand2 className="h-4 w-4" />}>
              <label htmlFor="softn-change" className="text-xs font-medium text-slate-600 dark:text-slate-300">Describe a change for AI Studio</label>
              <Textarea id="softn-change" rows={4} value={change} onChange={event => setChange(event.target.value)} disabled={ai.ready !== true}
                placeholder={ai.ready === false ? 'Connect an AI to describe changes.' : 'e.g. Add a page for favourites, and a search box on the list.'} className="mt-1.5 min-h-24 resize-none" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" disabled={ai.ready !== true || busy || !!preparing || !change.trim()} leftIcon={<Sparkles className="h-4 w-4" />}
                  onClick={() => {
                    // What was typed stays until AI Studio has it: a failed opening keeps it to try again.
                    const asked = change.trim();
                    void openEditor('studio', { prompt: asked, kind: 'edit' })?.then(opened => { if (opened) setChange(current => current.trim() === asked ? '' : current); });
                  }}>Make this change</Button>
                <Button size="sm" variant="secondary" disabled={ai.ready !== true || busy || !!preparing} onClick={() => openEditor('studio')}>Open AI Studio</Button>
              </div>
              {ai.ready === false && <AiConnectNotice lead="AI Studio needs an AI connection" reason={ai.reason} onConnected={ai.recheck} />}
              {/* The two ways that need no AI, as equals: by hand on the page, or in the files. The code
                  editor used to sit third under "Files", as a quiet link below Upload and Download. */}
              <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-white/5">
                <div>
                  <Button variant="secondary" className="w-full justify-start" disabled={busy || !!preparing} leftIcon={<PencilRuler className="h-4 w-4" />} onClick={() => openEditor('builder')}>Edit visually</Button>
                  <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Drag in components and change text and styles in the Visual Builder. No AI needed.</p>
                </div>
                <div>
                  <Button variant="secondary" className="w-full justify-start" leftIcon={<Code2 className="h-4 w-4" />} onClick={() => setAdvanced(true)}>Edit the source code</Button>
                  <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">Every file of the app in a code editor: its pages, logic, styles{backend ? ', backend and database changes' : ''}.</p>
                </div>
              </div>
            </Panel>
            <Panel title="Files" icon={<FolderOpen className="h-4 w-4" />}>
              <input ref={upload} type="file" accept=".softn,.zip" className="hidden" aria-label="Upload a new version" onChange={event => { void uploadVersion(event.target.files?.[0]); event.target.value = ''; }} />
              <div className="flex flex-col gap-2">
                <Button size="sm" variant="secondary" className="justify-start max-sm:min-h-11" disabled={busy || !!preparing} leftIcon={<Upload className="h-4 w-4" />} onClick={() => upload.current?.click()}>Upload a new version (.softn)</Button>
                <Button size="sm" variant="secondary" className="justify-start max-sm:min-h-11" disabled={!!preparing} isLoading={preparing === 'download'} leftIcon={<Download className="h-4 w-4" />} onClick={download}>Download as .softn</Button>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{backend
                ? <>Records stay in the app&apos;s database when you upload a new version. Downloads hold the source only.</>
                : <>This app has no backend: what it saves stays in each visitor&apos;s browser. Downloads hold the source only. <Link to={softnWorkspacePath(app.id, 'data')} className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300">Add a backend</Link></>}</p>
            </Panel>
          </aside>}
        </div>}

        {section === 'data' && (backend
          ? <section aria-label="Data" className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900 lg:min-h-0 lg:flex-1">
            {/* The table, its view and what is being looked at in it (search, filters, sort, page, the
                open row) are the address: Back, a reload and a copied link return to the same thing. */}
            <DataManager key={app.id} appId={app.id} appSlug={app.slug} version={version} readOnly={readOnly} table={dataTable} view={dataView}
              query={location.search.replace(/^\?/, '')}
              onNavigate={(table, view, query, options) => navigate(
                softnWorkspacePath(app.id, 'data', ...(table ? [table, ...(view === 'browse' ? [] : [view])] : [])) + (query ? `?${query}` : ''),
                { replace: options?.replace })}
              importPanel={app.ownerId === userId && !readOnly
                ? <BringDataPanel appId={app.id} disabled={busy} waiting={dirty ? 'Publish or discard your unpublished changes first: bringing data installs the app again.' : null}
                  onImported={result => {
                    setReloadKey(key => key + 1); setPreviewKey(key => key + 1);
                    toast.success('Data brought in', result.keyImported ? 'With the key it was kept under.' : 'The app keeps its own key here.');
                    if (result.verification?.configured) toast.info('Sign-in codes are on', 'Its Twilio Verify details now send this app’s codes.');
                    if (result.verificationProblem) toast.warning('Sign-in codes are not set up', result.verificationProblem);
                  }} />
                : undefined} />
          </section>
          : <section aria-label="Data" className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-5"><div className="flex items-start gap-3 text-sm leading-6 text-slate-600 dark:text-slate-400">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
            <div className="min-w-0 space-y-3">
              <p><span className="font-semibold text-slate-900 dark:text-white">This app has no database on the server.</span> It has no backend of its own, so what it saves stays in each visitor&apos;s browser. To keep data here and see it in this tab, give the app a backend: add one below, or ask AI Studio to.</p>
              {project && app.ownerId === userId && !readOnly && <AddBackendPanel project={project} disabled={busy}
                waiting={dirty ? 'Publish or discard your unpublished changes first: adding a backend makes a new version.' : null}
                onAdd={addBackend} />}
            </div>
          </div></section>)}

        {/* Wide: the address beside the domains. Narrow: one under the other. */}
        {section === 'domains' && <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <Panel title="Address" icon={<Globe className="h-4 w-4" />}>
            <Switch label="Open this app at its address" description={`Visitors to /app/${app.slug} get this app. Off: it opens at /app/${app.slug}/native.`}
              checked={!!project.home} disabled={busy || readOnly} onChange={checked => void changeSetting({ ...project, home: checked }, 'Address updated.')} />
            {published ? <Button className="mt-4" variant="secondary" size="sm" disabled={readOnly} onClick={() => setConfirmUnpublish(true)}>Unpublish</Button>
              : <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">Not published yet: only you can open it. Publish from the top of the page when it is ready.</p>}
          </Panel>
          {!readOnly && app.ownerId === userId
            ? <div className="min-w-0"><CustomDomainsPanel appId={app.id} published={published} softn /></div>
            : <p className="text-sm text-slate-600 dark:text-slate-400">Only the app&rsquo;s owner connects a domain of its own.</p>}
        </div>}

        {section === 'settings' && <div className="mt-4">
          {/* The page is long: one line of links to its panels, each an address a link elsewhere can use. */}
          <nav aria-label="Settings on this page" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {([['settings-access', 'Who can use it', true], ['settings-before', 'Before it opens', isOwner], ['settings-files', 'Files on this device', isOwner && !isSite], ['settings-outside', 'Outside sites', isOwner && isSite],
              ['settings-signin', 'Phone sign-in codes', isOwner && backend], ['app-ai-settings', 'AI', isOwner && backend && declaresFormlogicAi(project)],
              ['settings-payments', 'Payments', isOwner && backend && declaresFormlogicPayments(project)], ['settings-look', 'Look and sharing', isOwner],
              ['settings-engine', 'Engine', !isSite && !!(draft.engine && draft.enginePolicy)], ['settings-more', 'More tools', true]] as const)
              .filter(([, , shown]) => shown).map(([id, label]) =>
                <Link key={id} to={{ hash: `#${id}` }} replace className="inline-flex items-center font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 max-sm:min-h-11">{label}</Link>)}
          </nav>
          {/* The panels fill the page's width in as many columns as fit, each as tall as what it
              holds: one column on a phone, two on a laptop, three on a wide screen. */}
          <div className={cn('mt-3', PANEL_COLUMNS)}>
          <Panel id="settings-access" title="Who can use it" icon={<Users className="h-4 w-4" />}>
            <fieldset disabled={busy || readOnly} className="space-y-2">
              <legend className="sr-only">Who can use it</legend>
              {([['members', 'Only people you invite', 'Visitors sign in to FormLogic as members of this app. Invite them in Members.', Lock], ['application', 'Anyone with the link', 'The app is open to everyone. If it has its own sign-in, that is what protects it.', Globe]] as const).map(([value, label, hint, Icon]) =>
                <label key={value} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3', project.access === value ? 'border-primary-400 bg-primary-50/60 dark:border-primary-500/60 dark:bg-primary-500/10' : 'border-slate-200 dark:border-slate-700')}>
                  <input type="radio" name="softn-access" className="mt-1" checked={project.access === value}
                    onChange={() => void changeSetting({ ...project, access: value }, value === 'members' ? 'Now only invited members can use it.' : 'Now anyone with the link can use it.')} />
                  <span><span className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-white"><Icon className="h-4 w-4" aria-hidden="true" />{label}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span></span>
                </label>)}
            </fieldset>
            {!projectHasBackend(project) && <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">This app keeps its records in each visitor&rsquo;s own browser, so changing this starts everyone again from empty.</p>}
            <Link to={softnWorkspacePath(app.id, 'members')} className="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-primary-600 dark:text-primary-300">Members</Link>
          </Panel>
          {app.ownerId === userId && <Panel id="settings-before" title="Before it opens" icon={<Lock className="h-4 w-4" />}>
            <RequirementsSetting value={app.settings?.requires} disabled={gateBusy || readOnly} anonymousAccess={project.access === 'application'}
              onChange={next => void changeRequirements(next)} />
          </Panel>}
          {/* The other sites a JavaScript app may reach: none until its owner names them (SiteOutsidePanel). */}
          {isOwner && isSite && <Panel id="settings-outside" title="Outside sites" icon={<Globe className="h-4 w-4" />}>
            <SiteOutsidePanel sites={siteOutsideOf(project)} disabled={busy || readOnly}
              onChange={next => changeSetting(withOutsideSites(project, next), next.length ? 'Saved. The app may reach the sites on its list.' : 'Saved. The app reaches no outside site.')} />
          </Panel>}
          {/* Files on the device and the engine are a SoftN app's: a JavaScript app runs in the browser's own. */}
          {app.ownerId === userId && !isSite && <Panel id="settings-files" title="Files on this device" icon={<FolderOpen className="h-4 w-4" />}>
            <fieldset disabled={filesBusy || readOnly} className="space-y-2">
              <legend className="mb-2 text-xs leading-5 text-slate-500 dark:text-slate-400">Whether the app may open the files a person chooses for it and save files they ask for, such as a saved game. It never sees anything else on their device.</legend>
              {([[undefined, 'Off', 'The app cannot open or save files.'], ['ask', 'Ask each person', 'FormLogic asks each person before the app opens; they can say not now.'], ['allow', 'Allowed without asking', 'For an app you know: nobody is asked.']] as const).map(([value, label, hint]) =>
                <label key={label} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3', app.settings?.softnFiles === value ? 'border-primary-400 bg-primary-50/60 dark:border-primary-500/60 dark:bg-primary-500/10' : 'border-slate-200 dark:border-slate-700')}>
                  <input type="radio" name="softn-files" className="mt-1" checked={app.settings?.softnFiles === value} onChange={() => void changeFiles(value)} />
                  <span><span className="block text-sm font-medium text-slate-900 dark:text-white">{label}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</span></span>
                </label>)}
            </fieldset>
          </Panel>}
          {app.ownerId === userId && backend && <Panel id="settings-signin" title="Phone sign-in codes" icon={<MessageSquare className="h-4 w-4" />}>
            <PhoneSignInPanel appId={app.id} version={version} disabled={readOnly} />
          </Panel>}
          {app.ownerId === userId && backend && declaresFormlogicAi(project) && <div id="app-ai-settings" className="min-w-0 scroll-mt-24"><Panel title="AI for this app" icon={<Sparkles className="h-4 w-4" />}>
            <AppAiPanel appId={app.id} />
          </Panel></div>}
          {app.ownerId === userId && backend && declaresFormlogicPayments(project) && <Panel id="settings-payments" title="Payments" icon={<Wallet className="h-4 w-4" />}>
            <AppPaymentsPanel appId={app.id} />
          </Panel>}
          {app.ownerId === userId && <Panel id="settings-look" title="Look and sharing" icon={<Palette className="h-4 w-4" />}>

            <SoftnLookPanel appId={app.id} project={project} look={app.settings?.softnLook} themeColor={app.settings?.pwaThemeColor} disabled={readOnly} onSave={changeLook} />
          </Panel>}
          {!isSite && draft.engine && draft.enginePolicy && <Panel id="settings-engine" title="Engine" icon={<SettingsIcon className="h-4 w-4" />}>
            <AppEngineSelect appId={app.id} engine={draft.engine} policy={draft.enginePolicy} disabled={busy || readOnly} onChanged={() => void draft.refreshEngine()} />
            <div className="mt-4"><AppTorchSwitch appId={app.id} policy={draft.enginePolicy} disabled={busy || readOnly} /></div>
          </Panel>}
          <Panel id="settings-more" title="More tools" icon={<Code2 className="h-4 w-4" />}>
            <div className="flex flex-col items-start gap-1">
              <Button variant="ghost" size="sm" onClick={() => setAdvanced(true)} leftIcon={<Code2 className="h-4 w-4" />}>{isSite ? (backend ? 'Edit the backend code' : 'Edit the app’s manifest') : 'Edit the source code'}</Button>
              {/* Only for an app that also holds forms: the studio is where those are worked on, and no other SoftN app has one. */}
              {heldForms > 0 && <Button variant="ghost" size="sm" onClick={() => leave(`/apps/${app.id}/studio/data`)} leftIcon={<SettingsIcon className="h-4 w-4" />}>This app’s forms (App Studio)</Button>}
              {app.ownerId === userId && !readOnly && <Button variant="ghost" size="sm" onClick={() => leave(`/apps/${app.id}/settings`)} leftIcon={<SettingsIcon className="h-4 w-4" />}>Name, address and deleting the app</Button>}
            </div>
          </Panel>
          </div>
        </div>}
      </>}
    </div>
    <ConfirmDialog isOpen={confirmUnpublish} onClose={() => setConfirmUnpublish(false)} onConfirm={() => void unpublish()}
      title="Unpublish this app?" message="Nobody but you can open it until you publish again. Its data is kept." confirmLabel="Unpublish" />
  </div>;
}

/** An app with nothing installed: the three ways to start, as on "Create app". */
function Setup({ app, aiReady, aiReason, onAiRecheck, initialRequest, onInstalled }: { app: App; aiReady: boolean | null; aiReason: string | null; onAiRecheck: () => Promise<unknown>; initialRequest: string; onInstalled: (open: import('../../stores/uiStore').SoftnOpen | null) => void }) {
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
      const result = await api.saveNativeProject(app.id, await projectFromUpload(chosen), 0, { how: 'upload' });
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
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Sparkles className="h-4 w-4 text-primary-500" />Build it with AI</p>
        <Textarea aria-label="What should the app do?" rows={3} value={request} onChange={event => setRequest(event.target.value)} disabled={aiReady !== true || working} className="mt-2 min-h-20 resize-none" placeholder="Describe the app: its pages, what it stores, how it looks." />
        <Button size="sm" className="mt-2" disabled={aiReady !== true || working || !request.trim()} isLoading={working} onClick={() => void start({ appId: app.id, editor: 'studio', brief: { prompt: request.trim(), kind: 'build' } })}>Build it</Button>
        {aiReady === false && <AiConnectNotice lead="Building with AI needs an AI connection" reason={aiReason} onConnected={onAiRecheck} />}
      </div>
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><PencilRuler className="h-4 w-4 text-primary-500" />Start from a working app</p>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">A small app with a page, a backend and a database table, opened in the Visual Builder.</p>
        <Button size="sm" variant="secondary" className="mt-3" disabled={working} onClick={() => void start({ appId: app.id, editor: 'builder' })}>Start building</Button>
      </div>
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Upload className="h-4 w-4 text-primary-500" />Upload a .softn file</p>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">A SoftN app you already have, with its interface and backend.</p>
        <input ref={file} type="file" accept=".softn,.zip" className="hidden" aria-label="Upload a .softn file" onChange={event => { void fromFile(event.target.files?.[0]); event.target.value = ''; }} />
        <Button size="sm" variant="secondary" className="mt-3" disabled={working} onClick={() => file.current?.click()}>Choose a file</Button>
      </div>
    </div>
  </section>;
}

function Messages({ draft }: { draft: ReturnType<typeof useNativeProjectDraft> }) {
  const { ready, readOnly, available, preflight, error, notice, conflict, base, version, recoverable, busy, project } = draft;
  // The runtime runs backends only: an app with none is not stopped by its absence.
  const needsRuntime = !project || projectHasBackend(project);
  return <div className="mt-4 space-y-3 empty:hidden">
    {readOnly && <p role="note" className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300">This is the shared demo, so this app is read-only.</p>}
    {ready && !readOnly && needsRuntime && !available && !preflight && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">This server needs the app runtime installed before it can run SoftN apps. Ask your administrator.</p>}
    {ready && !readOnly && needsRuntime && preflight && !preflight.ok && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">The app runtime is installed but cannot start on this server yet.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{preflight.checks.filter(check => !check.ok).map(check => <li key={check.id}>{check.message}</li>)}</ul>
    </div>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
    {conflict && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">These changes started from version {base}; version {version} was published since. Publishing replaces version {version}.</p>}
    {draft.dirty && !busy && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary-200 bg-primary-50/70 p-3 text-sm text-primary-900 dark:border-primary-500/30 dark:bg-primary-950/30 dark:text-primary-100">
      <span className="min-w-0 flex-1">You have changes that are not live yet.</span>
      <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Discard your unpublished changes?')) draft.revert(); }}>Discard</Button>
    </div>}
    {recoverable && <div role="region" aria-label="Unpublished draft" className="rounded-xl border border-primary-200 bg-primary-50/60 p-4 text-sm dark:border-primary-500/40 dark:bg-primary-950/20">
      <p className="font-medium text-slate-900 dark:text-white">Unpublished changes from {new Date(recoverable.savedAt).toLocaleString()} are kept in this browser.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => draft.recoverDraft()}>Recover them</Button><Button size="sm" variant="secondary" disabled={busy} onClick={draft.discardDraft}>Discard them</Button></div>
    </div>}
  </div>;
}

function StatusPill({ live }: { live: boolean }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', live ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')}>
    {/* The words lib/appStatus gives every surface: Live, Draft. */}
    <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />{live ? 'Live' : 'Draft'}
  </span>;
}

function IconButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onClick}
    className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 max-sm:h-11 max-sm:w-11 dark:text-slate-400 dark:hover:bg-white/5', active && 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-white')}>{children}</button>;
}

export default SoftnAppWorkspace;
