import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Plus,
  Settings,
  ChevronLeft,
  ChevronRight,
  Globe,
  Cloud,
  HardDrive,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/uiStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';
import { Logo } from '../ui/Logo';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/forms', icon: FileText, label: 'My Forms' },
  { path: '/apps', icon: Globe, label: 'Apps' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const navigate = useNavigate();
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const { createForm, setActiveForm, storageMode } = useFormStore();

  const handleCreateForm = async () => {
    try {
      const form = await createForm('Untitled Form');
      if (!form) return;
      setActiveForm(form.id);
      navigate(`/builder/${form.id}`);
    } catch {
      toast.error('Creation failed', 'Could not create a new form. Please try again.');
    }
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-full bg-white dark:bg-slate-900/50 backdrop-blur-xl border-r border-gray-200 dark:border-white/10 z-40',
        'flex flex-col transition-all duration-300 shadow-xl',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-center px-4 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-transparent">
        <Logo size="sm" showText={!sidebarCollapsed} />
      </div>

      {/* Create Button */}
      <div className="p-3">
        <Button
          onClick={handleCreateForm}
          className={cn('w-full', sidebarCollapsed && 'px-0')}
          leftIcon={<Plus className="h-4 w-4" />}
          aria-label={sidebarCollapsed ? 'Create Form' : undefined}
        >
          {!sidebarCollapsed && 'Create Form'}
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200',
                'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100',
                isActive && [
                  'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 font-medium',
                  'border-l-[3px] border-primary-500 -ml-[3px] pl-[calc(0.75rem+3px)]',
                  'hover:bg-primary-100 dark:hover:bg-primary-500/20'
                ],
                sidebarCollapsed && 'justify-center px-0',
                sidebarCollapsed && isActive && 'ml-0 pl-0 border-l-0'
              )
            }
          >
            {({ isActive }) => (
              <>
                <div className={cn(
                  'flex-shrink-0 p-1 rounded-md transition-colors',
                  isActive && 'bg-primary-100 dark:bg-primary-500/20'
                )}>
                  <item.icon className="h-5 w-5" />
                </div>
                {!sidebarCollapsed && (
                  <span className="text-sm">{item.label}</span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

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
