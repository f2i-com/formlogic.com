// What the App Studio adds to the page's Header and to its row of sections:
//   StudioHeaderActions  search, App settings, Ask AI, Open app and Publish, at the header's right;
//   StudioStateLine      whether the app is live, whether the last change was saved and what is
//                        waiting to be published, at the right end of the section row.
// The studio used to draw a top bar of its own in place of the Header. It now stands in the same
// frame as every other page that manages an app, so the two pieces live here.
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, MoreHorizontal, Play, Rocket, RotateCcw, Search, Settings, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import { type UnpublishedChanges } from './studioSteps';
import { statusLabel } from '../../lib/appStatus';
import { useStudioSaveState } from './studioSaveState';
import { returnToState } from '../../hooks/useReturnTo';
import { isDemoLocalId } from '../../lib/demoLocal';
import type { App } from '../../types/app';

/** The publish action's three states: nothing is live, changes are waiting, or it is up to date. */
function publishAction(app: App, changes: UnpublishedChanges) {
  const published = app.status === 'published';
  if (!published) return { icon: Rocket, label: 'Publish', srLabel: 'Publish app', variant: 'primary' as const, waiting: true };
  if (changes.count > 0) return { icon: Rocket, label: 'Review changes', srLabel: 'Review pending changes', variant: 'primary' as const, waiting: true };
  return { icon: Check, label: 'Up to date', srLabel: 'Review & publish', variant: 'outline' as const, waiting: false };
}

/**
 * The studio's actions in the page Header.
 *
 * They size themselves against the header's real width (`@…/header`), not the screen: the header
 * loses the sidebar's width and the docked chat's, so a screen breakpoint would spell the labels
 * out exactly when there is least room. Each action keeps one accessible name at every width.
 * In a narrow header (a phone, a split screen) there is room for one control beside the app's
 * name: the app menu, which holds every action by name. Publish then stands in the state line.
 */
export function StudioHeaderActions({
  app,
  changes,
  aiAvailable = false,
  onOpenPublish,
  onOpenCommandPalette,
  onOpenAppMenu,
}: {
  app: App;
  changes: UnpublishedChanges;
  /** A usable default AI exists (audit FL-23 readiness): shows the Ask AI shortcut. */
  aiAvailable?: boolean;
  onOpenPublish: () => void;
  onOpenCommandPalette: () => void;
  /** Narrow header only: opens the app menu sheet. */
  onOpenAppMenu: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);

  // "Open app" carries the current studio step so the runtime's draft-preview
  // Back button returns exactly here.
  const openRuntime = () => navigate(`/app/${app.slug}`, { state: returnToState(location.pathname, 'App Studio') });
  // Real settings, not the directory: this button used to open `?tab=manage`, a grid
  // of nine tiles, so the studio's only control called "Manage app" opened a menu
  // rather than any app setting.
  const openSettings = () => navigate(`/apps/${app.id}/settings`, {
    state: returnToState(location.pathname, 'App Studio'),
  });
  const openChat = () => {
    setChatMinimized(false);
    setChatOpen(true);
  };
  const publish = publishAction(app, changes);

  return (
    <>
      <button
        type="button"
        onClick={onOpenAppMenu}
        aria-haspopup="dialog"
        aria-label={`${app.name} — app menu`}
        title="App menu"
        className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-gray-200/80 text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 @2xl/header:hidden dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
      </button>

      {/* With room for them: each control keeps its icon form and gains its word when the
          header can spare it. The app's name outranks a button's word, so the least-used
          words yield first. */}
      <div className="hidden min-w-0 items-center gap-2 @2xl/header:flex">
        <IconAction icon={Search} label="Search App Studio" title="Search App Studio (Ctrl+K)" onClick={onOpenCommandPalette} />
        <ActionButton icon={Settings} label="App settings" onClick={openSettings} variant="ghost" tier="manage" />
        {aiAvailable && (
          <ActionButton icon={Sparkles} label="Ask AI" srLabel="Ask AI about this app" onClick={openChat} variant="ghost" accent tier="askAi" />
        )}
        {/* Opening the app the way a member sees it. */}
        <ActionButton icon={Play} label="Open app" onClick={openRuntime} variant="secondary" tier="openApp" />
        <Button
          variant={publish.variant}
          size="sm"
          onClick={onOpenPublish}
          aria-label={publish.srLabel}
          leftIcon={<publish.icon className="h-4 w-4" />}
          className="whitespace-nowrap"
        >
          {publish.label}
        </Button>
      </div>
    </>
  );
}

