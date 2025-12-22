import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Plus,
  Settings,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/uiStore';
import { useFormStore } from '../../stores/formStore';
import { Button } from '../ui/Button';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/forms', icon: FileText, label: 'My Forms' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export function Sidebar() {
  const navigate = useNavigate();
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const { createForm, setActiveForm } = useFormStore();

  const handleCreateForm = async () => {
    const form = await createForm('Untitled Form');
    setActiveForm(form.id);
    navigate(`/builder/${form.id}`);
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-full bg-white border-r border-gray-200 z-40',
        'flex flex-col transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200">
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">FL</span>
            </div>
            <span className="font-semibold text-gray-900">FormLogic</span>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center mx-auto">
            <span className="text-white font-bold text-sm">FL</span>
          </div>
        )}
      </div>

      {/* Create Button */}
      <div className="p-3">
        <Button
          onClick={handleCreateForm}
          className={cn('w-full', sidebarCollapsed && 'px-0')}
          leftIcon={<Plus className="h-4 w-4" />}
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
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
                'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                isActive && 'bg-primary-50 text-primary-700 hover:bg-primary-50',
                sidebarCollapsed && 'justify-center px-0'
              )
            }
          >
            <item.icon className="h-5 w-5 flex-shrink-0" />
            {!sidebarCollapsed && (
              <span className="text-sm font-medium">{item.label}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Collapse Button */}
      <div className="p-3 border-t border-gray-200">
        <button
          onClick={toggleSidebar}
          className={cn(
            'flex items-center gap-3 px-3 py-2 w-full rounded-lg',
            'text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors',
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
