import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Logo } from '../components/ui/Logo';
import { Lock, AlertCircle, CheckCircle2 } from 'lucide-react';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) { setError('Password must be at least 10 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setSubmitting(true);
    const result = await api.resetPassword(token, password);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
    } else {
      setDone(true);
    }
  };

  // Redirect to login shortly after success — via an effect so it's cancelled if the
  // user navigates away first (no setState/navigate on an unmounted component).
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => navigate('/login'), 2000);
    return () => clearTimeout(t);
  }, [done, navigate]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        <div className="flex justify-center mb-8"><Link to="/"><Logo size="lg" /></Link></div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
          {!token ? (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
                <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Invalid reset link</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">This link is missing its token. Request a new reset link.</p>
              <Link to="/forgot-password" className="inline-block mt-6 text-sm text-primary-600 dark:text-primary-400 hover:underline">Request a new link</Link>
            </div>
          ) : done ? (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-green-50 dark:bg-green-500/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-6 w-6 text-green-500 dark:text-green-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Password reset</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Taking you to sign in…</p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 tracking-tight">Set a new password</h1>
              <p className="text-gray-500 dark:text-slate-400 mb-6 text-sm">Choose a new password for your account.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div role="alert" className="flex items-center gap-2.5 p-3.5 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200/80 dark:border-red-500/20">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <PasswordInput
                  label="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 10 characters"
                  leftIcon={<Lock className="h-4 w-4" />}
                  autoComplete="new-password"
                  required
                />
                <PasswordInput
                  label="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  leftIcon={<Lock className="h-4 w-4" />}
                  autoComplete="new-password"
                  error={confirm && password !== confirm ? 'Passwords do not match' : undefined}
                  required
                />
                <Button type="submit" className="w-full" size="lg" isLoading={submitting}>Reset password</Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetPassword;
