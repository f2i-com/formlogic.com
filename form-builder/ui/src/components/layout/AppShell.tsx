import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useUIStore } from '../../stores/uiStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';

export function AppShell() {
  const { sidebarCollapsed, isMobile, setIsMobile } = useUIStore();
  const isOnline = useOnlineStatus();

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  return (
    <div className="min-h-screen">
      {/* Offline Banner */}
      {!isOnline && (
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-white text-center py-1.5 text-sm font-medium flex items-center justify-center gap-2">
          <WifiOff className="h-4 w-4" />
          You're offline — changes will sync when you reconnect
        </div>
      )}

      {/* Desktop Sidebar */}
      {!isMobile && <Sidebar />}

      {/* Main Content */}
      <main
        className={cn(
          'min-h-screen transition-all duration-300',
          !isMobile && (sidebarCollapsed ? 'ml-16' : 'ml-64'),
          isMobile && 'pb-20',
          !isOnline && 'pt-8'
        )}
      >
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      {isMobile && <MobileNav />}
    </div>
  );
}
