/**
 * Where clicking an app goes — ONE definition, because there are three places that
 * list apps (the sidebar, the mobile drawer, the Home strip) and they had drifted.
 *
 * `canManage` is server-authoritative (AppController::index derives it from ownership
 * and the member's role). An owner wants the builder; a member has no business on a
 * management screen and wants the running app. Home used to send everyone to
 * `/apps/:id/settings`, so an invited staff member clicking their employer's app
 * landed on its settings page instead of the app itself.
 */
export interface AppNavTarget {
  id: string;
  slug: string;
  canManage?: boolean;
  /** A hosted SoftN app's owner manages it in its workspace rather than the App Studio. */
  settings?: { softnApp?: boolean } | null;
}

export function appClickPath(app: AppNavTarget): string {
  if (!app.canManage) return `/app/${app.slug}`;
  return app.settings?.softnApp === true ? `/apps/${app.id}/softn` : `/apps/${app.id}/studio`;
}

/** Matching label, so the tooltip/aria never promises the wrong destination. */
export function appClickLabel(app: AppNavTarget & { name?: string }): string {
  const name = app.name ?? 'app';
  if (!app.canManage) return `Open ${name}`;
  return app.settings?.softnApp === true ? `Open ${name} in its workspace` : `Open ${name} in the App Studio`;
}
