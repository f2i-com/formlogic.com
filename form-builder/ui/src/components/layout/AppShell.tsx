import { useEffect, useRef, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { DemoBanner } from './DemoBanner';
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
          className="fixed top-0 inset-x-0 z-50 h-8 bg-amber-500 text-amber-950 text-center text-sm font-medium flex items-center justify-center gap-2"
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
          // overflow-x-clip is a safety net so the page can NEVER scroll horizontally
          // (wide widgets like tables use their own contained overflow-x-auto). clip,
          // not hidden, so it doesn't create a scroll container — the sticky header
          // and dropdowns keep working.
          'min-h-screen transition-all duration-300 focus:outline-none overflow-x-clip',
          !isMobile && (sidebarCollapsed ? 'ml-16' : 'ml-64'),
          // Clear the fixed bottom nav PLUS the home-indicator safe-area inset on
          // notched phones, so trailing content isn't hidden behind the nav.
          isMobile && 'pb-[calc(5rem+env(safe-area-inset-bottom))]',
          !isOnline && 'pt-8'
        )}
      >
        {/* Live-demo banner (only for the shared Demo account) */}
        <DemoBanner />

        {/* Content-area Suspense so lazy pages load WITHOUT blanking the sidebar/
            nav (the app-level boundary would unmount the whole shell). */}
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-32" role="status" aria-label="Loading">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      {/* Mobile Bottom Nav */}
      {isMobile && <MobileNav />}
    </div>
  );
}
