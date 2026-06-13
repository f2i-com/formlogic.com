import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useUIStore } from '../../stores/uiStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { cn } from '../../lib/utils';

export function AppShell() {
  const { sidebarCollapsed, isMobile, setIsMobile } = useUIStore();
  const isOnline = useOnlineStatus();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  // (Removed a resize effect that auto-collapsed the sidebar in the 768–1024px
  // band: it read a stale `sidebarCollapsed` closure and overwrote the user's
  // persisted preference on every resize. The sidebar now respects the user's
  // explicit choice at all desktop widths.)

  // Move focus to the main region on navigation so keyboard / screen-reader
  // users land on the page content instead of re-traversing the chrome.
  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <div className="min-h-screen">
      {/* Skip to content (visible on keyboard focus) */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary-600 focus:text-primary-foreground focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        Skip to content
      </a>

      {/* Offline Banner */}
      {!isOnline && (
        <div
          role="status"
          className="fixed top-0 inset-x-0 z-50 h-8 bg-amber-500 text-white text-center text-sm font-medium flex items-center justify-center gap-2"
        >
          <WifiOff className="h-4 w-4" />
          You're offline — changes will sync when you reconnect
        </div>
      )}

      {/* Desktop Sidebar */}
      {!isMobile && <Sidebar offline={!isOnline} />}

      {/* Main Content */}
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        className={cn(
          'min-h-screen transition-all duration-300 focus:outline-none',
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
