import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, Play, Rocket, Settings, Sparkles } from 'lucide-react';
import { AppTile } from '../apps/AppTile';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';
import { UserMenu } from '../auth/UserMenu';
import { AuthModal } from '../auth/AuthModal';
import { VaultChip } from '../vault/VaultChip';
import { useUIStore } from '../../stores/uiStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';
import { versionLabel, type UnpublishedChanges } from './studioSteps';
import { useStudioSaveState } from './studioSaveState';
import { returnToState } from '../../hooks/useReturnTo';
import { isDemoLocalId } from '../../lib/demoLocal';
import type { App } from '../../types/app';

/**
 * App Studio top bar: app identity + live/draft state on the left, the
 * Use app / Edit app switch in the middle, Ask AI + publish shortcut +
 * account controls on the right. Replaces the generic page Header on
 * studio routes.
 */
export function StudioTopBar({
  app,
  changes,
  aiAvailable = false,
  onOpenPublish,
}: {
  app: App;
  changes: UnpublishedChanges;
  /** A usable default AI exists (audit FL-23 readiness) — shows the Ask AI shortcut. */
  aiAvailable?: boolean;
  onOpenPublish: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const isOnline = useOnlineStatus();
  const [showAuthModal, setShowAuthModal] = useState(false);

  // "Use app" carries the current studio step so the runtime's draft-preview
  // Back button returns exactly here.
  const openRuntime = () => navigate(`/app/${app.slug}`, { state: returnToState(location.pathname, 'App Studio') });
  const openManage = () => navigate(`/apps/${app.id}/settings?tab=manage`, {
    state: returnToState(location.pathname, 'App Studio'),
  });

  const liveVersion = versionLabel(app);
  const published = app.status === 'published';
  const browserOnly = isDemoLocalId(app.id);
  const saving = useStudioSaveState((s) => s.pending > 0);
  const lastSavedAt = useStudioSaveState((s) => s.lastSavedAt);
  const lastLabel = useStudioSaveState((s) => s.lastLabel);
  const saveError = useStudioSaveState((s) => s.lastError);
  const openChat = () => {
    setChatMinimized(false);
    setChatOpen(true);
  };

  return (
    <>
      <header
        className={cn(
          'sticky z-30 flex h-14 sm:h-16 items-center gap-2.5 sm:gap-3 border-b border-gray-200/60 dark:border-white/[0.06] bg-white/95 dark:bg-slate-900/70 backdrop-blur-xl px-3 sm:px-5',
          isOnline ? 'top-[var(--fl-demo-banner-h,0px)]' : 'top-[calc(2rem+var(--fl-demo-banner-h,0px))]'
        )}
      >
        <AppTile app={app} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="truncate text-sm sm:text-base font-semibold tracking-tight text-gray-900 dark:text-white" title={app.name}>
              {app.name}
            </h1>
            <Badge variant={published ? 'success' : 'warning'} size="sm" className="hidden sm:inline-flex whitespace-nowrap">
              {published ? `Live${liveVersion ? ` ${liveVersion}` : ''}` : 'Draft'}
            </Badge>
            {browserOnly && (
              <Badge variant="primary" size="sm" className="hidden lg:inline-flex whitespace-nowrap">
                Saved in browser
              </Badge>
            )}
          </div>
          <div className="mt-0.5 hidden items-center gap-1.5 text-[11px] text-gray-400 dark:text-slate-500 sm:flex min-w-0">
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
                <span className="shrink-0">Saving…</span>
              </>
            ) : saveError ? (
              <>
                <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" aria-hidden="true" />
                <span className="shrink-0 text-red-500 dark:text-red-400" title={saveError}>Couldn't save — try again</span>
              </>
            ) : (
              <>
                <Check className="h-3 w-3 text-emerald-500 shrink-0" aria-hidden="true" />
                <span className="shrink-0" title={lastLabel ?? undefined}>
                  {lastSavedAt ? (lastLabel ? `Saved — ${lastLabel}` : 'Saved just now') : 'All changes saved'}
                </span>
              </>
            )}
            {changes.everPublished && changes.count > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onOpenPublish}
                  className="font-semibold text-amber-600 dark:text-amber-300 hover:underline cursor-pointer truncate"
                >
                  {changes.count} unpublished {changes.count === 1 ? 'change' : 'changes'}
                </button>
              </>
            )}
            {!published && !changes.everPublished && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">Not published yet</span>
              </>
            )}
            {browserOnly && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span className="truncate">Private to this browser</span>
              </>
            )}
          </div>
        </div>

        {/* Use app / Edit app switch (the studio is always the "Edit" side) */}
        <div className="hidden md:flex items-center gap-1 rounded-xl bg-gray-100 dark:bg-white/[0.06] p-1" role="group" aria-label="App mode">
          <button
            type="button"
            onClick={openRuntime}
            className="h-8 cursor-pointer rounded-lg px-3 text-xs font-semibold text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-white transition-all"
          >
            Use app
          </button>
          <button
            type="button"
            aria-current="page"
            className="h-8 cursor-default rounded-lg px-3 text-xs font-semibold bg-white dark:bg-slate-800 text-primary-600 dark:text-primary-400 shadow-sm"
          >
            Edit app
          </button>
        </div>

        {aiAvailable && (
          <Button variant="secondary" size="sm" onClick={openChat} leftIcon={<Sparkles className="h-4 w-4" />} className="hidden sm:inline-flex">
            Ask AI
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={openManage}
          leftIcon={<Settings className="h-4 w-4" />}
          className="hidden lg:inline-flex"
        >
          Manage
        </Button>
        <Button
          variant={!published || changes.count > 0 ? 'primary' : 'outline'}
          size="sm"
          onClick={onOpenPublish}
          leftIcon={!published || changes.count > 0 ? <Rocket className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          className="hidden xl:inline-flex"
        >
          {!published ? 'Publish' : changes.count > 0 ? 'Review changes' : 'Up to date'}
        </Button>

        {/* Compact studio layouts use this top-bar shortcut instead of a
            floating launcher that can cover step content above the footer. */}
        {aiAvailable && (
          <button
            type="button"
            onClick={openChat}
            aria-label="Ask AI"
            className="sm:hidden flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-200 bg-white text-primary-600 transition-colors hover:bg-primary-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-primary-300 dark:hover:bg-primary-500/10"
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          onClick={openManage}
          aria-label="Manage app"
          title="Manage app"
          className="lg:hidden flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-primary-600 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-300 dark:hover:bg-primary-500/10 dark:hover:text-primary-300"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>

        {/* Mobile: jump into the live app */}
        <button
          type="button"
          onClick={openRuntime}
          className="md:hidden flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/[0.05] px-2.5 text-xs font-semibold text-gray-700 dark:text-slate-200"
        >
          <Play className="h-3.5 w-3.5" />
          Use
        </button>

        <div className="hidden sm:flex items-center gap-2">
          <VaultChip />
          <ThemeToggle />
        </div>
        <UserMenu onOpenAuth={() => setShowAuthModal(true)} />
      </header>
      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
    </>
  );
}
