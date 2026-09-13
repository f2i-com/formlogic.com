import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ThemeToggle } from '../ui/ThemeToggle';
import { UserMenu } from '../auth/UserMenu';
import { AuthModal } from '../auth/AuthModal';
import { VaultChip } from '../vault/VaultChip';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';

interface HeaderProps {
  title?: string;
  actions?: React.ReactNode;
  back?: { onClick: () => void; label?: string };
}

export function Header({ title, actions, back }: HeaderProps) {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const isOnline = useOnlineStatus();

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
        '@container/header h-14 sm:h-16 bg-white/95 dark:bg-slate-900/70 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] sticky z-30 flex items-center justify-between px-4 sm:px-6 gap-3 sm:gap-4',
        isOnline ? 'top-[var(--fl-demo-banner-h,0px)]' : 'top-[calc(2rem+var(--fl-demo-banner-h,0px))]'
      )}>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {back && (
            <button
              type="button"
              onClick={back.onClick}
              aria-label={back.label || 'Back'}
              title={back.label || 'Back'}
              className="inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-gray-200/80 px-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden @xl/header:inline">Back</span>
            </button>
          )}
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
              <div className="h-5 w-px flex-none bg-gray-200 dark:bg-slate-800" />
            </>
          )}
          <div className="flex flex-none items-center gap-2 sm:gap-3">
            {/* E2EE vault lock state - renders only when the user has a vault. */}
            <VaultChip />
            <ThemeToggle />
            <UserMenu onOpenAuth={() => setShowAuthModal(true)} />
          </div>
        </div>
      </header>

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
      />
    </>
  );
}
