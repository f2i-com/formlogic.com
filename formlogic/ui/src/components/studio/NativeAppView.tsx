// An installed native app, running: its runtime fetched for the signed-in member and mounted in
// the hosted app frame. The app's own page (/app/:slug/native) is this, full screen; the SoftN
// workspace and App Studio show the same thing in place as their preview. They used to frame that
// page instead, and a FormLogic page may not be framed (the web root sends frame-ancestors 'none'
// for every page of the app shell), so on a real server the preview was refused by the browser.
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DomainSignInContext } from '../../lib/domainSignIn';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import type { NativeRuntimeProject } from '../../lib/nativeHosting';
import { isNativeStorageScope } from '../../lib/nativeAppStorage';
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { HostedAppFrame } from './HostedAppFrame';
import { passAction, unmetRequirement } from '../../lib/passes';

/** The codes an app refuses with when it requires a pass the member does not hold (AccessGateService). */
const PASS_REFUSALS = ['pass_required', 'plugin_unavailable'];

/**
 * `fullScreen`: the app is the whole page, and names the tab. `signInTo`: where a refused visitor
 * goes. `plugin`: this is a plugin's own page, given its two bridge actions (HostedAppFrame).
 */
export function NativeAppView({ slug, fullScreen = false, signInTo, plugin }: { slug: string; fullScreen?: boolean; signInTo?: string; plugin?: { context: Record<string, unknown>; onDone: () => void; onCamera?: () => void } }) {
  const userId = useAuthStore(state => state.user?.id);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  // `engine`: the server's engine decision for this mount (absent from a server before E0).
  const platform = useContext(DomainSignInContext);
  // `pass`: refused for a pass the app requires, met on the main site at `verifyPath` (none when
  // the plugin that issues it is off or gone).
  const [result, setResult] = useState<{ slug: string; userId?: string; generation: number; name?: string; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string; pass?: { verifyPath: string | null; action: string } } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stillCurrent = () => !cancelled && isSessionGenerationCurrent(generation);
    void api.getNativeRuntime(slug).then(async response => {
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
  // Storage identity comes only from the admitted runtime GET, never app files or iframe input.
  const native = useMemo(() => project ? { assets: project.assets, origins: project.origins, access: project.access, storageScope: project.storageScope } : undefined, [project]);
  const title = fullScreen ? current?.name : undefined;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  const verify = current?.pass?.verifyPath ? `${current.pass.verifyPath}&return=` : null;
  const linkClass = 'mt-4 inline-flex min-h-11 items-center text-indigo-600 dark:text-indigo-300';
  return project ? <div className="h-full"><HostedAppFrame slug={slug} client={project.client} version={project.version} native={native} engine={current?.engine} bare={fullScreen} plugin={plugin} /></div> : <div className="mx-auto max-w-md p-6">{error ? <><p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p>
    {current?.pass
      // On an app's own domain the pass is met on FormLogic, never on the domain.
      ? (verify === null ? null : platform
        ? <a className={linkClass} href={`${platform}${verify}${encodeURIComponent(window.location.href)}`}>{current.pass.action}</a>
        : <Link className={linkClass} to={`${verify}${encodeURIComponent(window.location.pathname + window.location.search)}`}>{current.pass.action}</Link>)
      : plugin ? null : <Link className={linkClass} to={signInTo ?? `/app/${encodeURIComponent(slug)}`}>Sign in or join this app</Link>}</> : <p role="status">Opening your app…</p>}</div>;
}
