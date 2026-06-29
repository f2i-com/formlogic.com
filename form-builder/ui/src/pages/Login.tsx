import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Logo, LogoWhite } from '../components/ui/Logo';
import { Mail, Lock, AlertCircle } from 'lucide-react';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, isLoading, error, clearError, user } = useAuthStore();

  // Honor a same-origin redirect target (e.g. accepting an app invitation).
  // Reject protocol-relative (//host) and backslash (/\host) forms, which would
  // otherwise be open-redirects to another origin.
  const redirectParam = searchParams.get('redirect');
  const dest = redirectParam && /^\/(?![/\\])/.test(redirectParam) ? redirectParam : '/';

  useEffect(() => {
    if (user) {
      navigate(dest);
    }
  }, [user, navigate, dest]);

  useEffect(() => {
    return () => {
      clearError();
    };
  }, [clearError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    if (!email || !password) {
      setLocalError('Please fill in all required fields');
      return;
    }

    const result = await login(email, password);
    if (result.success) {
      navigate(dest);
    }
  };

  const displayError = localError || error;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex">
      {/* Left panel - Branding */}
      <div className="hidden lg:flex lg:w-[45%] bg-gradient-to-br from-primary-600 via-primary-700 to-slate-900 dark:from-slate-900/80 dark:via-primary-950/60 dark:to-slate-950/80 backdrop-blur-xl p-12 flex-col justify-between relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:60px_60px]" />
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary-500/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-primary-500/15 rounded-full blur-[100px]" />

        <div className="relative z-10">
          <Link to="/">
            <LogoWhite size="lg" />
          </Link>
        </div>
        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white mb-4 tracking-tight">
            Welcome back
          </h1>
          <p className="text-primary-200/80 text-lg leading-relaxed">
            Sign in to access your forms, responses, and analytics.
          </p>
        </div>
        <p className="text-primary-300/60 text-sm relative z-10">
          Trusted by developers and agencies worldwide.
        </p>
      </div>

      {/* Right panel - Form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-[400px]">
          <div className="lg:hidden mb-8">
            <Link to="/">
              <Logo size="lg" />
            </Link>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 tracking-tight">Sign in</h2>
          <p className="text-gray-500 dark:text-slate-400 mb-8">
            Don't have an account?{' '}
            <Link to="/signup" className="text-primary-600 dark:text-primary-400 hover:text-primary-500 dark:hover:text-primary-300 font-medium transition-colors">
              Create one
            </Link>
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {displayError && (
              <div role="alert" aria-live="assertive" className="flex items-center gap-2.5 p-3.5 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200/80 dark:border-red-500/20 animate-shake">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              leftIcon={<Mail className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="username"
              required
            />

            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              leftIcon={<Lock className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="current-password"
              required
            />

            <div className="flex justify-end -mt-1">
              <Link to="/forgot-password" className="text-sm text-primary-600 dark:text-primary-400 hover:text-primary-500 dark:hover:text-primary-300 font-medium transition-colors">
                Forgot password?
              </Link>
            </div>

            <div className="pt-1">
              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                Sign In
              </Button>
            </div>
          </form>

          <p className="mt-8 text-center text-sm text-gray-500 dark:text-slate-500">
            <Link to="/" className="text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
              &larr; Back to home
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
