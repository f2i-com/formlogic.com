// What a list of apps says of one app beyond its name and status: who can use it and what it
// holds. The table and the cards of the apps list say the same words.
import type { App, AppSummary } from '../types/app';
import { isSoftnApp } from './softnApps';
import { formatBytes } from './utils';

/** Who can use the app ("Anyone", "Members · 3"); '' while it is not known. */
export const who = (app: App, summary: AppSummary | undefined): string => {
  const members = typeof summary?.members === 'number' ? ` · ${summary.members.toLocaleString()}` : '';
  if (summary?.access === 'application') return 'Anyone';
  if (summary?.access === 'members' || !isSoftnApp(app)) return summary ? `Members${members}` : '';
  return '';
};

/** What the app holds ("13 tables · 208 KB", "3 forms"); '' while it is not known. */
export const holds = (app: App, summary: AppSummary | undefined): string => {
  if (!isSoftnApp(app)) { const forms = app.formCount ?? app.navConfig?.length ?? 0; return `${forms.toLocaleString()} form${forms === 1 ? '' : 's'}`; }
  if (!summary) return '';
  if (!summary.installed) return 'Nothing installed';
  if (!summary.backend && summary.tables === null) return 'In each browser';
  if (summary.tables === null) return 'No data yet';
  return `${summary.tables.toLocaleString()} table${summary.tables === 1 ? '' : 's'}${typeof summary.bytes === 'number' ? ` · ${formatBytes(summary.bytes)}` : ''}`;
};
