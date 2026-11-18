// The first section of a SoftN app's page (/apps/:appId/softn): what the app is doing, at a glance,
// with a way into each thing it shows. It runs nothing: the app itself is under Edit, so opening
// an app's page costs a few small requests and never starts its runtime.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Braces, Check, ChevronRight, ClipboardList, Copy, Database, ExternalLink, Globe, History, Layers, PencilRuler, Rocket, Settings, Table2, Users, Workflow, type LucideIcon } from 'lucide-react';
import { Button } from '../ui/Button';
import { followAppLink } from '../layout/useAppSectionSidebar';
import { api, type AppDomain } from '../../lib/api';
import { declaresFormlogicAi, declaresFormlogicPayments, phoneCodeProvider, type NativeDataSummary, type NativeProject } from '../../lib/nativeHosting';
import { projectHasBackend, softnWorkspacePath } from '../../lib/softnApps';
import type { ApiDescription } from '../../lib/appApi';
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
  draftStatus?: string;
  installedAccess: NativeProject['access'];
  canPublish: boolean;
  readOnly: boolean;
  installedApi: ApiDescription | null;
  isOwner: boolean;
  liveUrl: string;
  busy: boolean;
  onPublish: () => void;
  formCount?: number;
  onLeave: (to: string) => void;
}

