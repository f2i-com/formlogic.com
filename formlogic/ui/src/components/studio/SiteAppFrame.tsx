// A hosted JavaScript app, running: someone's compiled front end, which the SERVER sends from an
// address of its own under a sandbox policy (SiteAppController), shown here in a frame. Unlike a
// SoftN app (HostedAppFrame) this page hands the frame no files: the frame loads its own. What the
// app needs of this page it asks over a private line, opened by the script the server puts first
// in every page of the app (backend/resources/site-boot.js, the other half of what is here):
//   - requests to the app's own backend, which this page makes as whoever is signed in;
//   - what the app keeps in localStorage, which this page keeps for this app and person;
//   - what the browser refused the app, and errors in it, for its owner to be shown.
// Nothing the frame says is trusted: every request is checked here, and again by the server.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../../lib/api';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import type { NativeLook } from '../../lib/appLook';
import { NATIVE_IN_FLIGHT_RETRY_SECONDS, nativeTooManyRequests } from '../../lib/nativeRefusal';
import { currentSessionGeneration, isSessionGenerationCurrent, subscribeSessionGeneration } from '../../lib/sessionGeneration';
import { AppSplash } from './AppSplash';

/**
 * What the browser refused the app (`blocked`), an error in it, or something about how it is built
 * that its owner should know (`note`). `text` is the app's own words where it is an error: shown
 * as text, never as markup.
 */
export type SiteProblem = { kind: 'blocked' | 'error' | 'note'; text: string };

export interface SiteAppFrameProps {
  slug: string;
  /**
   * The app itself, whatever its address is called (the descriptor's storageScope.appId). What
   * the app keeps in this browser is kept under it: an address name can be given up and taken
   * by another app, which must not be handed what the first one kept.
   */
  appId: string;
  name: string;
  version: number;
  /** From the runtime descriptor: the address the frame loads, and the proof its page shows to be given its line. */
  site: { url: string; entry: string; proof: string };
  /** Addresses the app's manifest names as its backend (the descriptor's `origins`). */
  backendOrigins?: readonly string[];
  /** The signed-in person's id, or null. */
  userId: string | null;
  /** What the browser refused the app, or an error in it: for the app's owner to be shown. Each is told once. */
  onProblem?: (problem: SiteProblem) => void;
  /**
   * Where in the app to start, when whoever shows it knows (the address the visitor opened names
   * a place in the app): a path of the app's own, from its root. Read once, as the frame opens;
   * without it the app starts where this tab last had it, else at its first page.
   */
  initialRoute?: string | null;
  /** The app says where the visitor now is (a path of its own, from its root), for the page's address to follow. */
  onRoute?: (path: string) => void;
  /**
   * The frame no longer holds the app and loading its address once more did not bring it back: the
   * address may be out of date (it is good for a day or two), so whoever gave it asks for it again.
   */
  onLost?: () => void;
  /** The app's loading colours, where it has them (AppSplash). */
  look?: NativeLook | null;
  className?: string;
}

/** What an app may keep in this browser, as the JSON it is kept as. */
const STORAGE_LIMIT = 1024 * 1024;
const STORAGE_FULL = 'This app tried to keep more than 1 MB in this browser.';
/** The largest body an app sends its backend, as the text it came as. */
const BODY_LIMIT = 2 * 1024 * 1024;
const PATH_LIMIT = 2000;
/** Requests to the backend at once. More wait their turn, up to WAITING of them. */
const IN_FLIGHT = 6;
const WAITING = 100;
/** The server takes these and no others (NativeAppController). */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const API_PATH = /^\/api\/[a-zA-Z0-9/_-]+$/;
/** A request's path is read against an address that is nobody's: one that names another site ends up somewhere else, and is refused. */
const NOWHERE = 'https://app.invalid';
/** The only headers of the app's that reach its backend. */
const PASSED_HEADERS = ['authorization', 'idempotency-key'];
/** How many different problems one opening tells: an app that fails in a loop does not flood the page around it. */
const PROBLEMS = 50;
/** The splash goes after this long whatever happened, so what the frame shows instead of the app is never hidden for good. */
const UNCOVER_AFTER = 20_000;
/** How long a page that loaded in the frame has to show it is the app's, before the frame is taken to have lost the app. */
const LOST_AFTER = 2_500;
/**
 * A page that said hello this recently and has not answered since is taken to be busy starting
 * (a game setting itself up holds the page for seconds), and is given this long before the frame
 * is taken to have lost it.
 */
