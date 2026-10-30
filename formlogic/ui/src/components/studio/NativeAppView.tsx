// An installed native app, running: its runtime fetched for the signed-in member and mounted in
// the hosted app frame. The app's own page (/app/:slug/native) is this, full screen; the SoftN
// workspace and App Studio show the same thing in place as their preview. They used to frame that
// page instead, and a FormLogic page may not be framed (the web root sends frame-ancestors 'none'
// for every page of the app shell), so on a real server the preview was refused by the browser.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import type { NativeRuntimeProject } from '../../lib/nativeHosting';
import { isNativeStorageScope } from '../../lib/nativeAppStorage';
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { HostedAppFrame } from './HostedAppFrame';

export function NativeAppView({ slug }: { slug: string }) {
  const userId = useAuthStore(state => state.user?.id);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  // `engine`: the server's engine decision for this mount (absent from a server before E0).
  const [result, setResult] = useState<{ slug: string; userId?: string; generation: number; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stillCurrent = () => !cancelled && isSessionGenerationCurrent(generation);
    void api.getNativeRuntime(slug).then(response => {
      if (!stillCurrent()) return;
      const project = response.data?.project;
      const scope = project?.storageScope;
      const admitted = project && isNativeStorageScope(scope) && scope.access === project.access &&
        (scope.access === 'application' || (scope.userId === userId && scope.userId === currentSessionOwner()));
      const error = response.error || (!admitted ? 'This app could not verify its browser storage access. Please reload or sign in again.' : undefined);
      setResult({ slug, userId, generation, project: error ? undefined : project, engine: response.data?.engine, error });
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
  return project ? <div className="h-full"><HostedAppFrame slug={slug} client={project.client} version={project.version} native={native} engine={current?.engine} /></div> : <div className="mx-auto max-w-md p-6">{error ? <><p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p><Link className="mt-4 inline-flex min-h-11 items-center text-indigo-600 dark:text-indigo-300" to={`/app/${encodeURIComponent(slug)}`}>Sign in or join this app</Link></> : <p role="status">Opening your app…</p>}</div>;
}
