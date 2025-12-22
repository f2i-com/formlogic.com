import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, FileText, Plus, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useFormStore } from '../../stores/formStore';

export function MobileNav() {
  const navigate = useNavigate();
  const { createForm, setActiveForm } = useFormStore();

  const handleCreateForm = async () => {
    const form = await createForm('Untitled Form');
    setActiveForm(form.id);
    navigate(`/builder/${form.id}`);
  };

  const navItems = [
    { path: '/', icon: LayoutDashboard, label: 'Home' },
    { path: '/forms', icon: FileText, label: 'Forms' },
    { action: handleCreateForm, icon: Plus, label: 'Create', isAction: true },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 md:hidden">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item, index) => {
          if (item.isAction) {
            return (
              <button
                key={index}
                onClick={item.action}
                className="flex flex-col items-center justify-center gap-1 px-3 py-2 -mt-6"
              >
                <div className="w-12 h-12 bg-primary-600 rounded-full flex items-center justify-center shadow-lg">
                  <item.icon className="h-6 w-6 text-white" />
                </div>
              </button>
            );
          }

          return (
            <NavLink
              key={item.path}
              to={item.path!}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center justify-center gap-1 px-3 py-2',
                  'text-gray-500 transition-colors',
                  isActive && 'text-primary-600'
                )
              }
            >
              <item.icon className="h-5 w-5" />
              <span className="text-xs font-medium">{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
