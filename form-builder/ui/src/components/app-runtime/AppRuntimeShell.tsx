import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Home, FileText, User, Menu, X, ChevronLeft } from 'lucide-react';
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

  return (
    <div className="min-h-screen flex">
      {/* Desktop Sidebar */}
      <aside className={cn(
        'hidden md:flex flex-col border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 transition-all duration-300 flex-shrink-0',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}>
        <div className="h-14 flex items-center px-4 border-b border-gray-200 dark:border-slate-700">
          {!sidebarCollapsed && (
            <h2 className="font-semibold truncate app-text-primary">{config.app.name}</h2>
          )}
          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="ml-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-500 dark:text-slate-400"
          >
            <ChevronLeft className={cn('h-4 w-4 transition-transform', sidebarCollapsed && 'rotate-180')} />
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors text-left',
                isActive(item.id)
                  ? 'app-bg-primary-light app-text-primary font-medium'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800',
                sidebarCollapsed && 'justify-center px-0'
              )}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" />
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </button>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-200 dark:border-slate-700">
          <button
            onClick={() => navigate(`${basePath}/profile`)}
            className={cn(
              'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800',
              sidebarCollapsed && 'justify-center px-0'
            )}
          >
            <User className="h-4 w-4" />
            {!sidebarCollapsed && <span>Profile</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Mobile header */}
        <header className="md:hidden h-14 flex items-center px-4 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h2 className="ml-3 font-semibold truncate app-text-primary">{config.app.name}</h2>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 md:p-6 overflow-auto">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden flex border-t border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          {navItems.slice(0, 4).map((item) => (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={cn(
                'flex-1 flex flex-col items-center py-2 text-xs transition-colors',
                isActive(item.id)
                  ? 'app-text-primary font-medium'
                  : 'text-gray-400 dark:text-slate-500'
              )}
            >
              <item.icon className="h-5 w-5 mb-0.5" />
              <span className="truncate max-w-[60px]">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Mobile drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white dark:bg-slate-900 shadow-xl">
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-200 dark:border-slate-700">
              <h2 className="font-semibold app-text-primary">{config.app.name}</h2>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-500 dark:text-slate-400"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="p-2 space-y-1">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors text-left',
                    isActive(item.id)
                      ? 'app-bg-primary-light app-text-primary font-medium'
                      : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
