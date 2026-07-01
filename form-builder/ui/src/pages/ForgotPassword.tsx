import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Logo } from '../components/ui/Logo';
import { Mail, CheckCircle2 } from 'lucide-react';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setSubmitting(true);
    // The endpoint always responds success (no account enumeration), so we show
    // the same confirmation regardless of whether the email exists.
    await api.requestPasswordReset(email).catch(() => {});
    setSubmitting(false);
    setSent(true);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex items-center justify-center p-6 relative overflow-hidden">
      {/* Brand background treatment shared with Login/Signup */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-primary-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden="true" />
      <div className="absolute bottom-0 left-0 w-72 h-72 bg-primary-500/10 rounded-full blur-[100px] pointer-events-none" aria-hidden="true" />
      <div className="w-full max-w-[400px] relative z-10">
        <div className="flex justify-center mb-8"><Link to="/"><Logo size="lg" /></Link></div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-green-50 dark:bg-green-500/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-6 w-6 text-green-500 dark:text-green-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Check your email</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                If an account exists for <span className="font-medium text-gray-700 dark:text-slate-300">{email}</span>, we've sent a link to reset your password. The link expires in 1 hour.
              </p>
              <div className="mt-6 space-y-2">
                <button
                  type="button"
                  onClick={() => setSent(false)}
                  className="text-sm text-primary-600 dark:text-primary-400 hover:underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 rounded"
                >
                  Wrong email? Try again
                </button>
                <p>
                  <Link to="/login" className="text-sm text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">Back to sign in</Link>
                </p>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 tracking-tight">Forgot password?</h1>
              <p className="text-gray-500 dark:text-slate-400 mb-6 text-sm">Enter your email and we'll send you a reset link.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  leftIcon={<Mail className="h-4 w-4" />}
                  autoComplete="username"
                  required
                />
                <Button type="submit" className="w-full" size="lg" isLoading={submitting}>Send reset link</Button>
              </form>
              <p className="mt-6 text-center text-sm text-gray-500 dark:text-slate-500">
                <Link to="/login" className="text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">&larr; Back to sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ForgotPassword;
