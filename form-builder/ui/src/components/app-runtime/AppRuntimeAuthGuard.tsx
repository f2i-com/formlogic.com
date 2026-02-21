import { useState } from 'react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../ui/Button';
import { AlertCircle, Lock, Mail } from 'lucide-react';

interface AppRuntimeAuthGuardProps {
  children: React.ReactNode;
}

export function AppRuntimeAuthGuard({ children }: AppRuntimeAuthGuardProps) {
  const { config, isLoading, error, appSlug, initialize } = useAppRuntimeStore();
  const { user, login, isLoading: authLoading } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" role="status" aria-label="Loading app" />
      </div>
    );
  }

  // If there's an error and user isn't logged in, show login form
  const isAuthError = error && (!user || error.toLowerCase().includes('authentication') || error.toLowerCase().includes('token'));

  if (isAuthError) {
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
        setLoginError('Invalid email or password');
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
                <div className="flex items-center gap-2 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200 dark:border-red-500/20">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pl-10 pr-3.5 py-2.5 border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200"
                    disabled={authLoading}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                    className="w-full pl-10 pr-3.5 py-2.5 border border-gray-200 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200"
                    disabled={authLoading}
                    required
                  />
                </div>
              </div>

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
            <button type="button" onClick={() => window.location.reload()} className="text-sm text-gray-600 dark:text-slate-300 hover:underline cursor-pointer">Try Again</button>
            <a href="/" className="text-sm app-text-primary hover:underline">Go to Home</a>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
