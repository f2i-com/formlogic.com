// The API section of an app's own page, for SoftN and JavaScript apps with a backend alike: the
// routes of the app as it is live (its installed manifest's `server` block), each with what it runs,
// who may call it and what it does to the data; the database changes it has run; Try it, which
// sends one call as the owner to the live app (POST /api/app/{slug}/native/request, as the app's own
// page does) and shows what came back; and the app's latest calls, as the server recorded them
// (NativeAppCalls), asked for again every ten seconds while the section is open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Database, RefreshCw, Route, Send } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadFailure } from '../ui/LoadFailure';
import { Panel } from '../ui/Panel';
import { HELP, LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH, ROW_BOX } from '../ui/listLook';
import { formatAbsoluteTimeTitle, formatRelativeTime } from '../flows/relativeTime';
import { api } from '../../lib/api';
import {
  answerText, apiOf, callerInWords, checkBody, checkQuery, durationInWords, routeKey, routeWrites, statusInWords, statusTone, triable, whoMayCall,
  type ApiRoute, type NativeCallList,
} from '../../lib/appApi';
import { databaseChangeName } from '../../lib/nativeVersions';
import { cn } from '../../lib/utils';
import type { App } from '../../types/app';

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

export function SoftnApi({ app, access, manifest, version, dirty, readOnly }: {
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
}) {
  const described = useMemo(() => apiOf(manifest), [manifest]);
  const served = useMemo(() => (described?.routes ?? []).filter(triable), [described]);
  // The route Try it has chosen (by its method and address), and the calls asked for again once it has sent one.
  const [chosen, setChosen] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  // A row's Try it: the form below, scrolled to and given the keyboard (its route chosen).
  const tryRoute = (route: ApiRoute) => {
    setChosen(routeKey(route));
    window.setTimeout(() => {
      document.getElementById('api-try')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      document.getElementById('api-try-route')?.focus({ preventScroll: true });
    }, 30);
  };

  return <div className="mt-4" data-testid="softn-api">
    <p className="mb-4 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
      The app&rsquo;s pages read and save their data through these addresses. Each one runs a function of its backend, here on the server. Try one as yourself, and see the calls the app has had lately.
    </p>
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
              : <p className="text-sm text-slate-600 dark:text-slate-300">{described.database ? 'Its database has no changes listed yet.' : 'Its backend keeps no database of its own.'}</p>}
          </Panel>
        </div>

        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <Panel id="api-try" title="Try it" icon={<Send className="h-4 w-4" />}>
            {readOnly
              ? <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">This is the shared demo: its apps&rsquo; backends do not run here, so nothing can be sent.</p>
              : served.length === 0
                ? <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">The app has no route this server can call.</p>
                : <TryIt app={app} routes={served} chosen={chosen} onChoose={setChosen} onSent={() => setSent(n => n + 1)} />}
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

/**
 * One call to the live app, as its owner: a route, its query and its body, each checked before it
 * is sent. A route that can change the app's data asks first. What came back is shown as it came:
 * its status, the time it took, and the answer, laid out to read where it is JSON.
 */
function TryIt({ app, routes, chosen, onChoose, onSent }: { app: App; routes: ApiRoute[]; chosen: string | null; onChoose(key: string): void; onSent(): void }) {
  const route = routes.find(candidate => routeKey(candidate) === chosen) ?? routes[0];
  const key = routeKey(route);
  // What was typed for each route, kept while the section is open.
  const [texts, setTexts] = useState<Record<string, { query: string; body: string }>>({});
  const text = texts[key] ?? { query: '', body: '' };
  const type = (part: 'query' | 'body', value: string) => setTexts(all => ({ ...all, [key]: { ...(all[key] ?? { query: '', body: '' }), [part]: value } }));
  // What was wrong belongs to the route it was found in: another route, however it was chosen (the list here, or a
  // row's Try it), has none of it.
  const [problemOf, setProblemOf] = useState<{ key: string; part: 'query' | 'body'; message: string } | null>(null);
  const problem = problemOf?.key === key ? problemOf : null;
  const setProblem = (found: { part: 'query' | 'body'; message: string } | null) => setProblemOf(found && { key, ...found });
  const [asking, setAsking] = useState<{ query: Record<string, string>; body: unknown } | null>(null);
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const hasBody = route.method !== 'GET';
  const writes = routeWrites(route);

  const checked = (): { query: Record<string, string>; body: unknown } | null => {
    const query = checkQuery(text.query);
    if (!query.ok) { setProblem({ part: 'query', message: query.error }); return null; }
    const body = hasBody ? checkBody(text.body) : { ok: true as const, value: {} };
    if (!body.ok) { setProblem({ part: 'body', message: body.error }); return null; }
    setProblem(null);
    return { query: query.value, body: body.value };
  };

  const send = async (ready: { query: Record<string, string>; body: unknown }) => {
    setSending(true);
    const started = performance.now();
    const result = await api.runNativeRequest(app.slug, { path: route.path, method: route.method, query: ready.query, headers: {}, body: ready.body });
    const took = performance.now() - started;
    setSending(false);
    setAsking(null);
    const answered = result.data?.result;
    if (answered && typeof answered.status === 'number') setAnswer({ route: key, status: answered.status, body: answered.body, took });
    else if (result.transportFailure) setAnswer({ route: key, status: 0, took, error: 'The call could not be sent. Check your connection and try again.' });
    else setAnswer({ route: key, status: result.status ?? 0, took, error: result.error || 'The server did not answer.' });
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
    <label htmlFor="api-try-route" className="text-xs font-medium text-slate-600 dark:text-slate-300">Route</label>
    <select id="api-try-route" value={key} onChange={event => { onChoose(event.target.value); setProblem(null); }}
      className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 font-mono text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
      {routes.map(option => <option key={routeKey(option)} value={routeKey(option)}>{routeKey(option)}</option>)}
    </select>

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
      message={`${route.method} ${route.path} can change ${app.name}’s data. It runs on the live app, as you, and what it changes stays changed: anyone using the app sees it.`} />}
  </div>;
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
