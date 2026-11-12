import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Activity, Package, Stethoscope, Users, Wrench } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { PageBody } from '../../components/layout/PageBody';
import { SectionNav } from '../../components/ui/SectionNav';
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

// The sections, as the row of links under the header shows them. `end` marks a section that is
// one page; Users also holds each user's own page.
const SECTIONS = [
  { value: 'overview', to: '/admin', end: true, label: 'Overview', icon: Activity },
  { value: 'users', to: '/admin/users', end: false, label: 'Users', icon: Users },
  { value: 'platform', to: '/admin/platform', end: true, label: 'Platform', icon: Wrench },
  { value: 'upgrade', to: '/admin/upgrade', end: true, label: 'Updates', icon: Package },
  { value: 'doctor', to: '/admin/doctor', end: true, label: 'System health', icon: Stethoscope },
] as const;

export function AdminLayout() {
  const { pathname } = useLocation();
  const section = SECTIONS.find(tab => tab.end ? pathname === tab.to : pathname.startsWith(tab.to)) ?? SECTIONS[0];
  useDocumentTitle(`${section.label} · Admin`);
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);
  const needsMfa = useAuthStore((s) => !!s.user?.adminNeedsMfa && !s.user?.mfaEnabled);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen">
      <Header title="Admin" />
      <PageBody>
        <SectionNav label="Admin sections" current={section.value}
          items={SECTIONS.map(({ value, to, label, icon }) => ({ value, to, label, icon }))} />
        <div className="mt-4">
          {needsMfa ? (
            <section role="alert" className="max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
              <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Turn on two-factor authentication first</h2>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">The admin tools reach every account on this server, so they need more than a password. Turn it on, then come back.</p>
              <Link to="/settings#security" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-amber-900 underline dark:text-amber-200">Go to Security settings</Link>
            </section>
          ) : <Outlet />}
        </div>
      </PageBody>
    </div>
  );
}
