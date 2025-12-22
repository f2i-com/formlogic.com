import { useState } from 'react';
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
      <header className="h-14 sm:h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 sm:px-6 gap-3 sm:gap-4">
        <div className="flex-shrink-0 min-w-0">
          {title && <h1 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">{title}</h1>}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {actions && <div className="flex items-center gap-1.5 sm:gap-2">{actions}</div>}
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
