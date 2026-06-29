import { useState, useEffect } from 'react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PasswordInput } from '../ui/PasswordInput';
import { AlertCircle, Lock, Mail, UserPlus, Clock } from 'lucide-react';

interface AppRuntimeAuthGuardProps {
  children: React.ReactNode;
}

export function AppRuntimeAuthGuard({ children }: AppRuntimeAuthGuardProps) {
  const { config, isLoading, error, appSlug, initialize } = useAppRuntimeStore();
  const { user, login, isLoading: authLoading } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [membershipInfo, setMembershipInfo] = useState<{ appName: string; status: string; isMember: boolean; canSelfRegister: boolean } | null>(null);
  const [membershipChecked, setMembershipChecked] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Logged in but the app didn't load (likely not a member): discover whether
  // self-registration is allowed or we're awaiting approval. Track when the probe
  // has resolved so we don't flash "Access Denied" before we know.
  useEffect(() => {
    if (user && !config && appSlug && !isLoading) {
      let cancelled = false;
      setMembershipChecked(false);
      api.getAppMembership(appSlug)
        .then((r) => { if (!cancelled && r.data) setMembershipInfo(r.data); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setMembershipChecked(true); });
      return () => { cancelled = true; };
    }
    setMembershipInfo(null);
    setMembershipChecked(false);
  }, [user, config, appSlug, isLoading]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading app" />
      </div>
    );
  }

  // If there's an error and user isn't logged in, show login form
  const isAuthError = error && (!user || error.toLowerCase().includes('authentication') || error.toLowerCase().includes('token'));

  // Also treat "logged out with no app loaded" as an auth state — a session that
  // expires mid-use clears both user and config (and error), which would
  // otherwise fall through to a dead-end "Unable to Load" screen instead of an
  // inline re-login form.
  const showLogin = !user && (!config || isAuthError);

  if (showLogin) {
    const handleLogin = async (e: React.FormEvent) => {
      e.preventDefault();
      setLoginError(null);

      if (!email || !password) {
        setLoginError('Please fill in all fields');
        return;
      }

      const result = await login(email, password);
      if (result.success && appSlug) {
        // Re-initialize the app after login
        try {
          await initialize(appSlug);
        } catch {
          setLoginError('Login succeeded but failed to load the app. Please refresh.');
        }
      } else if (!result.success) {
        // Surface the real server message (rate-limit/lockout/network) instead of
        // always blaming the credentials.
        setLoginError(result.error || 'Invalid email or password');
      }
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
        <div className="w-full max-w-md">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
            <div className="text-center mb-6">
              <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-3">
                <Lock className="h-6 w-6 text-primary-600 dark:text-primary-400" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Sign in to continue</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Please log in to access this app</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <div role="alert" className="flex items-center gap-2 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200 dark:border-red-500/20">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}

              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                leftIcon={<Mail className="h-4 w-4" />}
                autoComplete="username"
                disabled={authLoading}
                required
              />

              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                leftIcon={<Lock className="h-4 w-4" />}
                autoComplete="current-password"
                disabled={authLoading}
                required
              />

              <Button type="submit" className="w-full" isLoading={authLoading}>
                Sign In
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-gray-500 dark:text-slate-500">
              <a href="/" className="text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">
                &larr; Back to home
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Logged in, not a member: offer self-registration or show awaiting-approval.
  if (user && !config && membershipInfo && !membershipInfo.isMember) {
    const handleJoin = async () => {
      if (!appSlug) return;
      setJoining(true);
      setJoinError(null);
      const r = await api.joinApp(appSlug);
      setJoining(false);
      if (r.error) { setJoinError(r.error); return; }
      if (r.data?.status === 'pending') {
        setMembershipInfo((m) => (m ? { ...m, status: 'pending' } : m));
      } else {
        await initialize(appSlug);
      }
    };

    if (membershipInfo.status === 'pending') {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
          <div className="text-center max-w-md mx-auto">
            <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center mb-4">
              <Clock className="h-6 w-6 text-amber-500 dark:text-amber-400" />
            </div>
            <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white tracking-tight">Awaiting approval</h2>
            <p className="text-gray-500 dark:text-slate-400 mb-4">Your request to join {membershipInfo.appName} is pending an admin's approval. You'll get access once it's approved.</p>
            <a href="/" className="text-sm app-text-primary hover:underline">Go to Home</a>
          </div>
        </div>
      );
    }

    if (membershipInfo.canSelfRegister) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
          <div className="text-center max-w-md mx-auto bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
            <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
              <UserPlus className="h-6 w-6 text-primary-600 dark:text-primary-400" />
            </div>
            <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white tracking-tight">Join {membershipInfo.appName}</h2>
            <p className="text-gray-500 dark:text-slate-400 mb-6">You're not a member yet. Join to start using this app.</p>
            {joinError && (
              <div role="alert" className="flex items-center gap-2 p-3 mb-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200 dark:border-red-500/20 text-left">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{joinError}</span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Button onClick={handleJoin} isLoading={joining}>Join app</Button>
              <a href="/" className="text-sm text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">Go to Home</a>
            </div>
          </div>
        </div>
      );
    }
  }

  // Logged in, app not loaded, and the membership probe hasn't resolved yet — show a
  // loader rather than flashing "Access Denied" before we know the user can join.
  if (user && !config && !membershipChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
            <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
          </div>
          <h2 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white tracking-tight">
            {error?.includes('403') || error?.includes('401') || error?.includes('denied') || error?.includes('permission') ? 'Access Denied' : 'Unable to Load'}
          </h2>
          <p className="text-gray-500 dark:text-slate-400 mb-4">{error || 'Unable to load this app. Please try again later.'}</p>
          <div className="flex items-center justify-center gap-3">
            <button type="button" onClick={() => window.location.reload()} className="text-sm text-gray-600 dark:text-slate-300 hover:underline cursor-pointer transition-colors">Try Again</button>
            <a href="/" className="text-sm app-text-primary hover:underline">Go to Home</a>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