export function SoftnOverview({ app, project, version, published, dirty, draftStatus, installedAccess, canPublish, readOnly, installedApi, isOwner, liveUrl, busy, onPublish, formCount, onLeave }: Props) {
  const backend = installedApi !== null;
  const [data, setData] = useState<NativeDataSummary | null>(null);
  const [dataError, setDataError] = useState('');
  const [domains, setDomains] = useState<AppDomain[] | null>();
  const [people, setPeople] = useState<number | null>();
  // Undefined while loading, null when a summary could not be read.
  const [flows, setFlows] = useState<{ all: number; running: number } | null>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!backend) return;
    const stop = new AbortController();
    void api.getNativeDataSummary(app.id, stop.signal).then(result => {
      if (stop.signal.aborted) return;
      if (result.error || !result.data) setDataError(result.error || 'The data summary is unavailable.');
      else { setDataError(''); setData(result.data); }
    });
    return () => stop.abort();
  }, [app.id, version, backend]);

  useEffect(() => {
    if (!isOwner || readOnly) return;
    let cancelled = false;
    void api.getAppDomains(app.id).then(result => { if (!cancelled) setDomains(result.error ? null : result.data?.domains ?? null); });
    if (installedAccess === 'members') void api.getAppUsers(app.id).then(result => { if (!cancelled) setPeople(result.error ? null : result.data?.count ?? null); });
    // Automations start from the app's own tables, so only an app with a backend has the section.
    if (backend) void api.listFlows(app.id).then(result => {
      if (cancelled) return;
      const list = result.data?.flows;
      setFlows(!result.error && list ? { all: list.length, running: list.filter(flow => flow.enabled).length } : null);
    });
    return () => { cancelled = true; };
  }, [app.id, isOwner, readOnly, backend, installedAccess]);

  const copyLink = async () => {
    if (await copyToClipboard(liveUrl)) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
    else toast.error('Copy failed', 'Use your browser’s Copy link action on the app link.');
  };

  const summary = data?.summary;
  const tables = summary ? [...summary.tables].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name)) : (data?.tables ?? []).map(name => ({ name, rows: null }));
  const rows = summary?.tables.reduce((sum, table) => sum + table.rows, 0);
  const largest = tables.slice(0, 8);
  const settings = softnWorkspacePath(app.id, 'settings');
  const members = installedAccess === 'members';

  const showPublish = !readOnly && (!published || dirty);
  const ownerControls = isOwner && !readOnly;
  const formsPath = `/apps/${app.id}/studio/data${formCount === 0 ? '?new=form' : ''}`;

  return <div className="@container/overview mt-4 space-y-4">
    <section aria-label="Release" className="min-w-0 overflow-hidden rounded-xl border border-slate-200 border-l-[3px] border-l-primary-500 bg-white dark:border-slate-700 dark:border-l-primary-400 dark:bg-slate-900">
      <div className="grid gap-3 px-4 pt-4 @2xl/overview:grid-cols-[minmax(0,1fr)_auto] @2xl/overview:items-start @2xl/overview:px-5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400"><Layers className="size-4" aria-hidden="true" />{published ? 'Current release' : 'App draft'}</p>
          <h2 className="mt-1.5 flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', published ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-amber-600 dark:bg-amber-400')} />
            {published ? `Live, version ${version}` : `Draft, version ${version}`}
          </h2>
          <p className={cn('mt-1 max-w-prose text-sm', detail)}>
            {!published ? 'Only the owner can preview this app until it is published.'
              : dirty ? 'You have changes that are not live yet. Visitors still get this release.'
              : members ? 'Invited members can open this release.' : 'Anyone with the link can open this release.'}
          </p>
          {dirty && draftStatus && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Unpublished changes · {draftStatus}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showPublish && <Button size="sm" onClick={onPublish} disabled={!canPublish} isLoading={busy} leftIcon={<Rocket className="size-4" />}>{published ? 'Publish changes' : 'Publish'}</Button>}
          <a href={liveUrl} target="_blank" rel="noopener noreferrer" className={cn(action, !showPublish && 'border-primary-200 bg-primary-50 text-primary-800 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/20')}><ExternalLink className="size-4" aria-hidden="true" />{published ? 'Open the app' : 'Preview draft'}</a>
          {!readOnly && <Link to={softnWorkspacePath(app.id, 'edit')} className={action}><PencilRuler className="size-4" aria-hidden="true" />Edit app</Link>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 border-t border-slate-200 bg-slate-50/70 px-4 py-1 dark:border-slate-700/80 dark:bg-slate-800/30 @2xl/overview:px-5">
        <button type="button" onClick={() => void copyLink()} aria-label={copied ? 'Link copied' : `Copy app address ${liveUrl}`} title={copied ? 'Link copied' : `Copy ${liveUrl}`} className="flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded text-slate-600 hover:text-primary-700 dark:text-slate-300 dark:hover:text-primary-300 max-sm:min-h-11">
          {copied ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : <Copy className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 break-all text-left font-mono text-xs">{copied ? 'Link copied' : liveUrl.replace(/^https?:\/\//, '')}</span>
        </button>
        {isOwner && <Link to={softnWorkspacePath(app.id, 'history')} className={link}><History className="size-3.5" aria-hidden="true" />Release history</Link>}
      </div>
    </section>

    <div className="grid items-start gap-4 @3xl/overview:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] @min-[68rem]/overview:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Panel title="Data" icon={Database} action={backend && <Link to={softnWorkspacePath(app.id, 'data')} className={link}>Open data<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}>
          {!backend ? <div className={detail}>
            {dirty && projectHasBackend(project) ? <><p>Your draft includes a backend.</p><Link to={softnWorkspacePath(app.id, 'data')} className={link}>Review backend changes<ChevronRight className="size-3.5" aria-hidden="true" /></Link></>
              : <><p className={summaryText}>Browser storage</p><p>Local records stay in each visitor&rsquo;s browser.</p>{ownerControls && <Link to={softnWorkspacePath(app.id, 'data')} className={link}>Add a backend<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}</>}
          </div>
            : dataError ? <p role="alert" className="text-red-700 dark:text-red-300">{dataError}</p>
            : !data ? <p role="status" className={detail}>Counting rows…</p>
            : !tables.length ? <p className={detail}>No tables yet. Tables appear here when the backend creates them.</p>
            : <>
              <p className={summaryText}>{count(tables.length, 'table')}{rows !== undefined && ` · ${count(rows, 'row')}`}{summary && ` · ${formatBytes(summary.bytes)}`}</p>
              <ul className="mt-2 divide-y divide-slate-200/70 border-y border-slate-200/70 dark:divide-slate-700/70 dark:border-slate-700/70">
                {largest.map(table => <li key={table.name}><Link to={softnWorkspacePath(app.id, 'data', table.name)} className={item}>
                  <Table2 className="size-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" /><span className="min-w-0 flex-1 break-all font-mono text-xs">{table.name}</span>
                  {table.rows !== null && <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">{count(table.rows, 'row')}</span>}
                  <ChevronRight className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                </Link></li>)}
              </ul>
              {tables.length > largest.length && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{summary ? `Showing the ${largest.length} largest tables.` : `Showing ${largest.length} of ${tables.length} tables.`}</p>}
            </>}
          {isOwner && installedApi && <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3">
            <span className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300"><Braces className="size-4" aria-hidden="true" />{count(installedApi.routes.length, 'API route')}</span>
            <Link to={softnWorkspacePath(app.id, 'api')} className={link}>Open API<ChevronRight className="size-3.5" aria-hidden="true" /></Link>
          </div>}
          {ownerControls && formCount !== undefined && <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 border-t border-slate-200 pt-2 dark:border-slate-700">
            <span className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-300"><ClipboardList className="size-4" aria-hidden="true" />{formCount > 0 ? count(formCount, 'attached form') : 'Forms'}</span>
            <Link to={formsPath} onClick={event => followAppLink(event, formsPath, softnWorkspacePath(app.id), onLeave)} className={link}>{formCount > 0 ? 'Manage forms' : 'Add a form'}<ChevronRight className="size-3.5" aria-hidden="true" /></Link>
          </div>}
        </Panel>

        {backend && ownerControls && <Panel title="Automations" icon={Workflow} action={<Link to={softnWorkspacePath(app.id, 'automations')} className={link}>View automations<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}>
          <p className={summaryText}>{flows === null ? 'Automation count unavailable' : flows === undefined ? 'Loading automations…' : flows.all === 0 ? 'Nothing runs by itself yet' : `${count(flows.all, 'automation')} · ${flows.running} running`}</p>
          <p className={detail}>{flows && flows.all > 0 ? 'Runs on record changes or a schedule.' : 'Trigger a workflow when a record is added, changed or removed.'}</p>
        </Panel>}
      </div>
      <div className="min-w-0 space-y-4 @min-[68rem]/overview:contents">
        <div className="min-w-0 space-y-4">
          <Panel title="People" icon={Users} action={members && ownerControls && <Link to={softnWorkspacePath(app.id, 'members')} className={link}>Members<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}>
            {!published && <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">Audience after publishing</p>}
            <p className={summaryText}>{members ? 'Only people you invite' : 'Anyone with the link'}</p>
            <p className={detail}>{members ? (people == null ? (people === null ? 'The member count is unavailable.' : 'Members sign in to this site to open the app.') : people <= 1 ? 'Nobody but you yet. Invite people in Members.' : `You and ${count(people - 1, 'other person', 'other people')} can use it.`)
              : 'The app can also require its own sign-in.'}</p>
            <Link to={`${settings}#settings-access`} className={link}>{ownerControls ? 'Change who can use it' : 'Access settings'}<ChevronRight className="size-3.5" aria-hidden="true" /></Link>
          </Panel>

          {ownerControls && <Panel title="Custom domains" icon={Globe} action={<Link to={softnWorkspacePath(app.id, 'domains')} className={link}>Domains<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}>
            {domains?.length ? <ul className="divide-y divide-slate-200 dark:divide-slate-700">{domains.map(domain => <li key={domain.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1">
              <span className="min-w-0 break-all font-mono text-xs">{domain.domain}</span>
              <span className={cn('text-xs font-medium', domain.status === 'active' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}>{domainState(domain.status)}</span>
            </li>)}</ul> : <p className={detail}>{domains === undefined ? 'Loading domains…' : domains === null ? 'Custom domains are unavailable.' : 'Using the FormLogic address.'}</p>}
          </Panel>}
        </div>
        <div className="min-w-0 @min-[68rem]/overview:mt-0">
          <Panel title="Settings" icon={Settings} action={<Link to={settings} className={link}>All settings<ChevronRight className="size-3.5" aria-hidden="true" /></Link>}>
            <ul className="divide-y divide-slate-200/70 dark:divide-slate-700/70">
              {isOwner && backend && declaresFormlogicAi(project) && <Jump to={`${settings}#app-ai-settings`} label="AI for this app" />}
              {isOwner && backend && declaresFormlogicPayments(project) && <Jump to={`${settings}#settings-payments`} label="Payments" />}
              {isOwner && backend && !!phoneCodeProvider(project) && <Jump to={`${settings}#settings-signin`} label="Phone sign-in codes" />}
              {isOwner && <Jump to={`${settings}#settings-before`} label="Before it opens" />}
              {isOwner && <Jump to={`${settings}#settings-look`} label="Look and sharing" />}
              <Jump to={`${settings}#settings-engine`} label="Engine" />
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  </div>;
}

const detail = 'text-slate-600 dark:text-slate-400';
const summaryText = 'font-medium text-slate-900 dark:text-slate-100';
const link = 'inline-flex min-h-8 items-center gap-1 rounded text-xs font-medium text-primary-700 underline-offset-2 hover:underline dark:text-primary-300 max-sm:min-h-11';
const action = 'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 max-sm:min-h-11 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-white/5';
const item = 'flex min-h-9 items-center gap-2.5 rounded px-1 text-slate-700 hover:bg-slate-50 hover:text-primary-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-primary-300 max-sm:min-h-11';

function Panel({ title, icon: Icon, action, children }: { title: string; icon: LucideIcon; action?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 pb-4 pt-3 text-sm leading-5 dark:border-slate-700 dark:bg-slate-900">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Icon className="size-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />{title}</h2>
      {action}
    </div>
    {children}
  </section>;
}

function Jump({ to, label }: { to: string; label: string }) {
  return <li><Link to={to} className={cn(item, 'justify-between')}>{label}<ChevronRight className="size-3.5 text-slate-400" aria-hidden="true" /></Link></li>;
}
