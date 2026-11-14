// The API section of an app's page (components/apps/SoftnApi), in words and checks: the routes the
// installed app's manifest declares (its `server` block) read as the app host reads them, who may
// call each and what it does to the data, a request's query and body checked before it is sent,
// an answer made readable, and a recorded call (NativeAppCalls on the server) in words.

/** One route of an app's backend, as the app host serves it. */
export interface ApiRoute {
  method: string;
  path: string;
  /** The backend function it runs; null where none is named. */
  handler: string | null;
  /** What it may do to the app's data: the host runs a route undeclared as a read for GET and a write otherwise. */
  transaction: 'read' | 'write';
  /** Who it is for, as declared: `anonymous` and `application` are served here alike; `hosttoken` is not. */
  authorization: string;
  /** Why this server does not serve it, in words, or null. */
  unserved: string | null;
  /**
   * Under /api/site/: the site's own to call (App AI's answers, a camera check), never a page's or
   * Try it's. The server refuses any other caller (PluginService::SITE_ROUTE_PREFIX).
   */
  siteOnly: boolean;
}

/** The addresses only the site calls (PluginService::SITE_ROUTE_PREFIX), matched as the server matches them. */
export const SITE_ROUTE_PREFIX = '/api/site/';

/** The backend of an installed app: its routes, in the manifest's order, and its database changes, in the order they run. */
export interface ApiDescription {
  routes: ApiRoute[];
  migrations: string[];
  /** The backend keeps a database of its own (`server.database`). */
  database: boolean;
}

/**
 * One call of the app's backend, as the server recorded it: never its body, query or headers.
 * A failed call's `error` is the app's own words, which can repeat what the call sent.
 */
