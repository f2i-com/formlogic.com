import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, Loader2, Play, Rocket, RotateCcw, Search, Settings, Sparkles } from 'lucide-react';
import { AppTile } from '../apps/AppTile';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';
import { UserMenu } from '../auth/UserMenu';
import { AuthModal } from '../auth/AuthModal';
import { VaultChip } from '../vault/VaultChip';
import { useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import { type UnpublishedChanges } from './studioSteps';
import { statusLabel, statusTone } from '../../lib/appStatus';
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
  onOpenAppMenu,
}: {
  app: App;
  changes: UnpublishedChanges;
  /** A usable default AI exists (audit FL-23 readiness) — shows the Ask AI shortcut. */
  aiAvailable?: boolean;
  onOpenPublish: () => void;
  onOpenCommandPalette: () => void;
  /** Phone only: the identity block opens the app menu sheet. */
  onOpenAppMenu: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // "Use app" carries the current studio step so the runtime's draft-preview
  // Back button returns exactly here.
  const openRuntime = () => navigate(`/app/${app.slug}`, { state: returnToState(location.pathname, 'App Studio') });
  // Real settings, not the directory: this button used to open `?tab=manage`, a grid
  // of nine tiles, so the studio's only control called "Manage app" opened a menu
  // rather than any app setting. The directory is still one tab away for anyone who
  // wants it (and remains the acting-admin hub).
  const openSettings = () => navigate(`/apps/${app.id}/settings`, {
    state: returnToState(location.pathname, 'App Studio'),
  });

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
      {/* The @container is declared on AppStudio's chrome wrapper, not here: an element
          cannot answer its own container query, so the height step below never fired
          while this element also declared the container. */}
      <header className="flex h-12 items-center gap-1 px-2 @2xl/topbar:h-16 @2xl/topbar:gap-3 @2xl/topbar:px-5">
        {/* PHONE ROW: three targets, not five. The identity block IS the menu
            trigger — the widest, left-most, easiest control in the row — and every
            secondary action lives inside it with a name attached. */}
        <button
          type="button"
          onClick={onOpenAppMenu}
          aria-haspopup="dialog"
          aria-label={`${app.name} — app menu`}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 text-left active:bg-gray-100 @2xl/topbar:hidden dark:active:bg-white/[0.06]"
        >
          <AppTile app={app} size="sm" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{app.name}</span>
              <Badge variant={statusTone(app)} size="sm" className="shrink-0 whitespace-nowrap">{statusLabel(app)}</Badge>
            </span>
            <SaveLine
              saving={saving}
              saveError={saveError}
              failedLabel={failedLabel}
              lastSavedAt={lastSavedAt}
              lastLabel={lastLabel}
              compact
            />
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
        </button>

        {/* DESKTOP ROW: unchanged behaviour, just gated so the two never both render. */}
        <div className="hidden min-w-0 shrink grow basis-44 items-center gap-3 @2xl/topbar:flex">
        <AppTile app={app} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-tight text-gray-900 @2xl/topbar:text-base dark:text-white" title={app.name}>
              {app.name}
            </h1>
            {/* Whether the app is live is the single most important fact in this bar.
                It used to be gated on @md/topbar (448px), so on EVERY phone — and in
                the docked-chat layout — it was not rendered at all. */}
            <Badge variant={statusTone(app)} size="sm" className="whitespace-nowrap">
              {statusLabel(app)}
            </Badge>
            {browserOnly && (
              <Badge variant="primary" size="sm" className="hidden whitespace-nowrap @4xl/topbar:inline-flex">
                Saved in browser
              </Badge>
            )}
          </div>
          {/* Always mounted. This line used to be `hidden … @lg/topbar:flex`, so on
              every phone and in the docked-chat layout the "Couldn't save — Retry"
              state was not rendered at all: the only recovery control for a failed
              write disappeared exactly when the bar was narrow. Now the glyph and
              Retry survive at every width and only the prose collapses. */}
          <div
            role="status"
            aria-live="polite"
            className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400"
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
                <span className="shrink-0">Saving…</span>
              </>
            ) : saveError ? (
              <>
                <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" aria-hidden="true" />
                <span className="min-w-0 truncate text-red-500 dark:text-red-400" title={saveError}>
                  Couldn't save {failedLabel ?? 'this change'}
                </span>
                {retry && (
                  <button
                    type="button"
                    onClick={() => void retryLast()}
                    className="inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-1 font-bold text-red-600 hover:underline dark:text-red-300"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Retry
                  </button>
                )}
              </>
            ) : (
              <>
                <Check className="h-3 w-3 text-emerald-500 shrink-0" aria-hidden="true" />
                <span className="hidden shrink-0 @lg/topbar:inline" title={lastLabel ?? undefined}>
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
                  className="min-h-6 shrink-0 cursor-pointer font-semibold text-amber-600 hover:underline dark:text-amber-300"
                >
                  {changes.count} {changes.count === 1 ? 'change' : 'changes'}
                  <span className="hidden @lg/topbar:inline"> to publish</span>
                </button>
              </>
            )}
            {!published && !changes.everPublished && (
              <>
                <span aria-hidden="true" className="hidden @lg/topbar:inline">·</span>
                <span className="hidden truncate @lg/topbar:inline">Not published yet</span>
              </>
            )}
            {browserOnly && (
              <>
                <span aria-hidden="true" className="hidden @lg/topbar:inline">&middot;</span>
                <span className="hidden truncate @lg/topbar:inline">Private to this browser</span>
              </>
            )}
          </div>
        </div>
        </div>

        {/*
          Desktop actions, widest-first: each control keeps its icon form and gains a
          label when the bar can spare it. On a phone none of these render — they live
          in the app menu, named, instead of as anonymous grey squares.
        */}
        <div className="hidden items-center gap-2 @2xl/topbar:flex @2xl/topbar:gap-3">
        <IconAction icon={Search} label="Search App Studio" title="Search App Studio (Ctrl+K)" onClick={onOpenCommandPalette} />

        <ActionButton
          icon={Settings}
          label="App settings"
          onClick={openSettings}
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
        </div>
        {/* The studio's primary action — it keeps its label longest, and it is the one
            action that stays in the phone bar. When the app is live with nothing
            pending it has nothing to do, so on a phone the slot is simply empty
            (the rail's Publish tab still carries the version). */}
        {(!published || changes.count > 0) ? (
          <ActionButton
            icon={Rocket}
            label={!published ? 'Publish' : 'Review changes'}
            srLabel={!published ? 'Publish app' : 'Review pending changes'}
            onClick={onOpenPublish}
            variant="primary"
            tier="publish"
          />
        ) : (
          <div className="hidden @2xl/topbar:block">
            <ActionButton
              icon={Check}
              label="Up to date"
              srLabel="Review & publish"
              onClick={onOpenPublish}
              variant="outline"
              tier="publish"
            />
          </div>
        )}

        {/* Account chrome yields to the app actions until the bar is genuinely wide.
            On a phone the vault and theme controls live in the app menu. */}
        <div className="hidden items-center gap-2 @6xl/topbar:flex">
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
 * Saving / Saved / Couldn't-save, in one place so both the phone identity block and
 * the desktop bar say the same thing.
 *
 * This used to be gated on `@lg/topbar`, so on every phone AND in the docked-chat
 * layout a FAILED write was completely silent: the builder tapped Add field, saw the
 * optimistic UI, and never learned the change had not landed. The failure arm — and
 * its Retry — now render at every width; only the wordy success tail collapses.
 */
