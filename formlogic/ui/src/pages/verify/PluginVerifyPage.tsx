import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, Puzzle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { NativeAppView } from '../../components/studio/NativeAppView';
import { CameraCheckPanel } from '../../components/plugins/CameraCheckPanel';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import type { PassRequirement } from '../../types/app';

type Loaded = {
  plugin: { id: string; name: string; slug: string | null };
  app: { name: string; slug: string };
  requirement: PassRequirement;
  /** The site's camera check is there for this plugin and requirement. */
  camera?: boolean;
  /** The plugin's settings, as the administrator set them. */
  settings?: Record<string, unknown>;
  returnTo: string;
};

/**
 * Where a member meets an app's requirement: the page of the plugin that issues the pass, run in
 * the sandboxed frame like any SoftN app, on this site and never on an app's own domain. ?app=
 * and ?kind= name the requirement; ?return= is where to go afterwards, which the server allows
 * only as a path of this site or an address of that app's own domain. The plugin's page is told
 * what it is for (pluginContext) and says when it is done (pluginDone); where to go then is the
 * server's answer, checked again here, never anything the plugin says.
 */
export function PluginVerifyPage() {
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  const navigate = useNavigate();
  const { plugin: pluginId = '' } = useParams();
  const [params] = useSearchParams();
  const slug = params.get('app') ?? '';
  const kind = params.get('kind') ?? '';
  const requestedReturn = params.get('return') ?? undefined;
  const paramKey = `${user?.id ?? ''}:${pluginId}:${slug}:${kind}:${requestedReturn ?? ''}`;
  const [fetchState, setFetchState] = useState<{ key: string; loaded: Loaded | null; error: string | null }>({ key: '', loaded: null, error: null });
  const [notYetKey, setNotYetKey] = useState<string | null>(null);
  const [cameraKey, setCameraKey] = useState<string | null>(null);
  const loaded = fetchState.key === paramKey ? fetchState.loaded : null;
  const error = fetchState.key === paramKey ? fetchState.error : null;
  const notYet = notYetKey === paramKey;
  const camera = cameraKey === paramKey;
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    if (!user || !slug || !kind) return () => { requestSeqRef.current += 1; };
    let cancelled = false;
    void api.getPluginContext(pluginId, slug, kind, requestedReturn).then((result) => {
      if (cancelled || requestSeqRef.current !== seq) return;
      if (result.error || !result.data) {
        setFetchState({ key: paramKey, loaded: null, error: result.error ?? 'This page could not be opened.' });
        return;
      }
      setFetchState({ key: paramKey, loaded: result.data, error: null });
    });
    return () => {
      cancelled = true;
      requestSeqRef.current += 1;
    };
  }, [user, pluginId, slug, kind, requestedReturn, paramKey]);

  const goOn = useCallback((to: string) => {
    // An app's own domain is another site: leave this one for it; otherwise require a safe root-relative path.
    if (/^https?:\/\//i.test(to)) {
      window.location.assign(to);
      return;
    }
    navigate(/^\/(?!\/)/.test(to) ? to : '/', { replace: true });
  }, [navigate]);

  // The plugin says it is done: go on if the server now holds the pass, and say so if it doesn't.
  const onDone = useCallback(() => {
    const seq = requestSeqRef.current;
    void api.getPluginContext(pluginId, slug, kind, requestedReturn).then((result) => {
      if (requestSeqRef.current !== seq) return;
      if (result.data?.requirement.satisfied) goOn(result.data.returnTo);
      else setNotYetKey(paramKey);
    });
  }, [pluginId, slug, kind, requestedReturn, paramKey, goOn]);

  // What the plugin's page is told: the app, what it asks, whether the site's camera check is there
  // for it, and its settings; nothing about the member.
  const context = useMemo(() => loaded ? {
    app: { name: loaded.app.name },
    requirement: { kind: loaded.requirement.kind, label: loaded.requirement.label, unit: loaded.requirement.unit, min: loaded.requirement.min, strength: loaded.requirement.strength },
    camera: loaded.camera === true,
    settings: loaded.settings ?? {},
  } : null, [loaded]);
  const openCamera = useCallback(() => setCameraKey(paramKey), [paramKey]);
  const bridge = useMemo(() => context ? { context, onDone, ...(loaded?.camera ? { onCamera: openCamera } : {}) } : undefined, [context, onDone, loaded, openCamera]);

  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  return (
    <div className="min-h-screen bg-gray-50 p-4 dark:bg-slate-950">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-6">
        <header className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary-50 dark:bg-primary-500/10">
            <Puzzle className="h-5 w-5 text-primary-600 dark:text-primary-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">{loaded ? `Before you open ${loaded.app.name}` : 'Before you continue'}</h1>
            {loaded && <p className="text-sm text-gray-500 dark:text-slate-400">{loaded.plugin.name}, a plugin on this site, asks this for the app. The app learns only that you passed.</p>}
          </div>
        </header>
        {!slug || !kind ? (
          <p role="alert" className="text-sm text-gray-600 dark:text-slate-300">This link doesn&apos;t name an app.</p>
        ) : !loaded && !error ? (
          <p role="status" className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : !loaded ? (
          <p role="alert" className="text-sm text-gray-600 dark:text-slate-300">{error}</p>
        ) : loaded.requirement.satisfied ? (
          <section className="rounded-2xl border border-gray-200/80 bg-white p-6 dark:border-slate-700/60 dark:bg-slate-900">
            <h2 className="mb-2 text-base font-semibold text-gray-900 dark:text-white">You&apos;re all set</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400">You already have this for apps like {loaded.app.name} on this site.</p>
            <div className="mt-5"><Button onClick={() => goOn(loaded.returnTo)}>Continue to {loaded.app.name}</Button></div>
          </section>
        ) : !loaded.plugin.slug || !bridge ? (
          <p role="alert" className="text-sm text-gray-600 dark:text-slate-300">This plugin could not be opened. Ask the site&apos;s administrator.</p>
        ) : (
          <>
            {notYet && (
              <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertCircle className="h-4 w-4 flex-shrink-0" /><span>That wasn&apos;t recorded yet. Try again below.</span>
              </div>
            )}
            <section aria-label={loaded.plugin.name} className="h-[480px]">
              <NativeAppView slug={loaded.plugin.slug} plugin={bridge} />
            </section>
            <a href="/" className="text-center text-sm text-gray-400 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white">Not now</a>
            {camera && (
              <CameraCheckPanel
                pluginName={loaded.plugin.name}
                start={() => api.startCameraCheck(loaded.plugin.id, loaded.app.slug, loaded.requirement.kind)}
                onPassed={onDone}
                onClose={() => setCameraKey(null)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
