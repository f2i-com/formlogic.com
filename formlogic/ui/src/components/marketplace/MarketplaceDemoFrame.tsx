import { useCallback, useState } from 'react';
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
}

export function MarketplaceDemoFrame({
  slug,
  name,
  sourceProtected = true,
  hasBackend = false,
  backendRuntime,
  renderMode,
}: MarketplaceDemoFrameProps) {
  const [session, setSession] = useState<MarketplaceDemoSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [frameKey, setFrameKey] = useState(0);

  const launch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.startMarketplaceDemo(slug);
      if (res.error || !res.data) {
        setError(res.error || 'Could not start the live sandbox demo.');
        return;
      }
      setSession(res.data);
      setFrameKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the live sandbox demo.');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const reset = useCallback(async () => {
    if (!session || resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await api.resetMarketplaceDemo(slug, session.token);
      if (res.error) {
        // Session expired — spin up a fresh one automatically
        await launch();
        return;
      }
      setFrameKey((k) => k + 1);
    } catch {
      await launch();
    } finally {
      setResetting(false);
    }
  }, [slug, session, resetting, launch]);

  const activeMode = session?.renderMode ?? renderMode;
  const activeBackend = session?.hasBackend ?? hasBackend;
  const activeRuntime = session?.backendRuntime ?? backendRuntime;
  const frameUrl = session ? resolveFileUrl(session.framePath) : '';

  return (
    <section
      aria-label="Interactive live sandbox"
      className="overflow-hidden rounded-2xl border border-primary-200/80 bg-white shadow-sm dark:border-primary-500/30 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-primary-50/80 via-white to-indigo-50/60 px-4 py-3 dark:border-slate-800 dark:from-primary-500/10 dark:via-slate-900 dark:to-indigo-500/10">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-600 px-2.5 py-1 text-xs font-semibold text-white">
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
      </div>

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!session ? (
        <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
            <Play className="h-7 w-7" />
          </div>
          <div className="max-w-lg space-y-1.5">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              Try {name} live in a private sandbox
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
            Launch Live Sandbox
          </Button>
          <p className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Temporary sandbox resets automatically after 30 minutes · Your login stays untouched
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center bg-slate-100/90 p-3 dark:bg-slate-950 sm:p-4">
          <div
            className={cn(
              'h-[540px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-inner transition-all dark:border-slate-800',
              device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full'
            )}
          >
            <iframe
              key={`${session.token}:${frameKey}`}
              title={`${name} live sandbox`}
              src={frameUrl}
              sandbox="allow-scripts allow-forms"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-white"
            />
          </div>
          <p className="mt-2.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>Isolated sandbox session · Changes are temporary and private to you</span>
            <span>·</span>
            <span>Source code protected on server</span>
          </p>
        </div>
      )}
    </section>
  );
}
