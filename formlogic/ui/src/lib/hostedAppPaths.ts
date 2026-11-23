export const SOFTN_SECTIONS = ['overview', 'data', 'api', 'members', 'files', 'edit', 'automations', 'history', 'domains', 'settings'] as const;
export type SoftnSection = (typeof SOFTN_SECTIONS)[number];

/** Keep section links available without loading project import, export or editing code. */
export const softnWorkspacePath = (appId: string, section: SoftnSection = 'overview', ...rest: string[]) =>
  section === 'overview' ? `/apps/${appId}/web` : `/apps/${appId}/web/${[section, ...rest.filter(Boolean).map(encodeURIComponent)].join('/')}`;