const STARTING_WITHIN = 15_000;
const LOST_AFTER_STARTING = 20_000;
/**
 * What an app keeps is written to this browser as it is set, up to this many times a second. An
 * app that saves in a loop past that is written every KEEP_EVERY instead, so it does not hold up
 * the page around it (each write is the whole of what the app keeps, and wakes every other tab).
 */
const KEEP_AT_ONCE = 20;
const KEEP_EVERY = 250;
/** Losses further apart than this are not counted together. */
const LOSSES_WITHIN = 60_000;
/** Where the app says the visitor is: a path of its own, from its root. */
const ROUTE = /^\/(?!\/)/;

type Answer = { status: number; headers: Record<string, string>; body: string };
type BackendInput = { path: string; query: Record<string, string>; method: string; headers: Record<string, string>; body: unknown };
/** One line to one page in the frame. A page that loads again says hello again and is given a new one. */
type Line = { port: MessagePort; open: boolean };
type Job = { from: Line; id: number; input: BackendInput };

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const refusal = (status: number, error: string): Answer => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error }) });

/** What was kept for this app and person: text by name. Anything else found there is left out. */
function readKept(key: string): Map<string, string> {
  const kept = new Map<string, string>();
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(key) ?? 'null'));
    for (const [name, value] of Object.entries(stored ?? {})) if (typeof value === 'string') kept.set(name, value);
  } catch { /* Nothing kept, or no storage to keep it in: the app starts with none. */ }
  return kept;
}

/**
 * A request as the app's page sent it, checked: what to ask the server, or the answer the app is
 * given instead. A refusal is an answer with a status, as a server would give it, so the app's own
 * error handling reads it.
 */
function checkRequest(payload: unknown): { input: BackendInput } | { refused: Answer } {
  const asked = record(payload) ?? {};
  const method = typeof asked.method === 'string' ? asked.method.toUpperCase() : '';
  if (!METHODS.includes(method)) return { refused: refusal(405, 'The app backend takes GET, POST, PUT and DELETE.') };
  let url: URL | null = null;
  if (typeof asked.path === 'string' && asked.path.length <= PATH_LIMIT) {
    try { url = new URL(asked.path, NOWHERE); } catch { /* Not an address at all. */ }
  }
  if (!url || url.origin !== NOWHERE || !API_PATH.test(url.pathname)) return { refused: refusal(404, 'The app backend has no such address.') };
  // GET and DELETE send no body. An empty one is none.
  let body: unknown = {};
  if (method !== 'GET' && method !== 'DELETE' && asked.body !== undefined && asked.body !== null && asked.body !== '') {
    if (typeof asked.body === 'string' && asked.body.length > BODY_LIMIT) return { refused: refusal(413, 'The app backend takes a body of up to 2 MB.') };
    let parsed: unknown = null;
    if (typeof asked.body === 'string') { try { parsed = JSON.parse(asked.body); } catch { /* Refused below. */ } }
    if (parsed === null || typeof parsed !== 'object') return { refused: refusal(415, 'The app backend takes a JSON body.') };
    body = parsed;
  }
  const headers: Record<string, string> = {};
  const sent = record(asked.headers) ?? {};
  for (const name of Object.keys(sent)) {
    const value = sent[name];
    if (PASSED_HEADERS.includes(name.toLowerCase()) && typeof value === 'string') headers[name.toLowerCase()] = value;
  }
  return { input: { path: url.pathname, query: Object.fromEntries(url.searchParams), method, headers, body } };
}

