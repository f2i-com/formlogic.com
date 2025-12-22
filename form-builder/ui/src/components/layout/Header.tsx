import { useState } from 'react';
import { Bell } from 'lucide-react';
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
      <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6">
        <div>
          {title && <h1 className="text-xl font-semibold text-gray-900">{title}</h1>}
        </div>

        <div className="flex items-center gap-4">
          {actions}

          <button className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            <Bell className="h-5 w-5" />
          </button>

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
