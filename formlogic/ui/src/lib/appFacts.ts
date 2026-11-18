// What a list of apps says of one app beyond its name and status: who can use it and what it
// holds. The table and the cards of the apps list say the same words.
import type { App, AppSummary } from '../types/app';
import { isSoftnApp } from './softnApps';
import { formatBytes } from './utils';

/** Forms-first apps can also have an installed web project. Web apps acquire form tools
 * when their first form is attached. Their original editor remains their entry point. */
export function appTools(app: App, summary?: AppSummary) {
  const web = isSoftnApp(app) || summary?.installed === true;
  const forms = !isSoftnApp(app) || (app.formCount ?? 0) > 0;
  return { web, forms, label: web && forms ? 'Web + forms' : web ? 'Web app' : 'Forms app' };
}

/** Who can use the app ("Anyone", "Members · 3"); '' while it is not known. */
export const who = (app: App, summary: AppSummary | undefined): string => {
  const members = typeof summary?.members === 'number' ? ` · ${summary.members.toLocaleString()}` : '';
  if (summary?.access === 'application') return 'Anyone';
  if (summary?.access === 'members' || !isSoftnApp(app)) return summary ? `Members${members}` : '';
  return '';
};

/** What the app holds ("13 tables · 208 KB", "3 forms"); '' while it is not known. */
export const holds = (app: App, summary: AppSummary | undefined): string => {
  const { web } = appTools(app, summary);
  const facts: string[] = [];
  if (app.formCount !== undefined && (app.formCount > 0 || !web)) {
    facts.push(`${app.formCount.toLocaleString()} form${app.formCount === 1 ? '' : 's'}`);
  }
  if (web && summary) {
    if (!summary.installed) facts.push('Nothing installed');
    else if (summary.tables !== null) facts.push(`${summary.tables.toLocaleString()} table${summary.tables === 1 ? '' : 's'}${typeof summary.bytes === 'number' ? ` · ${formatBytes(summary.bytes)}` : ''}`);
    else if (!facts.length) facts.push(summary.backend ? 'No data yet' : 'In each browser');
  }
  return facts.join(' · ');
};
