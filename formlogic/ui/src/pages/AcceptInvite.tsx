import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAppUserStore } from '../stores/appUserStore';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { CheckCircle2, AlertCircle, Loader2, Mail } from 'lucide-react';

/**
 * Redeems an app invitation. The invite link carries a one-time ?token=. The
 * user must be signed in with the invited email (the backend rejects a mismatch),
 * so unauthenticated visitors are routed to sign in / sign up and returned here.
 */
export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.isLoading);
  const logout = useAuthStore((s) => s.logout);
  const acceptInvitation = useAppUserStore((s) => s.acceptInvitation);

  const [status, setStatus] = useState<'idle' | 'accepting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || !user || attempted.current) return;
    attempted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: status must switch to 'accepting' synchronously before the async acceptInvitation call when token/user become available
    setStatus('accepting');
    acceptInvitation(token)
      .then(() => {
        setStatus('success');
        setTimeout(() => navigate('/apps'), 1500);
      })
      .catch((e) => {
        setStatus('error');
        setErrorMsg(e instanceof Error ? e.message : 'Could not accept this invitation.');
      });
  }, [token, user, acceptInvitation, navigate]);

  const redirect = `/accept-invite?token=${encodeURIComponent(token)}`;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Link to="/"><Logo size="lg" /></Link>
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20 text-center">
          {!token ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
                <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Invalid invitation link</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">This link is missing its invitation token. Please use the exact link you were sent.</p>
              <Button variant="outline" className="mt-6" onClick={() => navigate('/')}>Go to home</Button>
            </>
          ) : !user ? (
            authLoading ? (
              <Loader2 className="h-7 w-7 animate-spin text-primary-600 mx-auto" />
            ) : (
              <>
                <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
                  <Mail className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                </div>
                <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">You're invited to an app</h1>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Sign in (or create an account) with the email this invite was sent to, and you'll be added automatically.</p>
                <div className="flex flex-col gap-2 mt-6">
                  <Button onClick={() => navigate(`/login?redirect=${encodeURIComponent(redirect)}`)}>Sign in to accept</Button>
                  <Button variant="outline" onClick={() => navigate(`/signup?redirect=${encodeURIComponent(redirect)}`)}>Create an account</Button>
                </div>
              </>
            )
          ) : status === 'success' ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-green-50 dark:bg-green-500/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-6 w-6 text-green-500 dark:text-green-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Invitation accepted</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">You now have access. Taking you to your apps…</p>
            </>
          ) : status === 'error' ? (
            <>
              <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
                <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
              </div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Couldn't accept the invitation</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{errorMsg}</p>
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-2">Make sure you're signed in with the email the invite was sent to ({user.email}).</p>
              <div className="flex flex-col gap-2 mt-6">
                <Button
                  isLoading={signingOut}
                  onClick={async () => {
                    setSigningOut(true);
                    await logout();
                    navigate(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
                  }}
                >
                  Sign out & use a different account
                </Button>
                <Button variant="outline" onClick={() => navigate('/apps')}>Go to my apps</Button>
              </div>
            </>
          ) : (
            <>
              <Loader2 className="h-7 w-7 animate-spin text-primary-600 mx-auto" />
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-3">Accepting your invitation…</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AcceptInvite;
