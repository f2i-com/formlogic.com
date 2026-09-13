import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Activity, Package, Stethoscope, ShieldCheck, Users, Wrench } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { useAuthStore } from '../../stores/authStore';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

/**
 * Platform admin panel shell (/admin/* — platform administrators only; the
 * backend gate is AdminGateMiddleware, this layout just mirrors it client-side).
 *
 * Every section is a real routed PAGE (deep-linkable, no modals):
 *   /admin           Overview — instance counters
 *   /admin/users     User directory → /admin/users/:id detail pages
 *   /admin/platform  Maintenance mode · session boot · broadcasts
 *   /admin/upgrade   In-place release upgrades + backups
 *   /admin/doctor    Deep-health diagnostics (admin-only server-side too)
 *
 * Drilling into a user's app/form/flow leaves this shell for the REAL owner
 * UIs under the acting-as routes (/admin/apps/:id/*, /admin/builder/:id, …).
 */

const TABS = [
  { to: '/admin', end: true, label: 'Overview', description: 'A clear view of your installation, activity, and next steps.', icon: Activity },
  { to: '/admin/users', end: false, label: 'Users', description: 'Manage accounts, access, and account recovery.', icon: Users },
  { to: '/admin/platform', end: true, label: 'Platform', description: 'Configure plans, AI allowances, backups, and site availability.', icon: Wrench },
  { to: '/admin/upgrade', end: true, label: 'Updates', description: 'Review releases, install updates, and manage recovery backups.', icon: Package },
  { to: '/admin/doctor', end: true, label: 'System health', description: 'Check services and find what needs attention.', icon: Stethoscope },
];

export function AdminLayout() {
  const { pathname } = useLocation();
  const section = TABS.find(tab => tab.end ? pathname === tab.to : pathname.startsWith(tab.to)) ?? TABS[0];
  useDocumentTitle(`${section.label} · Admin`);
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <Header title="Admin" />
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300"><ShieldCheck className="h-5 w-5" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary-700 dark:text-primary-300">Administration</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Your FormLogic installation</p>
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
        <nav className="flex flex-wrap gap-2 self-start rounded-2xl border border-gray-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900 lg:sticky lg:top-24 lg:flex-col" aria-label="Admin sections">
          {TABS.map(({ to, end, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                isActive
                  ? 'inline-flex min-h-11 items-center gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 bg-primary-600 px-4 py-2 text-sm font-semibold text-primary-foreground'
                  : 'inline-flex min-h-11 items-center gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{section.label}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-slate-400">{section.description}</p>
          </div>
          <Outlet />
        </div>
        </div>
      </div>
    </div>
  );
}
