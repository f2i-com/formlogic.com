import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import type { NativeRuntimeProject } from '../../lib/nativeHosting';
import { isNativeStorageScope } from '../../lib/nativeAppStorage';
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { HostedAppFrame } from '../../components/studio/HostedAppFrame';

export default function NativeAppPage() {
  const { appSlug = '' } = useParams();
  const userId = useAuthStore(state => state.user?.id);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  // `engine`: the server's engine decision for this mount (absent from a server before E0).
  const [result, setResult] = useState<{ slug: string; userId?: string; generation: number; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const stillCurrent = () => !cancelled && isSessionGenerationCurrent(generation);
    void api.getNativeRuntime(appSlug).then(response => {
      if (!stillCurrent()) return;
      const project = response.data?.project;
      const scope = project?.storageScope;
      const admitted = project && isNativeStorageScope(scope) && scope.access === project.access &&
        (scope.access === 'application' || (scope.userId === userId && scope.userId === currentSessionOwner()));
      const error = response.error || (!admitted ? 'This app could not verify its browser storage access. Please reload or sign in again.' : undefined);
      setResult({ slug: appSlug, userId, generation, project: error ? undefined : project, engine: response.data?.engine, error });
    }).catch(() => {
      if (stillCurrent()) setResult({ slug: appSlug, userId, generation, error: 'This app could not be opened. Please reload to try again.' });
    });
    return () => { cancelled = true; };
  }, [appSlug, userId, generation]);
  const current = result?.slug === appSlug && result.userId === userId && result.generation === generation ? result : null;
  const project = current?.project;
  const error = current?.error;
  // Storage identity comes only from the admitted runtime GET, never app files or iframe input.
  const native = useMemo(() => project ? { assets: project.assets, origins: project.origins, access: project.access, storageScope: project.storageScope } : undefined, [project]);
  return <main className="h-dvh bg-slate-50 p-2 dark:bg-slate-950">{project ? <div className="h-full"><HostedAppFrame slug={appSlug} client={project.client} version={project.version} native={native} engine={current?.engine} /></div> : <div className="mx-auto max-w-md p-6">{error ? <><p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p><Link className="mt-4 inline-flex min-h-11 items-center text-indigo-600 dark:text-indigo-300" to={`/app/${encodeURIComponent(appSlug)}`}>Sign in or join this app</Link></> : <p role="status">Opening your app…</p>}</div>}</main>;
}
