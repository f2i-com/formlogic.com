// The first section of a SoftN app's page (/apps/:appId/softn): what the app is doing, at a glance,
// with a way into each thing it shows. It runs nothing: the app itself is under Edit, so opening
// an app's page costs a few small requests and never starts its runtime.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, PencilRuler, Rocket } from 'lucide-react';
import { Button } from '../ui/Button';
import { api, type AppDomain } from '../../lib/api';
import { declaresFormlogicAi, declaresFormlogicPayments, type NativeDataSummary, type NativeProject } from '../../lib/nativeHosting';
import { softnWorkspacePath } from '../../lib/softnApps';
import { cn, copyToClipboard, formatBytes } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import type { App } from '../../types/app';

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The domain statuses a visitor can already reach, as CustomDomainsPanel names them. */
const domainState = (status: string) => status === 'active' ? 'Connected' : status === 'verified' ? 'HTTPS pending' : status === 'failed' ? 'Not verified' : 'Waiting for DNS';

interface Props {
  app: App;
  project: NativeProject;
  version: number;
  published: boolean;
  /** Changes kept in this browser that are not installed yet. */
  dirty: boolean;
  readOnly: boolean;
  /** The app has a server side, so its data is kept here. */
  backend: boolean;
  isOwner: boolean;
  liveUrl: string;
  busy: boolean;
  onPublish: () => void;
}

