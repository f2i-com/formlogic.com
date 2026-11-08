// An API backend for a hosted SoftN app that has none: its own routes and database on this server,
// which its page calls with softn.net.fetch. Two ways to add one:
//  - the starter's backend (one table, a GET and a POST route), the one a new app starts with
//    (backend/resources/native-app-starter.json; softnBackend.test.ts holds them equal);
//  - the backend of another file of the same app: an app built in two halves (Coffee.Dating's
//    public page and its private backend) is put back together, its page kept as it is.
// Either is merged into the app's project and installed as its next version, as any change is.
import { backendProblem, NATIVE_LIMITS, type NativeProject } from './nativeHosting';

/** What makes a backend: the manifest's server block, the configuration it reads, its files, and the app it belongs to. */
export interface SoftnBackend {
  server: Record<string, unknown>;
  /** manifest.config.server (the origins the page calls its backend at, its body limit) and .app (what the backend reads as softn.config). */
  config: { server?: Record<string, unknown>; app?: Record<string, unknown> };
  /** server/: the entry, the migrations and what the entry reads. Never the old host's private/ (its key) or anything else. */
  files: Record<string, string>;
  /** The app's id (manifest.id) where the file names one: the identity its data and key were kept under. */
  id?: string;
}

/** Where the starter's page calls its backend: an address the host routes to the app's own backend. */
export const STARTER_ORIGIN = 'https://app.example';

export const STARTER_BACKEND: SoftnBackend = Object.freeze({
  server: {
    entry: 'server/main.logic',
    requires: { apiVersion: 1, capabilities: ['sql'] },
    database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
    routes: [
      { path: '/api/items', method: 'POST', handler: 'createItem', transaction: 'write', authorization: 'anonymous' },
      { path: '/api/items', method: 'GET', handler: 'listItems', transaction: 'read', authorization: 'anonymous' },
    ],
  },
  config: { server: { allowedOrigins: [STARTER_ORIGIN] } },
  files: {
    'server/main.logic': 'function createItem(req) {\n  let title = req.body.title;\n  if (typeof title != "string" || title.length == 0 || title.length > 200) return {status:422,body:{error:"Provide a title of 1 to 200 characters"}};\n  softn.sql.execute("INSERT INTO items(title) VALUES(?)",[title]);\n  return {status:201,body:softn.sql.first("SELECT id,title FROM items ORDER BY id DESC LIMIT 1",[])};\n}\nfunction listItems(req) {\n  return {status:200,body:{items:softn.sql.query("SELECT id,title FROM items ORDER BY id DESC LIMIT 50",[])}};\n}',
    'server/migrations/001.sql': 'CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT NOT NULL);',
  },
});

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function manifestOf(project: NativeProject): Record<string, unknown> {
  try { return record(JSON.parse(project.files['manifest.json'] ?? '{}')) ?? {}; } catch { return {}; }
}

/** The backend a project carries, or null when it has none (no server block). */
export function backendOf(project: NativeProject): SoftnBackend | null {
  const manifest = manifestOf(project);
  const server = record(manifest.server);
  if (!server) return null;
  const config = record(manifest.config) ?? {};
  // server/ alone, where the entry and its migrations have to be (backendProblem): a full bundle
  // from SoftN's own hosting may hold private/config.json, the key its data was sealed with, which
  // would otherwise be kept as source, downloaded with the app and shown to AI Studio.
  const files: Record<string, string> = {};
  for (const [path, source] of Object.entries(project.files)) if (/^server\//i.test(path)) files[path] = source;
  return {
    server,
    config: { ...(record(config.server) ? { server: record(config.server)! } : {}), ...(record(config.app) ? { app: record(config.app)! } : {}) },
    files,
    ...(typeof manifest.id === 'string' && manifest.id ? { id: manifest.id } : {}),
  };
}

/** The bytes a project keeps: its sources as UTF-8, its media decoded from base64. */
function projectBytes(project: NativeProject, files: Record<string, string>): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const source of Object.values(files)) total += encoder.encode(source).length;
  for (const media of Object.values(project.assets ?? {})) total += Math.floor(media.length * 3 / 4);
  return total;
}

/**
 * $project with $backend added: its server block and files, the origins its page calls them at
 * added to the page's own, and the settings the backend reads where the page set none. The page,
 * its media and everything else stay as they are; the app keeps the page's id, or takes the
 * backend's where the page names none. Throws when the project already has a backend, when the
 * two name different apps, or when the result is not one this host would keep or run (the reason
 * named), so nothing is created or installed from it.
 */
export function withBackend(project: NativeProject, backend: SoftnBackend): NativeProject {
  const manifest = manifestOf(project);
  if ('server' in manifest) throw new Error('This app already has a backend. Change it in the source editor, or upload a new version of the whole app.');
  const pageId = typeof manifest.id === 'string' && manifest.id ? manifest.id : null;
  if (pageId && backend.id && pageId !== backend.id) {
    throw new Error(`That file is another app's backend: this page is ${pageId}, and the file is ${backend.id}. Choose the full file of the same app.`);
  }
  const config = { ...(record(manifest.config) ?? {}) };
  const pageServer = record(config.server) ?? {};
  const origins = [...new Set([
    ...(Array.isArray(pageServer.allowedOrigins) ? pageServer.allowedOrigins : []),
    ...(Array.isArray(backend.config.server?.allowedOrigins) ? backend.config.server!.allowedOrigins as unknown[] : []),
  ].filter((origin): origin is string => typeof origin === 'string'))];
  const server = { ...(backend.config.server ?? {}), ...pageServer, ...(origins.length ? { allowedOrigins: origins } : {}) };
  if (Object.keys(server).length) config.server = server;
  const app = { ...(backend.config.app ?? {}), ...(record(config.app) ?? {}) };
  if (Object.keys(app).length) config.app = app;
  const next: Record<string, unknown> = {
    ...(!pageId && backend.id ? { id: backend.id } : {}),
    ...manifest,
    ...(Object.keys(config).length ? { config } : {}),
    server: backend.server,
  };
  // The backend's id where the page names none, even as an empty or null `id` of its own.
  if (!pageId && backend.id) next.id = backend.id;
  const files = { ...project.files, ...backend.files, 'manifest.json': JSON.stringify(next, null, 2) };
  const sources = Object.keys(files).length;
  if (sources > NATIVE_LIMITS.sourceFiles) throw new Error(`With its backend this app would have ${sources} source files; this host keeps up to ${NATIVE_LIMITS.sourceFiles}.`);
  const total = projectBytes(project, files);
  if (total > NATIVE_LIMITS.projectBytes) throw new Error(`With its backend this app would be ${(total / 1024 / 1024).toFixed(1)} MB; this host keeps apps up to ${NATIVE_LIMITS.projectBytes / 1024 / 1024} MB.`);
  const problem = backendProblem(next, files);
  if (problem) throw new Error(problem);
  return { ...project, files };
}

/** Where a project's page calls its backend: the first origin its manifest names for it, or null. */
export function backendOrigin(project: NativeProject): string | null {
  const origins = record(record(manifestOf(project).config)?.server)?.allowedOrigins;
  return Array.isArray(origins) && typeof origins[0] === 'string' ? origins[0] : null;
}
