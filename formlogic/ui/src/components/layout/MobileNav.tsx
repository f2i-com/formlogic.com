import { NavLink, useNavigate } from 'react-router-dom';
import { Boxes, FileText, LayoutDashboard, Plus, Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';

/**
 * The bar at the foot of a phone's screen: Home, Forms, Create app, Apps and Automations.
 *
 * Apps is the apps page itself (`/apps`: every app, its search, Create app), as on a wider screen.
 * It opened a side menu of the apps on a phone, a second, smaller list of the same apps with the
 * page one tap further in. It stands lit on any app's own page too.
 */
export function MobileNav() {
  const navigate = useNavigate();
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);

  // The demo account's Home/Dashboard lives at /dashboard ("/" is its marketing landing).
  const homePath = isDemo ? '/dashboard' : '/';

  const navItems = [
    { path: homePath, icon: LayoutDashboard, label: 'Home' },
    { path: '/forms', icon: FileText, label: 'Forms' },
    // App-first: "+" goes straight to Create app (name it → App Studio).
    { action: () => navigate('/apps/new'), icon: Plus, label: 'Create app', isAction: true },
    { path: '/apps', icon: Boxes, label: 'Apps' },
    { path: '/flows', icon: Workflow, label: 'Automations' },
  ];

  return (
    // (named as the sidebar it stands in for on a wider screen; the two are never on screen together)
    <nav aria-label="Workspace" className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-100 bg-white/95 backdrop-blur-xl safe-area-bottom dark:border-white/10 dark:bg-slate-900/90 md:hidden">
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

          return (
            <NavLink
              key={item.path}
              to={item.path!}
              // Home only at its own address; Apps, Forms and Automations on the pages under them too (an app's page is under /apps).
              end={item.path === homePath}
              className={({ isActive }) =>
                cn(
                  'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 transition-all duration-200',
                  isActive
                    ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                    : 'text-gray-500 hover:text-gray-600 active:bg-gray-100 dark:text-slate-400 dark:hover:text-slate-300 dark:active:bg-slate-800'
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
  );
}