function SaveLine({
  saving,
  saveError,
  failedLabel,
  lastSavedAt,
  lastLabel,
  compact,
}: {
  saving: boolean;
  saveError: string | null;
  failedLabel: string | null;
  lastSavedAt: number | null;
  lastLabel: string | null;
  /** Phone form: drop the healthy "Saved" text and keep only the glyph. */
  compact?: boolean;
}) {
  if (saving) {
    return (
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
        <span className="shrink-0">Saving…</span>
      </span>
    );
  }
  if (saveError) {
    return (
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-red-500 dark:text-red-400">
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium" title={saveError}>
          Couldn&apos;t save {failedLabel ?? 'this change'}
        </span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
      <Check className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
      <span className={cn('shrink-0 truncate', compact && 'hidden @sm/topbar:inline')} title={lastLabel ?? undefined}>
        {lastSavedAt ? (lastLabel ? `Saved — ${lastLabel}` : 'Saved just now') : 'All changes saved'}
      </span>
    </span>
  );
}

/**
 * Container widths at which each action earns its text label.
 *
 * Measured, not guessed: at a 1024px header (a 1280px laptop with the sidebar open)
 * every action was labelled AND the vault/theme pair rendered, which consumed the row
 * exactly and truncated the app name to "Sales …". Which app you are editing outranks
 * a button's word, so the least-used labels yield first. Written out in full
 * because Tailwind extracts class names from source TEXT — a template literal that
 * composes `@3xl/topbar:inline-flex` at runtime produces no CSS.
 */
const LABEL_TIER = {
  publish: { label: 'hidden whitespace-nowrap @xl/topbar:inline-flex', icon: 'flex @xl/topbar:hidden' },
  openApp: { label: 'hidden whitespace-nowrap @2xl/topbar:inline-flex', icon: 'flex @2xl/topbar:hidden' },
  askAi: { label: 'hidden whitespace-nowrap @4xl/topbar:inline-flex', icon: 'flex @4xl/topbar:hidden' },
  manage: { label: 'hidden whitespace-nowrap @6xl/topbar:inline-flex', icon: 'flex @6xl/topbar:hidden' },
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
