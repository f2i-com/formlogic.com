import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import type { FlowBinding, FlowDefinition } from '../../types/flows';
import { Button } from '../ui/Button';

export function nativeRecordEventLabel(event: string): string | null {
  const match = /^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/.exec(event);
  return match ? `${match[2]} · record ${match[1]}` : null;
}

/** Uses the same binding API as the full editor; no separate automation configuration. */
export function NativeRecordTriggers({ appId, flows, bindings, onReload }: {
  appId: string; flows: FlowDefinition[]; bindings: FlowBinding[]; onReload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [operation, setOperation] = useState('created');
  const [flowId, setFlowId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const selected = flows.find(flow => flow.id === flowId);
  const connected = bindings.filter(binding => nativeRecordEventLabel(binding.event));
  const control = 'mt-2 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white';
  async function load() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setOpen(true); setError('');
    try {
      const result = await api.getNativeRecords(appId);
      if (result.error) { setError('The app database could not be loaded. Install a native app in Screens → Hosting & app tools, then try again.'); return; }
      if (!result.data?.installed) { setError('Install a native app in Screens → Hosting & app tools before connecting its database.'); return; }
      const available = (result.data?.tables ?? []).filter(name => /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name));
      setTables(available); setTable(current => available.includes(current) ? current : available[0] ?? '');
    } catch { setError('Could not load the database. Please try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function connect() {
    if (lock.current || !selected || !table) return;
    const event = `app.record.${operation}.${table}`;
    if (connected.some(binding => binding.event === event && binding.flowDefinitionId === selected.id)) {
      setError('This flow already has that record trigger. Edit its existing trigger below.'); return;
    }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.createFlowBinding(appId, {
        event, flow: selected.slug, mode: 'async', enabled: true,
        inputMap: { record: '$event.data.record', table: '$event.data.table', operation: '$event.data.operation' },
      });
      if (result.error) { setError(result.error); return; }
      setNotice(selected.enabled ? 'Trigger connected. Future committed changes will queue this flow.' : 'Trigger saved. Enable the flow when you are ready to capture future changes.');
      await onReload();
    } catch { setError('Could not finish connecting the trigger. Refresh the list before trying again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section aria-label="Database automations" className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50 sm:p-5">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0"><h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><Database className="h-4 w-4 shrink-0" />When a record changes</h3>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">Connect your hosted app’s database to a flow. For a signup flow, choose the users table and “Record created”.</p>
      </div>
      <Button variant="secondary" className="min-h-11 shrink-0" leftIcon={<Plus className="h-4 w-4" />} isLoading={busy} onClick={() => void load()}>Connect database event</Button>
    </div>
    {open && <div className="mt-5 space-y-4 border-t border-slate-200 pt-5 dark:border-slate-700">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="min-w-0 text-sm font-medium text-slate-800 dark:text-slate-200">1. Table<select aria-label="Database event table" className={control} value={table} disabled={busy} onChange={event => setTable(event.target.value)}><option value="">Choose a table</option>{tables.map(name => <option key={name}>{name}</option>)}</select></label>
        <label className="min-w-0 text-sm font-medium text-slate-800 dark:text-slate-200">2. Change<select aria-label="Database event change" className={control} value={operation} disabled={busy} onChange={event => setOperation(event.target.value)}>{['created','updated','deleted'].map(value => <option key={value} value={value}>Record {value}</option>)}</select></label>
        <label className="min-w-0 text-sm font-medium text-slate-800 dark:text-slate-200">3. Flow<select aria-label="Database event flow" className={control} value={flowId} disabled={busy} onChange={event => setFlowId(event.target.value)}><option value="">Choose a flow</option>{flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name}{flow.enabled ? '' : ' (paused)'}</option>)}</select></label>
      </div>
      {!flows.length && <p className="text-sm text-slate-600 dark:text-slate-400">Create an automation first, then connect it here.</p>}
      <p className="text-sm leading-6 text-slate-600 dark:text-slate-400">The flow receives <code>record</code>, <code>table</code> and <code>operation</code> as inputs. Record previews omit common secret fields and shorten long text. Changes are queued after the database commits; existing records are not replayed. Keep OAIY connected for unattended execution, or open the app’s FormLogic member runtime.</p>
      <Button className="min-h-11 w-full sm:w-auto" disabled={busy || !selected || !table} onClick={() => void connect()}>Connect trigger</Button>
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error} {open && <button className="underline" onClick={() => void load()} disabled={busy}>Reload tables</button>}</p>}
    {notice && <p role="status" className="mt-4 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
    {connected.length > 0 && <ul className="mt-4 divide-y divide-slate-200 dark:divide-slate-700">{connected.map(binding => {
      const flow = flows.find(item => item.id === binding.flowDefinitionId);
      return <li key={binding.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 break-words"><span className="font-medium text-slate-900 dark:text-white">{nativeRecordEventLabel(binding.event)}</span><span className="block text-slate-500 dark:text-slate-400">{flow?.name ?? binding.flow} · {binding.enabled && flow?.enabled && binding.mode !== 'manual' ? 'Listening for changes' : 'Paused'}</span></div><Link className="inline-flex min-h-11 shrink-0 items-center text-indigo-700 underline dark:text-indigo-300" to={`/flows?flow=${binding.flowDefinitionId}&panel=triggers`}>Edit flow &amp; trigger</Link></li>;
    })}</ul>}
  </section>;
}
