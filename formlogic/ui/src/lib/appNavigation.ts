import { viewerOwnsApp, type App, type AppSummary } from '../types/app';

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
  ownerId?: string;
  settings?: { softnApp?: boolean } | null;
}

export function appClickPath(app: AppNavTarget, userId?: string): string {
  if (!viewerOwnsApp(app, userId)) return `/app/${app.slug}`;
  return app.settings?.softnApp === true ? `/apps/${app.id}/web` : `/apps/${app.id}/studio`;
}

export function appSettingsPath(app: AppNavTarget): string {
  return app.settings?.softnApp ? `/apps/${app.id}/web/settings` : `/apps/${app.id}/settings`;
}

/** The data shortcut opens the primary editor's records when both kinds are present. */
export function appDataLink(app: Pick<App, 'id' | 'settings' | 'formCount'>, summary?: AppSummary) {
  const base = `/apps/${app.id}`;
  if (app.settings?.softnApp && summary?.tables != null) return { to: `${base}/web/data`, label: 'Data' };
  if ((app.formCount ?? 0) > 0) return { to: `${base}/records`, label: 'Form records' };
  if (summary?.installed && summary.tables != null) return { to: `${base}/studio/data`, label: 'Data' };
}

/** Matching label, so the tooltip/aria never promises the wrong destination. */
export function appClickLabel(app: AppNavTarget & { name?: string }, userId?: string): string {
  const name = app.name ?? 'app';
  return viewerOwnsApp(app, userId) ? `Open ${name} in its workspace` : `Open ${name}`;
}
