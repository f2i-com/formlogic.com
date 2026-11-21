// The API section of an app's own page, for SoftN and JavaScript apps with a backend alike: the
// routes of the app as it is live (its installed manifest's `server` block), each with what it runs,
// who may call it and what it does to the data; the database changes it has run; Try it, which
// sends one call as the owner to the live app (POST /api/app/{slug}/native/request, as the app's own
// page does) and shows what came back; and the app's latest calls, as the server recorded them
// (NativeAppCalls), asked for again every ten seconds while the section is open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, Code2, Copy, Database, Globe, KeyRound, Lock, Plus, RefreshCw, Route, Save, Send, Server, Shield, SlidersHorizontal } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadFailure } from '../ui/LoadFailure';
import { Panel } from '../ui/Panel';
import { Switch } from '../ui/Switch';
import { HELP, LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH, ROW_BOX } from '../ui/listLook';
import { formatAbsoluteTimeTitle, formatRelativeTime } from '../flows/relativeTime';
import { api } from '../../lib/api';
import {
  answerText, apiOf, callerInWords, checkBody, checkQuery, durationInWords, routeKey, routeWrites, statusInWords, statusTone, triable, whoMayCall,
  type ApiRoute, type NativeCallList,
} from '../../lib/appApi';
import { databaseChangeName } from '../../lib/nativeVersions';
import { softnWorkspacePath } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import type { App, ExternalApiSettings } from '../../types/app';

/** How many seconds apart the latest calls are asked for while the section is open and the tab is in view. */
export const CALLS_EVERY_SECONDS = 10;
/**
 * The latest calls shown at first, and then at each Show more (the last of them all that is kept):
 * a short page on a phone, and a list asked for again every ten seconds is as long as it is shown.
 */
const CALL_PAGES = [20, 100] as const;
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums';
const TONES = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  redirect: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  refused: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
} as const;
const field = 'block w-full rounded-lg border border-gray-300 bg-white px-2.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

export function SoftnApi({ app, access, manifest, version, dirty, readOnly, onNavigate }: {
  app: App;
  /** Who can use the app, the installed project's `access`: whoever can open it may call its routes. */
  access: 'members' | 'application' | undefined;
  /** The installed version's manifest.json: the routes and the database changes of the app as it is live. */
  manifest: string | undefined;
  /** The installed version. */
  version: number;
  /** The page holds changes not published yet: what is shown is the live app, and the section says so. */
  dirty: boolean;
  /** The shared demo: it browses, and its apps' backends do not run for it. */
  readOnly: boolean;
  /** Optional SPA navigation callback (falls back to window.location.assign when rendered outside a Router). */
  onNavigate?: (to: string) => void;
}) {
  const goTo = useCallback((to: string) => {
    if (onNavigate) onNavigate(to);
    else if (typeof window !== 'undefined') window.location.assign(to);
  }, [onNavigate]);
  const fetchApps = useAppStore(s => s.fetchApps);
  const described = useMemo(() => apiOf(manifest), [manifest]);
  const served = useMemo(() => (described?.routes ?? []).filter(triable), [described]);
  // The route Try it has chosen (by its method and address), and the calls asked for again once it has sent one.
  const [chosen, setChosen] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [creatingApi, setCreatingApi] = useState(false);

  const createSharedApi = async () => {
    setCreatingApi(true);
    try {
      const res = await api.createSharedApiBackend(app.id, { name: `${app.name} API` });
      if (res.error || !res.data?.app) {
        toast.error('Could not create shared-DB API backend', typeof res.error === 'string' ? res.error : undefined);
        return;
      }
      await fetchApps();
      toast.success('Shared-DB API backend created', `Connected directly to ${app.name}'s SQLite database.`);
      goTo(softnWorkspacePath(res.data.app.id, 'api'));
    } finally {
      setCreatingApi(false);
    }
  };
  // A row's Try it: the form below, scrolled to and given the keyboard (its route chosen).
  const tryRoute = (route: ApiRoute) => {
    setChosen(routeKey(route));
    window.setTimeout(() => {
      document.getElementById('api-try')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      document.getElementById('api-try-route')?.focus({ preventScroll: true });
    }, 30);
  };

  return <div className="mt-4" data-testid="softn-api">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          {described?.containerRuntime && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Server className="h-3.5 w-3.5" />
              {described.containerRuntime.toUpperCase()} Container Backend
            </span>
          )}
          {app.settings?.sharedDatabaseAppId && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Database className="h-3.5 w-3.5" />
              Connected to Shared SQLite DB
            </span>
          )}
        </div>
        <p className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Your app&rsquo;s pages and external services read and write data through these endpoints. Test any route live, call it externally with an API key, or spin up a dedicated API backend on the same database.
        </p>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => goTo('/settings#api-keys')}
            leftIcon={<KeyRound className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            API Keys
          </Button>
          <Button
            size="sm"
            onClick={() => void createSharedApi()}
            isLoading={creatingApi}
            leftIcon={<Plus className="h-4 w-4" />}
            className="min-h-9 font-semibold"
          >
            Add Shared-DB API Backend
          </Button>
        </div>
      )}
    </div>
    {dirty && <p role="note" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
      You have changes that are not live yet. This is the live app, version {version}: publish your changes to see their routes here.
    </p>}

    {!described
      ? <Panel title="Routes" icon={<Route className="h-4 w-4" />}>
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">The app&rsquo;s backend is not live yet. Publish your changes, and its routes are listed here.</p>
      </Panel>
      : <>
        {/* Side by side only where the routes still have room for their table beside the database changes (with the
            sidebar open, 1280 px left the address column under a rem); below that, one above the other. */}
        <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Panel title="Routes" icon={<Route className="h-4 w-4" />}>
            <Routes routes={described.routes} access={access} published={app.status === 'published'} readOnly={readOnly} onTry={tryRoute} />
          </Panel>
          <Panel title="Database changes" icon={<Database className="h-4 w-4" />}>
            {described.migrations.length > 0
              ? <>
                <ol className={cn(ROW_BOX, 'list-none')} aria-label="Database changes">
                  {described.migrations.map((path, index) => <li key={path} title={path} className="flex items-baseline gap-2 px-3 py-2 text-xs">
                    <span className="w-5 flex-none text-right tabular-nums text-slate-400 dark:text-slate-500">{index + 1}</span>
                    <span className="min-w-0 break-all font-mono text-slate-800 dark:text-slate-100">{databaseChangeName(path)}</span>
                  </li>)}
                </ol>
                <p className={cn(HELP, 'mt-3')}>Each has run on the app&rsquo;s database, in this order. One that has run is never changed or removed: a new change is a new file, listed after the last.</p>
              </>
              : <p className="text-sm text-slate-600 dark:text-slate-300">{described.database ? 'Database schema is managed by this app backend.' : 'Its backend keeps no database of its own.'}</p>}
          </Panel>
        </div>

        <div className="mt-4">
          <ExternalApiAccessPanel app={app} firstRoute={served[0]} readOnly={readOnly} onOpenApiKeys={() => goTo('/settings#api-keys')} />
        </div>

        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Panel id="api-try" title="Try it" icon={<Send className="h-4 w-4" />}>
            {readOnly
              ? <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">This is the shared demo: its apps&rsquo; backends do not run here, so nothing can be sent.</p>
              : served.length === 0
                ? <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">The app has no route this server can call.</p>
                : <TryIt key={JSON.stringify([app.id, app.slug, version])} app={app} routes={served} containerRuntime={described.containerRuntime} chosen={chosen} onChoose={setChosen} onSent={() => setSent(n => n + 1)} />}
          </Panel>
          <RecentCalls appId={app.id} sent={sent} />
        </div>
      </>}
  </div>;
}

