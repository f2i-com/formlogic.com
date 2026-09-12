import { api } from '../api';
import type { AppRuntimeConfig } from '../../types/app';

/** Only app-scoped operations cross the frame boundary. Authentication stays in the host. */
export async function workspaceBridge(slug: string, action: string, input: Record<string, unknown>, navigate: (path: string) => void) {
  const result = await api.getAppRuntime(slug);
  if (result.error || !result.data) throw new Error(result.error || 'Could not connect to this workspace.');
  const config = result.data as Pick<AppRuntimeConfig, 'app' | 'forms'> & { permissions: { appLevel?: string[]; formLevel: Record<string, string[]> } };
  if (action === 'workspaceInfo') return {
    name: config.app.name,
    aokie: config.app.customLogic?.connector?.manifest?.connectorId === 'aokie',
    forms: config.forms.map(form => ({
      id: form.formId, alias: form.packFormId || '', name: form.displayName, description: form.description || '', hidden: form.hidden === true,
      tool: form.customScreen?.enabled === true,
      canRead: [...(config.permissions.appLevel || []), ...(config.permissions.formLevel[form.formId] || [])].some(permission => ['view_all_responses', 'view_own_responses'].includes(permission)),
    })),
  };
  const form = config.forms.find(form => form.formId === input.formId);
  if (!form) throw new Error('This form is not available in this app.');
  if (action === 'workspaceOpen') {
    if (form.hidden) throw new Error('This form stores data only.');
    navigate(`/app/${encodeURIComponent(slug)}/form/${encodeURIComponent(form.formId)}`);
    return { opened: true };
  }
  if (action === 'workspaceRecords') {
    const result = await api.getAppResponses(slug, form.formId, { limit: 12, offset: Number.isSafeInteger(input.offset) ? Math.max(0, Math.min(100000, Number(input.offset))) : 0 });
    if (result.error || !result.data) throw new Error(result.error || 'Could not load records.');
    return { count: result.data.count, records: result.data.responses.map(value => {
      const row = value as { id?: string; answers?: Record<string, unknown>; submittedAt?: string };
      const title = Object.values(row.answers || {}).find(value => typeof value === 'string' && value.trim());
      return { id: row.id, answers: row.answers || {}, details: Object.entries(row.answers || {}).map(([key, value]) => ({ label: (form.fields as Array<{ id: string; label?: string }> | undefined)?.find(field => field.id === key)?.label || key.replaceAll('_', ' '), value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') })).filter(field => field.value), title: typeof title === 'string' ? title.slice(0, 180) : 'Saved record', date: row.submittedAt ? new Date(row.submittedAt).toLocaleString() : '' };
    }) };
  }
  throw new Error('Unknown workspace operation.');
}
