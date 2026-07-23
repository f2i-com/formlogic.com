import { useEffect, useMemo, useState } from 'react';
import { NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Plus,
  Workflow,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Blocks,
  Cloud,
  HardDrive,
  Map,
  Package,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/uiStore';
import { useFormStore } from '../../stores/formStore';
import { useAuthStore } from '../../stores/authStore';
import { useAppStore } from '../../stores/appStore';
import { Button } from '../ui/Button';
import { Logo } from '../ui/Logo';
import { AppTile } from '../apps/AppTile';
import type { AppListItem } from '../../types/app';

const TOOLS_OPEN_KEY = 'formlogic.sidebar.toolsOpen';

/**
 * App-first sidebar (App Studio redesign): the user's apps — published and draft —
 * are the primary navigation; forms/flows/diagrams remain reachable under
 * "Advanced tools" as the shared building blocks behind apps.
 */
export function Sidebar({ offline = false }: { offline?: boolean }) {
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const { storageMode } = useFormStore();
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);
  const apps = useAppStore((s) => s.apps);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');

  // Advanced tools start expanded when you're ON one of them (deep links stay
  // oriented); the explicit toggle persists across sessions.
  const onToolRoute = ['/forms', '/flows', '/diagrams', '/packs', '/trash'].some(
    (p) => location.pathname === p || location.pathname.startsWith(p + '/')
  );
  const [toolsOpen, setToolsOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(TOOLS_OPEN_KEY);
      if (stored !== null) return stored === '1';
    } catch { /* private browsing */ }
    return false;
  });
  const toolsExpanded = toolsOpen || onToolRoute;
  const toggleTools = () => {
    const next = !toolsExpanded;
    setToolsOpen(next);
    try { localStorage.setItem(TOOLS_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };

  // Refresh the apps list once per mount so new/renamed apps appear without a reload.
  useEffect(() => { void fetchApps(); }, [fetchApps]);

  // The app whose workspace/studio the user is currently inside (if any).
  const activeAppId =
    matchPath('/apps/:appId/*', location.pathname)?.params.appId ?? null;

  const visibleApps = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const list = trimmed
      ? apps.filter((a) => a.name.toLowerCase().includes(trimmed) || a.slug.toLowerCase().includes(trimmed))
      : apps;
    // Archived apps live in Settings/recycle surfaces, not the primary nav.
    return list.filter((a) => a.status !== 'archived');
  }, [apps, query]);

  const openApp = (app: AppListItem) => {
    // Owners land in the App Studio; members go straight to the live app.
    if (app.canManage) navigate(`/apps/${app.id}/studio`);
    else navigate(`/app/${app.slug}`);
  };

  // The demo account's Dashboard lives at /dashboard ("/" is the marketing landing for it).
  const homePath = isDemo ? '/dashboard' : '/';

  const toolLinks = [
    { path: '/forms', icon: FileText, label: 'Forms' },
    { path: '/flows', icon: Workflow, label: 'Flows' },
    { path: '/diagrams', icon: Map, label: 'Diagrams' },
    { path: '/packs', icon: Package, label: 'Templates' },
    ...(!isDemo ? [{ path: '/trash', icon: Trash2, label: 'Recycle bin' }] : []),
  ];

  return (
    <aside
      className={cn(
        'fixed left-0 bg-white dark:bg-slate-900/50 backdrop-blur-xl border-r border-gray-200 dark:border-white/10 z-40',
        'flex flex-col transition-all duration-300 shadow-xl',
        // Sit below the offline banner (h-8) when offline so it isn't covered
        offline ? 'top-8 h-[calc(100%-2rem)]' : 'top-0 h-full',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-center px-4 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-transparent">
        <NavLink to={homePath} aria-label="Home" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded-lg">
          <Logo size="sm" showText={!sidebarCollapsed} />
        </NavLink>
      </div>

      {/* Create app + search */}
      <div className={cn('p-3 space-y-2.5', sidebarCollapsed && 'space-y-0')}>
        <Button
          onClick={() => navigate('/apps/new')}
          className={cn('w-full', sidebarCollapsed && 'px-0')}
          leftIcon={<Plus className="h-4 w-4" />}
          aria-label={sidebarCollapsed ? 'Create app' : undefined}
        >
          {!sidebarCollapsed && 'Create app'}
        </Button>
        {!sidebarCollapsed && (
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search apps"
              placeholder="Search apps"
              className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-slate-500"
            />
          </label>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-1 space-y-1" aria-label="Workspace">
        <SidebarNavLink
          to={homePath}
          end
          icon={LayoutDashboard}
          label="Home"
          collapsed={sidebarCollapsed}
        />

        {/* Your apps — published and draft */}
        {!sidebarCollapsed && (
          <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-slate-500">
            Your apps
          </p>
        )}
        {visibleApps.length === 0 && !sidebarCollapsed && (
          <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-slate-500">
            {query.trim() ? 'No apps match your search.' : 'No apps yet — create one to get started.'}
          </p>
        )}
        {visibleApps.map((app) => {
          const active = app.id === activeAppId;
          return (
            <button
              key={app.id}
              type="button"
              onClick={() => openApp(app)}
              title={sidebarCollapsed ? app.name : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-all duration-200',
                active
                  ? 'bg-primary-50 dark:bg-primary-500/10 ring-1 ring-inset ring-primary-200/70 dark:ring-primary-500/20'
                  : 'hover:bg-gray-100 dark:hover:bg-slate-800',
                sidebarCollapsed && 'justify-center px-0'
              )}
            >
              <AppTile app={app} size="sm" />
              {!sidebarCollapsed && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className={cn(
                      'block truncate text-sm font-medium',
                      active ? 'text-primary-700 dark:text-primary-300' : 'text-gray-700 dark:text-slate-300'
                    )}>
                      {app.name}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-slate-500">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          app.status === 'published' ? 'bg-emerald-500' : 'bg-amber-500'
                        )}
                        aria-hidden="true"
                      />
                      {app.status === 'published'
                        ? `Published${app.publishedVersion ? ` · v${app.publishedVersion}` : ''}`
                        : 'Draft'}
                    </span>
                  </span>
                  {active && <ChevronRight className="h-4 w-4 shrink-0 text-primary-500 dark:text-primary-400" />}
                </>
              )}
            </button>
          );
        })}

        {/* Advanced tools: the shared building blocks behind apps */}
        <div className="my-3 h-px bg-gray-200/80 dark:bg-white/[0.08]" />
        {sidebarCollapsed ? (
          toolLinks.map((item) => (
            <SidebarNavLink key={item.path} to={item.path} icon={item.icon} label={item.label} collapsed />
          ))
        ) : (
          <>
            <button
              type="button"
              onClick={toggleTools}
              aria-expanded={toolsExpanded}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100 transition-all duration-200"
            >
              <div className="flex-shrink-0 p-1 rounded-md">
                <Blocks className="h-5 w-5" />
              </div>
              <span className="flex-1 text-left text-sm">Advanced tools</span>
              <ChevronDown className={cn('h-4 w-4 transition-transform', toolsExpanded && 'rotate-180')} />
            </button>
            {toolsExpanded && (
              <div className="ml-5 space-y-0.5 border-l border-gray-200 pl-2 dark:border-white/10">
                {toolLinks.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 font-medium'
                          : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100'
                      )
                    }
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            )}
          </>
        )}

        {isAdmin && (
          <SidebarNavLink to="/admin" icon={ShieldCheck} label="Admin" collapsed={sidebarCollapsed} />
        )}
      </nav>

      {/* Settings */}
      <div className="px-3 py-1">
        <SidebarNavLink to="/settings" icon={Settings} label="Settings" collapsed={sidebarCollapsed} />
      </div>

      {/* Storage Mode Indicator */}
      {!sidebarCollapsed && (
        <div className="px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500">
            {storageMode === 'api' ? (
              <><Cloud className="h-3.5 w-3.5" /><span>Cloud Storage</span></>
            ) : (
              <><HardDrive className="h-3.5 w-3.5" /><span>Local Storage</span></>
            )}
          </div>
        </div>
      )}

      {/* Collapse Button */}
      <div className="p-3 border-t border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-transparent">
        <button
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex items-center gap-3 px-3 py-2 w-full rounded-lg',
            'text-gray-500 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-700 dark:hover:text-slate-300 transition-all duration-200 cursor-pointer',
            sidebarCollapsed && 'justify-center px-0'
          )}
        >
          {sidebarCollapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <>
              <ChevronLeft className="h-5 w-5" />
              <span className="text-sm font-medium">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function SidebarNavLink({
  to,
  icon: Icon,
  label,
  collapsed,
  end,
}: {
  to: string;
  icon: typeof Settings;
  label: string;
  collapsed: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200',
          'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100',
          isActive && [
            'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 font-medium',
            'border-l-[3px] border-primary-500 -ml-[3px] pl-[calc(0.75rem+3px)]',
            'hover:bg-primary-100 dark:hover:bg-primary-500/20'
          ],
          collapsed && 'justify-center px-0',
          collapsed && isActive && 'ml-0 pl-0 border-l-0'
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className={cn(
            'flex-shrink-0 p-1 rounded-md transition-colors',
            isActive && 'bg-primary-100 dark:bg-primary-500/20'
          )}>
            <Icon className="h-5 w-5" />
          </div>
          {!collapsed && <span className="text-sm">{label}</span>}
        </>
      )}
    </NavLink>
  );
}
