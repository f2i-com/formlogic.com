import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  FileText,
  LayoutDashboard,
  Plus,
  Search,
  Workflow,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { AppTile } from '../apps/AppTile';
import type { AppListItem } from '../../types/app';

export function MobileNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const apps = useAppStore((s) => s.apps);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const [appsOpen, setAppsOpen] = useState(false);
  const [query, setQuery] = useState('');

  // The demo account's Home/Dashboard lives at /dashboard ("/" is its marketing landing).
  const homePath = isDemo ? '/dashboard' : '/';
  const appsRouteActive = location.pathname === '/apps' || location.pathname.startsWith('/apps/');

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    if (!appsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAppsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appsOpen]);

  const visibleApps = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return apps.filter((app) => {
      if (app.status === 'archived') return false;
      return !needle || app.name.toLowerCase().includes(needle) || app.slug.toLowerCase().includes(needle);
    });
  }, [apps, query]);

  const openApp = (app: AppListItem) => {
    setAppsOpen(false);
    if (app.canManage) navigate(`/apps/${app.id}/studio`);
    else navigate(`/app/${app.slug}`);
  };

  const go = (path: string) => {
    setAppsOpen(false);
    navigate(path);
  };

  const navItems = [
    { path: homePath, icon: LayoutDashboard, label: 'Home' },
    { path: '/forms', icon: FileText, label: 'Forms' },
    // App-first: "+" goes straight to Create app (name it → App Studio).
    { action: () => go('/apps/new'), icon: Plus, label: 'Create app', isAction: true },
    // Apps opens the quick-access drawer; "View all apps" remains one tap inside.
    { action: () => setAppsOpen((open) => !open), icon: Boxes, label: 'Apps', isApps: true },
    { path: '/flows', icon: Workflow, label: 'Flows' },
  ];

  return (
    <>
      {appsOpen && (
        <div className="fixed inset-0 z-[55] md:hidden">
          <button
            type="button"
            aria-label="Close apps menu"
            onClick={() => setAppsOpen(false)}
            className="absolute inset-0 cursor-default bg-slate-950/35 backdrop-blur-[2px]"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Your apps"
            className="absolute inset-y-0 left-0 flex w-[min(88vw,22rem)] flex-col border-r border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-950"
          >
            <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-4 dark:border-white/10">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
                <Boxes className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-950 dark:text-white">Your apps</h2>
                <p className="text-xs text-gray-500 dark:text-slate-400">{visibleApps.length} available</p>
              </div>
              <button
                type="button"
                onClick={() => setAppsOpen(false)}
                aria-label="Close apps menu"
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 border-b border-gray-100 p-3 dark:border-white/[0.07]">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Search your apps"
                  placeholder="Search your apps"
                  autoFocus
                  className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-primary-400 focus:bg-white focus:ring-2 focus:ring-primary-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:placeholder:text-slate-500 dark:focus:bg-white/[0.06]"
                />
              </label>
              <button
                type="button"
                onClick={() => go('/apps/new')}
                className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:ring-offset-slate-950"
              >
                <Plus className="h-4 w-4" /> Create app
              </button>
            </div>

            <div className="scrollbar-thin flex-1 space-y-1 overflow-y-auto p-3">
              {visibleApps.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <Boxes className="mx-auto h-7 w-7 text-gray-300 dark:text-slate-700" />
                  <p className="mt-3 text-sm font-medium text-gray-700 dark:text-slate-300">
                    {query.trim() ? 'No matching apps' : 'No apps yet'}
                  </p>
                  <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                    {query.trim() ? 'Try a different name.' : 'Create your first app to see it here.'}
                  </p>
                </div>
              ) : (
                visibleApps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => openApp(app)}
                    className="group flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-white/[0.05]"
                  >
                    <AppTile app={app} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-gray-800 dark:text-slate-200">{app.name}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-slate-500">
                        <span className={cn('h-1.5 w-1.5 rounded-full', app.status === 'published' ? 'bg-emerald-500' : 'bg-amber-500')} />
                        {app.status === 'published' ? 'Published' : 'Draft'}
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-primary-500 dark:text-slate-700" />
                  </button>
                ))
              )}
            </div>

            <div className="border-t border-gray-200 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-white/10">
              <button
                type="button"
                onClick={() => go('/apps')}
                className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-xl px-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300 dark:hover:bg-white/[0.05] dark:hover:text-primary-300"
              >
                View all apps <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </aside>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-100 bg-white/95 backdrop-blur-xl safe-area-bottom dark:border-white/10 dark:bg-slate-900/90 md:hidden">
        <div className="flex h-16 items-center px-1">
          {navItems.map((item) => {
            if (item.isAction) {
              return (
                <button
                  key={item.label}
                  onClick={item.action}
                  aria-label="Create app"
                  className="group -mt-6 flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 py-2"
                >
                  <span className="flex h-14 w-14 items-center justify-center rounded-full border-4 border-white bg-gradient-to-br from-primary-500 to-primary-600 shadow-lg shadow-primary-500/30 transition-transform duration-200 group-hover:scale-105 group-active:scale-95 dark:border-slate-950 dark:shadow-primary-500/40">
                    <item.icon className="h-6 w-6 text-primary-foreground" />
                  </span>
                </button>
              );
            }

            if (item.isApps) {
              const active = appsOpen || appsRouteActive;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  aria-label="Open your apps"
                  aria-expanded={appsOpen}
                  className={cn(
                    'flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 transition-all duration-200',
                    active
                      ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                      : 'text-gray-400 hover:text-gray-600 active:bg-gray-100 dark:text-slate-500 dark:hover:text-slate-300 dark:active:bg-slate-800'
                  )}
                >
                  <item.icon className={cn('h-5 w-5 transition-transform', active && 'scale-110')} />
                  <span className="truncate text-[11px] font-medium">{item.label}</span>
                </button>
              );
            }

            return (
              <NavLink
                key={item.path}
                to={item.path!}
                end={item.path === homePath}
                className={({ isActive }) =>
                  cn(
                    'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 transition-all duration-200',
                    isActive
                      ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                      : 'text-gray-400 hover:text-gray-600 active:bg-gray-100 dark:text-slate-500 dark:hover:text-slate-300 dark:active:bg-slate-800'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={cn('h-5 w-5 transition-transform', isActive && 'scale-110')} />
                    <span className="truncate text-[11px] font-medium">{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </>
  );
}
