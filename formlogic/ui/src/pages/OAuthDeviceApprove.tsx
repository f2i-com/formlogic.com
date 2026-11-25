import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { AlertCircle, Check, CheckCircle2, KeyRound, Loader2, ShieldCheck, XCircle } from 'lucide-react';

interface DeviceInfo {
  userCode: string;
  clientName: string;
  scopes: string[];
  scopeLabels: Record<string, string>;
  appId: string | null;
  expiresAt: string;
  status: string;
}

function formatUserCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * RFC 8628 / in-MCP browser approval screen for `/oauth/device?code=XXXX-XXXX`.
 *
 * Allows an AI assistant connected over MCP (e.g. starting from a zero-account public form)
 * to upgrade to a user-authorized session after the user explicitly signs in and approves
 * the exact verification code shown by their AI assistant.
 */
export function OAuthDeviceApprove() {
  useDocumentTitle('Approve AI sign-in');
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const apps = useAppStore((s) => s.apps);
  const fetchApps = useAppStore((s) => s.fetchApps);

  const initialCode = formatUserCode(searchParams.get('code') || searchParams.get('user_code') || '');
  const [codeInput, setCodeInput] = useState(initialCode);
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [appId, setAppId] = useState('');
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);
  const lastAutoCodeRef = useRef<string | null>(null);
  const lookupSeqRef = useRef(0);

  useEffect(() => () => {
    lookupSeqRef.current += 1;
  }, []);

  const isDemo = user?.isDemo === true;

  // Signed-out visitors go through the standard login page and bounce right back with ?code= intact.
  useEffect(() => {
    if (user) return;
    navigate(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  }, [user, navigate, location.pathname, location.search]);

  const lookupCode = useCallback(async (rawCode: string) => {
    const formatted = formatUserCode(rawCode);
    if (formatted.replace('-', '').length < 8) {
      setLookupError('Enter the 8-character code shown by your AI assistant (for example, ABCD-EFGH).');
      return;
    }
    const seq = ++lookupSeqRef.current;
    setLoading(true);
    setLookupError(null);
    setActionError(null);
    const res = await api.getOAuthDeviceInfo(formatted);
    if (lookupSeqRef.current !== seq) return;
    setLoading(false);
    if (res.data) {
      setInfo(res.data);
      setSelectedScopes(res.data.scopes || []);
      setAppId(res.data.appId || '');
    } else {
      setInfo(null);
      setLookupError(res.error || 'That code was not found or has expired. Ask your AI assistant to start a new sign-in.');
    }
  }, []);

  useEffect(() => {
    if (!user || !initialCode || lastAutoCodeRef.current === initialCode) return;
    lastAutoCodeRef.current = initialCode;
    setCodeInput(initialCode);
    void lookupCode(initialCode);
  }, [user, initialCode, lookupCode]);

  useEffect(() => {
    if (user && info && !isDemo) void fetchApps();
  }, [user, info, isDemo, fetchApps]);

  const handleLookupSubmit = (e: FormEvent) => {
    e.preventDefault();
    void lookupCode(codeInput);
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleDecision = async (deny: boolean) => {
    if (!info) return;
    if (!deny && !isDemo && selectedScopes.length === 0) {
      setActionError('Select at least one permission or deny the request.');
      return;
    }
    setSubmitting(true);
    setActionError(null);
    const res = await api.approveOAuthDevice({
      code: info.userCode,
      deny,
      scopes: deny ? undefined : selectedScopes,
      appId: deny || isDemo ? null : (appId || null),
    });
    setSubmitting(false);
    if (res.data?.success) {
      setOutcome(deny ? 'denied' : 'approved');
    } else {
      setActionError(res.error || 'Could not update this sign-in request. It may have expired.');
    }
  };

  let body: ReactNode;
  if (!user) {
    body = (
      <div className="text-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary-600 mx-auto" />
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-3">Taking you to sign in…</p>
      </div>
    );
  } else if (outcome === 'approved') {
    body = (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 dark:bg-emerald-500/15 flex items-center justify-center mb-4">
          <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">AI sign-in approved</h1>
        <p className="text-sm text-gray-600 dark:text-slate-300 mt-2">
          You can return to <span className="font-semibold text-gray-900 dark:text-white">{info?.clientName || 'your AI assistant'}</span> now — it can finish signing in and act on your behalf.
        </p>
        <p className="text-xs text-gray-400 dark:text-slate-500 mt-4">
          You can revoke this connection anytime from <strong>Connect an AI</strong> in your dashboard.
        </p>
        <div className="mt-6">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center rounded-xl border border-gray-200 dark:border-slate-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-800"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    );
  } else if (outcome === 'denied') {
    body = (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
          <XCircle className="h-6 w-6 text-gray-500 dark:text-slate-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Sign-in request denied</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">No access was granted. You can close this tab.</p>
      </div>
    );
  } else if (loading) {
    body = (
      <div className="text-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary-600 mx-auto" />
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-3">Checking verification code…</p>
      </div>
    );
  } else if (!info) {
    body = (
      <form onSubmit={handleLookupSubmit} className="space-y-4">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center mb-4">
            <KeyRound className="h-6 w-6 text-primary-600 dark:text-primary-400" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Connect your AI assistant</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Enter the 8-character verification code displayed by your AI assistant to link it to <span className="font-medium text-gray-700 dark:text-slate-200">{user.email}</span>.
          </p>
        </div>

        <div>
          <label htmlFor="device-user-code" className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">
            Verification code
          </label>
          <input
            id="device-user-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            value={codeInput}
            onChange={(e) => setCodeInput(formatUserCode(e.target.value))}
            placeholder="ABCD-EFGH"
            maxLength={9}
            className="w-full px-4 py-3 text-center text-xl font-mono font-bold tracking-[0.25em] uppercase border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>

        {lookupError && (
          <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{lookupError}</span>
          </div>
        )}

        <Button type="submit" className="w-full">Continue</Button>
      </form>
    );
  } else {
    const ownedApps = apps.filter((a) => a.ownerId === user.id);
    body = (
      <>
        <div className="text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center mb-4">
            <ShieldCheck className="h-6 w-6 text-primary-600 dark:text-primary-400" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">
            Approve <span className="text-primary-700 dark:text-primary-300">{info.clientName || 'AI Assistant'}</span>?
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Sign in as <span className="font-medium text-gray-800 dark:text-slate-200">{user.email}</span>
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-primary-200/80 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 px-4 py-3 text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-primary-700 dark:text-primary-300">
            Confirm this code matches your AI assistant
          </p>
          <p className="mt-1 text-2xl font-mono font-bold tracking-[0.22em] text-gray-900 dark:text-white">
            {info.userCode}
          </p>
        </div>

        {isDemo ? (
          <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            The shared demo account always grants <strong>read-only</strong> MCP access (apps, forms, and responses cannot be modified).
          </div>
        ) : (
          <div className="mt-5">
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Permissions requested:</p>
            <ul className="space-y-2">
              {info.scopes.map((scope) => {
                const checked = selectedScopes.includes(scope);
                return (
                  <li key={scope}>
                    <label className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScope(scope)}
                        className="mt-0.5 rounded accent-primary-600"
                      />
                      <span className="flex-1">
                        {info.scopeLabels?.[scope] || scope}
                        <span className="ml-1.5 text-[11px] font-mono text-gray-400 dark:text-slate-500">{scope}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!isDemo && ownedApps.length > 0 && (
          <div className="mt-5">
            <label htmlFor="device-app-limit" className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">
              Limit access to one app <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
            </label>
            <select
              id="device-app-limit"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            >
              <option value="">All my apps</option>
              {ownedApps.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}

        {actionError && (
          <div role="alert" className="mt-4 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-6">
          <Button onClick={() => void handleDecision(false)} isLoading={submitting} leftIcon={<Check className="h-4 w-4" />}>
            Approve AI sign-in
          </Button>
          <Button variant="outline" onClick={() => void handleDecision(true)} disabled={submitting}>
            Deny
          </Button>
        </div>

        <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-4 text-center">
          Only approve if you asked this AI assistant to connect. Tokens expire automatically and can be revoked anytime.
        </p>
      </>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 dark:bg-transparent flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Link to="/"><Logo size="lg" /></Link>
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5 sm:p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
          {body}
        </div>
      </div>
    </main>
  );
}

export default OAuthDeviceApprove;