export function SoftnOverview({ app, project, version, published, dirty, readOnly, backend, isOwner, liveUrl, busy, onPublish }: Props) {
  const [data, setData] = useState<NativeDataSummary | null>(null);
  const [dataError, setDataError] = useState('');
  const [domains, setDomains] = useState<AppDomain[] | null>(null);
  const [people, setPeople] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!backend) return;
    const stop = new AbortController();
    void api.getNativeDataSummary(app.id, stop.signal).then(result => {
      if (stop.signal.aborted) return;
      if (result.error) setDataError(result.error); else { setDataError(''); setData(result.data ?? null); }
    });
    return () => stop.abort();
  }, [app.id, version, backend]);

  useEffect(() => {
    if (!isOwner || readOnly) return;
    let cancelled = false;
    void api.getAppDomains(app.id).then(result => { if (!cancelled && !result.error) setDomains(result.data?.domains ?? []); });
    void api.getAppUsers(app.id).then(result => { if (!cancelled && !result.error) setPeople(result.data?.count ?? null); });
    return () => { cancelled = true; };
  }, [app.id, isOwner, readOnly]);

  const copyLink = async () => {
    if (await copyToClipboard(liveUrl)) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
    else toast.error('Copy failed', 'Select the link and copy it manually.');
  };

  const tables = data?.summary?.tables ?? [];
  const rows = tables.reduce((sum, table) => sum + table.rows, 0);
  const largest = [...tables].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name)).slice(0, 8);
  const settings = softnWorkspacePath(app.id, 'settings');
  const members = project.access === 'members';

  // One grid across the page's whole width: four cards a row on a wide screen, three on a laptop,
  // two on a tablet, one on a phone. The data card is the wide one where there is room.
  return <div className="mt-4 grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <Card title="Status">
        <p className="text-xl font-semibold text-slate-900 dark:text-white">{published ? `Live, version ${version}` : `Draft, version ${version}`}</p>
        <p className="mt-1 text-slate-600 dark:text-slate-300">
          {!published ? 'Only you can open it. It goes live when you publish.'
            : dirty ? 'You have changes that are not live yet. Visitors still get the version above.'
            : 'Visitors get this version until you publish again.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {!readOnly && (!published || dirty) && <Button size="sm" onClick={onPublish} isLoading={busy} leftIcon={<Rocket className="h-4 w-4" />}>{published ? 'Publish changes' : 'Publish'}</Button>}
          <a href={liveUrl} target="_blank" rel="noopener noreferrer" className={quiet}><ExternalLink className="h-4 w-4" aria-hidden="true" />Open the app</a>
          {!readOnly && <Link to={softnWorkspacePath(app.id, 'edit')} className={quiet}><PencilRuler className="h-4 w-4" aria-hidden="true" />Edit it</Link>}
        </div>
      </Card>

      <Card title="Data" className="xl:col-span-2" action={backend ? <Link to={softnWorkspacePath(app.id, 'data')} className={link}>Open data</Link> : undefined}>
        {!backend ? <p className="text-slate-600 dark:text-slate-300">This app has no server side, so what it saves stays in each person&rsquo;s browser and cannot be seen here. <Link to={softnWorkspacePath(app.id, 'data')} className={link}>Give it a backend</Link> to keep its data on this site.</p>
          : dataError ? <p role="alert" className="text-red-700 dark:text-red-300">{dataError}</p>
          : !data ? <p role="status" className="text-slate-500 dark:text-slate-400">Counting rows…</p>
          : !tables.length ? <p className="text-slate-600 dark:text-slate-300">No tables yet. The app makes them the first time it runs.</p>
          : <>
            <p className="font-semibold text-slate-900 dark:text-white">{count(tables.length, 'table')} · {count(rows, 'row')}{data.summary ? ` · ${formatBytes(data.summary.bytes)}` : ''}</p>
            <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {largest.map(table => <li key={table.name}>
                <Link to={softnWorkspacePath(app.id, 'data', table.name)} className="flex min-h-7 items-center gap-3 rounded text-slate-700 hover:text-primary-700 dark:text-slate-300 dark:hover:text-primary-300 max-sm:min-h-11">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{table.name}</span>
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{table.rows.toLocaleString()}</span>
                </Link>
              </li>)}
            </ul>
            {tables.length > largest.length && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">The {largest.length} largest of {tables.length}.</p>}
          </>}
      </Card>

      <Card title="Addresses" action={isOwner && !readOnly ? <Link to={softnWorkspacePath(app.id, 'domains')} className={link}>Domains</Link> : undefined}>
        <div className="flex items-center gap-1">
          <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-primary-700 hover:underline dark:text-primary-300 max-sm:py-3">{liveUrl.replace(/^https?:\/\//, '')}</a>
          <button type="button" onClick={() => void copyLink()} aria-label={copied ? 'Link copied' : 'Copy the app’s link'} className="inline-flex h-7 w-7 flex-none items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-white/5 max-sm:h-11 max-sm:w-11">{copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}</button>
        </div>
        {!published && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Only you can open it until it is published.</p>}
        {domains?.map(domain => <div key={domain.id} className="mt-1 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800 dark:text-slate-200">{domain.domain}</span>
          <span className={cn('text-xs font-medium', domain.status === 'active' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}>{domainState(domain.status)}</span>
        </div>)}
        {domains && !domains.length && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">No domain of its own yet.</p>}
      </Card>

      <Card title="People" action={members && isOwner && !readOnly ? <Link to={softnWorkspacePath(app.id, 'members')} className={link}>Members</Link> : undefined}>
        <p className="font-semibold text-slate-900 dark:text-white">{members ? 'Only people you invite' : 'Anyone with the link'}</p>
        <p className="mt-0.5 text-slate-600 dark:text-slate-300">
          {/* The count is everyone with access, the owner among them. */}
          {members ? (people === null ? 'They sign in to this site as members of the app.' : people <= 1 ? 'Nobody but you yet. Invite people in Members.' : `You and ${count(people - 1, 'other person', 'other people')} can use it.`)
            : 'It is open to everyone. If it has its own sign-in, that is what protects it.'}
        </p>
        <Link to={`${settings}#settings-access`} className={cn(link, 'mt-1 inline-block')}>Change who can use it</Link>
      </Card>

      <Card title="Settings" action={<Link to={settings} className={link}>All settings</Link>}>
        <ul>
          {isOwner && backend && declaresFormlogicAi(project) && <Jump to={`${settings}#app-ai-settings`} label="AI for this app" />}
          {isOwner && backend && declaresFormlogicPayments(project) && <Jump to={`${settings}#settings-payments`} label="Payments" />}
          {isOwner && backend && <Jump to={`${settings}#settings-signin`} label="Phone sign-in codes" />}
          {isOwner && <Jump to={`${settings}#settings-before`} label="Before it opens" />}
          {isOwner && <Jump to={`${settings}#settings-look`} label="Look and sharing" />}
          <Jump to={`${settings}#settings-engine`} label="Engine" />
        </ul>
      </Card>
  </div>;
}

const link = 'text-xs font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';
const quiet = 'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-white/5';

function Card({ title, action, className, children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return <section aria-label={title} className={cn('min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-[13px] leading-5 shadow-sm dark:border-slate-700 dark:bg-slate-900', className)}>
    <div className="mb-1.5 flex items-center gap-2">
      <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title}</h2>
      {action}
    </div>
    {children}
  </section>;
}

function Jump({ to, label }: { to: string; label: string }) {
  return <li><Link to={to} className="flex min-h-7 items-center text-slate-700 hover:text-primary-700 dark:text-slate-300 dark:hover:text-primary-300 max-sm:min-h-11">{label}</Link></li>;
}
