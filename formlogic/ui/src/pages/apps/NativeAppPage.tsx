import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import type { NativeRuntimeProject } from '../../lib/nativeHosting';
import { HostedAppFrame } from '../../components/studio/HostedAppFrame';

export default function NativeAppPage() {
  const { appSlug = '' } = useParams();
  const userId = useAuthStore(state => state.user?.id);
  // `engine`: the server's engine decision for this mount (absent from a server before E0).
  const [result, setResult] = useState<{ slug: string; userId?: string; project?: NativeRuntimeProject; engine?: { id: string; revision: string }; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.getNativeRuntime(appSlug).then(response => {
      if (!cancelled) setResult({ slug: appSlug, userId, project: response.data?.project, engine: response.data?.engine, error: response.error });
    });
    return () => { cancelled = true; };
  }, [appSlug, userId]);
  const current = result?.slug === appSlug && result.userId === userId ? result : null;
  const project = current?.project;
  const error = current?.error;
  const native = useMemo(() => project ? { assets: project.assets, origins: project.origins } : undefined, [project]);
  return <main className="h-dvh bg-slate-50 p-2 dark:bg-slate-950">{project ? <div className="h-full"><HostedAppFrame slug={appSlug} client={project.client} version={project.version} native={native} engine={current?.engine} /></div> : <div className="mx-auto max-w-md p-6">{error ? <><p role="alert" className="text-sm text-slate-800 dark:text-slate-200">{error}</p><Link className="mt-4 inline-flex min-h-11 items-center text-indigo-600 dark:text-indigo-300" to={`/app/${encodeURIComponent(appSlug)}`}>Sign in or join this app</Link></> : <p role="status">Opening your app…</p>}</div>}</main>;
}
