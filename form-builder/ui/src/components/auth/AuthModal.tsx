import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { Mail, Lock, User, AlertCircle, Loader2 } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'register';
}

export function AuthModal({ isOpen, onClose, initialMode = 'login' }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');

  // Sync mode when initialMode prop changes (e.g. opening from different buttons)
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const { login, register, isLoading, error, clearError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    if (!email || !password) {
      setLocalError('Please fill in all required fields');
      return;
    }

    if (mode === 'register') {
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
        handleClose();
      }
    } else {
      const result = await login(email, password);
      if (result.success) {
        handleClose();
      }
    }
  };

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setName('');
    setConfirmPassword('');
    setLocalError(null);
    clearError();
    onClose();
  };

  const toggleMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setLocalError(null);
    clearError();
  };

  const displayError = localError || error;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={mode === 'login' ? 'Sign In' : 'Create Account'}
      size="sm"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        {displayError && (
          <div className="flex items-center gap-2.5 p-3.5 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl animate-shake">
            <div className="p-1 bg-red-100 dark:bg-red-500/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
            </div>
            <span className="font-medium">{displayError}</span>
          </div>
        )}

        {mode === 'register' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
              Name
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="pl-10"
                disabled={isLoading}
              />
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
            Email <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="pl-10"
              disabled={isLoading}
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
            Password <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
              className="pl-10"
              disabled={isLoading}
              required
            />
          </div>
        </div>

        {mode === 'register' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
              Confirm Password <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                className="pl-10"
                disabled={isLoading}
                required
              />
            </div>
          </div>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={isLoading}
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {mode === 'login' ? 'Signing in...' : 'Creating account...'}
            </>
          ) : (
            mode === 'login' ? 'Sign In' : 'Create Account'
          )}
        </Button>

        <div className="pt-2 text-center text-sm text-gray-600 dark:text-slate-400">
          {mode === 'login' ? (
            <>
              Don't have an account?{' '}
              <button
                type="button"
                onClick={toggleMode}
                className="text-primary-600 hover:text-primary-700 font-semibold transition-colors focus:outline-none focus-visible:underline"
                disabled={isLoading}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={toggleMode}
                className="text-primary-600 hover:text-primary-700 font-semibold transition-colors focus:outline-none focus-visible:underline"
                disabled={isLoading}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
