// An installed native app, running: its runtime fetched for the signed-in member and mounted in
// the hosted app frame. The app's own page (/app/:slug/native) is this, full screen; the SoftN
// workspace and App Studio show the same thing in place as their preview. They used to frame that
// page instead, and a FormLogic page may not be framed (the web root sends frame-ancestors 'none'
// for every page of the app shell), so on a real server the preview was refused by the browser.
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DomainSignInContext, isAnotherAddress } from '../../lib/domainSignIn';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import type { NativeRuntimeProject } from '../../lib/nativeHosting';
import { isNativeStorageScope } from '../../lib/nativeAppStorage';
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { HostedAppFrame } from './HostedAppFrame';
import { AppSplash } from './AppSplash';
import { applyAppHead, rememberedLook, rememberLook, type NativeLook } from '../../lib/appLook';
import { passAction, unmetRequirement } from '../../lib/passes';

/** The codes an app refuses with when it requires a pass the member does not hold (AccessGateService). */
const PASS_REFUSALS = ['pass_required', 'plugin_unavailable'];

/**
 * A person's answer to an app that asks to use files on this device (its owner's choice is 'ask'):
 * Allow is kept on this device; Not now for this browser session only, so they are asked again
 * another day rather than never. Keyed by the app's id, which a renamed app keeps, and for a members'
 * app by the member too: another account on this browser is asked for itself.
 */
const filesKey = (appId: string) => `formlogic:native-files:v1:${appId}`;
function filesAnswer(appId: string): 'allow' | 'deny' | null {
  try { if (localStorage.getItem(filesKey(appId)) === 'allow') return 'allow'; } catch { /* Asked again. */ }
  try { if (sessionStorage.getItem(filesKey(appId)) === 'deny') return 'deny'; } catch { /* Asked again. */ }
  return null;
}
function rememberFilesAnswer(appId: string, answer: 'allow' | 'deny'): void {
  try { if (answer === 'allow') localStorage.setItem(filesKey(appId), 'allow'); else sessionStorage.setItem(filesKey(appId), 'deny'); } catch { /* This visit only. */ }
}

/**
 * `fullScreen`: the app is the whole page, and names the tab, wears its icon and installs as itself.
 * `onDomain`: that page is the app's own domain, whose manifest the domain's router already set.
 * `onLook`: told the app's look (its loading background) for the page around it. `signInTo`: where a
 * refused visitor goes. `plugin`: this is a plugin's own page, given its two bridge actions
 * (HostedAppFrame).
 */
