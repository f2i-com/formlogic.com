import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Logo, LogoWhite } from '../components/ui/Logo';
import { Mail, Lock, User, AlertCircle, Check } from 'lucide-react';

export function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const navigate = useNavigate();
  const { register, isLoading, error, clearError, user } = useAuthStore();

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

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters');
      return;
    }

    const result = await register(email, password, name || undefined);
    if (result.success) {
      navigate('/');
    }
  };

  const displayError = localError || error;

  const benefits = [
    'Unlimited forms with the free plan',
    'Real backend logic with scripting',
    'SQLite database per form',
    'Full data ownership',
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex">
      {/* Left panel - Branding */}
      <div className="hidden lg:flex lg:w-[45%] bg-gradient-to-br from-indigo-600 via-indigo-700 to-slate-900 dark:from-slate-900/80 dark:via-indigo-950/60 dark:to-slate-950/80 backdrop-blur-xl p-12 flex-col justify-between relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:60px_60px]" />
        <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-purple-600/15 rounded-full blur-[100px]" />

        <div className="relative z-10">
          <Link to="/">
            <LogoWhite size="lg" />
          </Link>
        </div>
        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white mb-4 tracking-tight">
            Start building smarter forms
          </h1>
          <p className="text-indigo-200/80 text-lg mb-8 leading-relaxed">
            Create forms with real backend logic and full data control.
          </p>
          <ul className="space-y-3.5">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-center gap-3 text-white/90">
                <div className="p-0.5 rounded-full bg-indigo-400/20">
                  <Check className="h-4 w-4 text-indigo-300" />
                </div>
                {benefit}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-indigo-300/60 text-sm relative z-10">
          No credit card required. Get started in seconds.
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

          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 tracking-tight">Create your account</h2>
          <p className="text-gray-500 dark:text-slate-400 mb-8">
            Already have an account?{' '}
            <Link to="/login" className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 font-medium transition-colors">
              Sign in
            </Link>
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {displayError && (
              <div className="flex items-center gap-2.5 p-3.5 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 rounded-xl border border-red-200/80 dark:border-red-500/20 animate-shake">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <Input
              label="Name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              leftIcon={<User className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="name"
            />

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              leftIcon={<Mail className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="email"
              required
            />

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              leftIcon={<Lock className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="new-password"
              required
            />

            <Input
              label="Confirm Password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              leftIcon={<Lock className="h-4 w-4" />}
              disabled={isLoading}
              autoComplete="new-password"
              required
            />

            <div className="pt-1">
              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                Create Account
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
