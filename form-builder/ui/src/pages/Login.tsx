import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Logo, LogoWhite } from '../components/ui/Logo';
import { Mail, Lock, AlertCircle } from 'lucide-react';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const navigate = useNavigate();
  const { login, isLoading, error, clearError, user } = useAuthStore();

  useEffect(() => {
    if (user) {
      navigate('/');
    }
  }, [user, navigate]);

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
      navigate('/');
    }
  };

  const displayError = localError || error;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex">
      {/* Left panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-indigo-900 to-slate-900 dark:from-slate-900/80 dark:to-slate-950/80 backdrop-blur-xl p-12 flex-col justify-between relative overflow-hidden">
        <div className="absolute inset-0 bg-grid-white/[0.02] bg-[length:50px_50px]" />
        <div className="relative z-10">
          <Link to="/">
            <LogoWhite size="lg" />
          </Link>
        </div>
        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white mb-4">
            Welcome back
          </h1>
          <p className="text-indigo-200 text-lg">
            Sign in to access your forms, responses, and analytics.
          </p>
        </div>
        <p className="text-indigo-300 text-sm relative z-10">
          Trusted by developers and agencies worldwide.
        </p>
      </div>

      {/* Right panel - Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-white/0 dark:bg-slate-900/40 backdrop-blur-sm">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8">
            <Link to="/">
              <Logo size="lg" />
            </Link>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Sign in</h2>
          <p className="text-gray-600 dark:text-slate-400 mb-8">
            Don't have an account?{' '}
            <Link to="/signup" className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 font-medium">
              Create one
            </Link>
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            {displayError && (
              <div className="flex items-center gap-2 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-lg border border-red-200 dark:border-red-500/20">
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

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              leftIcon={<Lock className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="current-password"
              required
            />

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
              Sign In
            </Button>
          </form>

          <p className="mt-8 text-center text-sm text-gray-500 dark:text-slate-500">
            <Link to="/" className="text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">
              &larr; Back to home
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
