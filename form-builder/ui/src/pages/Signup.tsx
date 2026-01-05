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
    <div className="min-h-screen bg-gray-50 flex">
      {/* Left panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-indigo-600 to-indigo-800 p-12 flex-col justify-between">
        <Link to="/">
          <LogoWhite size="lg" />
        </Link>
        <div>
          <h1 className="text-4xl font-bold text-white mb-4">
            Start building smarter forms
          </h1>
          <p className="text-indigo-200 text-lg mb-8">
            Create forms with real backend logic and full data control.
          </p>
          <ul className="space-y-3">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-center gap-3 text-white">
                <Check className="h-5 w-5 text-indigo-300" />
                {benefit}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-indigo-300 text-sm">
          No credit card required. Get started in seconds.
        </p>
      </div>

      {/* Right panel - Form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8">
            <Link to="/">
              <Logo size="lg" />
            </Link>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-2">Create your account</h2>
          <p className="text-gray-600 mb-8">
            Already have an account?{' '}
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">
              Sign in
            </Link>
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            {displayError && (
              <div className="flex items-center gap-2 p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
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
            />

            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              leftIcon={<Mail className="h-4 w-4" />}
              disabled={isLoading}
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
              required
            />

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
              Create Account
            </Button>
          </form>

          <p className="mt-8 text-center text-sm text-gray-500">
            <Link to="/" className="text-gray-600 hover:text-gray-900">
              &larr; Back to home
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
