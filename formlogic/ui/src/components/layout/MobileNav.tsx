import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, FileText, Plus, Boxes, Workflow, Plug, FilePlus2, Map as MapIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { useCreateFormFlow } from '../../hooks/useCreateFormFlow';
import { useAuthStore } from '../../stores/authStore';
import { ConnectAiModal } from '../mcp/ConnectAiModal';

export function MobileNav() {
  // Tapping "Create" opens the New Form picker (template or blank), not a blank form.
  const { openNewForm, newFormPicker } = useCreateFormFlow();
  const navigate = useNavigate();
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [showHandToAi, setShowHandToAi] = useState(false);
  // The demo account's Home/Dashboard lives at /dashboard ("/" is its marketing landing).
  const homePath = isDemo ? '/dashboard' : '/';

  useEffect(() => {
    if (!quickMenuOpen) return undefined;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setQuickMenuOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [quickMenuOpen]);

  const closeMenu = () => setQuickMenuOpen(false);
  const handleNewForm = () => {
    closeMenu();
    openNewForm();
  };
  const handleNewApp = () => {
    closeMenu();
    navigate('/apps/new');
  };
  const handleNewFlow = () => {
    closeMenu();
    // ?new=1 tells the flows workspace to open the New-flow dialog immediately.
    navigate('/flows?new=1');
  };
  const handleNewDiagram = () => {
    closeMenu();
    // §11A: same entry as the Dashboard's "Start with a diagram" — create and land on it.
    void api.createBlueprint({ name: 'Untitled diagram' }).then((res) => {
      if (res.data?.blueprint) navigate(`/diagrams/${res.data.blueprint.id}`);
    });
  };
  const handleHandToAi = () => {
    closeMenu();
    setShowHandToAi(true);
  };

  const navItems = [
    { path: homePath, icon: LayoutDashboard, label: 'Home' },
    { path: '/forms', icon: FileText, label: 'Forms' },
    { action: () => setQuickMenuOpen((open) => !open), icon: Plus, label: 'Create', isAction: true },
    // Boxes matches the Apps iconography on My Forms — Globe is reserved for "publish".
    { path: '/apps', icon: Boxes, label: 'Apps' },
    // Settings moved into the profile menu (Header); Flows is now a first-class section.
    { path: '/flows', icon: Workflow, label: 'Flows' },
  ];

  return (
    <>
    {quickMenuOpen && (
      <>
        <button
          type="button"
          aria-label="Close create menu"
          className="fixed inset-0 z-[55] bg-transparent md:hidden"
          onClick={closeMenu}
        />
        <div
          role="menu"
          aria-label="Create menu"
          className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] left-1/2 z-[60] w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-gray-200/80 bg-white p-1.5 shadow-xl ring-1 ring-black/5 animate-scale-in dark:border-slate-800 dark:bg-slate-900 dark:ring-white/[0.06] md:hidden"
        >
          <QuickMenuItem icon={FilePlus2} label="New form" onClick={handleNewForm} />
          {!isDemo && <QuickMenuItem icon={MapIcon} label="New diagram" onClick={handleNewDiagram} />}
          <QuickMenuItem icon={Boxes} label="New app" onClick={handleNewApp} />
          <QuickMenuItem icon={Workflow} label="New flow" onClick={handleNewFlow} />
          <QuickMenuItem icon={Plug} label="Connect an AI" onClick={handleHandToAi} />
        </div>
      </>
    )}
    <nav className="fixed bottom-0 left-0 right-0 bg-white/95 dark:bg-slate-900/50 backdrop-blur-xl border-t border-gray-100 dark:border-white/10 z-50 md:hidden safe-area-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item, index) => {
          if (item.isAction) {
            return (
              <button
                key={index}
                onClick={item.action}
                aria-label="Create"
                aria-haspopup="menu"
                aria-expanded={quickMenuOpen}
                className="flex flex-col items-center justify-center gap-1 px-3 py-2 -mt-6 group cursor-pointer"
              >
                <div className="w-14 h-14 bg-gradient-to-br from-primary-500 to-primary-600 rounded-full flex items-center justify-center shadow-lg shadow-primary-500/30 dark:shadow-primary-500/40 transition-transform duration-200 group-hover:scale-105 group-active:scale-95 border-4 border-white dark:border-slate-950">
                  <item.icon className={cn('h-6 w-6 text-primary-foreground transition-transform duration-200', quickMenuOpen && 'rotate-45')} />
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
    <ConnectAiModal isOpen={showHandToAi} onClose={() => setShowHandToAi(false)} creator />
    </>
  );
}

function QuickMenuItem({ icon: Icon, label, onClick }: { icon: typeof Plus; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      // cursor-pointer is explicit: Tailwind's preflight leaves buttons at cursor:default,
      // so desktop/responsive testing never showed the hand cursor here.
      className="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium text-gray-700 transition-colors hover:bg-primary-50 hover:text-primary-700 active:bg-primary-100 dark:text-slate-200 dark:hover:bg-primary-500/10 dark:hover:text-primary-300"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-gray-100 text-gray-500 transition-colors group-hover:bg-primary-100 group-hover:text-primary-600 dark:bg-slate-800 dark:text-slate-400 dark:group-hover:bg-primary-500/20 dark:group-hover:text-primary-300">
        <Icon className="h-5 w-5" />
      </span>
      {label}
    </button>
  );
}
