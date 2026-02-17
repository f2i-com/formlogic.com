import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Home, FileText, User, Menu, X, ChevronLeft, MoreHorizontal } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { cn } from '../../lib/utils';

interface AppRuntimeShellProps {
  children: React.ReactNode;
}

export function AppRuntimeShell({ children }: AppRuntimeShellProps) {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const { config, activeFormId, setActiveForm, sidebarCollapsed, toggleSidebar } = useAppRuntimeStore();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close drawer on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && mobileMenuOpen) {
      setMobileMenuOpen(false);
    }
  }, [mobileMenuOpen]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);

  if (!config) return null;

  const forms = config.forms || [];
  const basePath = `/app/${appSlug}`;

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Home, path: basePath },
    ...forms.map((f) => ({
      id: f.formId,
      label: f.displayName,
      icon: FileText,
      path: `${basePath}/form/${f.formId}`,
    })),
  ];

  const handleNav = (item: typeof navItems[0]) => {
    if (item.id !== 'dashboard') {
      setActiveForm(item.id);
    } else {
      setActiveForm(null);
    }
    navigate(item.path);
    setMobileMenuOpen(false);
  };

  const isActive = (id: string) =>
    id === activeFormId || (id === 'dashboard' && !activeFormId);

  // Bottom nav: show up to 4 items, with "More" if overflow
  const maxBottomItems = navItems.length > 4 ? 3 : 4;
  const bottomNavItems = navItems.slice(0, maxBottomItems);
  const hasMoreItems = navItems.length > maxBottomItems;

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-slate-950">
      {/* Desktop Sidebar */}
      <aside className={cn(
        'hidden md:flex flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-all duration-300 flex-shrink-0',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}>
        <div className="h-14 flex items-center px-4 border-b border-gray-100 dark:border-slate-800">
          {!sidebarCollapsed && (
            <h2 className="font-semibold truncate app-text-primary text-sm">{config.app.name}</h2>
          )}
          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors cursor-pointer"
          >
            <ChevronLeft className={cn('h-4 w-4 transition-transform duration-200', sidebarCollapsed && 'rotate-180')} />
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors text-left',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
                isActive(item.id)
                  ? 'app-bg-primary-light app-text-primary font-medium'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800',
                sidebarCollapsed && 'justify-center px-0'
              )}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-100 dark:border-slate-800">
          <button
            onClick={() => navigate(`${basePath}/profile`)}
            className={cn(
              'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
              sidebarCollapsed && 'justify-center px-0'
            )}
            title={sidebarCollapsed ? 'Profile' : undefined}
          >
            <User className="h-4 w-4" />
            {!sidebarCollapsed && <span>Profile</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Mobile header */}
        <header className="md:hidden h-14 flex items-center px-4 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-30">
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="p-1.5 -ml-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h2 className="ml-3 font-semibold truncate app-text-primary text-sm">{config.app.name}</h2>
          <button
            onClick={() => navigate(`${basePath}/profile`)}
            aria-label="Profile"
            className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors"
          >
            <User className="h-5 w-5" />
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 md:p-6 overflow-auto bg-gray-50 dark:bg-slate-950">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 pb-safe">
          {bottomNavItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={cn(
                'flex-1 flex flex-col items-center py-2.5 text-[10px] transition-colors',
                isActive(item.id)
                  ? 'app-text-primary font-semibold'
                  : 'text-gray-400 dark:text-slate-500'
              )}
            >
              <item.icon className={cn('h-5 w-5 mb-0.5', isActive(item.id) && 'scale-110')} />
              <span className="truncate max-w-[64px]">{item.label}</span>
            </button>
          ))}
          {hasMoreItems && (
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="flex-1 flex flex-col items-center py-2.5 text-[10px] text-gray-400 dark:text-slate-500 transition-colors"
            >
              <MoreHorizontal className="h-5 w-5 mb-0.5" />
              <span>More</span>
            </button>
          )}
        </nav>
      </div>

      {/* Mobile drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 top-0 bottom-0 w-64 sm:w-72 bg-white dark:bg-slate-900 shadow-2xl flex flex-col">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-100 dark:border-slate-800 flex-shrink-0">
              <h2 className="font-semibold app-text-primary text-sm">{config.app.name}</h2>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors text-left',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
                    isActive(item.id)
                      ? 'app-bg-primary-light app-text-primary font-medium'
                      : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                  )}
                >
                  <item.icon className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="p-2 border-t border-gray-100 dark:border-slate-800">
              <button
                onClick={() => { navigate(`${basePath}/profile`); setMobileMenuOpen(false); }}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
              >
                <User className="h-4 w-4" />
                <span>Profile</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
