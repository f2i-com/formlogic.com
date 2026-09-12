import { deferEffect } from '../../lib/deferredEffect';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import type { App, AppForm } from '../../types/app';

export function AppCompositionPanel({ app, onComplete }: { app: App; onComplete?: () => void }) {
  const [open, setOpen] = useState(false);
  return <section className="rounded-xl border border-slate-200 p-5 dark:border-slate-700">
    <Boxes className="mb-3 h-5 w-5 text-sky-600" /><h3 className="font-semibold">Bring another app into this one</h3>
    <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-slate-300">Share Aokie's forms to add calls, transcripts and appointments alongside your existing dashboard. Both apps use the same saved records.</p>
    <Button variant="outline" className="mt-4 min-h-11 w-full" onClick={() => setOpen(true)}>Add from another app</Button>
    {open && <CompositionDialog app={app} onClose={() => setOpen(false)} onComplete={onComplete} />}
  </section>;
}
function CompositionDialog({ app, onClose, onComplete }: { app: App; onClose: () => void; onComplete?: () => void }) {
  const [choices, setChoices] = useState<Array<{ id: string; name: string }>>([]);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<App | null>(null);
  const [forms, setForms] = useState<AppForm[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    void api.getAppsFormUsage().then(result => {
      if (!active) return;
      setLoading(false);
      if (result.error) setError(result.error);
      else setChoices((result.data?.apps || []).filter(item => item.canManage && item.appId !== app.id).map(item => ({ id: item.appId, name: item.appName })));
    }).catch(() => { if (active) { setLoading(false); setError('Could not load apps.'); } });
    return () => { active = false; };
  }, [app.id]);
  const [previousSourceId, setPreviousSourceId] = useState(sourceId);
  if (previousSourceId !== sourceId) {
    setPreviousSourceId(sourceId);
    setLoading(!!sourceId); setError(''); setSource(null); setMove(false); setApproved(false);
    setForms([]); setSelected([]); setGrants([]);
  }
  useEffect(() => deferEffect(() => {
    if (!sourceId) return;
    let active = true;
    void Promise.all([api.getApp(sourceId), api.getAppForms(sourceId), api.listFlows(sourceId)]).then(([a, f, flows]) => {
      if (!active) return;
      setLoading(false);
      if (a.error || f.error || flows.error) { setError(a.error || f.error || flows.error || 'Could not read this app.'); return; }
      const value = a.data?.app as App;
      setSource(value); setForms(f.data?.forms || []); setSelected((f.data?.forms || []).map(form => form.formId));
      const logic = value.customLogic;
      setGrants([...new Set([...(logic?.permissions || []), ...(logic?.scripts || []).flatMap(script => script.permissions || []), ...(flows.data?.flows || []).flatMap(flow => flow.nodeCapabilities || [])])].filter(grant => grant.startsWith('connector.')));
    }).catch(() => { if (active) { setLoading(false); setError('Could not read this app.'); } });
    return () => { active = false; };
  }), [sourceId]);
  async function compose() {
    if (busy || !source) return;
    setBusy(true); setError('');
    try {
      const result = await api.composeApps(app.id, { sourceAppId: source.id, formIds: move ? forms.map(form => form.formId) : selected, moveAutomation: move, approvedConnectorGrants: approved ? grants : [] });
      if (result.error) { setError(result.error); return; }
      setDone(true); onComplete?.();
    } catch { setError('The request could not be completed. Refresh the app before retrying.'); }
    finally { setBusy(false); }
  }
  return <Modal isOpen onClose={busy ? () => {} : onClose} title={`Add to ${app.name}`} size="lg" footer={<div className="flex flex-wrap justify-end gap-3"><Button variant="outline" onClick={onClose} disabled={busy}>{done ? 'Done' : 'Cancel'}</Button>{!done && <Button onClick={() => void compose()} isLoading={busy} disabled={loading || busy || !source || !selected.length || (move && grants.length > 0 && !approved)}>{move ? 'Move integration here' : 'Share selected forms'}</Button>}</div>}>
    <div className="space-y-5 p-5 sm:p-6">
      {done ? <div role="status"><h3 className="font-semibold">Your apps are connected.</h3><p className="mt-2 text-sm leading-6">The selected forms use their existing records. Review access in People &amp; roles before sharing with members. {move && 'Automation now belongs to this app; source event scripts are paused. Reload open source-app tabs before continuing.'}</p><Link className="mt-4 inline-flex min-h-11 items-center font-medium text-indigo-600" to={`/app/${encodeURIComponent(app.slug)}`}>Open connected app</Link></div> : <>
        <label className="block text-sm font-medium">Source app<select value={sourceId} disabled={busy} onChange={event => { setSourceId(event.target.value); setSource(null); setForms([]); setSelected([]); setGrants([]); setMove(false); setApproved(false); setError(''); setLoading(!!event.target.value); }} className="mt-2 min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"><option value="">Choose an existing app</option>{choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {loading && <p role="status">Loading apps...</p>}
        {!loading && choices.length === 0 && <p className="text-sm">Create another app or install the Aokie starter first.</p>}
        {source && <>
          <p className="rounded-xl bg-indigo-50 p-4 text-sm leading-6 dark:bg-indigo-950">Share Calls and Appointments to add the Front desk view. Include Transcripts, Device Setup and Follow-ups for a complete receptionist workspace. Your current app home stays in place.</p>
          <fieldset disabled={busy || move}><legend className="mb-2 text-sm font-semibold">Forms to share</legend><div className="max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700">{forms.map(form => <label key={form.formId} className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm"><input type="checkbox" checked={move || selected.includes(form.formId)} onChange={event => setSelected(ids => event.target.checked ? [...ids, form.formId] : ids.filter(id => id !== form.formId))} /><span>{form.displayName}</span></label>)}</div></fieldset>
          <label className="flex items-start gap-3 rounded-xl bg-sky-50 p-4 text-sm leading-6 dark:bg-sky-900/20"><input className="mt-1" type="checkbox" checked={move} disabled={busy} onChange={event => { setMove(event.target.checked); setApproved(false); }} /><span><strong>Move automation here too</strong><br />Includes all forms, connector scripts, services, flows and triggers. Source event scripts are paused. Destination branding, dashboard and member roles are kept.</span></label>
          {move && grants.length > 0 && <div className="rounded-xl border border-amber-300 p-4 text-sm"><p className="font-semibold">Connector capabilities</p><ul className="my-3 max-h-32 overflow-auto break-all text-xs">{grants.map(grant => <li key={grant}>{grant}</li>)}</ul><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} />Allow these capabilities in the destination app</label></div>}
        </>}
      </>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    </div>
  </Modal>;
}
