import { useState } from 'react';
import { ThemeToggle } from '../ui/ThemeToggle';
import { UserMenu } from '../auth/UserMenu';
import { AuthModal } from '../auth/AuthModal';

interface HeaderProps {
  title?: string;
  actions?: React.ReactNode;
}

export function Header({ title, actions }: HeaderProps) {
  const [showAuthModal, setShowAuthModal] = useState(false);

  return (
    <>
      <header className="h-14 sm:h-16 bg-white/95 dark:bg-slate-900/70 backdrop-blur-xl border-b border-gray-200/60 dark:border-white/[0.06] sticky top-0 z-30 flex items-center justify-between px-4 sm:px-6 gap-3 sm:gap-4">
        <div className="flex-1 min-w-0 overflow-hidden">
          {title && (
            <h1
              className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white truncate tracking-tight"
              title={title}
            >
              {title}
            </h1>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {actions && (
            <>
              <div className="flex items-center gap-1.5 sm:gap-2">{actions}</div>
              <div className="h-5 w-px bg-gray-200 dark:bg-slate-800" />
            </>
          )}
          <ThemeToggle />
          <UserMenu onOpenAuth={() => setShowAuthModal(true)} />
        </div>
      </header>

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
      />
    </>
  );
}
