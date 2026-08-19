import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Globe2,
  Link2,
  Play,
  Rocket,
  Search,
  Settings,
  Shield,
  Sparkles,
  Table,
  Users,
  X,
} from 'lucide-react';
import { AppTile } from '../apps/AppTile';
import { Badge } from '../ui/Badge';
import { ThemeToggle } from '../ui/ThemeToggle';
import { VaultChip } from '../vault/VaultChip';
import { cn } from '../../lib/utils';
import { statusLabel, statusTone } from '../../lib/appStatus';
import { returnToState } from '../../hooks/useReturnTo';
import { isDemoLocalId } from '../../lib/demoLocal';
import type { UnpublishedChanges } from './studioSteps';
import type { App } from '../../types/app';

/**
 * The App Studio's phone menu.
 *
 * On a narrow bar the studio used to render four unlabelled 36px squares (Manage
 * app, Ask AI, Open app, Review & publish) plus a fifth that appeared only above
 * 412px — so the same app grew a control between two ordinary phones. A sighted
 * phone user had to tap each square to find out what it did, and the app name was
 * squeezed to "Sales C…" to make room for them.
 *
 * They all live here now, named, behind one wide target: the app's own identity
 * block. This also gives phones their first route to the app's records, members,
 * roles and delivery pages, which were previously surfaces you could only fall
 * into from somewhere else.
 *
 * Its own sheet rather than `components/ui/BottomSheet`: that one has the right
 * ergonomics but no focus trap, no Escape and no focus restore, so a keyboard or
 * screen-reader user who opened it was stranded.
 */
export function StudioAppMenu({
  app,
  changes,
  aiAvailable,
  aiPrompt,
  onClose,
  onOpenSearch,
  onOpenPublish,
  onAskAi,
}: {
  app: App;
  changes: UnpublishedChanges;
  aiAvailable: boolean;
  /** The current section's suggested prompt, shown as the Ask AI subtitle. */
  aiPrompt: string;
  onClose: () => void;
  onOpenSearch: () => void;
  onOpenPublish: () => void;
  onAskAi: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const browserOnly = isDemoLocalId(app.id);
  const back = returnToState(location.pathname, 'App Studio');

  // Focus management: trap inside the sheet, restore to the trigger on close.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('button, a[href]')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  const go = (path: string) => {
    onClose();
    navigate(path, { state: back });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close app menu"
        onClick={onClose}
        className="fixed inset-0 z-[80] cursor-default bg-gray-900/40 dark:bg-slate-950/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-app-menu-title"
        className="fixed inset-x-0 bottom-0 z-[90] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3 border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
          <AppTile app={app} size="md" />
          <div className="min-w-0 flex-1">
            <p id="studio-app-menu-title" className="text-base font-semibold leading-tight text-gray-900 dark:text-white">
              {app.name}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant={statusTone(app)} size="sm">{statusLabel(app)}</Badge>
              {changes.everPublished && changes.count > 0 && (
                <Badge variant="warning" size="sm">
                  {changes.count} {changes.count === 1 ? 'change' : 'changes'} to publish
                </Badge>
              )}
              {browserOnly && <Badge variant="primary" size="sm">Saved in this browser</Badge>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close app menu"
            className="-m-1 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-white/[0.06]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Group>
            <Row icon={Play} label="Open app" detail="See it the way a member does" onClick={() => go(`/app/${app.slug}`)} />
            <Row
              icon={Rocket}
              label="Review &amp; publish"
              detail={changes.count > 0 ? `${changes.count} ${changes.count === 1 ? 'change' : 'changes'} waiting` : 'Release log and readiness checks'}
              onClick={() => { onClose(); onOpenPublish(); }}
            />
            {aiAvailable && (
              <Row icon={Sparkles} label="Ask AI about this app" detail={aiPrompt} accent onClick={() => { onClose(); onAskAi(); }} />
            )}
            <Row icon={Search} label="Search App Studio" detail="Jump to a section, form, automation or role" onClick={() => { onClose(); onOpenSearch(); }} />
            <Row icon={Settings} label="App settings" detail="Name, address, timezone, services, deletion" onClick={() => go(`/apps/${app.id}/settings`)} />
          </Group>

          <Group title="Manage">
            <Row icon={Table} label="Records" detail="Browse and export collected data" onClick={() => go(`/apps/${app.id}/records`)} />
            <Row icon={Link2} label="Relations" detail="How records link across data types" onClick={() => go(`/apps/${app.id}/relations`)} />
            <Row icon={Users} label="Members" detail="Invitations and existing access" onClick={() => go(`/apps/${app.id}/users`)} />
            <Row icon={Shield} label="Roles &amp; permissions" detail="What each role may do" onClick={() => go(`/apps/${app.id}/roles`)} />
            <Row icon={Globe2} label="Deploy &amp; share" detail="QR code, install as an app, custom domains" onClick={() => go(`/apps/${app.id}/deploy`)} />
          </Group>

          <div className="flex items-center justify-between gap-3 border-t border-gray-200/80 px-4 py-3 dark:border-white/[0.06]">
            <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Appearance &amp; vault</span>
            <span className="flex items-center gap-2">
              <VaultChip />
              <ThemeToggle />
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-b border-gray-200/70 py-1.5 last:border-b-0 dark:border-white/[0.06]">
      {title && (
        <p className="px-4 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">{title}</p>
      )}
      {children}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  detail,
  accent,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  detail: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The accessible name matches the desktop control exactly, so voice control
      // ("tap Open app") behaves the same at every width.
      aria-label={label.replace(/&amp;/g, '&')}
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-white/[0.035] dark:active:bg-white/[0.06]"
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          accent
            ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300'
            : 'bg-gray-100 text-gray-500 dark:bg-white/[0.05] dark:text-slate-400'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">
          {label.replace(/&amp;/g, '&')}
        </span>
        <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-slate-400">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
    </button>
  );
}