export function NativeAppView({ slug, fullScreen = false, onDomain = false, onLook, signInTo, plugin }: { slug: string; fullScreen?: boolean; onDomain?: boolean; onLook?: (look: NativeLook | null) => void; signInTo?: string; plugin?: { context: Record<string, unknown>; onDone: () => void; onCamera?: () => void } }) {
  const userId = useAuthStore(state => state.user?.id);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  // `engine`: the server's engine decision for this mount (absent from a server before E0).
  const platform = useContext(DomainSignInContext);
  // A domain of its own, at an address that is neither FormLogic's nor a local test one, whose
  // storage may hold other SoftN pages' keys. Only there does the app take the site's earlier saves.
  const ownDomain = onDomain && isAnotherAddress(platform);
  // `pass`: refused for a pass the app requires, met on the main site at `verifyPath` (none when
  // the plugin that issues it is off or gone).
  // The loading colours: the server's, else what this browser saw last time, else the site's own.
  const [seen, setLook] = useState<{ slug: string; look: NativeLook | null } | null>(null);
  // Read once for each app (a plugin's page looks like the site's own).
  const remembered = useMemo(() => plugin ? null : rememberedLook(slug), [plugin, slug]);
  const look = seen?.slug === slug ? seen.look : remembered;
  const [result, setResult] = useState<{ slug: string; userId?: string; generation: number; name?: string; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string; pass?: { verifyPath: string | null; action: string } } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stillCurrent = () => !cancelled && isSessionGenerationCurrent(generation);
    // The app's look as soon as the server says it, before its media have downloaded (a plugin's
    // page looks like the site's own, and the server sends none for it).
    const seeLook = (next: NativeLook | null) => { if (!stillCurrent()) return; setLook({ slug, look: next }); rememberLook(slug, next); };
    void api.getNativeRuntime(slug, seeLook).then(async response => {
      if (!stillCurrent()) return;
      const project = response.data?.project;
      const scope = project?.storageScope;
      const admitted = project && isNativeStorageScope(scope) && scope.access === project.access &&
        (scope.access === 'application' || (scope.userId === userId && scope.userId === currentSessionOwner()));
      const error = response.error || (!admitted ? 'This app could not verify its browser storage access. Please reload or sign in again.' : undefined);
      let pass: { verifyPath: string | null; action: string } | undefined;
      if (response.error && PASS_REFUSALS.includes(response.code ?? '')) {
        // Which requirement, and where it is met: from the app's membership, which stays open.
        const membership = await api.getAppMembership(slug).catch(() => null);
        if (!stillCurrent()) return;
        const unmet = unmetRequirement(membership?.data?.requirements);
        pass = { verifyPath: unmet && unmet.available ? unmet.verifyPath : null, action: unmet ? passAction(unmet) : 'Continue' };
      }
      setResult({ slug, userId, generation, name: response.data?.name, project: error ? undefined : project, engine: response.data?.engine, error, pass });
    }).catch(() => {
      if (stillCurrent()) setResult({ slug, userId, generation, error: 'This app could not be opened. Please reload to try again.' });
    });
    return () => { cancelled = true; };
  }, [slug, userId, generation]);
  const current = result?.slug === slug && result.userId === userId && result.generation === generation ? result : null;
  const project = current?.project;
  const error = current?.error;
  // Whether the app may use files on this device: the owner's choice from the admitted runtime GET,
  // and where the owner chose to ask, this person's answer, given before the app opens (a grant
  // changed under a running app restarts it). Asked in this page, which the app cannot draw over.
  const filesAppId = project?.files !== 'ask' ? null : project.storageScope.access === 'members'
    ? `${project.storageScope.appId}:${project.storageScope.userId}` : project.storageScope.appId;
  const [answered, setAnswered] = useState<{ appId: string; answer: 'allow' | 'deny' } | null>(null);
  const answer = filesAppId ? (answered?.appId === filesAppId ? answered.answer : filesAnswer(filesAppId)) : null;
  const filesGranted = project?.files === 'allow' || (project?.files === 'ask' && answer === 'allow');
  // Storage identity comes only from the admitted runtime GET, never app files or iframe input.
  const native = useMemo(() => project ? { assets: project.assets, origins: project.origins, access: project.access, storageScope: project.storageScope, files: filesGranted, look: plugin ? undefined : (look ?? null) } : undefined, [project, filesGranted, look, plugin]);
  const answerFiles = (choice: 'allow' | 'deny') => {
    if (!filesAppId) return;
    rememberFilesAnswer(filesAppId, choice);
    setAnswered({ appId: filesAppId, answer: choice });
  };
  useEffect(() => { onLook?.(look); }, [look, onLook]);
  // The tab's icon, the theme colour and description, and (off a domain) the manifest that installs it.
  useEffect(() => {
    if (!fullScreen || !look || plugin) return;
    return applyAppHead(slug, look, { manifest: !onDomain });
  }, [fullScreen, look, onDomain, plugin, slug]);
  const title = fullScreen ? current?.name : undefined;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  const verify = current?.pass?.verifyPath ? `${current.pass.verifyPath}&return=` : null;
  const linkClass = 'mt-4 inline-flex min-h-11 items-center text-indigo-600 dark:text-indigo-300';
  if (project && filesAppId && answer === null) {
    const appName = current?.name || 'This app';
    return <div className="flex h-full items-center justify-center p-6">
      <section role="dialog" aria-modal="false" aria-labelledby="native-files-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 id="native-files-title" className="text-lg font-semibold text-slate-900 dark:text-white">{appName} would like to use files on this device</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">It can open the files you choose for it and save files you ask it to, such as a saved game. It cannot look at anything else on this device.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="min-h-11 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700" onClick={() => answerFiles('allow')}>Allow</button>
          <button type="button" className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-800 dark:border-slate-600 dark:text-slate-200" onClick={() => answerFiles('deny')}>Not now</button>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">Not now opens the app without them; you will be asked again on another visit.</p>
      </section>
    </div>;
  }
  return project ? <div className="h-full"><HostedAppFrame slug={slug} client={project.client} version={project.version} native={native} engine={current?.engine} bare={fullScreen} domain={ownDomain} plugin={plugin} /></div> : !error ? <AppSplash look={look} label={current?.name ? `Opening ${current.name}` : 'Opening the app'} /> : <div className="mx-auto max-w-md p-6">{error ? <><p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p>
    {current?.pass
      // On an app's own domain the pass is met on FormLogic, never on the domain.
      ? (verify === null ? null : platform
        ? <a className={linkClass} href={`${platform}${verify}${encodeURIComponent(window.location.href)}`}>{current.pass.action}</a>
        : <Link className={linkClass} to={`${verify}${encodeURIComponent(window.location.pathname + window.location.search)}`}>{current.pass.action}</Link>)
      : plugin ? null : <Link className={linkClass} to={signInTo ?? `/app/${encodeURIComponent(slug)}`}>Sign in or join this app</Link>}</> : null}</div>;
}
