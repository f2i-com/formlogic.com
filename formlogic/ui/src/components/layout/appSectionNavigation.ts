import { Braces, ClipboardList, Database, LayoutDashboard, PanelsTopLeft, Rocket, Settings, Users, Workflow, type LucideIcon } from 'lucide-react';
import { matchPath } from 'react-router-dom';
import type { SoftnSection } from '../../lib/hostedAppPaths';
import type { StudioStepId } from '../studio/studioSteps';

export type AppSection = SoftnSection | StudioStepId | 'forms' | 'records' | 'web' | 'form-automations' | 'form-settings';

export interface AppSectionItem {
  value: AppSection;
  label: string;
  icon: LucideIcon;
  group: 'Build' | 'Manage' | null;
  to: string;
}

export function formsNavigationItems(appId: string, { hasWebApp = false } = {}): AppSectionItem[] {
  const base = `/apps/${appId}`;
  const items: AppSectionItem[] = [
    { value: 'plan', label: 'Overview', icon: LayoutDashboard, group: null, to: `${base}/studio/plan` },
    { value: 'data', label: 'Forms', icon: ClipboardList, group: 'Build', to: `${base}/studio/data` },
    { value: 'screens', label: 'Screens', icon: PanelsTopLeft, group: 'Build', to: `${base}/studio/screens` },
    { value: 'automations', label: 'Automations', icon: Workflow, group: 'Build', to: `${base}/studio/automations` },
    { value: 'records', label: 'Records', icon: Database, group: 'Build', to: `${base}/records` },
  ];
  if (hasWebApp) items.push({ value: 'web', label: 'Edit', icon: Braces, group: 'Build', to: `${base}/web/edit` });
  items.push(
    { value: 'access', label: 'Members', icon: Users, group: 'Manage', to: `${base}/studio/access` },
    { value: 'publish', label: 'Publish', icon: Rocket, group: 'Manage', to: `${base}/studio/publish` },
    { value: 'settings', label: 'Settings', icon: Settings, group: 'Manage', to: `${base}/settings` },
  );
  return items;
}

const managementPages = {
  forms: { section: 'data', label: 'Manage forms' },
  relations: { section: 'data', label: 'Relations' },
  users: { section: 'access', label: 'Manage members' },
  roles: { section: 'access', label: 'Roles' },
  deploy: { section: 'publish', label: 'Deployment' },
  records: { section: 'records', label: 'Records' },
  settings: { section: 'settings', label: 'Settings' },
} as const;

/** The same app can own a web project and forms. The address selects which tools are open. */
export function appSectionAt(pathname: string) {
  const match = matchPath('/apps/:appId/*', pathname);
  if (!match?.params.appId) return null;
  const [area, step] = (match.params['*'] ?? '').split('/');
  const appId = match.params.appId;
  if (area === 'web') return { appId, section: step || 'overview', area, detail: undefined };
  if (area === 'studio') return { appId, section: step || 'plan', area, detail: undefined };
  if (!Object.hasOwn(managementPages, area)) return null;
  const page = managementPages[area as keyof typeof managementPages];
  return { appId, section: page.section, area, detail: page.label };
}

/** Legacy Studio and management addresses stay valid even when a hybrid's main Overview,
 * Members and Settings live next to its project. Every surface highlights the same link. */
export function sectionForAppItems(items: readonly AppSectionItem[], pathname: string): string {
  const location = appSectionAt(pathname);
  if (!location) return '';
  if (location.area === 'web' || items[0]?.value !== 'overview') return location.section;
  if (location.area === 'users') return 'members';
  switch (location.section) {
    case 'plan': return 'overview';
    case 'data': return 'forms';
    case 'automations': return 'form-automations';
    case 'settings': return 'form-settings';
    default: return location.section;
  }
}
