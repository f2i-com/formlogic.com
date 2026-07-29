/**
 * App menu composition: which forms get a nav entry, plus the owner-authored
 * custom LINK entries from `app.navConfig` (kind 'link'). Form entries keep
 * `app_forms` as their single source of truth (display name / order / icon /
 * settings.hidden / settings.menuHidden edited in the Forms manager) — the
 * navConfig carries ONLY what forms can't express: extra links.
 *
 * Pure helpers so the menu rules are unit-testable without the shell.
 */
import type { AppNavItem, AppRuntimeForm, PermissionAction } from '../../types/app';
import { FORM_LEVEL_PERMISSIONS } from '../../types/app';
import { safeAppNavTarget } from '../../lib/screenNav';

/** Forms that render a menu entry: not data-only (`hidden`), not unlisted (`menuHidden`). */
export function menuForms(forms: AppRuntimeForm[]): AppRuntimeForm[] {
  return forms.filter((f) => f.hidden !== true && f.menuHidden !== true);
}

/** App-wide grants that cover every form at once (mirrors AppPublicController::memberCanSeeForm). */
const SEES_EVERY_FORM: PermissionAction[] = ['manage_app', 'view_analytics'];
/** Per-form grants that put a form in a member's runtime config. */
const SEES_ONE_FORM: PermissionAction[] = [...FORM_LEVEL_PERMISSIONS, 'view_analytics'];

/**
 * Whether a role's permission rows let it reach `formId` at all — the client mirror of the
 * server's `AppPublicController::memberCanSeeForm`. A permission row with `formId: null` is
 * an APP-WIDE grant and applies to every form.
 *
 * Kept next to the menu rules so the Studio's role preview and the runtime agree; the two
 * drifting is how an owner ends up being told a working screen is inaccessible.
 */
export function roleCanSeeForm(
  permissions: Array<{ formId: string | null; permission: PermissionAction }>,
  formId: string
): boolean {
  for (const p of permissions) {
    if (p.formId === null && SEES_EVERY_FORM.includes(p.permission)) return true;
    if ((p.formId === null || p.formId === formId) && SEES_ONE_FORM.includes(p.permission)) return true;
  }
  return false;
}

export interface AppMenuLink {
  key: string;
  label: string;
  icon: string | null;
  /** External http(s) target — opened in a new tab. Exclusive with appTarget. */
  externalUrl?: string;
  /** Validated in-app target (relative to the app base), via safeAppNavTarget. */
  appTarget?: string;
  /** Desired index within the Forms group (clamped at render). */
  position: number;
}

/**
 * Sanitize navConfig link entries. Only http(s) URLs or safeAppNavTarget-valid
 * in-app targets survive — a javascript:/data: url can never become a menu
 * entry, whatever is stored. `navigableFormIds` excludes hidden forms, so a
 * link can't route into a data-only form either.
 */
export function menuLinks(
  navConfig: AppNavItem[] | null | undefined,
  navigableFormIds: Set<string>
): AppMenuLink[] {
  const out: AppMenuLink[] = [];
  for (let i = 0; i < (navConfig?.length ?? 0); i++) {
    const n = navConfig![i];
    if (!n || n.kind !== 'link' || n.isVisible === false) continue;
    const label = String(n.displayName ?? '').trim();
    const url = String(n.url ?? '').trim();
    if (!label || !url) continue;
    const key = typeof n.id === 'string' && n.id !== '' ? n.id : `link-${i}`;
    const position = Number.isFinite(n.sortOrder) ? Math.max(0, Math.floor(n.sortOrder)) : Number.MAX_SAFE_INTEGER;
    const icon = typeof n.icon === 'string' && n.icon !== '' ? n.icon : null;
    if (/^https?:\/\//i.test(url)) {
      out.push({ key, label, icon, externalUrl: url, position });
      continue;
    }
    const target = safeAppNavTarget(url, navigableFormIds);
    if (target) out.push({ key, label, icon, appTarget: target, position });
  }
  return out.sort((a, b) => a.position - b.position);
}

/**
 * Insert each link at min(position, current length) into the base list —
 * stable WYSIWYG interleave: links keep their authored slot among the forms,
 * and out-of-range positions append at the end.
 */
export function interleaveMenu<T, L extends { position: number }>(base: T[], links: L[]): Array<T | L> {
  const out: Array<T | L> = base.slice();
  for (const l of links.slice().sort((a, b) => a.position - b.position)) {
    out.splice(Math.min(Math.max(0, l.position), out.length), 0, l);
  }
  return out;
}
