import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Monitor, Play, RefreshCw, ShieldCheck, Smartphone, Sparkles, Database } from 'lucide-react';
import { Button } from '../ui/Button';
import { api, resolveFileUrl, type MarketplaceDemoSession } from '../../lib/api';
import { cn } from '../../lib/utils';

interface MarketplaceDemoFrameProps {
  slug: string;
  name: string;
  sourceProtected?: boolean;
  hasBackend?: boolean;
  backendRuntime?: string | null;
  renderMode?: 'dom_ssr' | 'sandbox_web';
  autoLaunch?: boolean;
  fullHeight?: boolean;
  compact?: boolean;
  refreshSignal?: number;
  resetSignal?: number;
  onSessionReady?: (session: MarketplaceDemoSession | null) => void;
  onSessionReset?: () => void;
}

const SESSION_STORAGE_PREFIX = 'fl-demo-sbx:v1:';

function readStoredSandboxSession(slug: string): MarketplaceDemoSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_PREFIX + slug);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketplaceDemoSession;
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.framePath !== 'string' || parsed.slug !== slug) {
      return null;
    }
    const exp = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(exp) || exp < Date.now() + 60_000) {
      window.sessionStorage.removeItem(SESSION_STORAGE_PREFIX + slug);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSandboxSession(slug: string, session: MarketplaceDemoSession | null): void {
  try {
    if (!session) {
      window.sessionStorage.removeItem(SESSION_STORAGE_PREFIX + slug);
    } else {
      window.sessionStorage.setItem(SESSION_STORAGE_PREFIX + slug, JSON.stringify(session));
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export function MarketplaceDemoFrame({
  slug,
  name,
  sourceProtected = true,
  hasBackend = false,
  backendRuntime,
  renderMode,
  autoLaunch = false,
  fullHeight = false,
  compact = false,
  refreshSignal = 0,
  resetSignal = 0,
  onSessionReady,
  onSessionReset,
}: MarketplaceDemoFrameProps) {
  const [session, setSession] = useState<MarketplaceDemoSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [frameKey, setFrameKey] = useState(0);
  const autoLaunchedRef = useRef<string | null>(null);
  const lastResetSignalRef = useRef<number>(resetSignal);
  const onSessionReadyRef = useRef(onSessionReady);
  const onSessionResetRef = useRef(onSessionReset);

  useEffect(() => {
    onSessionReadyRef.current = onSessionReady;
    onSessionResetRef.current = onSessionReset;
  }, [onSessionReady, onSessionReset]);

  const commitSession = useCallback((next: MarketplaceDemoSession | null) => {
    setSession(next);
    writeStoredSandboxSession(slug, next);
    onSessionReadyRef.current?.(next);
  }, [slug]);

  const launch = useCallback(async (forceNew = false) => {
    setLoading(true);
    setError(null);
    try {
      if (!forceNew) {
        const cached = readStoredSandboxSession(slug);
        if (cached && cached.hasBackend) {
          // Verify cached session still exists on server before reusing it
          const probe = await api.getMarketplaceDemoTables(slug, cached.token);
          if (!probe.error && probe.data) {
            commitSession(cached);
            setFrameKey((k) => k + 1);
            return;
          }
          writeStoredSandboxSession(slug, null);
        }
      }
      const res = await api.startMarketplaceDemo(slug);
      if (res.error || !res.data) {
        setError(res.error || 'Could not start the live sandbox demo.');
        return;
      }
      commitSession(res.data);
      setFrameKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the live sandbox demo.');
    } finally {
      setLoading(false);
    }
  }, [slug, commitSession]);

  useEffect(() => {
    if (!autoLaunch || autoLaunchedRef.current === slug) return;
    autoLaunchedRef.current = slug;
    void Promise.resolve().then(() => launch());
  }, [autoLaunch, slug, launch]);

  const reset = useCallback(async () => {
    if (!session || resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await api.resetMarketplaceDemo(slug, session.token);
      if (res.error) {
        // Session expired — spin up a fresh one automatically
        await launch(true);
        onSessionResetRef.current?.();
        return;
      }
      setFrameKey((k) => k + 1);
      onSessionResetRef.current?.();
    } catch {
      await launch(true);
      onSessionResetRef.current?.();
    } finally {
      setResetting(false);
    }
  }, [slug, session, resetting, launch]);

  useEffect(() => {
    if (resetSignal !== lastResetSignalRef.current) {
      lastResetSignalRef.current = resetSignal;
      void Promise.resolve().then(() => (session ? reset() : launch(true)));
    }
  }, [resetSignal, session, reset, launch]);

  const activeMode = session?.renderMode ?? renderMode;
  const activeBackend = session?.hasBackend ?? hasBackend;
  const activeRuntime = session?.backendRuntime ?? backendRuntime;
  const frameUrl = session ? resolveFileUrl(session.framePath) : '';

  return (
    <section
      aria-label="Interactive live sandbox"
      className={cn(
        'overflow-hidden bg-white dark:bg-slate-900',
        fullHeight
          ? 'flex h-full flex-col'
          : 'rounded-2xl border border-primary-200/80 shadow-sm dark:border-primary-500/30'
      )}
    >
      {!compact && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-primary-50/80 via-white to-indigo-50/60 px-4 py-3 dark:border-slate-800 dark:from-primary-500/10 dark:via-slate-900 dark:to-indigo-500/10">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-600 px-2.5 py-1 text-xs font-semibold text-primary-foreground">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Live Sandbox
          </span>
          {sourceProtected && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {activeMode === 'dom_ssr' ? 'Server-Rendered DOM · Source Hidden' : 'Private Sandbox · Source Hidden'}
            </span>
          )}
          {activeBackend && (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              <Database className="h-3.5 w-3.5 text-indigo-500" aria-hidden="true" />
              Isolated Backend{activeRuntime ? ` (${activeRuntime})` : ''}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {session && (
            <>
              <div className="hidden items-center rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800 sm:inline-flex">
                <button
                  type="button"
                  onClick={() => setDevice('desktop')}
                  aria-label="Desktop preview width"
                  aria-pressed={device === 'desktop'}
                  className={cn(
                    'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition',
                    device === 'desktop'
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  )}
                >
                  <Monitor className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDevice('mobile')}
                  aria-label="Mobile preview width"
                  aria-pressed={device === 'mobile'}
                  className={cn(
                    'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition',
                    device === 'mobile'
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  )}
                >
                  <Smartphone className="h-4 w-4" />
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reset()}
                isLoading={resetting}
                leftIcon={<RefreshCw className="h-4 w-4" />}
              >
                Reset sandbox
              </Button>
            </>
          )}
        </div>
      </div>}

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!session ? (
        <div className={cn('flex flex-col items-center justify-center gap-4 px-6 py-12 text-center', fullHeight && 'flex-1')}>
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
            <Play className="h-7 w-7" />
          </div>
          <div className="max-w-lg space-y-1.5">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              {loading ? `Starting ${name} live sandbox…` : `Try ${name} live in a private sandbox`}
            </h3>
            <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
              Interact with the real app{activeBackend ? ' and its isolated temporary database' : ''} right here.
              {sourceProtected
                ? ' Hosted privately so only the live page DOM is shown while the creator’s source code and backend stay protected.'
                : ' Runs in an isolated sandbox without affecting your account.'}
            </p>
          </div>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void launch()}
            isLoading={loading}
            leftIcon={<Play className="h-5 w-5" />}
          >
            {loading ? 'Starting Sandbox…' : 'Launch Live Sandbox'}
          </Button>
          <p className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Temporary sandbox resets automatically after 30 minutes · Your login stays untouched
          </p>
        </div>
      ) : (
        <div className={cn(
          'flex flex-col items-center bg-slate-100/90 dark:bg-slate-950',
          fullHeight ? 'min-h-0 flex-1 p-0' : 'p-3 sm:p-4'
        )}>
          <div
            className={cn(
              'overflow-hidden bg-white transition-all',
              fullHeight
                ? 'h-full w-full'
                : 'h-[540px] rounded-xl border border-slate-200 shadow-inner dark:border-slate-800',
              !fullHeight && (device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full')
            )}
          >
            <iframe
              key={`${session.token}:${frameKey}:${refreshSignal}`}
              title={`${name} live sandbox`}
              src={frameUrl}
              sandbox="allow-scripts allow-forms"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-white"
            />
          </div>
          {!fullHeight && !compact && (
            <p className="mt-2.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span>Isolated sandbox session · Changes are temporary and private to you</span>
              <span>·</span>
              <span>{sourceProtected ? 'Source code protected on server' : 'Reset any time with 1 click'}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
