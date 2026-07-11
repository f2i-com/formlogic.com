import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { Activity, Package, Stethoscope, Users, Wrench } from 'lucide-react';
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
  { to: '/admin', end: true, label: 'Overview', icon: Activity },
  { to: '/admin/users', end: false, label: 'Users', icon: Users },
  { to: '/admin/platform', end: true, label: 'Platform', icon: Wrench },
  { to: '/admin/upgrade', end: true, label: 'Upgrade', icon: Package },
  { to: '/admin/doctor', end: true, label: 'Doctor', icon: Stethoscope },
];

export function AdminLayout() {
  useDocumentTitle('Admin');
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <Header title="Admin" />
      <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto w-full">
        <nav className="flex flex-wrap gap-2 mb-6" aria-label="Admin sections">
          {TABS.map(({ to, end, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                isActive
                  ? 'inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-primary-foreground'
                  : 'inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </div>
    </div>
  );
}
