import { Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { deferEffect } from '../../lib/deferredEffect';
import { useAuthStore } from '../../stores/authStore';
import { AdminActingBanner } from './AdminActingBanner';
import { AdminActingContext, enterActing, exitActing, type AdminActing } from './AdminActingContext';

/**
 * Mounts a reused owner UI (app manager / form builder / flows workspace) in
 * platform-admin ACTING mode. Resolves the resource's OWNER via the existing
 * admin structure endpoints BEFORE any child mounts, so by the time the page's
 * own data fetches fire, api.setAdminActing() is already rewriting them onto
 * the /admin/users/{ownerId} mirror.
 *
 * kind: which route param identifies the target —
 *   'app'  → :appId   (owner via adminGetApp)
 *   'form' → :formId  (owner via adminGetForm)
 *   'user' → :userId  (the owner directly, via adminGetUser)
 */
export function AdminActingBoundary({ kind, children }: { kind: 'app' | 'form' | 'user'; children?: ReactNode }) {
  const params = useParams();
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);
  const targetId = (kind === 'app' ? params.appId : kind === 'form' ? params.formId : params.userId) ?? '';
  // Keyed by the target it was resolved FOR — a target change invalidates the
  // previous resolution at render time, so the effect never needs a synchronous
  // reset (eslint react-hooks/set-state-in-effect).
  const [resolved, setResolved] = useState<{ target: string; acting?: AdminActing; error?: string } | null>(null);
  const current = resolved && resolved.target === targetId ? resolved : null;
  const acting = current?.acting ?? null;
  const error = current?.error ?? null;
  const [admitted, setAdmitted] = useState<AdminActing | null>(null);

  // Install the request scope before the owner UI can mount. A lazy editor can suspend,
  // hide and later reconnect the same subtree, even when the owner lookup hasn't changed.
  useLayoutEffect(() => {
    if (!acting || !isAdmin) return;
    enterActing(acting);
    const cancel = deferEffect(() => setAdmitted(acting));
    return () => { cancel(); exitActing(); };
  }, [acting, isAdmin]);

  useEffect(() => {
    if (!isAdmin || !targetId) return;
    let cancelled = false;

    const fail = (message: string) => {
      if (!cancelled) setResolved({ target: targetId, error: message });
    };
    const ready = (ctx: AdminActing) => {
      if (cancelled) return;
      setResolved({ target: targetId, acting: ctx });
    };
    const resolveOwner = (ownerId: string) => {
      api.adminGetUser(ownerId).then((u) => {
        if (u.data) ready({ ownerId, ownerEmail: u.data.user.email, ownerName: u.data.user.name });
        else fail(u.error || 'Could not resolve the resource owner.');
      });
    };

    if (kind === 'app') {
      api.adminGetApp(targetId).then((r) => {
        if (r.data?.ownerId) resolveOwner(r.data.ownerId);
        else fail(r.error || 'App not found.');
      });
    } else if (kind === 'form') {
      api.adminGetForm(targetId).then((r) => {
        if (r.data?.ownerId) resolveOwner(r.data.ownerId);
        else fail(r.error || 'Form not found.');
      });
    } else {
      resolveOwner(targetId);
    }

    return () => {
      cancelled = true;
    };
  }, [kind, targetId, isAdmin]);

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Link to="/admin/users" className="text-sm text-primary-600 dark:text-primary-400 hover:underline">
            Back to the user directory
          </Link>
        </div>
      </div>
    );
  }

  const loading = <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" role="status" aria-label="Loading account tools" />
  </div>;
  if (!acting || admitted !== acting) return loading;

  return (
    <AdminActingContext.Provider value={acting}>
      <AdminActingBanner acting={acting} />
      <Suspense fallback={loading}>{children ?? <Outlet />}</Suspense>
    </AdminActingContext.Provider>
  );
}
