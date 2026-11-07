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
  // The app's name as soon as the project has come, for the tab while its media download.
  const [early, setEarly] = useState<{ slug: string; name?: string } | null>(null);
  // Bumped by Try again, and by the connection coming back after a failed opening: asks again.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ slug: string; userId?: string; generation: number; name?: string; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string; retry?: boolean; pass?: { verifyPath: string | null; action: string } } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stillCurrent = () => !cancelled && isSessionGenerationCurrent(generation);
    // The app's look and name as soon as the server says them, before its media have downloaded (a
    // plugin's page looks like the site's own, and the server sends none for it).
    const seeLook = (next: NativeLook | null, known?: { name?: string }) => {
      if (!stillCurrent()) return;
      setLook({ slug, look: next }); rememberLook(slug, next);
      setEarly({ slug, name: known?.name });
    };
    void api.getNativeRuntime(slug, seeLook).then(async response => {
      if (!stillCurrent()) return;
      const project = response.data?.project;
      const scope = project?.storageScope;
      const admitted = project && isNativeStorageScope(scope) && scope.access === project.access &&
        (scope.access === 'application' || (scope.userId === userId && scope.userId === currentSessionOwner()));
      // No answer at all is said plainly: the browser's own words ("Failed to fetch") say nothing to a player.
      const error = response.transportFailure ? 'This app could not be opened. Check your connection and try again.'
        : response.error || (!admitted ? 'This app could not verify its browser storage access. Please reload or sign in again.' : undefined);
      let pass: { verifyPath: string | null; action: string } | undefined;
      if (response.error && PASS_REFUSALS.includes(response.code ?? '')) {
        // Which requirement, and where it is met: from the app's membership, which stays open.
        const membership = await api.getAppMembership(slug).catch(() => null);
        if (!stillCurrent()) return;
        const unmet = unmetRequirement(membership?.data?.requirements);
        pass = { verifyPath: unmet && unmet.available ? unmet.verifyPath : null, action: unmet ? passAction(unmet) : 'Continue' };
      }
      // What asking again may cure: no answer, the app updated while it opened, a busy server.
      const status = response.status ?? 0;
      const retry = !!response.error && (!!response.transportFailure || status === 0 || status === 408 || status === 409 || status === 429 || status >= 500);
      setResult({ slug, userId, generation, name: response.data?.name, project: error ? undefined : project, engine: response.data?.engine, error, retry, pass });
    }).catch(() => {
      if (stillCurrent()) setResult({ slug, userId, generation, error: 'This app could not be opened. Check your connection and try again.', retry: true });
    });
    return () => { cancelled = true; };
  }, [slug, userId, generation, attempt]);
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
  // The tab's icon, the theme colour and description, and (off a domain, once published) the
  // manifest that installs it.
  useEffect(() => {
    if (!fullScreen || !look || plugin) return;
    return applyAppHead(slug, look, { manifest: !onDomain && look.installable });
  }, [fullScreen, look, onDomain, plugin, slug]);
  const name = current?.name ?? (early?.slug === slug ? early.name : undefined);
  const title = fullScreen ? name : undefined;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    // And the name an iPhone gives it on a home screen, which Safari takes from this before the manifest.
    const apple = document.head.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    const before = apple?.getAttribute('content');
    apple?.setAttribute('content', title);
    return () => {
      document.title = previous;
      if (apple && before !== null && before !== undefined) apple.setAttribute('content', before);
    };
  }, [title]);
  // Asks again, on the splash rather than under the old error. A failed opening that asking again
  // may cure is asked again by itself when the connection comes back.
  const askAgain = () => { setResult(null); setAttempt(value => value + 1); };
  const retryable = !!current?.error && !!current.retry;
  useEffect(() => {
    if (!retryable) return;
    const again = () => { setResult(null); setAttempt(value => value + 1); };
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [retryable]);
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
  return project ? <div className="h-full"><HostedAppFrame slug={slug} client={project.client} version={project.version} native={native} engine={current?.engine} bare={fullScreen} domain={ownDomain} plugin={plugin} /></div> : !error ? <AppSplash look={look} label={name ? `Opening ${name}` : 'Opening the app'} /> : <div className="p-6">
    {/* On a card of its own: the page around it may wear the app's loading colours, dark or light. */}
    <div className="mx-auto max-w-md rounded-2xl bg-white/95 p-5 shadow-sm dark:bg-slate-900/95">
      <p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p>
      {current?.pass
        // On an app's own domain the pass is met on FormLogic, never on the domain.
        ? (verify === null ? null : platform
          ? <a className={linkClass} href={`${platform}${verify}${encodeURIComponent(window.location.href)}`}>{current.pass.action}</a>
          : <Link className={linkClass} to={`${verify}${encodeURIComponent(window.location.pathname + window.location.search)}`}>{current.pass.action}</Link>)
        // Signing in is no cure for no answer, and on an app's own domain this page is where it
        // would lead: there, and for anything asking again may cure, the way on is to ask again.
        : <div className="flex flex-wrap items-center gap-x-5">
          <button type="button" className={linkClass} onClick={askAgain}>Try again</button>
          {plugin || onDomain || current?.retry ? null : <Link className={linkClass} to={signInTo ?? `/app/${encodeURIComponent(slug)}`}>Sign in or join this app</Link>}
        </div>}
    </div>
  </div>;
}
