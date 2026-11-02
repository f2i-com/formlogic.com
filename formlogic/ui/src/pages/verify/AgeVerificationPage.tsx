import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import type { AgeGateStatus } from '../../types/app';

type Loaded = { appName: string; slug: string; gate: AgeGateStatus | null; methods: string[]; returnTo: string | null };

/**
 * Where a member meets an app's age gate: on this site, never on an app's own domain, as sign-in.
 * ?app= names the app; ?return= is where to go afterwards, which the server allows only as a path
 * of this site or an address of that app's own domain.
 */
export function AgeVerificationPage() {
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const slug = params.get('app') ?? '';
  const requestedReturn = params.get('return') ?? undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!user || !slug) return;
    let cancelled = false;
    void api.getAgeVerification(slug, requestedReturn).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'This app could not be found.'); return; }
      setLoaded({ appName: result.data.app.name, slug: result.data.app.slug, gate: result.data.ageGate, methods: result.data.methods, returnTo: result.data.returnTo });
    });
    return () => { cancelled = true; };
  }, [user, slug, requestedReturn]);

  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const goOn = (returnTo: string | null) => {
    const to = returnTo ?? `/app/${encodeURIComponent(loaded?.slug ?? slug)}`;
    // An app's own domain is another site: leave this one for it.
    if (/^https?:\/\//i.test(to)) window.location.assign(to);
    else navigate(to, { replace: true });
  };

  const declare = async () => {
    if (!loaded || sending) return;
    setSending(true);
    setError(null);
    const result = await api.declareAge(loaded.slug, requestedReturn);
    setSending(false);
    if (result.error || !result.data) { setError(result.error ?? 'Your age could not be recorded. Try again.'); return; }
    goOn(result.data.returnTo);
  };

  const gate = loaded?.gate ?? null;
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
      <main className="w-full max-w-md rounded-2xl border border-gray-200/80 bg-white p-8 shadow-lg shadow-gray-900/[0.04] dark:border-slate-700/60 dark:bg-slate-900 dark:shadow-black/20">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 dark:bg-primary-500/10">
          <ShieldCheck className="h-6 w-6 text-primary-600 dark:text-primary-400" aria-hidden="true" />
        </div>
        {!slug ? (
          <p role="alert" className="text-center text-sm text-gray-600 dark:text-slate-300">This link doesn&apos;t name an app.</p>
        ) : !loaded && !error ? (
          <p role="status" className="text-center text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : !loaded ? (
          <p role="alert" className="text-center text-sm text-gray-600 dark:text-slate-300">{error}</p>
        ) : !gate ? (
          <>
            <h1 className="mb-2 text-center text-xl font-semibold tracking-tight text-gray-900 dark:text-white">{loaded.appName} has no age requirement</h1>
            <div className="mt-6 flex justify-center"><Button onClick={() => goOn(loaded.returnTo)}>Continue to {loaded.appName}</Button></div>
          </>
        ) : gate.satisfied ? (
          <>
            <h1 className="mb-2 text-center text-xl font-semibold tracking-tight text-gray-900 dark:text-white">You&apos;re all set</h1>
            <p className="text-center text-sm text-gray-500 dark:text-slate-400">You&apos;ve already confirmed your age for apps like {loaded.appName} on this site.</p>
            <div className="mt-6 flex justify-center"><Button onClick={() => goOn(loaded.returnTo)}>Continue to {loaded.appName}</Button></div>
          </>
        ) : loaded.methods.includes('self_declaration') ? (
          <>
            <h1 className="mb-2 text-center text-xl font-semibold tracking-tight text-gray-900 dark:text-white">Confirm your age</h1>
            <p className="mb-5 text-center text-sm text-gray-500 dark:text-slate-400">{loaded.appName} is for people aged {gate.minimumAge} and over.</p>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 text-sm dark:border-slate-700">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span className="text-gray-900 dark:text-white">I am {gate.minimumAge} or older.</span>
            </label>
            <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
              This is your own word, not a check of your age. It is kept with your account on this site and opens other apps here that ask the same,
              until it expires or you withdraw it in Settings. Nothing else about you is kept.
            </p>
            {error && (
              <div role="alert" className="mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
                <AlertCircle className="h-4 w-4 flex-shrink-0" /><span>{error}</span>
              </div>
            )}
            <div className="mt-6 flex flex-col gap-2">
              <Button onClick={() => void declare()} disabled={!confirmed} isLoading={sending}>Confirm and continue</Button>
              <a href="/" className="text-center text-sm text-gray-400 hover:text-gray-900 dark:text-slate-400 dark:hover:text-white">Not now</a>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-2 text-center text-xl font-semibold tracking-tight text-gray-900 dark:text-white">A stronger check is needed</h1>
            <p className="text-center text-sm text-gray-500 dark:text-slate-400">
              {loaded.appName} is for people aged {gate.minimumAge} and over, and needs a check this site doesn&apos;t offer yet. Ask the app&apos;s owner.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
