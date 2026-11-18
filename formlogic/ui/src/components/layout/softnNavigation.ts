import { Braces, ClipboardList, Database, Globe, History, LayoutDashboard, PanelsTopLeft, PencilRuler, Rocket, Settings, ShieldCheck, Table2, Users, Workflow } from 'lucide-react';
import { softnWorkspacePath, type SoftnSection } from '../../lib/hostedAppPaths';
import type { AppSectionItem } from './appSectionNavigation';

export type { AppSectionItem } from './appSectionNavigation';

const sections: readonly (Omit<AppSectionItem, 'value' | 'to'> & { value: SoftnSection })[] = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard, group: null },
  { value: 'edit', label: 'Edit', icon: PencilRuler, group: 'Build' },
  { value: 'data', label: 'Data', icon: Database, group: 'Build' },
  { value: 'api', label: 'API', icon: Braces, group: 'Build' },
  { value: 'automations', label: 'Automations', icon: Workflow, group: 'Build' },
  { value: 'members', label: 'Members', icon: Users, group: 'Manage' },
  { value: 'domains', label: 'Domains', icon: Globe, group: 'Manage' },
  { value: 'history', label: 'History', icon: History, group: 'Manage' },
  { value: 'settings', label: 'Settings', icon: Settings, group: 'Manage' },
];

export interface WorkspaceAccess {
  isOwner: boolean;
  managesMembers: boolean;
  backend: boolean;
  liveBackend: boolean;
  hasForms?: boolean;
}

export function softnNavigationItems(appId: string, access: WorkspaceAccess): AppSectionItem[] {
  const { isOwner, managesMembers, backend, liveBackend } = access;
  const items = sections.filter(({ value }) => {
    switch (value) {
      case 'members': return managesMembers;
      case 'automations': return managesMembers && liveBackend;
      case 'history': return isOwner;
      case 'api': return isOwner && (backend || liveBackend);
      default: return true;
    }
  }).map(item => ({ ...item, to: softnWorkspacePath(appId, item.value) }));
  if (!isOwner || !managesMembers || !access.hasForms) return items;

  const base = `/apps/${appId}`;
  const after: Partial<Record<SoftnSection, AppSectionItem[]>> = {
    edit: [
      { value: 'forms', label: 'Forms', icon: ClipboardList, group: 'Build', to: `${base}/studio/data` },
      { value: 'screens', label: 'Screens', icon: PanelsTopLeft, group: 'Build', to: `${base}/studio/screens` },
    ],
    data: [
      { value: 'records', label: 'Form records', icon: Table2, group: 'Build', to: `${base}/records` },
      { value: 'form-automations', label: 'Form automations', icon: Workflow, group: 'Build', to: `${base}/studio/automations` },
    ],
    members: [{ value: 'access', label: 'Roles', icon: ShieldCheck, group: 'Manage', to: `${base}/studio/access` }],
    history: [{ value: 'publish', label: 'Publish', icon: Rocket, group: 'Manage', to: `${base}/studio/publish` }],
    settings: [{ value: 'form-settings', label: 'Form settings', icon: Settings, group: 'Manage', to: `${base}/settings` }],
  };
  return items.flatMap(item => [
    item.value === 'automations' ? { ...item, label: 'Database triggers' } : item,
    ...(after[item.value] ?? []),
  ]);
}
