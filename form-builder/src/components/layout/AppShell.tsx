import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

export function AppShell() {
  const { sidebarCollapsed, isMobile, setIsMobile } = useUIStore();

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Desktop Sidebar */}
      {!isMobile && <Sidebar />}

      {/* Main Content */}
      <main
        className={cn(
          'min-h-screen transition-all duration-300',
          !isMobile && (sidebarCollapsed ? 'ml-16' : 'ml-64'),
          isMobile && 'pb-20'
        )}
      >
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      {isMobile && <MobileNav />}
    </div>
  );
}
