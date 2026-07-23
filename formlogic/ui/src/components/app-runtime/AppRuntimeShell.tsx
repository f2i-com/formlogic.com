import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Home, User, Menu, X, ChevronLeft, MoreHorizontal, WifiOff, Database, FileBarChart, Link2, PencilRuler } from 'lucide-react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { interleaveMenu, menuForms, menuLinks } from './appMenu';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';
import type { AppSettings } from '../../types/app';

interface AppRuntimeShellProps {
  children: React.ReactNode;
}

type NavKind = 'dashboard' | 'form' | 'records' | 'reports' | 'link';

interface NavItem {
  id: string;
  label: string;
  iconName: string | null;
  kind: NavKind;
  path: string;
  /** kind 'link' with an http(s) target: opened in a new tab, never routed. */
  external?: boolean;
}

export function AppRuntimeShell({ children }: AppRuntimeShellProps) {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { config, activeFormId, setActiveForm, sidebarCollapsed, toggleSidebar, isOwner } = useAppRuntimeStore();
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
    const path = location.pathname;
    const onRecordsView = path.includes('/records') || /\/form\/[^/]+\/responses/.test(path);
    const onReportsView = path.includes('/reports');
    const hasReports = (config.app?.reports?.length ?? 0) > 0 || isOwner();
    return (
      <main id="app-main-content" ref={mainRef} tabIndex={-1} className="h-screen overflow-y-auto bg-gray-50 dark:bg-slate-950 outline-none">
        {children}
        {/* Chromeless apps still get unobtrusive access to Records + Reports: a single compact
            cluster that rests at 60% opacity so it never fights the dashboard for attention. */}
        {(!onRecordsView || !onReportsView) && (
          <div
            className="group fixed bottom-4 right-4 z-40 flex items-center gap-1.5"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {hasReports && !onReportsView && (
              <button
                onClick={() => navigate(`/app/${appSlug}/reports`)}
                aria-label="View reports"
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium bg-white/80 dark:bg-slate-800/80 backdrop-blur-md text-gray-700 dark:text-slate-200 border border-gray-200/80 dark:border-slate-700/80 shadow-md shadow-black/10 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white dark:hover:bg-slate-800 transition duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <FileBarChart className="h-3.5 w-3.5" />
                Reports
              </button>
            )}
            {!onRecordsView && (
              <button
                onClick={() => navigate(`/app/${appSlug}/records`)}
                aria-label="View records"
                className="app-btn-primary inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium backdrop-blur-md shadow-md shadow-black/10 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
              >
                <Database className="h-3.5 w-3.5" />
                Records
              </button>
            )}
          </div>
        )}
      </main>
    );
  }

  const forms = config.forms || [];
  const basePath = `/app/${appSlug}`;

  const onRecords = location.pathname.includes('/records');
  const onReports = location.pathname.includes('/reports');
  // Reports are optional: the section shows if any exist, or to the owner (who can create them).
  const showReports = (config.app?.reports?.length ?? 0) > 0 || isOwner();

  const dashboardItem: NavItem = { id: 'dashboard', label: 'Dashboard', iconName: null, kind: 'dashboard', path: basePath };
  // Menu entries: data-only (`hidden`) and unlisted (`menuHidden`) forms render
  // no entry; hidden forms are also excluded from custom-link nav targets.
  const formItems: NavItem[] = menuForms(forms).map((f) => ({
    id: f.formId,
    label: f.displayName,
    iconName: f.icon ?? null,
    kind: 'form',
    path: `${basePath}/form/${f.formId}`,
  }));
  // Owner-authored custom menu links (navConfig kind 'link'), interleaved into
  // the Forms group at their authored positions.
  const navigableIds = new Set(forms.filter((f) => f.hidden !== true).map((f) => f.formId));
  const linkItems = menuLinks(config.app.navConfig, navigableIds).map((l) => ({
    item: {
      id: `link:${l.key}`,
      label: l.label,
      iconName: l.icon,
      kind: 'link',
      path: l.externalUrl ?? `${basePath}/${l.appTarget}`,
      external: !!l.externalUrl,
    } as NavItem,
    position: l.position,
  }));
  const formsGroupItems: NavItem[] = interleaveMenu(formItems, linkItems).map((e) =>
    'item' in (e as { item?: NavItem }) ? (e as { item: NavItem }).item : (e as NavItem)
  );
  const recordsItem: NavItem = { id: 'records', label: 'Records', iconName: null, kind: 'records', path: `${basePath}/records` };
  const reportsItem: NavItem = { id: 'reports', label: 'Reports', iconName: null, kind: 'reports', path: `${basePath}/reports` };

  // Sidebar/drawer nav, grouped: Overview / Forms / Data.
  const navGroups: Array<{ label: string; items: NavItem[] }> = [
    { label: 'Overview', items: [dashboardItem] },
    ...(formsGroupItems.length > 0 ? [{ label: 'Forms', items: formsGroupItems }] : []),
    { label: 'Data', items: showReports ? [recordsItem, reportsItem] : [recordsItem] },
  ];

  const handleNav = (item: NavItem) => {
    if (item.external) {
      window.open(item.path, '_blank', 'noopener,noreferrer');
      setMobileMenuOpen(false);
      return;
    }
    setActiveForm(item.kind === 'form' ? item.id : null);
    navigate(item.path);
    setMobileMenuOpen(false);
  };

  const navIcon = (item: NavItem, className: string) => {
    if (item.kind === 'dashboard') return <Home className={className} />;
    if (item.kind === 'records') return <Database className={className} />;
    if (item.kind === 'reports') return <FileBarChart className={className} />;
    if (item.kind === 'link' && !item.iconName) return <Link2 className={className} />;
    return <DynamicIcon name={item.iconName} className={className} />;
  };

  const isActive = (id: string) => {
    if (location.pathname.includes('/profile')) return false;
    if (id === 'reports') return onReports;
    if (id === 'records') return onRecords && !onReports;
    if (onRecords || onReports) return false; // on records/reports, no form/dashboard item is active
    return id === activeFormId || (id === 'dashboard' && !activeFormId);
  };

  // Mobile bottom bar: Dashboard / Records / Reports own the fixed slots — forms live
  // under "More" (they're also reachable from Dashboard and Records), so Records and
  // Reports never fall into the overflow just because an app has many forms.
  const bottomNavItems: NavItem[] = [dashboardItem, recordsItem, ...(showReports ? [reportsItem] : [])];
  const hasMoreItems = formsGroupItems.length > 0;
  // Highlight "More" when the current section (a form) lives in the overflow menu.
  const activeInOverflow = hasMoreItems && formsGroupItems.some((i) => isActive(i.id));

  // Brand mark: logo image if the app has one, else its lucide icon, else its initial —
  // always on the app-accent tint tile so every app gets a mark without configuration.
  const appIconName = (config.app.settings as AppSettings & { icon?: string }).icon ?? null;
  const appInitial = (config.app.name || '').trim().charAt(0).toUpperCase() || '?';
  const brandMark = (size: 'md' | 'sm') => (
    <span
      aria-hidden="true"
      className={cn(
        'app-bg-primary-light app-text-primary inline-flex items-center justify-center overflow-hidden flex-shrink-0',
        size === 'md' ? 'h-9 w-9 rounded-xl' : 'h-8 w-8 rounded-lg'
      )}
    >
      {config.app.logoUrl ? (
        <img src={config.app.logoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <DynamicIcon
          name={appIconName}
          className={size === 'md' ? 'h-[18px] w-[18px]' : 'h-4 w-4'}
          fallback={
            <span className={cn('font-semibold leading-none', size === 'md' ? 'text-sm' : 'text-xs')}>
              {appInitial}
            </span>
          }
        />
      )}
    </span>
  );

  return (
    <div className="h-dvh flex bg-gray-50 dark:bg-slate-950">
      <a
        href="#app-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-white dark:focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 app-ring-primary"
      >
        Skip to content
      </a>
      {/* Desktop Sidebar */}
      <aside className={cn(
        'hidden md:flex flex-col border-r border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 transition-all duration-300 flex-shrink-0',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}>
        <div className="h-14 flex items-center gap-2.5 px-3 border-b border-gray-100 dark:border-slate-800/80">
          {!sidebarCollapsed && (
            <>
              {brandMark('md')}
              <h2 className="font-semibold truncate min-w-0 text-gray-900 dark:text-slate-100 text-[15px] tracking-tight">{config.app.name}</h2>
            </>
          )}
          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
          >
            <ChevronLeft className={cn('h-4 w-4 motion-safe:transition-transform motion-safe:duration-200', sidebarCollapsed && 'rotate-180')} />
          </button>
        </div>
        <nav className="flex-1 p-2 overflow-y-auto">
          {navGroups.map((group, gi) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className={cn(gi > 0 && (sidebarCollapsed ? 'mt-2 pt-2 border-t border-gray-100 dark:border-slate-800/80' : 'mt-4'))}
            >
              {!sidebarCollapsed && (
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 select-none">
                  {group.label}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleNav(item)}
                    aria-current={isActive(item.id) ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors duration-150 text-left cursor-pointer',
                      'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                      isActive(item.id)
                        ? 'app-bg-primary-light app-text-primary font-medium shadow-sm'
                        : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 hover:text-gray-900 dark:hover:text-slate-200',
                      sidebarCollapsed && 'justify-center px-0'
                    )}
                    title={sidebarCollapsed ? item.label : undefined}
                  >
                    {/* Accent bar doubles the active cue so it doesn't rely on the tint alone. */}
                    {isActive(item.id) && (
                      <span aria-hidden="true" className="app-bg-primary absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full" />
                    )}
                    {navIcon(item, 'h-4 w-4 flex-shrink-0')}
                    {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-100 dark:border-slate-800/80">
          {/* Owner bridge back to the App Studio (Use app ↔ Edit app). */}
          {isOwner() && (
            <button
              onClick={() => navigate(`/apps/${config.app.id}/studio`)}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2 mb-1 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 hover:text-gray-900 dark:hover:text-slate-200 transition-colors duration-150 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                sidebarCollapsed && 'justify-center px-0'
              )}
              title={sidebarCollapsed ? 'Edit app' : undefined}
            >
              <PencilRuler className="h-4 w-4" />
              {!sidebarCollapsed && <span>Edit app</span>}
            </button>
          )}
          <div className={cn('flex gap-1', sidebarCollapsed ? 'flex-col items-center' : 'items-center')}>
            <button
              onClick={() => navigate(`${basePath}/profile`)}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors duration-150 cursor-pointer',
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

      {/* Main content — min-w-0 so a wide data table / long string can't widen the flex row and scroll
          the whole page; min-h-0 so <main> scrolls internally (keeps the sidebar footer on-screen). */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile header */}
        <header className="md:hidden h-14 flex items-center px-4 border-b border-gray-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/80 sticky top-0 z-30 backdrop-blur-xl">
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="min-h-11 min-w-11 inline-flex items-center justify-center -ml-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400 transition-colors duration-150 cursor-pointer"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="ml-2 flex items-center gap-2.5 min-w-0">
            {brandMark('sm')}
            <h2 className="font-semibold truncate min-w-0 text-gray-900 dark:text-slate-100 text-[15px] tracking-tight">{config.app.name}</h2>
          </div>
          <div className="ml-auto -mr-1.5 flex items-center flex-shrink-0">
            <ThemeToggle />
            <button
              onClick={() => navigate(`${basePath}/profile`)}
              aria-label="Profile"
              className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors duration-150 cursor-pointer"
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
                'flex-1 flex flex-col items-center py-3 text-[11px] transition-colors duration-150 cursor-pointer',
                isActive(item.id)
                  ? 'app-text-primary font-semibold'
                  : 'text-gray-400 dark:text-slate-500'
              )}
            >
              {navIcon(item, cn('h-5 w-5 mb-0.5 motion-safe:transition-transform motion-safe:duration-200', isActive(item.id) && 'scale-110'))}
              <span className="truncate max-w-[64px]">{item.label}</span>
            </button>
          ))}
          {hasMoreItems && (
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-current={activeInOverflow ? 'page' : undefined}
              className={cn(
                'flex-1 flex flex-col items-center py-3 text-[11px] transition-colors duration-150 cursor-pointer',
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
            <div className="h-14 flex items-center gap-2.5 px-3 border-b border-gray-100 dark:border-slate-800/80 flex-shrink-0">
              {brandMark('sm')}
              <h2 className="font-semibold truncate min-w-0 text-gray-900 dark:text-slate-100 text-[15px] tracking-tight">{config.app.name}</h2>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 transition-colors duration-150 cursor-pointer flex-shrink-0"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-2 overflow-y-auto">
              {navGroups.map((group, gi) => (
                <div key={group.label} role="group" aria-label={group.label} className={cn(gi > 0 && 'mt-4')}>
                  <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 select-none">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => handleNav(item)}
                        aria-current={isActive(item.id) ? 'page' : undefined}
                        className={cn(
                          'relative flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-colors duration-150 text-left cursor-pointer',
                          'focus-visible:outline-none focus-visible:ring-2 app-ring-primary',
                          isActive(item.id)
                            ? 'app-bg-primary-light app-text-primary font-medium shadow-sm'
                            : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 hover:text-gray-900 dark:hover:text-slate-200'
                        )}
                      >
                        {isActive(item.id) && (
                          <span aria-hidden="true" className="app-bg-primary absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full" />
                        )}
                        {navIcon(item, 'h-4 w-4 flex-shrink-0')}
                        <span className="truncate">{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
            <div className="p-2 border-t border-gray-100 dark:border-slate-800/80">
              {isOwner() && (
                <button
                  onClick={() => { navigate(`/apps/${config.app.id}/studio`); setMobileMenuOpen(false); }}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
                >
                  <PencilRuler className="h-4 w-4" />
                  <span>Edit app</span>
                </button>
              )}
              <button
                onClick={() => { navigate(`${basePath}/profile`); setMobileMenuOpen(false); }}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/80 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
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
