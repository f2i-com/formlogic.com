import { useContext, useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/authStore';
import { DomainSignInContext, startDomainSignIn } from '../../lib/domainSignIn';
import { Mail, Lock, User, AlertCircle, Loader2, ShieldCheck } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'register';
}

export function AuthModal({ isOpen, onClose, initialMode = 'login' }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset form & MFA state whenever the modal closes via props or opens in a different mode.
  const [prevModalProps, setPrevModalProps] = useState({ isOpen, initialMode });
  if (prevModalProps.isOpen !== isOpen || prevModalProps.initialMode !== initialMode) {
    setPrevModalProps({ isOpen, initialMode });
    if (!isOpen || prevModalProps.initialMode !== initialMode) {
      setMode(initialMode);
      setEmail('');
      setPassword('');
      setName('');
      setConfirmPassword('');
      setMfaToken(null);
      setMfaCode('');
      setRememberBrowser(false);
      setLocalError(null);
    }
  }

  const { login, verifyMfa, register, isLoading, error, clearError } = useAuthStore();

  // On an app's own domain the form is on FormLogic, never here (see domainSignIn).
  const signInAt = useContext(DomainSignInContext);
  useEffect(() => {
    if (isOpen && signInAt) startDomainSignIn(signInAt, initialMode === 'register' ? 'signup' : 'login', window.location.pathname + window.location.search);
  }, [isOpen, signInAt, initialMode]);

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
      } else if (result.error) {
        setLocalError(result.error);
      }
    } else {
      const result = await login(email, password);
      if (result.mfaRequired && result.mfaToken) {
        setPassword('');
        setMfaToken(result.mfaToken);
        setMfaCode('');
        return;
      }
      if (result.success) {
        handleClose();
      } else if (result.error) {
        setLocalError(result.error);
      }
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearError();
    if (!mfaToken) return;
    if (!mfaCode.trim()) {
      setLocalError('Enter the code from your authenticator app');
      return;
    }
    const result = await verifyMfa(mfaToken, mfaCode.trim(), rememberBrowser);
    if (result.success) {
      handleClose();
    } else {
      if (result.error) setLocalError(result.error);
      if ((result.error || '').toLowerCase().includes('expired')) {
        setMfaToken(null);
        setMfaCode('');
      }
    }
  };

  const backToPassword = () => {
    setPassword('');
    setMfaToken(null);
    setMfaCode('');
    setLocalError(null);
    clearError();
  };

  const handleClose = () => {
    setEmail('');
    setPassword('');
    setName('');
    setConfirmPassword('');
    setMfaToken(null);
    setMfaCode('');
    setRememberBrowser(false);
    setLocalError(null);
    setMode(initialMode);
    clearError();
    onClose();
  };

  const toggleMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setMfaToken(null);
    setMfaCode('');
    setLocalError(null);
    clearError();
  };

  const displayError = localError || error;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={mfaToken ? 'Two-Factor Verification' : mode === 'login' ? 'Sign In' : 'Create Account'}
      size="sm"
    >
      {mfaToken ? (
      <form onSubmit={handleMfaSubmit} className="p-6 space-y-5">
        {displayError && (
          <div role="alert" aria-live="assertive" className="flex items-center gap-2.5 p-3.5 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl animate-shake">
            <div className="p-1 bg-red-100 dark:bg-red-500/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
            </div>
            <span className="font-medium">{displayError}</span>
          </div>
        )}

        <p className="text-sm text-gray-600 dark:text-slate-300">
          Enter the 6-digit code from your authenticator app or a recovery code.
        </p>

        <div>
          <label htmlFor="auth-mfa-code" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
            Verification code <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
            <Input
              id="auth-mfa-code"
              type="text"
              inputMode="text"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              placeholder="123456"
              className="pl-10"
              disabled={isLoading}
              autoComplete="one-time-code"
              required
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={rememberBrowser}
            onChange={(e) => setRememberBrowser(e.target.checked)}
            disabled={isLoading}
            className="rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
          />
          <span>Remember this browser for 60 days</span>
        </label>

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Verifying...
            </>
          ) : (
            'Verify & Sign In'
          )}
        </Button>

        <div className="pt-1 text-center text-sm">
          <button
            type="button"
            onClick={backToPassword}
            className="text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-white cursor-pointer"
            disabled={isLoading}
          >
            &larr; Back to sign in
          </button>
        </div>
      </form>
      ) : (
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        {displayError && (
          <div role="alert" aria-live="assertive" className="flex items-center gap-2.5 p-3.5 text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl animate-shake">
            <div className="p-1 bg-red-100 dark:bg-red-500/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
            </div>
            <span className="font-medium">{displayError}</span>
          </div>
        )}

        {mode === 'register' && (
          <div>
            <label htmlFor="auth-name" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
              Name
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <Input
                id="auth-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="pl-10"
                disabled={isLoading}
                autoComplete="name"
              />
            </div>
          </div>
        )}

        <div>
          <label htmlFor="auth-email" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
            Email <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
            <Input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="pl-10"
              disabled={isLoading}
              autoComplete={mode === 'login' ? 'username' : 'email'}
              required
            />
          </div>
        </div>

        <div>
          <label htmlFor="auth-password" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
            Password <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
            <Input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
              className="pl-10"
              disabled={isLoading}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          </div>
        </div>

        {mode === 'register' && (
          <div>
            <label htmlFor="auth-confirm-password" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
              Confirm Password <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-slate-500" />
              <Input
                id="auth-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                className="pl-10"
                disabled={isLoading}
                autoComplete="new-password"
                error={confirmPassword && password !== confirmPassword ? 'Passwords do not match' : undefined}
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
                className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 font-semibold transition-colors focus:outline-none focus-visible:underline cursor-pointer"
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
                className="text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 font-semibold transition-colors focus:outline-none focus-visible:underline cursor-pointer"
                disabled={isLoading}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </form>
      )}
    </Modal>
  );
}
