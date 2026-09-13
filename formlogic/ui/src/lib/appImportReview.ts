import { unzipSync, strFromU8 } from 'fflate';

export interface AppImportReview {
  name: string;
  root: string;
  fileCount: number;
  expandedBytes: number;
  assets: number;
  backend: 'native' | 'actions' | 'client';
  routes: number;
  migrations: number;
  capabilities: string[];
  blockers: string[];
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const textExtensions = /\.(ui|logic|json)$/i;
const metadata = /^(README|LICENSE|NOTICE)(\.|$)/i;
const privatePath = /^(server|backend|private)\//i;

/** Inspect only; never execute app source, strip a private backend, or mutate a draft. */
export function reviewAppArchive(bytes: Uint8Array): { review: AppImportReview; files: Record<string, Uint8Array> } {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('Choose an archive under 32 MB for import review.');
  let size = 0;
  let count = 0;
  const paths = new Set<string>();
  const archive = unzipSync(bytes, { filter(entry) {
    size += entry.originalSize;
    if (++count > 500 || size > 64 * 1024 * 1024) throw new Error('This archive exceeds the review limit (64 MB expanded / 500 entries).');
    const path = entry.name;
    if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) throw new Error('The archive contains an invalid file path.');
    if (paths.has(path)) throw new Error('The archive contains duplicate file paths.');
    paths.add(path);
    return !path.endsWith('/');
  } });
  const candidates = Object.keys(archive).filter(path => /(^|\/)manifest\.json$/.test(path)).flatMap(path => {
    if (archive[path].length > 200000) return [];
    try {
      const manifest = object(JSON.parse(strFromU8(archive[path])));
      const root = path.slice(0, -'manifest.json'.length);
      return typeof manifest.main === 'string' && /\.ui$/.test(manifest.main) && archive[root + manifest.main] ? [{ manifest, root }] : [];
    } catch { return []; }
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? 'This archive contains several apps. Export one .softn app to import.' : 'No app manifest with an included .ui entry was found.');
  const { manifest, root } = candidates[0];
  const files = Object.fromEntries(Object.entries(archive).filter(([path]) => path.startsWith(root)).map(([path, data]) => [path.slice(root.length), data]));
  const names = Object.keys(files);
  const server = object(manifest.server);
  const requirements = object(server.requires);
  const native = Object.keys(server).length > 0 || names.some(path => privatePath.test(path));
  const assets = names.filter(path => !textExtensions.test(path) && !metadata.test(path) && !privatePath.test(path));
  const expandedBytes = Object.values(files).reduce((sum, value) => sum + value.length, 0);
  let permissions: Record<string, unknown> = {};
  try { permissions = object(object(JSON.parse(strFromU8(files['permission.json'] ?? new Uint8Array()))).permissions); } catch { /* backend validation reports malformed source if imported */ }
  const enabledPermissions = Object.entries(permissions).filter(([, value]) => value === true || object(value).enabled === true).map(([name]) => name);
  const blockers: string[] = [];
  if (native) blockers.push('This app uses a native private backend. Use Native app hosting in Hosting & app tools to preserve its routes, application sign-in and SQLite migrations. This editor accepts named FormLogic backend actions.');
  if (assets.length) blockers.push(`${assets.length} media or other asset files need asset hosting. The current host accepts .ui, .logic and .json client files.`);
  if (enabledPermissions.length) blockers.push(`The app requests ${enabledPermissions.join(', ')} access. The current hosted runtime grants only its FormLogic backend bridge; these permissions need an explicit host integration.`);
  if (expandedBytes > 2 * 1024 * 1024 || names.length > 100 || names.some(path => textExtensions.test(path) && files[path].length > 200000)) blockers.push('This app exceeds the current hosting limits (2 MB total, 100 files, 200 KB per text file).');
  return { files, review: {
    name: typeof manifest.name === 'string' ? manifest.name.slice(0, 120) : 'Imported app', root, fileCount: names.length, expandedBytes,
    assets: assets.length, backend: native ? 'native' : 'client', routes: list(server.routes).length,
    migrations: list(object(server.database).migrations).length,
    capabilities: list(requirements.capabilities).filter((value): value is string => typeof value === 'string'), blockers,
  } };
}
