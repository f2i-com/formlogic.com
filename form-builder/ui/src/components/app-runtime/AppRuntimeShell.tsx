import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Home, User, Menu, X, ChevronLeft, MoreHorizontal, WifiOff, Database } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';

interface AppRuntimeShellProps {
  children: React.ReactNode;
}

export function AppRuntimeShell({ children }: AppRuntimeShellProps) {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, activeFormId, setActiveForm, sidebarCollapsed, toggleSidebar } = useAppRuntimeStore();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isOnline = useOnlineStatus();
  const mainRef = useRef<HTMLElement>(null);

  // Move focus to the main region on navigation so keyboard / screen-reader users
  // land on the new content instead of staying on the nav.
  useEffect(() => { mainRef.current?.focus(); }, [location.pathname]);

  // Sync activeFormId from URL on location change (deep links, browser back/forward)
  useEffect(() => {
    if (!config) return;
    const formMatch = location.pathname.match(/\/form\/([^/]+)/);
    const urlFormId = formMatch ? formMatch[1] : null;
    // Only sync from URL to store; activeFormId not in deps to avoid extra renders
    if (urlFormId !== useAppRuntimeStore.getState().activeFormId) {
      setActiveForm(urlFormId);
    }
  }, [location.pathname, config, setActiveForm]);

  // Focus trap + Escape + focus restore for the mobile drawer. The drawer is
  // aria-modal, but previously only handled Escape — keyboard/SR users could Tab
  // out onto the page behind it. (Replaces the manual Escape-only handler.)
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, mobileMenuOpen, () => setMobileMenuOpen(false));

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

  // Chromeless mode: a self-contained app (e.g. a custom-home dashboard) can hide the sidebar/header/nav.
  // We still give it a single, unobtrusive way into the submitted records — otherwise a custom
  // dashboard is a dead end for browsing data. Hidden on the records screens themselves.
  const hideNav = (config.app?.settings as { hideNav?: boolean } | undefined)?.hideNav === true;
  if (hideNav) {
    const onRecordsView = location.pathname.includes('/records') || /\/form\/[^/]+\/responses/.test(location.pathname);
    return (
      <main id="app-main-content" ref={mainRef} tabIndex={-1} className="h-screen overflow-y-auto bg-gray-50 dark:bg-slate-950 outline-none">
        {children}
        {!onRecordsView && (
          <button
            onClick={() => navigate(`/app/${appSlug}/records`)}
            aria-label="View records"
            className="app-btn-primary fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium shadow-lg shadow-black/10 hover:opacity-90 transition-opacity cursor-pointer"
            style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
          >
            <Database className="h-4 w-4" />
            Records
          </button>
        )}
      </main>
    );
  }

  const forms = config.forms || [];
  const basePath = `/app/${appSlug}`;

  const onRecords = location.pathname.includes('/records');

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', iconName: null as string | null, kind: 'dashboard' as 'dashboard' | 'form' | 'records', path: basePath },
    ...forms.map((f) => ({
      id: f.formId,
      label: f.displayName,
      iconName: f.icon ?? null,
      kind: 'form' as 'dashboard' | 'form' | 'records',
      path: `${basePath}/form/${f.formId}`,
    })),
    { id: 'records', label: 'Records', iconName: null as string | null, kind: 'records' as 'dashboard' | 'form' | 'records', path: `${basePath}/records` },
  ];

  const handleNav = (item: typeof navItems[0]) => {
    setActiveForm(item.kind === 'form' ? item.id : null);
    navigate(item.path);
    setMobileMenuOpen(false);
  };

  const navIcon = (item: typeof navItems[0], className: string) => {
    if (item.kind === 'dashboard') return <Home className={className} />;
    if (item.kind === 'records') return <Database className={className} />;
    return <DynamicIcon name={item.iconName} className={className} />;
  };

  const isActive = (id: string) => {
    if (location.pathname.includes('/profile')) return false;
    if (id === 'records') return onRecords;
    if (onRecords) return false; // on the records screen, no form/dashboard item is active
    return id === activeFormId || (id === 'dashboard' && !activeFormId);
  };

  // Bottom nav: show up to 4 items, with "More" if overflow
  const maxBottomItems = navItems.length > 4 ? 3 : 4;
  const bottomNavItems = navItems.slice(0, maxBottomItems);
  const hasMoreItems = navItems.length > maxBottomItems;
  // Highlight "More" when the current section lives in the overflow menu.
  const activeInOverflow = hasMoreItems && navItems.slice(maxBottomItems).some((i) => isActive(i.id));

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-slate-950">
      <a
        href="#app-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-white dark:focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-primary-500"
      >
        Skip to content
      </a>
      {/* Desktop Sidebar */}
      <aside className={cn(
        'hidden md:flex flex-col border-r border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 transition-all duration-300 flex-shrink-0',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}>
        <div className="h-14 flex items-center px-4 border-b border-gray-100 dark:border-slate-800/80">
          {!sidebarCollapsed && (
            <h2 className="font-semibold truncate app-text-primary text-sm tracking-tight">{config.app.name}</h2>
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
              aria-current={isActive(item.id) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-all duration-200 text-left cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                isActive(item.id)
                  ? 'app-bg-primary-light app-text-primary font-medium shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80',
                sidebarCollapsed && 'justify-center px-0'
              )}
              title={sidebarCollapsed ? item.label : undefined}
            >
              {navIcon(item, 'h-4 w-4 flex-shrink-0')}
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-100 dark:border-slate-800/80">
          <div className={cn('flex gap-1', sidebarCollapsed ? 'flex-col items-center' : 'items-center')}>
            <button
              onClick={() => navigate(`${basePath}/profile`)}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                sidebarCollapsed ? 'justify-center px-0' : 'flex-1'
              )}
              title={sidebarCollapsed ? 'Profile' : undefined}
            >
              <User className="h-4 w-4" />
              {!sidebarCollapsed && <span>Profile</span>}
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Main content — min-w-0 so a wide data table / long string can't widen the
          flex row and scroll the whole page (the table + main scroll internally). */}
      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* Mobile header */}
        <header className="md:hidden h-14 flex items-center px-4 border-b border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 sticky top-0 z-30 backdrop-blur-xl">
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="min-h-11 min-w-11 inline-flex items-center justify-center -ml-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400 transition-colors cursor-pointer"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h2 className="ml-3 font-semibold truncate app-text-primary text-sm tracking-tight">{config.app.name}</h2>
          <div className="ml-auto -mr-1.5 flex items-center">
            <ThemeToggle />
            <button
              onClick={() => navigate(`${basePath}/profile`)}
              aria-label="Profile"
              className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors cursor-pointer"
            >
              <User className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Offline banner */}
        {!isOnline && (
          <div role="status" className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200/80 dark:border-amber-800/50 px-4 py-2 flex items-center gap-2">
            <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              You're offline. You can keep filling out the form — submissions are queued and sent automatically when you reconnect.
            </p>
          </div>
        )}

        {/* Page content */}
        <main id="app-main-content" ref={mainRef} tabIndex={-1} className="flex-1 p-4 md:p-6 overflow-y-auto overflow-x-clip bg-gray-50 dark:bg-slate-950 outline-none">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 pb-safe backdrop-blur-xl">
          {bottomNavItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              aria-current={isActive(item.id) ? 'page' : undefined}
              className={cn(
                'flex-1 flex flex-col items-center py-3 text-[11px] transition-all duration-200 cursor-pointer',
                isActive(item.id)
                  ? 'app-text-primary font-semibold'
                  : 'text-gray-400 dark:text-slate-500'
              )}
            >
              {navIcon(item, cn('h-5 w-5 mb-0.5 transition-transform', isActive(item.id) && 'scale-110'))}
              <span className="truncate max-w-[64px]">{item.label}</span>
            </button>
          ))}
          {hasMoreItems && (
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-current={activeInOverflow ? 'page' : undefined}
              className={cn(
                'flex-1 flex flex-col items-center py-3 text-[11px] transition-colors cursor-pointer',
                activeInOverflow ? 'app-text-primary font-semibold' : 'text-gray-400 dark:text-slate-500'
              )}
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
          <div ref={drawerRef} tabIndex={-1} className="absolute left-0 top-0 bottom-0 w-64 sm:w-72 bg-white dark:bg-slate-900 shadow-2xl shadow-black/20 flex flex-col">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-100 dark:border-slate-800/80 flex-shrink-0">
              <h2 className="font-semibold app-text-primary text-sm tracking-tight">{config.app.name}</h2>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  aria-current={isActive(item.id) ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-all duration-200 text-left cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                    isActive(item.id)
                      ? 'app-bg-primary-light app-text-primary font-medium shadow-sm'
                      : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80'
                  )}
                >
                  {navIcon(item, 'h-4 w-4 flex-shrink-0')}
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="p-2 border-t border-gray-100 dark:border-slate-800/80">
              <button
                onClick={() => { navigate(`${basePath}/profile`); setMobileMenuOpen(false); }}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
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
