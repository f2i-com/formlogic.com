import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAdminActing } from '../components/admin/AdminActingContext';
import { useAuthStore } from '../stores/authStore';
import { viewerOwnsApp, type App } from '../types/app';

type OwnershipFields = Pick<App, 'ownerId' | 'canManage'>;

/**
 * Whether the person at this page acts as the app's owner: true or false once that is known,
 * undefined while it is not.
 *
 * `listed` is the app's row in the apps list (appStore) when the list holds it, and then the row
 * decides. The list is loaded by the page shell, not by the members and roles pages, so a page can
 * be up before the list arrives or after it failed to load; and a draft or archived app is never
 * listed to a member. So when the list does not hold the app, the app itself is asked for:
 * GET /apps/{id} carries ownerId for the owner alone, and answers not found to a member the app
 * is not open to.
 *
 * A platform admin on an acting route is the owner as far as the server is concerned
 * (AdminActAsMiddleware runs each request as the owner AdminActingBoundary resolved for this
 * app), whatever the signed-in id and the admin's own apps list say.
 *
 * Callers lock an owner-only control on `false` alone. While the answer is not known the control
 * stays usable, and the server, which decides, refuses with its reason: an owner is never shown
 * "Owner only" about their own app because a request was slow or failed.
 */
export function useViewerOwnsApp(appId: string | undefined, listed: OwnershipFields | undefined): boolean | undefined {
  const acting = useAdminActing();
  const userId = useAuthStore((s) => s.user?.id);
  // Keyed by what it was asked for, so an answer about another app or another user is not read.
  const [asked, setAsked] = useState<{ key: string; owns: boolean | undefined } | null>(null);
  const key = `${appId ?? ''}\n${userId ?? ''}`;
  const mustAsk = !acting && !listed && !!appId;

  useEffect(() => {
    if (!mustAsk || !appId) return;
    let cancelled = false;
    void api.getApp(appId).then((res) => {
      if (cancelled) return;
      const app = res.data?.app as OwnershipFields | undefined;
      // Not found (or refused) is an answer, since the owner is never told that about their own
      // app. No connection or a server error is not one, and leaves the question open.
      const refused = res.status === 404 || res.status === 403;
      setAsked({ key, owns: app ? viewerOwnsApp(app, userId) : refused ? false : undefined });
    }).catch(() => { /* left unknown */ });
    return () => { cancelled = true; };
  }, [mustAsk, appId, userId, key]);

  if (acting) return true;
  if (listed) return viewerOwnsApp(listed, userId);
  return asked && asked.key === key ? asked.owns : undefined;
}