/** The routes as a table while there is room for one, and as cards below that (listLook). */
function Routes({ routes, access, published, readOnly, onTry }: { routes: ApiRoute[]; access: 'members' | 'application' | undefined; published: boolean; readOnly: boolean; onTry(route: ApiRoute): void }) {
  if (routes.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-300">Its backend has no routes yet. They are listed in the server block of its manifest.json.</p>;
  return <>
    <div className="@container/list min-w-0">
      <div className={LIST_BOX}>
        <table className={LIST_TABLE}>
          <caption className="sr-only">Routes</caption>
          <thead className={LIST_HEAD}>
            <tr>
              <th scope="col" className={cn(LIST_TH, 'w-20 pl-3')}>Method</th>
              <th scope="col" className={LIST_TH}>Address</th>
              <th scope="col" className={cn(LIST_TH, 'w-36')}>Runs</th>
              <th scope="col" className={cn(LIST_TH, 'w-44')}>Who may call it</th>
              <th scope="col" className={cn(LIST_TH, 'w-24')}>Data</th>
              {!readOnly && <th scope="col" className={cn(LIST_TH, 'w-24 pr-3')}><span className="sr-only">Try it</span></th>}
            </tr>
          </thead>
          <tbody className={LIST_BODY}>
            {routes.map(route => <tr key={routeKey(route)} className={cn(LIST_ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1')}>
              <td className={cn(LIST_CELL, 'hidden @xl/list:pl-3')}><MethodTag method={route.method} /></td>
              <th scope="row" className={cn(LIST_CELL, 'font-normal')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="@xl/list:hidden"><MethodTag method={route.method} /></span>
                  <span className="min-w-0 break-all font-mono text-[12px] text-slate-900 dark:text-white">{route.path}</span>
                </span>
                {route.unserved && <span className="mt-0.5 block text-xs leading-5 text-amber-700 dark:text-amber-300">Not served here. {route.unserved}</span>}
                {route.siteOnly && <span className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400">The site calls it with App AI&rsquo;s answers and camera checks. The app&rsquo;s pages and Try it cannot.</span>}
              </th>
              <td className={cn(LIST_CELL, 'col-span-2 min-w-0 truncate')}>
                <span className={LIST_LABEL}>Runs</span>
                {route.handler ? <span className="font-mono text-[12px] text-slate-700 dark:text-slate-200" title={route.handler}>{route.handler}</span> : <span className="text-slate-400">None named</span>}
              </td>
              <td className={cn(LIST_CELL, 'text-slate-700 dark:text-slate-300')}>
                <span className={LIST_LABEL}>Who may call it</span>{whoMayCall(route, access, published)}
              </td>
              <td className={cn(LIST_CELL, 'text-slate-700 dark:text-slate-300')}>
                <span className={LIST_LABEL}>Data</span>{route.transaction === 'write' ? 'Changes it' : 'Reads it'}
              </td>
              {!readOnly && <td className={cn(LIST_CELL, 'col-start-2 row-start-1 self-start @xl/list:pr-2 @xl/list:text-right')}>
                {triable(route) && <Button size="sm" variant="ghost" className="px-2" leftIcon={<Send className="h-3.5 w-3.5" />} aria-label={`Try it: ${route.method} ${route.path}`} onClick={() => onTry(route)}>Try it</Button>}
              </td>}
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
    <p className={cn(HELP, 'mt-3')}>
      {!published
        ? 'The app is not published yet, so only you can open it and call its routes. Once it is, who can is as Settings says.'
        : access === 'application'
          ? 'Anyone who opens the app can call its routes. Each route’s own code decides what a caller may see and change.'
          : 'Only you and the people you invite can open the app and call its routes. Each route’s own code decides what each of them may see and change.'}
      {' '}A route&rsquo;s address is matched exactly, so a call to any other address is answered &ldquo;not found&rdquo;.
    </p>
  </>;
}

function MethodTag({ method }: { method: string }) {
  return <span className="inline-flex h-5 min-w-[3.25rem] flex-none items-center justify-center rounded bg-slate-100 px-1.5 font-mono text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{method}</span>;
}

function StatusPill({ status }: { status: number }) {
  if (!status) return <span className={cn(pill, TONES.failed)}>No answer</span>;
  const words = statusInWords(status);
  return <span className={cn(pill, TONES[statusTone(status)])}>{status}{words && ` ${words}`}</span>;
}

type Answer = {
  route: string;
  status: number;
  /** Round trip, from the page. */
  took: number;
  /** What the app's backend answered. */
  body?: unknown;
  /** Why there is no answer of the app's: FormLogic refused the call, or it could not be sent. */
  error?: string;
};

const emptyDraft = { query: '', body: '', authorization: '', 'idempotency-key': '' };
type DraftPart = keyof typeof emptyDraft;
type LiveRequest = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown };

/**
 * One call to the live app, as its owner: a route, its query and its body, each checked before it
 * is sent. A route that can change the app's data asks first. What came back is shown as it came:
 * its status, the time it took, and the answer, laid out to read where it is JSON.
 */
function TryIt({ app, routes, containerRuntime, chosen, onChoose, onSent }: { app: App; routes: ApiRoute[]; containerRuntime?: string; chosen: string | null; onChoose(key: string): void; onSent(): void }) {
  const route = routes.find(candidate => routeKey(candidate) === chosen) ?? routes[0];
  const key = routeKey(route);
  const isContainer = !!containerRuntime;
  const [customMethod, setCustomMethod] = useState(route.method === 'ANY' ? 'GET' : route.method);
  const [customPath, setCustomPath] = useState(route.path);
  const effectiveMethod = isContainer ? customMethod : route.method;
  const effectivePath = isContainer ? (customPath.trim() || route.path) : route.path;
  // What was typed for each route, kept while the section is open.
  const [texts, setTexts] = useState<Record<string, typeof emptyDraft>>({});
  const text = texts[key] ?? emptyDraft;
  const headerCount = [text.authorization, text['idempotency-key']].filter(Boolean).length;
  // What was wrong belongs to the route it was found in: another route, however it was chosen (the list here, or a
  // row's Try it), has none of it.
  const [problemOf, setProblemOf] = useState<{ key: string; part: DraftPart; message: string } | null>(null);
  const problem = problemOf?.key === key ? problemOf : null;
  const type = (part: DraftPart, value: string) => {
    setTexts(all => ({ ...all, [key]: { ...(all[key] ?? emptyDraft), [part]: value } }));
    if (problem?.part === part) setProblemOf(null);
  };
  const headerFields = useRef<HTMLDetailsElement>(null);
  const invalid = (part: DraftPart, message: string) => {
    setProblemOf({ key, part, message });
    if ((part === 'authorization' || part === 'idempotency-key') && headerFields.current) headerFields.current.open = true;
    document.getElementById('api-try-' + part)?.focus();
    return null;
  };
  const [asking, setAsking] = useState<LiveRequest | null>(null);
  if (asking && !isContainer && routeKey(asking) !== key) setAsking(null);
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const hasBody = effectiveMethod !== 'GET';
  const writes = isContainer ? effectiveMethod !== 'GET' : routeWrites(route);

  const checked = (): LiveRequest | null => {
    const query = checkQuery(text.query);
    if (!query.ok) return invalid('query', query.error);
    const body = hasBody ? checkBody(text.body) : { ok: true as const, value: {} };
    if (!body.ok) return invalid('body', body.error);
    // NativeAppController limits these values by their UTF-8 byte length.
    const headers: Record<string, string> = {};
    const utf8 = new TextEncoder();
    if (text.authorization) {
      if (utf8.encode(text.authorization).length > 4096) return invalid('authorization', 'Authorization can contain up to 4,096 bytes.');
      headers.authorization = text.authorization;
    }
    if (text['idempotency-key']) {
      if (utf8.encode(text['idempotency-key']).length > 255) return invalid('idempotency-key', 'Idempotency-Key can contain up to 255 bytes.');
      headers['idempotency-key'] = text['idempotency-key'];
    }
    setProblemOf(null);
    return { path: effectivePath.startsWith('/') ? effectivePath : `/${effectivePath}`, method: effectiveMethod, query: query.value, headers, body: body.value };
  };

  const send = async (ready: LiveRequest) => {
    setSending(true);
    const started = performance.now();
    const result = await api.runNativeRequest(app.slug, ready);
    const took = performance.now() - started;
    setSending(false);
    setAsking(null);
    const answered = result.data?.result;
    const label = `${ready.method} ${ready.path}`;
    if (answered && typeof answered.status === 'number') setAnswer({ route: label, status: answered.status, body: answered.body, took });
    else if (result.transportFailure) setAnswer({ route: label, status: 0, took, error: writes
      ? 'The connection ended before an answer arrived. Check the app’s data or recent calls before sending this write again.'
      : 'The call could not be sent. Check your connection and try again.' });
    else setAnswer({ route: label, status: result.status ?? 0, took, error: result.error || 'The server did not answer.' });
    onSent();
  };

  const press = () => {
    const ready = checked();
    if (!ready) return;
    if (writes) setAsking(ready);
    else void send(ready);
  };

  const shown = answer && answer.error === undefined ? answerText(answer.body) : null;
  return <div>
    {isContainer ? (
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
        <div>
          <label htmlFor="api-try-method" className="text-xs font-medium text-slate-600 dark:text-slate-300">Method</label>
          <select
            id="api-try-method"
            value={customMethod}
            onChange={e => setCustomMethod(e.target.value)}
            className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="api-try-route" className="text-xs font-medium text-slate-600 dark:text-slate-300">Path</label>
          <input
            id="api-try-route"
            type="text"
            value={customPath}
            onChange={e => { setCustomPath(e.target.value); setProblemOf(null); }}
            placeholder="/api/items"
            className={cn(field, 'mt-1 h-9 max-sm:h-11')}
          />
        </div>
      </div>
    ) : (
      <>
        <label htmlFor="api-try-route" className="text-xs font-medium text-slate-600 dark:text-slate-300">Route</label>
        <select id="api-try-route" value={key} onChange={event => { onChoose(event.target.value); setProblemOf(null); }}
          className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
          {routes.map(option => <option key={routeKey(option)} value={routeKey(option)}>{routeKey(option)}</option>)}
        </select>
      </>
    )}

    <label htmlFor="api-try-query" className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">Query <span className="font-normal text-slate-500 dark:text-slate-400">(JSON, optional)</span></label>
    <textarea id="api-try-query" rows={2} value={text.query} onChange={event => type('query', event.target.value)} spellCheck={false}
      placeholder='{"page": "2"}' aria-invalid={problem?.part === 'query' || undefined} aria-describedby={problem?.part === 'query' ? 'api-try-problem' : undefined}
      className={cn(field, 'mt-1 min-h-[3.25rem] resize-y py-2', problem?.part === 'query' && 'border-red-400 dark:border-red-500/60')} />

    {hasBody && <>
      <label htmlFor="api-try-body" className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">Body <span className="font-normal text-slate-500 dark:text-slate-400">(JSON)</span></label>
      <textarea id="api-try-body" rows={5} value={text.body} onChange={event => type('body', event.target.value)} spellCheck={false}
        placeholder='{"title": "Buy milk"}' aria-invalid={problem?.part === 'body' || undefined} aria-describedby={problem?.part === 'body' ? 'api-try-problem' : undefined}
        className={cn(field, 'mt-1 min-h-[6.5rem] resize-y py-2', problem?.part === 'body' && 'border-red-400 dark:border-red-500/60')} />
    </>}
    <details ref={headerFields} className="mt-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <summary className="cursor-pointer text-xs font-medium text-slate-700 dark:text-slate-200">
        Request headers{headerCount > 0 && ` (${headerCount})`}
      </summary>
      <label htmlFor="api-try-authorization" className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">Authorization</label>
      <input id="api-try-authorization" type="password" autoComplete="off" spellCheck={false} value={text.authorization} onChange={event => type('authorization', event.target.value)}
        placeholder="Bearer …" aria-invalid={problem?.part === 'authorization' || undefined} aria-describedby={problem?.part === 'authorization' ? 'api-try-problem' : 'api-try-auth-help'}
        className={cn(field, 'mt-1 h-9')} />
      <p id="api-try-auth-help" className={cn(HELP, 'mt-1')}>Enter the full value your app expects, including any prefix.</p>
      <label htmlFor="api-try-idempotency-key" className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">Idempotency-Key</label>
      <input id="api-try-idempotency-key" autoComplete="off" spellCheck={false} value={text['idempotency-key']} onChange={event => type('idempotency-key', event.target.value)}
        placeholder="item-create-1" aria-invalid={problem?.part === 'idempotency-key' || undefined} aria-describedby={problem?.part === 'idempotency-key' ? 'api-try-problem' : 'api-try-idempotency-help'}
        className={cn(field, 'mt-1 h-9')} />
      <p id="api-try-idempotency-help" className={cn(HELP, 'mt-1')}>Reuse the same key when retrying a request if your backend supports it.</p>
    </details>
    {problem && <p id="api-try-problem" role="alert" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{problem.message}</p>}

    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button size="sm" leftIcon={<Send className="h-4 w-4" />} isLoading={sending} onClick={press}>Send</Button>
      <span className={HELP}>As you, to the live app.{writes && ' It can change the app’s data, so you are asked first.'}</span>
    </div>

    {answer && <section aria-label="Answer" className="mt-4 border-t border-slate-100 pt-3 dark:border-white/5">
      {/* The status and the time are said when they come; the answer itself is there to be read. */}
      <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        <StatusPill status={answer.status} />
        {answer.status > 0 && <span className="tabular-nums">{durationInWords(answer.took)}</span>}
        <span className="min-w-0 break-all font-mono text-slate-500 dark:text-slate-400">{answer.route}</span>
      </p>
      {answer.error !== undefined
        ? <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">
          {answer.status > 0 && <span className="font-semibold">FormLogic answered, not the app: </span>}{answer.error}
        </p>
        : <>
          <pre data-testid="api-answer" className="scrollbar-thin mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-800 dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-100">{shown!.text || 'The answer was empty.'}</pre>
          {shown!.cut && <p className={cn(HELP, 'mt-1')}>The answer is longer than is shown here.</p>}
        </>}
    </section>}

    {asking && <ConfirmDialog isOpen onClose={() => { if (!sending) setAsking(null); }} onConfirm={() => void send(asking)} isLoading={sending}
      title="Send this to the live app?" confirmLabel="Send it"
      message={`${asking.method} ${asking.path} can change ${app.name}’s data. It runs on the live app, as you, and what it changes stays changed: anyone using the app sees it.`} />}
  </div>;
}

const ALL_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const DEFAULT_EXTERNAL_API: ExternalApiSettings = {
  enabled: true,
  authMode: 'api_key',
  allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedPaths: [],
  blockedPaths: [],
  defaultPrefix: '',
  corsOrigins: [],
  rateLimitPerMinute: 120,
  customHeaders: {},
};

function parseLines(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHeadersText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function formatHeadersText(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function ExternalApiAccessPanel({
  app,
  firstRoute,
  readOnly = false,
  onOpenApiKeys,
}: {
  app: App;
  firstRoute?: ApiRoute;
  readOnly?: boolean;
  onOpenApiKeys: () => void;
}) {
  const updateApp = useAppStore((s) => s.updateApp);
  const saved: ExternalApiSettings = useMemo(() => ({
    ...DEFAULT_EXTERNAL_API,
    ...(app.settings?.externalApi ?? {}),
    allowedMethods: app.settings?.externalApi?.allowedMethods?.length
      ? app.settings.externalApi.allowedMethods
      : DEFAULT_EXTERNAL_API.allowedMethods,
    allowedPaths: app.settings?.externalApi?.allowedPaths ?? [],
    blockedPaths: app.settings?.externalApi?.blockedPaths ?? [],
    corsOrigins: app.settings?.externalApi?.corsOrigins ?? [],
    customHeaders: app.settings?.externalApi?.customHeaders ?? {},
  }), [app.settings?.externalApi]);

  const [enabled, setEnabled] = useState(saved.enabled);
  const [authMode, setAuthMode] = useState<'api_key' | 'both' | 'public'>(saved.authMode);
  const [allowedMethods, setAllowedMethods] = useState<string[]>(saved.allowedMethods);
  const [allowedPathsText, setAllowedPathsText] = useState(saved.allowedPaths.join('\n'));
  const [blockedPathsText, setBlockedPathsText] = useState(saved.blockedPaths.join('\n'));
  const [defaultPrefix, setDefaultPrefix] = useState(saved.defaultPrefix);
  const [corsOriginsText, setCorsOriginsText] = useState(saved.corsOrigins.join('\n'));
  const [rateLimit, setRateLimit] = useState(String(saved.rateLimitPerMinute));
  const [customHeadersText, setCustomHeadersText] = useState(formatHeadersText(saved.customHeaders));
  const [showCustomize, setShowCustomize] = useState(false);
  const [saving, setSaving] = useState(false);

  const [tab, setTab] = useState<'direct' | 'invoke' | 'js' | 'python'>('direct');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://formlogic.com';
  const appRef = app.slug || app.id;
  const samplePath = firstRoute?.path || '/api/status';
  const sampleMethod = firstRoute?.method && firstRoute.method !== 'ANY' ? firstRoute.method : 'GET';
  const trimmedPath = samplePath.replace(/^\/+/, '');
  const publicActive = enabled && (authMode === 'public' || authMode === 'both') && app.status === 'published';
  const usePublicSnippet = authMode === 'public';

  const directRestBase = `${origin}/api/v1/apps/${appRef}/routes/`;
  const publicRestBase = `${origin}/api/public/apps/${appRef}/routes/`;
  const invokeUrl = `${origin}/api/v1/apps/${appRef}/invoke`;

  const snippets = {
    direct: usePublicSnippet
      ? `curl -X ${sampleMethod} "${publicRestBase}${trimmedPath}"`
      : `curl -X ${sampleMethod} "${directRestBase}${trimmedPath}" \\\n  -H "Authorization: Bearer flk_YOUR_API_KEY"`,
    invoke: `curl -X POST "${invokeUrl}" \\\n  -H "Authorization: Bearer flk_YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"method": "${sampleMethod}", "path": "${samplePath}", "query": {}, "body": {}}'`,
    js: usePublicSnippet
      ? `const res = await fetch("${publicRestBase}${trimmedPath}");\nconst data = await res.json();`
      : `const res = await fetch("${directRestBase}${trimmedPath}", {\n  method: "${sampleMethod}",\n  headers: {\n    "Authorization": "Bearer flk_YOUR_API_KEY",\n    "Content-Type": "application/json",\n  },\n});\nconst data = await res.json();`,
    python: usePublicSnippet
      ? `import requests\n\nres = requests.${sampleMethod.toLowerCase()}("${publicRestBase}${trimmedPath}")\nprint(res.json())`
      : `import requests\n\nres = requests.${sampleMethod.toLowerCase()}(\n    "${directRestBase}${trimmedPath}",\n    headers={"Authorization": "Bearer flk_YOUR_API_KEY"},\n)\nprint(res.json())`,
  };

  const copyText = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
    }).catch(() => undefined);
  };

  const toggleMethod = (m: string) => {
    setAllowedMethods((prev) => {
      if (prev.includes(m)) {
        return prev.length > 1 ? prev.filter((x) => x !== m) : prev;
      }
      return [...prev, m];
    });
  };

  const handleSave = async () => {
    if (readOnly) return;
    setSaving(true);
    try {
      const nextPolicy: ExternalApiSettings = {
        enabled,
        authMode,
        allowedMethods: allowedMethods.length > 0 ? allowedMethods : ['GET'],
        allowedPaths: parseLines(allowedPathsText),
        blockedPaths: parseLines(blockedPathsText),
        defaultPrefix: defaultPrefix.trim(),
        corsOrigins: parseLines(corsOriginsText),
        rateLimitPerMinute: Math.max(1, Math.min(600, Number(rateLimit) || 120)),
        customHeaders: parseHeadersText(customHeadersText),
      };
      const updated = await updateApp(app.id, {
        settings: {
          ...(app.settings ?? {}),
          externalApi: nextPolicy,
        },
      });
      if (!updated) {
        toast.error('Could not save External API settings');
        return;
      }
      toast.success(
        'External API settings saved',
        enabled
          ? authMode === 'api_key'
            ? 'API-key access rules updated.'
            : 'Public & external REST rules are now live.'
          : 'External API access is now turned off for this app.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="External API Access & Customization"
      icon={<KeyRound className="h-4 w-4" />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold',
            !enabled
              ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
              : authMode === 'api_key'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
          )}>
            {!enabled ? <Lock className="h-3 w-3" /> : authMode === 'api_key' ? <Shield className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
            {!enabled ? 'Disabled' : authMode === 'api_key' ? 'API Key' : authMode === 'both' ? 'Public + API Key' : 'Public Only'}
          </span>
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowCustomize((v) => !v)}
              leftIcon={<SlidersHorizontal className="h-3.5 w-3.5" />}
            >
              {showCustomize ? 'Hide Settings' : 'Customize API'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">
          Use this SoftN app as a live external REST API from websites, mobile apps, scripts, or webhooks — with customizable auth mode, allowed routes &amp; methods, CORS origins, rate limits, and custom headers.
        </p>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={onOpenApiKeys} leftIcon={<KeyRound className="h-3.5 w-3.5" />}>
            Create / Manage API Keys
          </Button>
        )}
      </div>

      {/* Live Endpoint Base URLs */}
      {enabled && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {authMode !== 'public' && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">API Key REST Base (flk_ · apps:invoke)</p>
                <p className="truncate font-mono text-xs text-slate-900 dark:text-white">{directRestBase}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => copyText('directUrl', directRestBase)} aria-label="Copy API key REST URL">
                {copiedKey === 'directUrl' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}
          {(authMode === 'public' || authMode === 'both') && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2 dark:border-indigo-500/30 dark:bg-indigo-500/10">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                  Public REST Base {app.status !== 'published' ? '(Publish app to activate)' : '(No API key needed)'}
                </p>
                <p className="truncate font-mono text-xs text-slate-900 dark:text-white">{publicRestBase}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => copyText('publicUrl', publicRestBase)} aria-label="Copy public REST URL">
                {copiedKey === 'publicUrl' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Customizable Gateway Policy Form */}
      {showCustomize && !readOnly && (
        <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-700 dark:bg-slate-800/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Switch
              label="Expose this SoftN app as an external API"
              checked={enabled}
              onChange={setEnabled}
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Supports <code className="font-mono">X-App-Authorization</code> header forwarding
            </span>
          </div>

          {enabled && (
            <>
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Authentication Mode</p>
                <div className="flex flex-wrap gap-2">
                  {([
                    ['api_key', 'API Key Only (flk_)', Shield],
                    ['both', 'Public + API Key', Globe],
                    ['public', 'Public Routes Only', Globe],
                  ] as const).map(([mode, label, Icon]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setAuthMode(mode)}
                      className={cn(
                        'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition',
                        authMode === mode
                          ? 'border-primary-500 bg-primary-600 text-primary-foreground shadow-xs'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                {(authMode === 'public' || authMode === 'both') && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Public mode serves published apps on <code className="font-mono">/api/public/apps/{appRef}/routes/…</code> without a FormLogic API key. Restrict Allowed Methods and Allowed Route Prefixes below to expose only what you intend.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Allowed HTTP Methods</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setAllowedMethods(['GET'])}
                      className="cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                    >
                      Read-only (GET)
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllowedMethods([...ALL_HTTP_METHODS])}
                      className="cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                    >
                      Full CRUD
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {ALL_HTTP_METHODS.map((m) => {
                    const active = allowedMethods.includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleMethod(m)}
                        className={cn(
                          'h-8 cursor-pointer rounded-lg border px-3 font-mono text-xs font-semibold transition',
                          active
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-200'
                            : 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
                        )}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="ext-api-allowed-paths" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Allowed Route Prefixes <span className="font-normal text-slate-500">(blank = all routes)</span>
                  </label>
                  <textarea
                    id="ext-api-allowed-paths"
                    rows={3}
                    value={allowedPathsText}
                    onChange={(e) => setAllowedPathsText(e.target.value)}
                    placeholder={'/api/products\n/api/orders'}
                    className={cn(field, 'mt-1 py-2')}
                  />
                </div>
                <div>
                  <label htmlFor="ext-api-blocked-paths" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Blocked Route Prefixes <span className="font-normal text-slate-500">(always denied)</span>
                  </label>
                  <textarea
                    id="ext-api-blocked-paths"
                    rows={3}
                    value={blockedPathsText}
                    onChange={(e) => setBlockedPathsText(e.target.value)}
                    placeholder={'/api/admin\n/api/setup'}
                    className={cn(field, 'mt-1 py-2')}
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="ext-api-cors" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                      Allowed Browser CORS Origins
                    </label>
                    <button
                      type="button"
                      onClick={() => setCorsOriginsText('*')}
                      className="cursor-pointer text-[11px] font-medium text-primary-600 hover:underline dark:text-primary-400"
                    >
                      Allow any (*)
                    </button>
                  </div>
                  <textarea
                    id="ext-api-cors"
                    rows={2}
                    value={corsOriginsText}
                    onChange={(e) => setCorsOriginsText(e.target.value)}
                    placeholder={'https://myapp.com\nhttps://staging.myapp.com'}
                    className={cn(field, 'mt-1 py-2')}
                  />
                </div>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="ext-api-prefix" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                        Default Path Prefix
                      </label>
                      <input
                        id="ext-api-prefix"
                        type="text"
                        value={defaultPrefix}
                        onChange={(e) => setDefaultPrefix(e.target.value)}
                        placeholder="/api"
                        className={cn(field, 'mt-1 h-9')}
                      />
                    </div>
                    <div>
                      <label htmlFor="ext-api-rate" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                        Rate Limit (req / min)
                      </label>
                      <input
                        id="ext-api-rate"
                        type="number"
                        min={1}
                        max={600}
                        value={rateLimit}
                        onChange={(e) => setRateLimit(e.target.value)}
                        className={cn(field, 'mt-1 h-9')}
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ext-api-headers" className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                      Custom Response Headers <span className="font-normal text-slate-500">(Header: Value per line)</span>
                    </label>
                    <textarea
                      id="ext-api-headers"
                      rows={2}
                      value={customHeadersText}
                      onChange={(e) => setCustomHeadersText(e.target.value)}
                      placeholder={'Cache-Control: public, max-age=60\nX-API-Version: 1.0'}
                      className={cn(field, 'mt-1 py-2')}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {publicActive ? 'Public routes and API-key rules take effect immediately upon saving.' : 'Changes apply immediately to every external request.'}
            </p>
            <Button size="sm" variant="primary" isLoading={saving} onClick={() => void handleSave()} leftIcon={<Save className="h-3.5 w-3.5" />}>
              Save External API Settings
            </Button>
          </div>
        </div>
      )}

      {/* Ready-to-copy client snippets */}
      {enabled && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
              {([
                ['direct', 'Direct REST (cURL)'],
                ['invoke', 'Invoke JSON (cURL)'],
                ['js', 'JavaScript fetch'],
                ['python', 'Python requests'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    tab === id
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
                  )}
                >
                  <Code2 className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => copyText('snippet', snippets[tab])}
              leftIcon={copiedKey === 'snippet' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            >
              {copiedKey === 'snippet' ? 'Copied' : 'Copy snippet'}
            </Button>
          </div>
          <pre className="mt-2.5 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
            {snippets[tab]}
          </pre>
        </>
      )}
    </Panel>
  );
}

/** How long a read may take before a timed refresh stops waiting for it and asks again. */
const READ_GIVEN_UP_MS = 30_000;
/** After Try it sends a call, the calls are read at once and again this much later. */
const SENT_READ_AGAIN_MS = 1500;

/**
 * The app's latest calls, newest first, as the server recorded them: asked for again every ten
 * seconds while the section is open and its tab is in view, at once when the tab comes back, and
 * after Try it sends one. A read that fails is never "no calls": the last list stays, and says it
 * could not be refreshed.
 *
 * A timed refresh waits for a read still under way rather than throwing it away (reads slower than
 * ten seconds would otherwise never land); another page size, a call sent or Refresh starts a read
 * of its own, and only the newest read started is shown.
 */
function RecentCalls({ appId, sent }: { appId: string; sent: number }) {
  const [limit, setLimit] = useState<number>(CALL_PAGES[0]);
  const [list, setList] = useState<NativeCallList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(0);
  const readingSince = useRef<number | null>(null);
  const read = useCallback((force: boolean) => {
    const since = readingSince.current;
    if (!force && since !== null && Date.now() - since < READ_GIVEN_UP_MS) return;
    const seq = ++latest.current;
    readingSince.current = Date.now();
    void api.getNativeCalls(appId, limit).then(result => {
      if (seq !== latest.current) return;
      readingSince.current = null;
      if (result.error || !result.data || !Array.isArray(result.data.calls)) { setFailed(result.error || 'The server did not answer.'); return; }
      setFailed(null);
      setList(result.data);
    });
  }, [appId, limit]);
  const again = useCallback(() => read(true), [read]);
  useEffect(() => {
    read(true);
    // A call Try it sent may be written just after its answer (PHP-FPM): asked for again a moment later too.
    if (sent === 0) return;
    const later = window.setTimeout(() => read(true), SENT_READ_AGAIN_MS);
    return () => window.clearTimeout(later);
  }, [read, sent]);
  // Gone from the page: a read still under way is not shown.
  useEffect(() => () => { latest.current = -1; }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) read(false); }, CALLS_EVERY_SECONDS * 1000);
    const back = () => { if (!document.hidden) read(false); };
    document.addEventListener('visibilitychange', back);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', back); };
  }, [read]);

  const refresh = <button type="button" onClick={again} aria-label="Refresh the calls" title="Refresh"
    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 max-sm:h-11 max-sm:w-11 dark:text-slate-400 dark:hover:bg-white/5">
    <RefreshCw className="h-4 w-4" aria-hidden="true" />
  </button>;
  return <Panel title="Recent calls" icon={<Activity className="h-4 w-4" />} actions={refresh}>
    {!list && failed && <LoadFailure compact title="The app’s calls could not be loaded" message={failed} onRetry={again} />}
    {!list && !failed && <p role="status" className="text-sm text-slate-500 dark:text-slate-400">Loading the calls…</p>}
    {list && <>
      {failed && <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-300">Could not refresh just now: these are the calls as they were.</p>}
      {list.calls.length === 0
        ? <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">No calls in the last {list.keep.days} days. They appear here as the app&rsquo;s pages use its backend, and as you try a route.</p>
        : <div className="@container/list min-w-0">
          <div className={LIST_BOX}>
            <table className={LIST_TABLE}>
              <caption className="sr-only">Recent calls</caption>
              <thead className={LIST_HEAD}>
                <tr>
                  <th scope="col" className={cn(LIST_TH, 'w-24 pl-3')}>When</th>
                  <th scope="col" className={LIST_TH}>Call</th>
                  <th scope="col" className={cn(LIST_TH, 'w-32')}>Answer</th>
                  <th scope="col" className={cn(LIST_TH, 'w-20 text-right')}>Took</th>
                  <th scope="col" className={cn(LIST_TH, 'w-24 pr-3')}>Who</th>
                </tr>
              </thead>
              <tbody className={LIST_BODY}>
                {list.calls.map(call => <tr key={call.id} className={cn(LIST_ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1')}>
                  <td className={cn(LIST_CELL, 'order-3 col-span-2 text-xs text-slate-500 dark:text-slate-400 @xl/list:pl-3 @xl/list:text-[13px]')}>
                    <time dateTime={call.at} title={formatAbsoluteTimeTitle(call.at)}>{formatRelativeTime(call.at)}</time>
                    <span className="@xl/list:hidden"> · {durationInWords(call.ms)} · {callerInWords(call.caller)}</span>
                  </td>
                  <th scope="row" className={cn(LIST_CELL, 'order-1 font-normal')}>
                    <span className="flex min-w-0 items-center gap-2">
                      <MethodTag method={call.method} />
                      {call.path
                        ? <span className="min-w-0 break-all font-mono text-[12px] text-slate-900 dark:text-white @xl/list:truncate">{call.path}</span>
                        : <span className="min-w-0 text-[13px] italic text-slate-500 dark:text-slate-400" title="Someone other than you asked for an address the app does not have. What they sent is not kept.">An address the app does not have</span>}
                    </span>
                    {call.error && <span className="mt-0.5 block break-words text-xs leading-5 text-slate-600 dark:text-slate-300 @xl/list:truncate" title={call.error}>{call.error}</span>}
                  </th>
                  <td className={cn(LIST_CELL, 'order-2 justify-self-end @xl/list:justify-self-auto')}><StatusPill status={call.status} /></td>
                  <td className={cn(LIST_CELL, 'hidden tabular-nums text-slate-600 dark:text-slate-300 @xl/list:table-cell @xl/list:text-right')}>{durationInWords(call.ms)}</td>
                  <td className={cn(LIST_CELL, 'hidden text-slate-600 dark:text-slate-300 @xl/list:table-cell @xl/list:pr-3')}>{callerInWords(call.caller)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className={HELP}>The newest {list.keep.calls} calls of the last {list.keep.days} days are kept: when each came, its answer, how long it took and who made it. Never its body, query or headers. A failed call keeps the first words of the error the app answered with, which can repeat what was sent.</p>
        {list.calls.length >= list.limit && list.limit < list.keep.calls && <Button size="sm" variant="outline"
          onClick={() => setLimit(CALL_PAGES.find(page => page > list.limit) ?? list.keep.calls)}>Show more</Button>}
      </div>
    </>}
  </Panel>;
}

export default SoftnApi;
