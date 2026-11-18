import { ArrowLeft } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { AppTile } from '../apps/AppTile';
import { listedStatus } from '../../lib/appStatus';
import { cn } from '../../lib/utils';
import { followAppLink, type AppSidebarNavigation } from './useAppSectionSidebar';
import type { AppSectionItem } from './appSectionNavigation';

export function ScopedAppSidebar({ navigation: { app, items, leave }, section, collapsed }: {
  navigation: AppSidebarNavigation;
  section: string;
  collapsed: boolean;
}) {
  const { pathname } = useLocation();
  const link = (item: AppSectionItem) => {
    const active = section === item.value;
    return (
      <Link key={item.value} to={item.to} aria-label={item.label} aria-current={active ? 'page' : undefined}
        onClick={event => followAppLink(event, item.to, pathname, leave)}
        title={collapsed ? item.label : undefined}
        className={cn(
          'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary-500',
          collapsed && 'justify-center px-0',
          active
            ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-200'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
        )}>
        <item.icon className="size-[17px] shrink-0" aria-hidden="true" />
        {!collapsed && item.label}
      </Link>
    );
  };
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className={cn('px-4 pb-3 pt-4', collapsed && 'px-2')}>
        <Link to="/apps" aria-label="All apps" title={collapsed ? 'All apps' : undefined}
          onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            leave('/apps');
          }}
          className={cn('inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-300 dark:hover:bg-slate-800',
            collapsed && 'flex w-full justify-center px-0')}>
          <ArrowLeft className="size-4" aria-hidden="true" />{!collapsed && 'All apps'}
        </Link>
        <div title={app.name} className={cn('mt-3 flex items-center gap-3 px-1', collapsed && 'justify-center px-0')}>
          <AppTile app={app} size="sm" className="size-9 rounded-lg" />
          {!collapsed && <div className="min-w-0">
            <p className="break-words text-[15px] font-semibold leading-tight tracking-tight text-slate-950 dark:text-white">{app.name}</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{listedStatus(app)}</p>
          </div>}
        </div>
      </div>
      <nav aria-label="App sections" className={cn('space-y-3 px-3 pb-4', collapsed && 'px-2')}>
        {items.filter(item => !item.group).map(link)}
        {(['Build', 'Manage'] as const).map(group => (
          <div key={group} role="group" aria-label={group} className={cn('space-y-0.5', collapsed && 'border-t border-slate-200 pt-2 dark:border-slate-700')}>
            {!collapsed && <p aria-hidden="true" className="px-3 pb-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{group}</p>}
            {items.filter(item => item.group === group).map(link)}
          </div>
        ))}
      </nav>
    </div>
  );
}
