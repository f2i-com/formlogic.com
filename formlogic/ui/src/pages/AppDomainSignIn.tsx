import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Globe } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';
import { fetchLaunchConfig, type LaunchConfig } from '../lib/domainLaunchApi';
import { useAuthStore } from '../stores/authStore';

function hostOf(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : '';
  } catch {
    return '';
  }
}

/**
 * Where a member of an app on its own domain lands to sign in, from startDomainSignIn. Passwords
 * stay on this site; the domain gets a one-time code for its app, once the member has seen which
 * site is asking. Signed-out visitors go through the usual ?redirect= login and land back here.
 */
export function AppDomainSignIn() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const origin = searchParams.get('origin') ?? '';
  const state = searchParams.get('state') ?? '';
  const page = searchParams.get('page') === 'signup' ? '/signup' : '/login';
  const host = hostOf(origin);
  const [config, setConfig] = useState<LaunchConfig | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (user) return;
    navigate(`${page}?redirect=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  }, [user, page, navigate, location.pathname, location.search]);

  useEffect(() => {
    if (!user || !host) return;
    let cancelled = false;
    void fetchLaunchConfig(host).then(found => { if (!cancelled) setConfig(found); });
    return () => { cancelled = true; };
  }, [user, host]);

  // A site can swap this page in under the second click of a double-click. Nobody reads and
  // decides in a second.
  useEffect(() => {
    if (!config) return;
    const timer = window.setTimeout(() => setArmed(true), 1000);
    return () => window.clearTimeout(timer);
  }, [config]);

  if (!user) return null;
  if (host && config === undefined) return <p role="status" className="p-6">Checking this site…</p>;

  const proceed = async () => {
    setWorking(true);
    setError('');
    const result = await api.createAppDomainCode(origin);
    if (!result.data?.code) {
      setWorking(false);
      setError(result.error || 'This could not be completed. Please try again.');
      return;
    }
    const fragment = new URLSearchParams({ code: result.data.code, state });
    // The button stays busy while the browser leaves.
    window.location.assign(`${origin}/sign-in/complete#${fragment}`);
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
        {config ? (
          <>
            <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
              <Globe className="h-6 w-6 text-primary-600 dark:text-primary-400" />
            </div>
            <h1 className="text-xl font-semibold text-center text-gray-900 dark:text-white tracking-tight">Continue to {config.app.name}</h1>
            <p className="mt-2 text-center font-mono text-sm break-all text-gray-700 dark:text-slate-300">{host}</p>
            <p className="mt-4 text-sm text-gray-500 dark:text-slate-400">
              You're signed in as {user.email}. This site will see your name and email, and can open {config.app.name} as you.
              It doesn't get your password, your other apps or your account.
            </p>
            {error && (
              <div role="alert" className="mt-4 flex items-center gap-2 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200 dark:border-red-500/20">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="mt-6 flex flex-col gap-2">
              <Button onClick={proceed} isLoading={working} disabled={!armed}>Continue</Button>
              <a href={origin} className="min-h-11 inline-flex items-center justify-center text-sm text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">Cancel</a>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-center text-gray-900 dark:text-white tracking-tight">This site isn't connected</h1>
            <p role="alert" className="mt-2 text-center text-sm text-gray-500 dark:text-slate-400">
              {host ? <><span className="font-mono break-all">{host}</span> isn't a site you can sign in to from here.</> : 'This sign-in link is not complete.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