/**
 * The app's state in a line: Draft or Live with its version, whether the last change was saved,
 * and what is waiting to be published.
 *
 * A failed save, and its Retry, are drawn at every width: a builder who taps Add field on a poor
 * connection must learn the change did not land. Only the healthy wording yields to a narrow
 * screen. Where the header has no room for Publish (see StudioHeaderActions) it stands here, at
 * the line's right end.
 */
export function StudioStateLine({
  app,
  changes,
  onOpenPublish,
}: {
  app: App;
  changes: UnpublishedChanges;
  onOpenPublish: () => void;
}) {
  const published = app.status === 'published';
  const browserOnly = isDemoLocalId(app.id);
  const saving = useStudioSaveState((s) => s.pending > 0);
  const lastSavedAt = useStudioSaveState((s) => s.lastSavedAt);
  const lastLabel = useStudioSaveState((s) => s.lastLabel);
  const saveError = useStudioSaveState((s) => s.lastError);
  const failedLabel = useStudioSaveState((s) => s.failedLabel);
  const retry = useStudioSaveState((s) => s.retry);
  const retryLast = useStudioSaveState((s) => s.retryLast);
  const publish = publishAction(app, changes);

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs text-gray-500 @2xl/studio:w-auto @2xl/studio:self-center dark:text-slate-400">
      <span className={cn(
        'inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        published ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-gray-100 text-gray-700 dark:bg-slate-800 dark:text-slate-300',
      )}>
        <span className={cn('h-1.5 w-1.5 rounded-full', published ? 'bg-emerald-500' : app.status === 'archived' ? 'bg-gray-400' : 'bg-amber-500')} aria-hidden="true" />
        {statusLabel(app)}
      </span>
      <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5">
        {saving ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
            <span className="shrink-0">Saving…</span>
          </>
        ) : saveError ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden="true" />
            <span className="min-w-0 truncate font-medium text-red-600 dark:text-red-400" title={saveError}>
              Couldn&apos;t save {failedLabel ?? 'this change'}
            </span>
            {retry && (
              <button
                type="button"
                onClick={() => void retryLast()}
                className="inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-1 font-bold text-red-600 hover:underline max-sm:min-h-11 dark:text-red-300"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Retry
              </button>
            )}
          </>
        ) : (
          <>
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
            <span className="min-w-0 truncate" title={lastLabel ?? undefined}>
              {lastSavedAt ? (lastLabel ? `Saved — ${lastLabel}` : 'Saved just now') : 'All changes saved'}
            </span>
          </>
        )}
      </span>
      {changes.everPublished && changes.count > 0 && (
        <button
          type="button"
          onClick={onOpenPublish}
          className="min-h-6 shrink-0 cursor-pointer font-semibold text-amber-700 hover:underline max-sm:min-h-11 dark:text-amber-300"
        >
          {changes.count} {changes.count === 1 ? 'change' : 'changes'} to publish
        </button>
      )}
      {/* The pill already says Draft: these words join it once the row has room for them. */}
      {!published && !changes.everPublished && <span className="hidden shrink-0 @7xl/studio:inline">Not published yet</span>}
      {browserOnly && <span className="shrink-0">Saved in this browser</span>}
      {publish.waiting && (
        <Button
          variant="primary"
          size="sm"
          onClick={onOpenPublish}
          aria-label={publish.srLabel}
          leftIcon={<Rocket className="h-4 w-4" />}
          className="ml-auto whitespace-nowrap @2xl/studio:hidden"
        >
          {publish.label}
        </Button>
      )}
    </div>
  );
}

/**
 * Container widths of the header at which an action earns its word.
 *
 * Measured, not guessed: the header also holds Back, the app's name, the theme switch and the
 * account menu, and the name must not be cut to make room for a button's word. Written out in
 * full because Tailwind extracts class names from source TEXT: a template literal that composes
 * `@4xl/header:inline-flex` at runtime produces no CSS.
 */
const LABEL_TIER = {
  openApp: { label: 'hidden whitespace-nowrap @4xl/header:inline-flex', icon: 'flex @4xl/header:hidden' },
  askAi: { label: 'hidden whitespace-nowrap @5xl/header:inline-flex', icon: 'flex @5xl/header:hidden' },
  manage: { label: 'hidden whitespace-nowrap @5xl/header:inline-flex', icon: 'flex @5xl/header:hidden' },
} as const;

/**
 * A header action that is an icon button when space is tight and a labelled button
 * when it isn't. The accessible name is the SAME in both forms, so the control never
 * changes identity for a screen reader or for voice control as the header resizes.
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

/** Square icon button with a real accessible name: an action's compact form. */
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
