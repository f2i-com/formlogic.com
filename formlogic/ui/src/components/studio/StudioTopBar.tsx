import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, Play, Rocket, RotateCcw, Search, Settings, Sparkles } from 'lucide-react';
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
  onOpenCommandPalette,
}: {
  app: App;
  changes: UnpublishedChanges;
  /** A usable default AI exists (audit FL-23 readiness) — shows the Ask AI shortcut. */
  aiAvailable?: boolean;
  onOpenPublish: () => void;
  onOpenCommandPalette: () => void;
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
  const failedLabel = useStudioSaveState((s) => s.failedLabel);
  const retry = useStudioSaveState((s) => s.retry);
  const retryLast = useStudioSaveState((s) => s.retryLast);
  const openChat = () => {
    setChatMinimized(false);
    setChatOpen(true);
  };

  return (
    <>
      {/*
        The bar is a query CONTAINER, not a viewport-breakpoint layout. It lives INSIDE
        the app shell's sidebar offset, so at a 768px viewport it only has ~512px —
        viewport-based `md:` rules expanded the actions exactly when there was no room
        and the right-hand controls were silently clipped.
      */}
      <header
        className={cn(
          '@container/topbar sticky z-30 flex h-14 items-center gap-2 border-b border-gray-200/60 bg-white/95 px-3 backdrop-blur-xl dark:border-white/[0.06] dark:bg-slate-900/70 @2xl/topbar:h-16 @2xl/topbar:gap-3 @2xl/topbar:px-5',
          isOnline ? 'top-[var(--fl-demo-banner-h,0px)]' : 'top-[calc(2rem+var(--fl-demo-banner-h,0px))]'
        )}
      >
        <AppTile app={app} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-tight text-gray-900 @2xl/topbar:text-base dark:text-white" title={app.name}>
              {app.name}
            </h1>
            <Badge variant={published ? 'success' : 'warning'} size="sm" className="hidden whitespace-nowrap @md/topbar:inline-flex">
              {published ? `Live${liveVersion ? ` ${liveVersion}` : ''}` : 'Draft'}
            </Badge>
            {browserOnly && (
              <Badge variant="primary" size="sm" className="hidden whitespace-nowrap @4xl/topbar:inline-flex">
                Saved in browser
              </Badge>
            )}
          </div>
          <div className="mt-0.5 hidden min-w-0 items-center gap-1.5 text-[11px] text-gray-500 @lg/topbar:flex dark:text-slate-400">
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
                <span className="shrink-0">Saving…</span>
              </>
            ) : saveError ? (
              <>
                <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" aria-hidden="true" />
                <span className="max-w-52 truncate text-red-500 dark:text-red-400" title={saveError}>
                  Couldn't save {failedLabel ?? 'this change'}
                </span>
                {retry && (
                  <button
                    type="button"
                    onClick={() => void retryLast()}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 font-bold text-red-600 hover:underline dark:text-red-300"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Retry
                  </button>
                )}
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

        {/*
          Actions, widest-first: each control keeps its icon form at every width and
          gains a label only when the bar can actually spare it. Nothing disappears —
          the bar degrades to icons rather than clipping controls off the edge.
        */}
        <IconAction icon={Search} label="Search App Studio" title="Search App Studio (Ctrl+K)" onClick={onOpenCommandPalette} className="hidden @sm/topbar:flex" />

        <ActionButton
          icon={Settings}
          label="Manage app"
          onClick={openManage}
          variant="ghost"
          tier="manage"
        />
        {aiAvailable && (
          <ActionButton
            icon={Sparkles}
            label="Ask AI"
            srLabel="Ask AI about this app"
            onClick={openChat}
            variant="ghost"
            accent
            tier="askAi"
          />
        )}
        {/* Opening the app the way a member sees it — the studio replaced a Use/Edit
            segmented control whose "Edit" half was a focusable button that did nothing. */}
        <ActionButton
          icon={Play}
          label="Open app"
          onClick={openRuntime}
          variant="secondary"
          tier="openApp"
        />
        {/* The studio's primary action — it keeps its label longest. */}
        <ActionButton
          icon={!published || changes.count > 0 ? Rocket : Check}
          label={!published ? 'Publish' : changes.count > 0 ? 'Review changes' : 'Up to date'}
          srLabel={!published ? 'Publish app' : changes.count > 0 ? 'Review pending changes' : 'Review & publish'}
          onClick={onOpenPublish}
          variant={!published || changes.count > 0 ? 'primary' : 'outline'}
          tier="publish"
        />

        {/* Account chrome yields to the app actions until the bar is genuinely wide. */}
        <div className="hidden items-center gap-2 @4xl/topbar:flex">
          <VaultChip />
          <ThemeToggle />
        </div>
        <UserMenu onOpenAuth={() => setShowAuthModal(true)} />
      </header>
      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} />
    </>
  );
}

/**
 * Container widths at which each action earns its text label. Written out in full
 * because Tailwind extracts class names from source TEXT — a template literal that
 * composes `@3xl/topbar:inline-flex` at runtime produces no CSS.
 */
const LABEL_TIER = {
  publish: { label: 'hidden whitespace-nowrap @xl/topbar:inline-flex', icon: 'flex @xl/topbar:hidden' },
  openApp: { label: 'hidden whitespace-nowrap @2xl/topbar:inline-flex', icon: 'flex @2xl/topbar:hidden' },
  askAi: { label: 'hidden whitespace-nowrap @3xl/topbar:inline-flex', icon: 'flex @3xl/topbar:hidden' },
  manage: { label: 'hidden whitespace-nowrap @4xl/topbar:inline-flex', icon: 'flex @4xl/topbar:hidden' },
} as const;

/**
 * A top-bar action that is an icon button when space is tight and a labelled button
 * when it isn't. The accessible name is the SAME in both forms, so the control never
 * changes identity for a screen reader or for voice control as the bar resizes.
 */
function ActionButton({
  icon: Icon,
  label,
  srLabel,
  onClick,
  variant,
  accent,
  tier,
}: {
  icon: typeof Search;
  label: string;
  /** Fuller name for assistive tech when the visible label is terse. */
  srLabel?: string;
  onClick: () => void;
  variant: 'primary' | 'secondary' | 'outline' | 'ghost';
  accent?: boolean;
  tier: keyof typeof LABEL_TIER;
}) {
  const classes = LABEL_TIER[tier];
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={onClick}
        aria-label={srLabel ?? label}
        leftIcon={<Icon className="h-4 w-4" />}
        className={classes.label}
      >
        {label}
      </Button>
      <IconAction icon={Icon} label={srLabel ?? label} onClick={onClick} accent={accent} className={classes.icon} />
    </>
  );
}

/** Square icon button with a real accessible name — the top bar's compact form. */
function IconAction({
  icon: Icon,
  label,
  title,
  onClick,
  accent,
  className,
}: {
  icon: typeof Search;
  label: string;
  title?: string;
  onClick: () => void;
  accent?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className={cn(
        'h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-200 bg-white transition-colors dark:border-white/10 dark:bg-white/[0.05]',
        accent
          ? 'text-primary-600 hover:bg-primary-50 dark:text-primary-300 dark:hover:bg-primary-500/10'
          : 'text-gray-600 hover:border-primary-200 hover:bg-primary-50 hover:text-primary-700 dark:text-slate-300 dark:hover:border-primary-500/30 dark:hover:bg-primary-500/10 dark:hover:text-primary-300',
        className ?? 'flex'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