export interface NativeCall {
  id: number;
  at: string;
  method: string;
  /** Empty for a call from someone other than the owner to an address the app does not have: what they sent is not kept. */
  path: string;
  status: number;
  /** How long the answer took, in milliseconds, from the call's arrival. */
  ms: number;
  /** The first words of what a failed call said; null for one that did not fail. */
  error: string | null;
  caller: 'owner' | 'member' | 'visitor';
}
export interface NativeCallList {
  calls: NativeCall[];
  limit: number;
  /** What the server keeps of each app: its newest `calls` of the last `days` days. */
  keep: { calls: number; days: number };
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The backend a manifest.json declares, or null where it declares none (no `server` block, or the
 * text is not a manifest). A route's transaction and authorization are read as softn-runner reads
 * them, and a route it would not serve says why.
 */
export function apiOf(manifestText: string | undefined | null): ApiDescription | null {
  let manifest: Record<string, unknown> | null;
  try { manifest = record(JSON.parse(manifestText ?? '')); } catch { return null; }
  const server = record(manifest?.server);
  if (!server) return null;
  const routes: ApiRoute[] = [];
  for (const entry of Array.isArray(server.routes) ? server.routes : []) {
    const route = record(entry);
    if (!route || typeof route.path !== 'string' || typeof route.method !== 'string') continue;
    const method = route.method;
    const declared = typeof route.transaction === 'string' ? route.transaction : null;
    const transaction = declared === 'read' || declared === 'write' ? declared : method === 'GET' ? 'read' : 'write';
    const authorization = typeof route.authorization === 'string' ? (route.authorization === 'host-token' ? 'hosttoken' : route.authorization) : 'application';
    const unserved = !/^\/api\/[A-Za-z0-9/_-]+$/.test(route.path)
      ? 'This server routes addresses under /api/ made of letters, digits, hyphens, underscores and slashes.'
      : !METHODS.includes(method)
        ? 'This server takes GET, POST, PUT and DELETE only.'
        : authorization === 'hosttoken'
          ? 'It asks for a host key, which this server does not hold.'
          : null;
    const siteOnly = route.path.toLowerCase().startsWith(SITE_ROUTE_PREFIX);
    routes.push({ method, path: route.path, handler: typeof route.handler === 'string' && route.handler !== '' ? route.handler : null, transaction, authorization, unserved, siteOnly });
  }
  const database = record(server.database);
  const migrations = Array.isArray(database?.migrations) ? database.migrations.filter((path): path is string => typeof path === 'string') : [];
  return { routes, migrations, database: database !== null };
}

/** The key a route is chosen by in Try it: its method and its address. */
export const routeKey = (route: Pick<ApiRoute, 'method' | 'path'>) => `${route.method} ${route.path}`;

/** Whether calling the route can change the live app's data, so its owner is asked first. */
export const routeWrites = (route: Pick<ApiRoute, 'method' | 'transaction'>) => route.transaction === 'write' || route.method !== 'GET';

/**
 * Who may call a route, in the words the app's Settings use for who can use it: whoever can open
 * the app reaches its backend, and the route's own code decides what each of them may do.
 */
export function whoMayCall(route: Pick<ApiRoute, 'unserved' | 'siteOnly'>, access: 'members' | 'application' | undefined, published = true): string {
  if (route.unserved) return 'No one here';
  if (route.siteOnly) return 'This site only';
  // (an app not published yet is opened by its owner alone, whoever it is for: AppService::isRuntimeVisible)
  if (!published) return 'Only you, until it is published';
  return access === 'application' ? 'Anyone with the link' : 'Only people you invite';
}

/** Whether Try it can send a route: one this server serves, and not the site's own. */
export const triable = (route: Pick<ApiRoute, 'unserved' | 'siteOnly'>) => !route.unserved && !route.siteOnly;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The largest body the app takes (NativeAppService: 2 MB a request), counted as the page sends it. */
export const BODY_LIMIT = 2 * 1024 * 1024;

const parseDetail = (reason: unknown) => (reason instanceof Error && reason.message ? `: ${reason.message}` : '.');

/**
 * A query as Try it sends it: what an address carries after its `?`, names and text values. Empty
 * is none. Numbers and true or false are sent as the text an address would carry.
 */
export function checkQuery(text: string): Checked<Record<string, string>> {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (reason) { return { ok: false, error: `The query is not valid JSON${parseDetail(reason)}` }; }
  const query = record(parsed);
  if (!query) return { ok: false, error: 'The query is a JSON object of names and values, such as {"page": "2"}.' };
  const value: Record<string, string> = {};
  for (const [name, item] of Object.entries(query)) {
    if (typeof item === 'string') value[name] = item;
    else if ((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean') value[name] = String(item);
    else return { ok: false, error: `In the query, "${name}" is not text or a number: an address cannot carry a list or an object.` };
  }
  return { ok: true, value };
}

/** A body as Try it sends it: a JSON object or list, as the app's own page sends one. Empty is an empty object. */
export function checkBody(text: string): Checked<Record<string, unknown> | unknown[]> {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (reason) { return { ok: false, error: `The body is not valid JSON${parseDetail(reason)}` }; }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, error: 'The body is a JSON object or list, such as {"title": "Buy milk"}.' };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > BODY_LIMIT) return { ok: false, error: 'The body is larger than the 2 MB the app takes in one call.' };
  return { ok: true, value: parsed as Record<string, unknown> | unknown[] };
}

/** How much of an answer is shown: more is cut, and said to be. */
export const ANSWER_SHOWN = 200_000;

/** An answer as it is shown: JSON laid out to read, text as it came, and whether it was cut. */
export function answerText(body: unknown): { text: string; json: boolean; cut: boolean } {
  let text: string;
  let json = true;
  if (typeof body === 'string') {
    try { text = JSON.stringify(JSON.parse(body), null, 2); } catch { text = body; json = false; }
  } else if (body === undefined) {
    text = ''; json = false;
  } else {
    text = JSON.stringify(body, null, 2) ?? '';
  }
  return text.length > ANSWER_SHOWN ? { text: text.slice(0, ANSWER_SHOWN), json, cut: true } : { text, json, cut: false };
}

/** A status in a word or two, as a person reads it; empty where there is no common one. */
export function statusInWords(status: number): string {
  const words: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 301: 'Moved', 302: 'Moved', 304: 'Not changed',
    400: 'Not understood', 401: 'Not signed in', 402: 'Plan needed', 403: 'Refused', 404: 'Not found', 405: 'Not allowed', 409: 'Conflict',
    413: 'Too large', 422: 'Not accepted', 429: 'Too many calls', 500: 'Server error', 501: 'Not available', 502: 'Unavailable', 503: 'Unavailable', 504: 'Took too long',
  };
  return words[status] ?? '';
}

/** How a status looks: a success, a redirect, a refusal of the call, or a failure of the server. */
export function statusTone(status: number): 'ok' | 'redirect' | 'refused' | 'failed' {
  return status < 300 ? 'ok' : status < 400 ? 'redirect' : status < 500 ? 'refused' : 'failed';
}

/** A time taken, as a person reads it: milliseconds under a second, seconds above. */
export function durationInWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Who made a call, as its owner reads it. */
export function callerInWords(caller: NativeCall['caller']): string {
  return caller === 'owner' ? 'You' : caller === 'member' ? 'A member' : 'A visitor';
}
