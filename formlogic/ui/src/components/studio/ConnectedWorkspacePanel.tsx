import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, LayoutDashboard } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { ToolRow } from './ToolRow';
import { downloadHostedClient, type HostedPackage } from '../../lib/hosting';
import aokieTemplate from '../../data/aokie-workspace.json';
import workspaceTemplate from '../../data/connected-workspace.json';
import type { App } from '../../types/app';

export function ConnectedWorkspacePanel({ app }: { app: { id: string; name: string; slug: string } }) {
  const [aokie, setAokie] = useState(false);
  const template = aokie ? aokieTemplate : workspaceTemplate;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  async function setHome(enabled: boolean) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (enabled) {
        const project = await api.getAppHosting(app.id);
        if (project.error || !project.data?.deployment) throw new Error(project.error || 'Create or publish a project first.');
      }
      const current = await api.getApp(app.id);
      if (current.error || !current.data?.app) throw new Error(current.error || 'Could not read app settings.');
      const value = current.data.app as App;
      const result = await api.updateApp(app.id, { settings: { ...value.settings, hostedDashboard: enabled } });
      if (result.error) throw new Error(result.error);
      setMessage(enabled ? 'Your app now opens on its connected dashboard.' : 'Your original app home has been restored.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not change the app home.'); }
    finally { setBusy(false); }
  }
  async function create() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const current = await api.getAppHosting(app.id);
      if (current.error) throw new Error(current.error);
      if (current.data?.deployment) throw new Error('This app already has a hosted project. Open App hosting to edit it; your work has been kept.');
      const result = await api.publishAppHosting(app.id, template as HostedPackage, 0);
      if (result.error) throw new Error(result.error);
      setReady(true);
      setMessage('Your connected dashboard is ready. Open it or download its editable project.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create the dashboard.'); }
    finally { setBusy(false); }
  }
  // Under the sentence, one compact line each: the choice of interface, then what can be done with
  // a dashboard once there is one, all as links. A finger gets the full height; a pointer less.
  const link = 'inline-flex min-h-11 cursor-pointer items-center gap-1.5 hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 @2xl/tool:min-h-8';
  return <ToolRow icon={LayoutDashboard} title="Connected dashboard"
    description="Add a ready-made dashboard that lists this app’s forms and latest records, and make it the app’s home if you like."
    actions={<Button variant="secondary" onClick={() => void create()} isLoading={busy} disabled={busy || ready}>Create connected dashboard</Button>}>
    <label className="mt-1 flex min-h-11 w-fit cursor-pointer items-center gap-2 text-xs text-gray-700 @2xl/tool:min-h-8 dark:text-slate-300"><input type="checkbox" className="h-4 w-4 shrink-0 accent-primary-600" checked={aokie} onChange={event => setAokie(event.target.checked)} />Use the Aokie front desk interface</label>
    <div className="flex flex-wrap items-center gap-x-4 text-xs font-medium text-primary-700 dark:text-primary-300">
      <Link className={link} to={`/app/${encodeURIComponent(app.slug)}/project`}>Open dashboard</Link>
      <button type="button" className={link} title="The download contains no account credentials." onClick={() => void downloadHostedClient(template.client, app.name).catch(() => setMessage('Download failed. Please try again.'))}><Download size={14} aria-hidden="true" />Download starter</button>
      <button type="button" className={link} disabled={busy} onClick={() => void setHome(true)}>Use as app home</button>
      <button type="button" className={link} disabled={busy} onClick={() => void setHome(false)}>Restore original home</button>
    </div>
    {message && <p role="status" className="mt-1 text-xs leading-relaxed text-gray-700 dark:text-slate-200">{message}</p>}
  </ToolRow>;
}
