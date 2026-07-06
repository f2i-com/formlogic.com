import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { api } from '../lib/api';
import type { OAuthAuthorizeInfo, OAuthErrorInfo } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { AlertCircle, Check, Globe, Loader2, Plug, XCircle } from 'lucide-react';

/** Plain-language labels for the McpTokenService scope ids (unknown scopes show their raw id). */
const SCOPE_LABELS: Record<string, string> = {
  'apps:read': 'See your apps',
  'apps:write': 'Create and edit apps',
  'forms:read': 'See your forms',
  'forms:write': 'Create and edit forms',
  'screens:write': 'Create and edit custom screens',
  'responses:read': 'Read submitted form responses',
  'responses:write': 'Submit and edit form responses',
  'offline_access': 'Stay connected without asking you again',
};

/**
 * OAuth 2.1 consent page for external AI connectors (Claude, ChatGPT, Claude Code, …).
 * The client sends the user here with the standard authorize params; we pass them through
 * VERBATIM to the backend for validation (GET /api/oauth/authorize-info), show who is asking
 * and what they get, and on Approve the backend mints a one-time code and tells us where to
 * redirect. Signed-out visitors go through the existing ?redirect= login flow and land back
 * on this exact URL.
 *
 * Spec notes honored here:
 * - On a typed validation error (invalid_request / invalid_client / bad redirect_uri) we show
 *   the error and NEVER redirect — redirecting to an unvalidated URI is an open redirect.
 * - Deny redirects with error=access_denied (+ state) ONLY after the server validated the
 *   redirect_uri (i.e. authorize-info succeeded).
 * - The redirect host is displayed prominently (anti-phishing).
 */
export function OAuthAuthorize() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const apps = useAppStore((s) => s.apps);
  const fetchApps = useAppStore((s) => s.fetchApps);

  // The raw OAuth query params, verbatim — the server does ALL validation.
  const params = useMemo(() => Object.fromEntries(searchParams.entries()), [searchParams]);
  const missingClientId = !params.client_id;

  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null);
  const [oauthError, setOauthError] = useState<OAuthErrorInfo | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [appId, setAppId] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const requested = useRef(false);

  // Signed-out: send to the login flow with a return-to back to THIS full URL (the same
  // same-origin ?redirect= mechanism AcceptInvite uses; Login validates + navigates to it).
  useEffect(() => {
    if (user || missingClientId) return;
    navigate(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
  }, [user, missingClientId, navigate]);

  // Signed-in: validate the request server-side (once).
  useEffect(() => {
    if (!user || missingClientId || requested.current) return;
    requested.current = true;
    api.getOAuthAuthorizeInfo(params).then((r) => {
      if (r.data) setInfo(r.data);
      else if (r.oauthError) setOauthError(r.oauthError);
      else setNetworkError(r.networkError || 'Could not reach the server.');
    });
  }, [user, missingClientId, params]);

  // Load the user's apps for the optional "limit to one app" picker.
  useEffect(() => {
    if (user && info) void fetchApps();
  }, [user, info, fetchApps]);

  const approve = async () => {
    setApproving(true);
    setApproveError(null);
    const r = await api.approveOAuth(params, appId || undefined);
    if (r.data?.redirectTo) {
      // Keep the button in its loading state while the browser navigates away.
      window.location.assign(r.data.redirectTo);
      return;
    }
    setApproving(false);
    setApproveError(r.oauthError?.errorDescription || r.oauthError?.error || r.networkError || 'Could not complete the approval.');
  };

  const deny = () => {
    // Redirect with access_denied ONLY when the server validated redirect_uri (info present);
    // otherwise just tell the user they can close the window.
    if (info && params.redirect_uri) {
      try {
        const u = new URL(params.redirect_uri);
        u.searchParams.set('error', 'access_denied');
        if (params.state) u.searchParams.set('state', params.state);
        window.location.assign(u.toString());
        return;
      } catch { /* malformed URI — fall through to the static message */ }
    }
    setDenied(true);
  };

  const retry = () => {
    setNetworkError(null);
    api.getOAuthAuthorizeInfo(params).then((r) => {
      if (r.data) setInfo(r.data);
      else if (r.oauthError) setOauthError(r.oauthError);
      else setNetworkError(r.networkError || 'Could not reach the server.');
    });
  };

  const shownError: OAuthErrorInfo | null = missingClientId
    ? { error: 'invalid_request', errorDescription: 'The authorization link is missing its client_id. Please start the connection again from your AI client.' }
    : oauthError;

  let body: ReactNode;
  if (shownError) {
    body = (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
          <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">This connection request is invalid</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">
          {shownError.errorDescription || 'The authorization request could not be validated.'}
        </p>
        <p className="text-xs font-mono text-gray-400 dark:text-slate-500 mt-2">{shownError.error}</p>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-4">Nothing was shared. You can close this window and try connecting again from your AI client.</p>
      </div>
    );
  } else if (denied) {
    body = (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-gray-100 dark:bg-slate-800 flex items-center justify-center mb-4">
          <XCircle className="h-6 w-6 text-gray-500 dark:text-slate-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Access denied</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">No access was granted. You can close this window.</p>
      </div>
    );
  } else if (networkError) {
    body = (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
          <AlertCircle className="h-6 w-6 text-red-500 dark:text-red-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">Couldn't check this request</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">{networkError}</p>
        <Button variant="outline" className="mt-6" onClick={retry}>Try again</Button>
      </div>
    );
  } else if (!user || !info) {
    body = (
      <div className="text-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary-600 mx-auto" />
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-3">{user ? 'Checking this connection request…' : 'Taking you to sign in…'}</p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-4">
            <Plug className="h-6 w-6 text-primary-600 dark:text-primary-400" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">
            <span className="text-primary-700 dark:text-primary-300">{info.clientName}</span> wants to connect
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">to your FormLogic account ({user.email})</p>
        </div>

        {/* Where the browser goes after approval — shown prominently (anti-phishing). */}
        <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-gray-200/80 dark:border-slate-700/60 bg-gray-50 dark:bg-slate-800/60 px-3.5 py-2.5">
          <Globe className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" />
          <p className="text-xs text-gray-600 dark:text-slate-300 min-w-0">
            After you approve, you'll be sent back to{' '}
            <span className="font-semibold text-gray-900 dark:text-white break-all">{info.redirectHost}</span>
          </p>
        </div>

        <div className="mt-5">
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">This will let it:</p>
          <ul className="space-y-1.5">
            {info.scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-200">
                <Check className="h-4 w-4 shrink-0 mt-0.5 text-primary-600 dark:text-primary-400" />
                <span>{SCOPE_LABELS[scope] || scope}</span>
              </li>
            ))}
          </ul>
        </div>

        {apps.length > 0 && (
          <div className="mt-5">
            <label htmlFor="oauth-app-limit" className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">
              Limit access to one app <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
            </label>
            <select
              id="oauth-app-limit"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200"
            >
              <option value="">All my apps</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}

        {approveError && (
          <div className="mt-4 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{approveError}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-6">
          <Button onClick={approve} isLoading={approving}>Approve access</Button>
          <Button variant="outline" onClick={deny} disabled={approving}>Deny</Button>
        </div>

        <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-4 text-center">
          Only approve if you started this connection yourself. You can revoke it anytime from Connect an AI.
        </p>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-transparent flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Link to="/"><Logo size="lg" /></Link>
        </div>
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-8 shadow-lg shadow-gray-900/[0.04] dark:shadow-black/20">
          {body}
        </div>
      </div>
    </div>
  );
}

export default OAuthAuthorize;
