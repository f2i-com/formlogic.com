import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, LayoutDashboard } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
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
  return <section className="min-w-0 rounded-xl border border-indigo-200 bg-indigo-50/60 p-5 dark:border-indigo-500/25 dark:bg-indigo-500/5">
    <LayoutDashboard className="mb-3 h-5 w-5 text-indigo-600 dark:text-indigo-300" />
    <h3 className="font-semibold text-gray-900 dark:text-white">A connected app dashboard</h3>
    <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-slate-300">Package your dashboard as an editable app. Its forms, records and Aokie tools stay connected to this workspace.</p>
    <label className="mt-4 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={aokie} onChange={event => setAokie(event.target.checked)} />Use the Aokie front desk interface</label>
    <Button className="mt-4 min-h-11 w-full" onClick={() => void create()} isLoading={busy} disabled={busy || ready}>Create connected dashboard</Button>
    <div className="mt-3 flex flex-wrap gap-3 text-sm">
      <Link className="inline-flex min-h-11 items-center font-medium text-indigo-700 dark:text-indigo-300" to={`/app/${encodeURIComponent(app.slug)}/project`}>Open dashboard</Link>
      <button className="inline-flex min-h-11 items-center gap-2 text-gray-600 dark:text-slate-300" onClick={() => void downloadHostedClient(template.client, app.name).catch(() => setMessage('Download failed. Please try again.'))}><Download size={15} />Download starter</button>
    </div>
    <p className="mt-2 text-xs leading-5 text-gray-500 dark:text-slate-400">The project uses your FormLogic session when hosted here. Downloads contain no account credentials.</p>
    <div className="mt-3 flex flex-wrap gap-3"><Button size="sm" variant="outline" disabled={busy} onClick={() => void setHome(true)}>Use as app home</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void setHome(false)}>Restore original home</Button></div>
    {message && <p role="status" className="mt-3 text-sm leading-6 text-gray-700 dark:text-slate-200">{message}</p>}
  </section>;
}
