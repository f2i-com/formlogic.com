import { useContext, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { ThemeToggle } from '../ui/ThemeToggle';
import { BotGuideToggle } from '../guide/BotGuideToggle';
import { UserMenu } from '../auth/UserMenu';
import { AuthModal } from '../auth/AuthModal';
import { VaultChip } from '../vault/VaultChip';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { AccountInDock } from './navigationDock';
import { AppManagementHeader } from './useAppSectionSidebar';

interface HeaderProps {
  title?: string;
  /** Drawn before the title: what the page is about, such as an app's own icon on that app's pages. */
  mark?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { onClick: () => void; label?: string; text?: string };
}

export function Header({ title, mark, actions, back }: HeaderProps) {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const isOnline = useOnlineStatus();
  const signedIn = useAuthStore(state => !!state.user);
  const accountInDock = useContext(AccountInDock);
  const appNavigation = useContext(AppManagementHeader);

  return (
    <>
      {/* Offset the sticky header below the fixed offline banner (h-8) and below
          whichever sticky top bar set --fl-demo-banner-h (the demo banner or the
          admin acting banner, both z-40) — otherwise the header tucks UNDER the
          bar on scroll and its top half is occluded. The var is 0px outside
          those contexts, so this is a no-op on normal pages. */}
      {/* @container/header: page actions must size themselves against the header's REAL
          width, not the viewport. `main` is inset by the sidebar (64/256px) and by a
          docked chat rail (384px), so a viewport media query turns labels ON exactly
          when the header has least room — and because `main` is overflow-x-clip, the
          overflow was silently swallowed instead of scrolling. Consumers gate their
          action labels on `@…/header` for this reason; see FormResponses. */}
      <header className={cn(
        '@container/header h-[var(--fl-workspace-header-h,3.5rem)] sm:h-[var(--fl-workspace-header-h,4rem)] bg-white/95 dark:bg-slate-900/70 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] sticky z-30 flex items-center justify-between px-4 sm:px-6 gap-3 sm:gap-4',
        isOnline ? 'top-[calc(var(--fl-nav-top,0px)+var(--fl-system-top,0px)+var(--fl-demo-banner-h,0px))]' : 'top-[calc(2rem+var(--fl-nav-top,0px)+var(--fl-demo-banner-h,0px))]'
      )}>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {back && (
            <button
              type="button"
              onClick={back.onClick}
              aria-label={back.label || 'Back'}
              title={back.label || 'Back'}
              className={cn('inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-gray-200/80 px-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                back.text && '@xl/header:min-w-0 @xl/header:rounded-md @xl/header:border-0 @xl/header:px-1')}
            >
              <ArrowLeft className={cn('size-4', back.text && '@xl/header:hidden')} aria-hidden="true" />
              <span className="hidden @xl/header:inline">{back.text ?? 'Back'}</span>
            </button>
          )}
          {back?.text && <ChevronRight className="hidden size-3.5 shrink-0 text-slate-400 @xl/header:block" aria-hidden="true" />}
          {mark}
          {title && (
            <h1
              className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white truncate tracking-tight"
              title={title}
            >
              {title}
            </h1>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {actions && (
            <>
              {/* min-w-0 (not flex-shrink-0) so the action group yields space before the
                  identity cluster does. Deliberately NOT a scroll container: setting
                  overflow on one axis forces the other to `auto`, which would clip the
                  dropdown menus pages anchor inside their actions (e.g. Export). */}
              <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">{actions}</div>
              {!accountInDock && <div className="hidden h-5 w-px flex-none bg-gray-200 dark:bg-slate-800 md:block" />}
            </>
          )}
          <div className="flex flex-none items-center gap-2 empty:hidden sm:gap-3">
            {/* E2EE vault lock state - renders only when the user has a vault. */}
            <VaultChip />
            {!accountInDock && <>
              <div className={signedIn ? 'hidden md:flex items-center gap-1' : 'flex items-center gap-1'}>
                <BotGuideToggle variant="header" />
                <ThemeToggle />
              </div>
              <UserMenu onOpenAuth={() => setShowAuthModal(true)} />
            </>}
          </div>
        </div>
      </header>
      {appNavigation}

      {!accountInDock && <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
      />}
    </>
  );
}