/** What the browser refused the app, as a sentence for its owner: `what` is the rule that refused it, `where` what was asked for. */
function blockedText(what: unknown, where: unknown): string {
  const rule = typeof what === 'string' ? what.trim().slice(0, 60) : '';
  const asked = typeof where === 'string' ? where.trim().slice(0, 300) : '';
  const address = /^(?:https?|wss?):\/\//i.test(asked) && !/^(?:form-action|base-uri|frame-ancestors)/.test(rule);
  if (!address) return `The browser stopped the app from using ${asked || 'something it asked for'}${rule ? ` (${rule})` : ''}.`;
  const doing = rule.startsWith('connect-src') ? 'reaching' : 'loading';
  let here = false;
  try { here = new URL(asked).origin === window.location.origin; } catch { /* Cut short: said as it came. */ }
  return here
    // The usual cause: a build that asks for /assets/… from its script or its styles.
    ? `The browser stopped the app from ${doing} ${asked} (a path that starts with / is this site's, not the app's: the app reaches its own files by relative paths).`
    : `The browser stopped the app from ${doing} ${asked}. A hosted app reaches another site only when its owner names it: Settings, Outside sites.`;
}

export function SiteAppFrame({ slug, appId, name, version, site, backendOrigins, userId, onProblem, onLost, initialRoute, onRoute, look, className = '' }: SiteAppFrameProps) {
  const { proof } = site;
  // The address comes under the API's own base, as every address this page is given does: joined
  // to wherever this installation's API is, which need not be where this page is.
  const url = resolveBackendApiUrl(site.url);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  // Bumped to load the app's address once more in a new frame, when the frame has lost the app.
  const [revival, setRevival] = useState(0);
  const losses = useRef({ opened: '', count: 0, at: 0 });
  // Everything a frame is opened for. Any of it changing loads the app afresh in a new frame: a
  // new version has a new address, and a frame opened for one person is never answered as another.
  const opened = JSON.stringify([slug, appId, userId, url, proof, generation]);
  const frameKey = `${opened}#${revival}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  // Read when a page in the frame says hello, not a reason to open the line again.
  const latest = useRef({ name, version, backendOrigins, onProblem, onLost, initialRoute, onRoute });
  useLayoutEffect(() => { latest.current = { name, version, backendOrigins, onProblem, onLost, initialRoute, onRoute }; }, [name, version, backendOrigins, onProblem, onLost, initialRoute, onRoute]);

  // A layout effect: listening before the browser can run anything else, so a hello is never
  // missed (a page says it once), and its cleanup shuts the line before another frame opens.
  useLayoutEffect(() => {
    const admitted = generation;
    let mounted = true;
    // Only while this frame is on screen, in the session it was opened in.
    const current = () => mounted && isSessionGenerationCurrent(admitted);
    const controller = new AbortController();
    const storageKey = `formlogic-site-storage:${appId}:${userId || 'anyone'}`;
    let kept = readKept(storageKey);
    // Where the visitor was in the app, kept for this tab: a frame opened afresh (a newer version,
    // this page loaded again, the app brought back) starts there, as a site loaded again would.
    const routeKey = `formlogic-site-route:${appId}`;
    const lastRoute = (): string | null => {
      try { const was = window.sessionStorage.getItem(routeKey); return was && was.length <= PATH_LIMIT && ROUTE.test(was) ? was : null; } catch { return null; }
    };
    let greeted = 0;
    let helloAt = 0;
    let pings = 0;
    let ponged = 0;
    let checking = 0;
    let line: Line | null = null;
    let inFlight = 0;
    const waiting: Job[] = [];
    const told = new Set<string>();

    const tell = (kind: SiteProblem['kind'], said: string) => {
      const text = said.trim().slice(0, 600);
      const once = `${kind}:${text}`;
      if (!text || told.has(once) || told.size >= PROBLEMS) return;
      told.add(once);
      latest.current.onProblem?.({ kind, text });
    };

    // ── Storage ────────────────────────────────────────────────────────────────────────────────
    // `held`: the change may grow what is kept, so it is held to the limit. One that would pass
    // it is dropped, and what was there stays.
    const keep = (next: Map<string, string>, held: boolean) => {
      if (next.size === 0) {
        kept = next;
        window.clearTimeout(writing);
        writing = 0;
        try { window.localStorage.removeItem(storageKey); } catch { /* Nothing was kept there. */ }
        return;
      }
      const now = Date.now();
      if (now - burst.since > 1000) burst = { since: now, count: 0 };
      if (++burst.count <= KEEP_AT_ONCE && !writing) {
        const json = JSON.stringify(Object.fromEntries(next));
        if (held && json.length > STORAGE_LIMIT) { tell('error', STORAGE_FULL); return; }
        kept = next;
        try { window.localStorage.setItem(storageKey, json); } catch { /* Kept for this visit only. */ }
        return;
      }
      // Saving in a loop: measured roughly here (each name and value, and what JSON puts round
      // them), and written a moment later, once for however many changes came in that moment.
      if (held && [...next].reduce((size, [name, value]) => size + name.length + value.length + 6, 2) > STORAGE_LIMIT) { tell('error', STORAGE_FULL); return; }
      kept = next;
      if (!writing) writing = window.setTimeout(write, KEEP_EVERY);
    };
    let burst = { since: 0, count: 0 };
    let writing = 0;
    const write = () => {
      writing = 0;
      const json = JSON.stringify(Object.fromEntries(kept));
      if (json.length > STORAGE_LIMIT) { tell('error', STORAGE_FULL); return; }
      try { window.localStorage.setItem(storageKey, json); } catch { /* Kept for this visit only. */ }
    };
    // The same app open in another tab keeps things too: what it wrote is not written over from here.
    const otherTab = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) kept = readKept(storageKey); };

    // ── The app's backend ──────────────────────────────────────────────────────────────────────
    const answer = (to: Line, message: unknown) => {
      if (!to.open || !current()) return;
      try { to.port.postMessage(message); } catch { /* An answer that cannot be sent has nobody waiting for it. */ }
    };
    const runWaiting = () => {
      while (current() && inFlight < IN_FLIGHT && waiting.length) {
        const job = waiting.shift()!;
        // A page that has gone (the frame loaded again) is not asked for: nobody waits for the answer.
        if (job.from.open) void run(job);
      }
    };
    const run = async (job: Job) => {
      inFlight++;
      try {
        const result = await api.runNativeRequest(slug, job.input, controller.signal);
        const sent = result.data?.result;
        // The server's own refusal (not signed in, too many requests, no answer) is an answer with
        // its status too: the app's page reads it as it would read its backend's.
        const value: Answer = result.error || !sent || typeof sent.status !== 'number'
          ? refusal(result.status || 502, result.error || 'The app backend did not answer.')
          : { status: sent.status, headers: { 'content-type': 'application/json' }, body: typeof sent.body === 'string' ? sent.body : sent.body === undefined ? '' : JSON.stringify(sent.body) };
        answer(job.from, { id: job.id, ok: true, value });
      } catch (reason) {
        answer(job.from, { id: job.id, ok: false, error: reason instanceof Error ? reason.message : 'The request could not be made.' });
      } finally {
        inFlight--;
        runWaiting();
      }
    };

    // ── What a page in the frame says on its line ──────────────────────────────────────────────
    const hear = (from: Line, data: unknown) => {
      const message = record(data);
      if (!message) return;
      const payload = record(message.payload) ?? {};
      switch (message.kind) {
        case 'backend': {
          const id = message.id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return;
          const checked = checkRequest(message.payload);
          if ('refused' in checked) { answer(from, { id, ok: true, value: checked.refused }); return; }
          const job: Job = { from, id, input: checked.input };
          if (inFlight < IN_FLIGHT) { void run(job); return; }
          // It waits its turn. A line of them without end is told what a busy host says.
          if (waiting.length < WAITING) { waiting.push(job); return; }
          const busy = nativeTooManyRequests(NATIVE_IN_FLIGHT_RETRY_SECONDS);
          answer(from, { id, ok: true, value: { status: busy.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(busy.body) } });
          return;
        }
        case 'storage:set': {
          if (typeof payload.key === 'string' && typeof payload.value === 'string') keep(new Map(kept).set(payload.key, payload.value), true);
          return;
        }
        case 'storage:remove': {
          if (typeof payload.key !== 'string' || !kept.has(payload.key)) return;
          const without = new Map(kept);
          without.delete(payload.key);
          keep(without, false);
          return;
        }
        case 'storage:clear': keep(new Map(), false); return;
        case 'blocked': tell('blocked', blockedText(payload.what, payload.where)); return;
        case 'error': {
          if (typeof payload.message === 'string') tell('error', payload.message);
          // A page that failed before it was ready says why in the frame: it is not left covered.
          setShownKey(frameKey);
          return;
        }
        case 'ready': setShownKey(frameKey); return;
        case 'route': {
          if (typeof payload.path !== 'string' || payload.path.length > PATH_LIMIT || !ROUTE.test(payload.path)) return;
          try { window.sessionStorage.setItem(routeKey, payload.path); } catch { /* Not remembered. */ }
          latest.current.onRoute?.(payload.path);
          return;
        }
        case 'pong': { if (typeof payload.ping === 'number') ponged = Math.max(ponged, payload.ping); return; }
        case 'routing': {
          // The app changed its address's path, or tried to: it picks its screens from the path.
          // A built app's code no longer says so, so its owner is told when it is seen to happen.
          const to = typeof payload.path === 'string' && ROUTE.test(payload.path) ? payload.path.slice(0, 200) : 'another path';
          const cure = 'for Safari, use hash routing (createHashRouter / createWebHashHistory)';
          tell('note', payload.refused === true
            ? `This browser did not let the app change its address to ${to}, so the app stayed on the screen it was on. Safari, on Mac and iPhone, does this to a hosted app. An app that picks its screens from the address path works in Chrome, Edge and Firefox: ${cure}.`
            : `This app picks its screens from the address path (it went to ${to}). That works in this browser, as in Chrome, Edge and Firefox. Safari, on Mac and iPhone, does not let a hosted app change its path, so there it stays on its first screen: ${cure}.`);
          return;
        }
        default: return;
      }
    };
    const hangUp = (old: Line) => { old.open = false; old.port.onmessage = null; old.port.close(); };

    // ── Hello ──────────────────────────────────────────────────────────────────────────────────
    const receive = (event: MessageEvent) => {
      const inFrame = frame.current?.contentWindow;
      if (!current() || !inFrame || event.source !== inFrame) return;
      const hello = record(event.data);
      if (!hello || hello.type !== 'formlogic:site:hello') return;
      // The frame's window stays the same window whatever page is in it, and a sandboxed frame may
      // take itself anywhere: to a page the visitor followed a link to, or one that sends this
      // hello on purpose. Only the app's own page, as the server sent it, knows the proof, so only
      // it is given the app's line to its backend. No proof to compare with opens no line at all.
      if (typeof proof !== 'string' || !proof || hello.proof !== proof) return;
      // The page loaded again, or went to another of the app's pages: the line of the one before is shut.
      if (line) hangUp(line);
      const channel = new MessageChannel();
      const mine: Line = { port: channel.port1, open: true };
      line = mine;
      channel.port1.onmessage = (message: MessageEvent) => { if (mine.open && current()) hear(mine, message.data); };
      const app = latest.current;
      helloAt = Date.now();
      const context = {
        app: { name: app.name, slug, version: app.version },
        user: userId ? { id: userId } : null,
        backendOrigins: [...(app.backendOrigins ?? [])],
        storage: Object.fromEntries(kept),
        // Only the first page of a frame is told where the visitor was. A page the app went to
        // itself afterwards (its own link home) is where the app meant to go.
        route: greeted++ === 0 ? (typeof app.initialRoute === 'string' && app.initialRoute.length <= PATH_LIMIT && ROUTE.test(app.initialRoute) ? app.initialRoute : lastRoute()) : null,
      };
      // To '*': a sandboxed frame has no origin, so no origin named here would ever be its own.
      // Who gets the line was settled by the proof above.
      inFrame.postMessage({ type: 'formlogic:site:port', context }, '*', [channel.port2]);
    };

    // ── Whether the frame still holds the app ──────────────────────────────────────────────────
    // A sandboxed frame may take itself anywhere, and some of where it goes is not the app: the
    // app loading itself again (its address reads "/" to it, which is this site's own page and
    // refuses to be framed), an address that has run out, another site. This page cannot look
    // into the frame, so each time something loads there it asks the page it has a line to
    // whether it is still there. An answer, or a new hello, means the app is in the frame. Neither
    // means it is not, and the app's address is loaded once more; if that does not bring it
    // back, whoever gave the address is told (`onLost`). Then it is left as it is: no loop.
    const lost = () => {
      const now = Date.now();
      const seen = losses.current;
      if (seen.opened !== opened || now - seen.at > LOSSES_WITHIN) losses.current = { opened, count: 0, at: now };
      losses.current.count += 1;
      losses.current.at = now;
      if (losses.current.count === 1) setRevival(value => value + 1);
      else if (losses.current.count === 2) latest.current.onLost?.();
    };
    const loaded = () => {
      const at = Date.now();
      const ping = ++pings;
      if (line?.open) { try { line.port.postMessage({ ping }); } catch { /* Nobody there to answer. */ } }
      window.clearTimeout(checking);
      const check = (last: boolean) => {
        if (!current() || helloAt >= at || ponged >= ping) return;
        // No answer yet. From a page that has only just started, that is most often a busy page.
        if (!last && at - helloAt < STARTING_WITHIN) { checking = window.setTimeout(() => check(true), LOST_AFTER_STARTING - LOST_AFTER); return; }
        lost();
      };
      checking = window.setTimeout(() => check(false), LOST_AFTER);
    };
    const shown = frame.current;
    shown?.addEventListener('load', loaded);

    const uncover = window.setTimeout(() => { if (current()) setShownKey(frameKey); }, UNCOVER_AFTER);
    window.addEventListener('message', receive);
    window.addEventListener('storage', otherTab);
    return () => {
      mounted = false;
      window.clearTimeout(uncover);
      window.clearTimeout(checking);
      // What the app kept in its last moment is written before the frame goes.
      if (writing) { window.clearTimeout(writing); write(); }
      shown?.removeEventListener('load', loaded);
      window.removeEventListener('message', receive);
      window.removeEventListener('storage', otherTab);
      controller.abort();
      waiting.length = 0;
      if (line) hangUp(line);
    };
  }, [slug, appId, userId, url, proof, generation, opened, frameKey]);

  return (
    // White whatever this site's theme: a page that sets no background of its own is drawn on the
    // white a browser tab gives it, and most are written for that. One that sets its own covers it.
    <div className={`relative h-full w-full min-w-0 overflow-hidden bg-white ${className}`}>
      <iframe
        key={frameKey}
        ref={frame}
        src={url}
        title={name || 'Hosted app'}
        // The containment. The page is someone else's code, so the frame is given no origin: it
        // has none of this site's cookies, storage or DOM, and its requests carry no session.
        // NEVER add the same-origin token here: with it the app's page would be this site, signed
        // in as whoever is looking at it. And NEVER any top-navigation token: the app must not be
        // able to take the person's window somewhere else. The server sends the app's files under
        // a sandbox policy of its own (SecurityHeadersMiddleware::SITE_FRAME_SANDBOX) and the two
        // apply together, so the app's page may do only what both allow; this attribute is also
        // what holds anything else that ends up in the frame.
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock"
        referrerPolicy="no-referrer"
        className="absolute inset-0 h-full w-full border-0 bg-white"
      />
      {shownKey !== frameKey && <AppSplash look={look} label={name ? `Opening ${name}` : undefined} className="absolute inset-0" />}
    </div>
  );
}
