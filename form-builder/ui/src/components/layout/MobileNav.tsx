import { NavLink } from 'react-router-dom';
import { LayoutDashboard, FileText, Plus, Boxes, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useCreateFormFlow } from '../../hooks/useCreateFormFlow';
import { useAuthStore } from '../../stores/authStore';

export function MobileNav() {
  // Tapping "Create" opens the New Form picker (template or blank), not a blank form.
  const { openNewForm, newFormPicker } = useCreateFormFlow();
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  // The demo account's Home/Dashboard lives at /dashboard ("/" is its marketing landing).
  const homePath = isDemo ? '/dashboard' : '/';

  const navItems = [
    { path: homePath, icon: LayoutDashboard, label: 'Home' },
    { path: '/forms', icon: FileText, label: 'Forms' },
    { action: openNewForm, icon: Plus, label: 'Create', isAction: true },
    // Boxes matches the Apps iconography on My Forms — Globe is reserved for "publish".
    { path: '/apps', icon: Boxes, label: 'Apps' },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <>
    <nav className="fixed bottom-0 left-0 right-0 bg-white/95 dark:bg-slate-900/50 backdrop-blur-xl border-t border-gray-100 dark:border-white/10 z-50 md:hidden safe-area-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item, index) => {
          if (item.isAction) {
            return (
              <button
                key={index}
                onClick={item.action}
                aria-label="Create new form"
                className="flex flex-col items-center justify-center gap-1 px-3 py-2 -mt-6 group cursor-pointer"
              >
                <div className="w-14 h-14 bg-gradient-to-br from-primary-500 to-primary-600 rounded-full flex items-center justify-center shadow-lg shadow-primary-500/30 dark:shadow-primary-500/40 transition-transform duration-200 group-hover:scale-105 group-active:scale-95 border-4 border-white dark:border-slate-950">
                  <item.icon className="h-6 w-6 text-primary-foreground" />
                </div>
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
                  'flex flex-col items-center justify-center gap-1 px-4 py-2 rounded-xl',
                  'transition-all duration-200',
                  isActive
                    ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10'
                    : 'text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 active:bg-gray-100 dark:active:bg-slate-800'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('h-5 w-5 transition-transform', isActive && 'scale-110')} />
                  <span className="text-xs font-medium">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
    {newFormPicker}
    </>
  );
}
