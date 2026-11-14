// JavaScript apps: a web app someone has already built (the dist or build folder of a Vite, React,
// Vue, Svelte… project), hosted as it is. It is kept in the project a SoftN app is kept in: the
// built files under site/ in `assets`, and a manifest.json whose `site` block names the first
// page. Here the .zip of a build becomes that project, and a new app is made from one.
import { strFromU8, unzipSync } from 'fflate';
import { api } from './api';
import { NATIVE_LIMITS, type NativeProject } from './nativeHosting';
import { useAppStore } from '../stores/appStore';
import type { App } from '../types/app';

/**
 * A built file a JavaScript app keeps, by path (the server holds uploads to the same rule,
 * NativeAppService::SITE_PATH): a web file under site/, in folders, named with letters, digits
 * and - _ . @ + ~. sitePathProblem holds a path to the rest: no two dots together, no name that
 * starts with a dot, and no more than 240 characters.
 */
export const SITE_PATH = /^site\/(?:[a-zA-Z0-9_.@+~-]+\/)*[a-zA-Z0-9_.@+~-]+\.(?:html?|js|mjs|cjs|css|json|map|svg|png|jpe?g|gif|webp|avif|ico|cur|bmp|tiff?|jxl|woff2?|ttf|ttc|otf|eot|mp3|wav|ogg|opus|aac|flac|m4a|midi?|mp4|m4v|mov|webm|ogv|vtt|srt|wasm|txt|xml|webmanifest|md|csv|tsv|ya?ml|toml|geojson|ndjson|rss|atom|ics|pdf|zip|glb|gltf|bin|data|dat|mem|pck|pak|unityweb|atlas|fnt|ktx2?|basis|hdr|obj|mtl|dds|tga|ply|stl|usdz|riv|lottie|glsl|vert|frag|wgsl)(?:\.(?:br|gz))?$/;
/** Endings a web server may run, wherever in a name they stand: no site file has one (NativeAppService::SITE_RUNS). */
export const SITE_RUNS = /\.(?:php\d?|phtml|phar|phps|cgi|pl|asp|aspx|ashx|jsp|jspx|shtml)(?:\.|$)/i;
/** A site file's path is at most this long, folders included (NativeAppService::MAX_SITE_PATH_LENGTH). */
const SITE_PATH_LENGTH = 240;
const SITE_NAME = /^[a-zA-Z0-9_.@+~-]+$/;
const SITE_KINDS = 'A hosted app keeps what a build is made of: pages, scripts, styles, data, pictures, fonts, sound, video, 3D models and a game\'s data files. This kind of file is not one of them.';

/** A path as the rule reads it: its name's endings in lower case, so IMG_0001.JPG is a .jpg (NativeAppService::isSitePath). */
function ruleReading(path: string): string {
  const dot = path.indexOf('.', path.lastIndexOf('/') + 1);
  // The plain letters only, as the server lowers them: toLowerCase also folds a few other signs (the Kelvin sign to k).
  return dot < 0 ? path : path.slice(0, dot) + path.slice(dot).replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/** Why a path cannot be a built file of a hosted app, or null when it can: the rule an upload is held to. */
export function sitePathProblem(path: string): string | null {
  if (path.length > SITE_PATH_LENGTH) return `A file's path, folders included, can be up to ${SITE_PATH_LENGTH} characters long.`;
  if (path.includes('..')) return 'A file name cannot have two dots together.';
  const parts = path.split('/');
  if (parts.some(part => part.startsWith('.'))) return 'A file or folder name cannot start with a dot.';
  if (SITE_RUNS.test(path)) return 'A file name cannot hold an ending a web server runs (.php, .cgi, .asp and the like), even in its middle.';
  if (SITE_PATH.test(ruleReading(path))) return null;
  if (parts.length < 2 || parts[0] !== 'site') return 'A built file is kept under site/.';
  if (parts.slice(1).some(part => !SITE_NAME.test(part))) return 'A file or folder name is made of letters, digits and - _ . @ + ~, with no spaces.';
  if (!parts[parts.length - 1].includes('.')) return 'A file\'s name ends in its kind (.html, .js, .css, .png and the like), and this one has no ending.';
  return SITE_KINDS;
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * A project's built site, as its manifest's `site` block names it: the first page, a path under
 * site/. Null for a project that has none (a SoftN app) and for a manifest that cannot be read.
 */
export function siteOf(project: Pick<NativeProject, 'files'>): { entry: string } | null {
  try {
    const site = record(record(JSON.parse(project.files['manifest.json'] ?? '{}'))?.site);
    return site && typeof site.entry === 'string' ? { entry: site.entry } : null;
  } catch { return null; }
}

const MB = 1024 * 1024;
/** What a build's .zip may be before it is opened: as much as a .softn file (reviewAppArchive). */
const ARCHIVE_BYTES = 80 * MB;
const ARCHIVE_ENTRIES = 1500;
const count = (value: number) => value.toLocaleString('en-US');
const unreadable = (label: string) => `${label} could not be read as a .zip file.`;

/** A refusal in this file's own words, told apart from fflate's when a zip cannot be read. */
class Refusal extends Error {}

/** One file of a zip, before any of it is unpacked. */
interface ZipEntry {
  /** Its name as the zip has it, which is how it is asked for. */
  raw: string;
  /** Its path with forward slashes and no empty or `.` parts: how it is matched, and named in a refusal. */
  path: string;
  /** Its size unpacked, as the zip's index says. */
  size: number;
}

/**
 * What a zip carries that is no part of a build: macOS's and Windows's own files (__MACOSX/,
 * .DS_Store, Thumbs.db), anything in a folder or under a name that starts with a dot (.vite/,
 * .git/), and source maps, which are not needed to run the app.
 */
function isLeftOut(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  return parts.includes('__MACOSX') || name === 'Thumbs.db' || name.endsWith('.map') || parts.some(part => part.startsWith('.'));
}

/**
 * The files of a zip, read from its index alone: nothing is unpacked, so the limits below are
 * checked before a file past them costs any memory. Windows PowerShell's Compress-Archive writes
 * folders with backslashes, read here as the folders they are.
 */
function listEntries(zip: Uint8Array, label: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let listed = 0;
  try {
    unzipSync(zip, { filter(entry) {
      // A zip this full is most often a whole project, node_modules and all.
      if (++listed > ARCHIVE_ENTRIES) throw new Refusal(`${label} has more than ${count(ARCHIVE_ENTRIES)} entries, the most a build's zip can hold. Zip only the folder your build made (dist or build).`);
      const name = entry.name.replace(/\\/g, '/');
      if (name.endsWith('/')) return false;
      const path = name.split('/').filter(part => part !== '' && part !== '.').join('/');
      if (!path || isLeftOut(path)) return false;
      if (seen.has(path)) throw new Refusal(`${label} has two files named ${path}.`);
      seen.add(path);
      entries.push({ raw: entry.name, path, size: entry.originalSize });
      return false;
    } });
  } catch (reason) {
    throw reason instanceof Refusal ? reason : new Error(unreadable(label));
  }
  return entries;
}

/** The bytes of the files asked for, in the order asked. */
function unpack(zip: Uint8Array, wanted: ZipEntry[], label: string): Uint8Array[] {
  const names = new Set(wanted.map(entry => entry.raw));
  let unpacked: Record<string, Uint8Array>;
  try { unpacked = unzipSync(zip, { filter: entry => names.has(entry.name) }); } catch { throw new Error(unreadable(label)); }
  return wanted.map(entry => {
    const bytes = unpacked[entry.raw];
    // A zip whose index misstates a file's size is damaged, or made to pass the limits read from it.
    if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size) throw new Error(unreadable(label));
    return bytes;
  });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** What a project is written in and a build never holds: a sign that the zip is the project, not the build. (.ts is also a video segment.) */
const PROJECT_SOURCE = /\.(?:tsx|jsx|vue|svelte|astro|scss|sass|less)$/;

/** What a zip becomes: the manifest's text, and each kept file's path in the project beside its entry in the zip. */
interface Plan { manifest: string; text: [string, ZipEntry][]; site: [string, ZipEntry][] }

/**
 * A whole project, as its export wrote it (exportNativeProject): a manifest.json with a `site`
 * block at the zip's root, or at the root of the one folder everything in the zip is in. Its
 * backend (server/….logic and .sql) and its built files (site/…) are kept; anything else is not.
 * Null for a zip that is not one, which is then read as a plain build.
 */
function exportedProject(zip: Uint8Array, entries: ZipEntry[], label: string): Plan | null {
  const first = entries[0]?.path.split('/')[0] ?? '';
  const root = entries.length > 0 && entries.every(entry => entry.path.startsWith(`${first}/`)) ? `${first}/` : '';
  const found = entries.find(entry => entry.path === `${root}manifest.json`);
  if (!found || found.size > NATIVE_LIMITS.sourceFileBytes) return null;
  const manifest = strFromU8(unpack(zip, [found], label)[0]);
  let site: Record<string, unknown> | null;
  try { site = record(record(JSON.parse(manifest))?.site); } catch { return null; }
  if (!site) return null;
  const inside = entries.map((entry): [string, ZipEntry] => [entry.path.slice(root.length), entry]);
  const built = inside.filter(([path]) => path.startsWith('site/'));
  // The server's own checks of the block, read here first so a project it would refuse makes no app.
  const page = site.entry;
  if (typeof page !== 'string') throw new Error('manifest.json\'s site block names no first page: give it "entry", such as "index.html".');
  if (!/\.html?$/.test(page) || !built.some(([path]) => path === `site/${page}`)) throw new Error(`manifest.json names ${page} as the app's first page, which is not a page among the zip's site/ files.`);
  return { manifest, text: inside.filter(([path]) => path.startsWith('server/') && /\.(?:logic|sql)$/.test(path)), site: built };
}

/**
 * A plain build: the folder that holds its index.html is the site's root (the shallowest one when
 * a build has several pages, the first by name between two as deep), and every file under it is
 * kept at the same place under site/.
 */
function builtSite(entries: ZipEntry[], name: string): Plan {
  const depth = (path: string) => path.split('/').length;
  const pages = entries.filter(entry => entry.path === 'index.html' || entry.path.endsWith('/index.html'))
    .sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!pages.length) throw new Error('This zip has no index.html: zip the folder your build made (dist or build).');
  const root = pages[0].path.slice(0, -'index.html'.length);
  return {
    manifest: `${JSON.stringify({ name, version: '1.0.0', site: { entry: 'index.html' } }, null, 2)}\n`,
    text: [],
    site: entries.filter(entry => entry.path.startsWith(root)).map(entry => [`site/${entry.path.slice(root.length)}`, entry]),
  };
}

/**
 * The .zip of a built web app as a project this host installs. The usual zip is the folder a
 * build made (dist or build), at the zip's root or inside a folder; a project's own export comes
 * back as the project it was. Every refusal names the file it is about, and the limits are the
 * server's, read here first so a zip it would refuse makes no app.
 */
export async function importSiteBuild(file: File, name: string, notes: string[] = []): Promise<NativeProject> {
  if (file.size > ARCHIVE_BYTES) throw new Error(`${file.name} is larger than a build's zip can be (${ARCHIVE_BYTES / MB} MB).`);
  let zip: Uint8Array;
  // A file moved or deleted since it was chosen cannot be read, and the browser's own words for that name no file.
  try { zip = new Uint8Array(await file.arrayBuffer()); } catch { throw new Error(`${file.name} could not be read: choose it again.`); }
  const entries = listEntries(zip, file.name);
  const plan = exportedProject(zip, entries, file.name) ?? builtSite(entries, name);
  // A build carries files a hosted app does not keep (a LICENSE, a name with a space, a kind that
  // is no web file). They are left out and named to the app's owner (`notes`): the app is still
  // made, and one of them the app needs is put right by renaming it. A packed twin of a file that
  // is here too (app.js.br beside app.js) is left out without a word: the file itself is sent.
  const present = new Set(plan.site.map(([path]) => path));
  const left: string[] = [];
  const site = plan.site.filter(([path, entry]) => {
    const packed = /\.(?:br|gz)$/i.exec(path);
    if (packed && present.has(path.slice(0, -packed[0].length))) return false;
    if (sitePathProblem(path) === null) return true;
    left.push(entry.path);
    return false;
  });
  // Source files or a package.json beside the index.html: the zip is the project (a Vite project keeps its index.html at its root), not what it builds.
  if (left.some(path => PROJECT_SOURCE.test(path)) || plan.site.some(([path]) => path === 'site/package.json')) {
    throw new Error('This looks like a project\'s source, not its build: build it, then zip the folder the build made (dist or build).');
  }
  if (left.length) {
    const named = left.slice(0, 6).join(', ') + (left.length > 6 ? ` and ${count(left.length - 6)} more` : '');
    notes.push(`${count(left.length)} ${left.length === 1 ? 'file was' : 'files were'} left out of the app: ${named}. A hosted app keeps web files named with letters, digits and - _ . @ + ~ (no spaces). If the app needs ${left.length === 1 ? 'it' : 'one of them'}, rename it and upload the build again.`);
  }
  plan.site = site;
  const kept = [...plan.text, ...plan.site];
  const large = kept.find(([, entry]) => entry.size > NATIVE_LIMITS.mediaFileBytes);
  if (large) throw new Error(`${large[1].path} is larger than a hosted app keeps (${NATIVE_LIMITS.mediaFileBytes / MB} MB per file).`);
  if (plan.site.length > NATIVE_LIMITS.mediaFiles) throw new Error(`${file.name} has ${count(plan.site.length)} files to host: a hosted app keeps up to ${count(NATIVE_LIMITS.mediaFiles)}.`);
  const total = kept.reduce((sum, [, entry]) => sum + entry.size, plan.manifest.length);
  if (total > NATIVE_LIMITS.projectBytes) throw new Error(`${file.name} holds more than a hosted app keeps (${NATIVE_LIMITS.projectBytes / MB} MB in all).`);
  const unpacked = unpack(zip, kept.map(([, entry]) => entry), file.name);
  const files: Record<string, string> = { 'manifest.json': plan.manifest };
  const assets: Record<string, string> = {};
  kept.forEach(([path], index) => {
    if (index < plan.text.length) files[path] = strFromU8(unpacked[index]);
    else assets[path] = base64(unpacked[index]);
  });
  // Open at the app's address, and for members only until its owner opens it to everyone.
  return { version: 0, files, assets, access: 'members', home: true };
}

/**
 * An app's project with a newly uploaded build in place of its old one (`imported`, as
 * importSiteBuild read the zip). A plain build replaces the site's files and nothing else: the
 * app's backend, its database changes and the rest of its manifest stay, and only the first page
 * the manifest names follows the build. A zip that is a whole project (its own export, with a
 * backend) replaces the project. Who can use the app and where it opens stay as its owner set
 * them, and so does the version this is a change to.
 */
export function withNewBuild(current: NativeProject, imported: NativeProject): NativeProject {
  const kept = { version: current.version, access: current.access, home: current.home };
  let theirs: Record<string, unknown> | null = null;
  try { theirs = record(JSON.parse(imported.files['manifest.json'] ?? '{}')); } catch { /* A build's manifest is made by the import: read as none. */ }
  if (Object.keys(imported.files).some(path => path !== 'manifest.json') || theirs?.server) return { ...imported, ...kept };
  let manifest: Record<string, unknown> = {};
  try { manifest = record(JSON.parse(current.files['manifest.json'] ?? '{}')) ?? {}; } catch { /* Written afresh below. */ }
  manifest = { ...manifest, site: { ...(record(manifest.site) ?? {}), entry: siteOf(imported)?.entry ?? 'index.html' } };
  return {
    ...current,
    ...kept,
    files: { ...current.files, 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` },
    assets: { ...Object.fromEntries(Object.entries(current.assets).filter(([path]) => !path.startsWith('site/'))), ...imported.assets },
  };
}

/**
 * One outside site an app may be allowed to reach, as the server takes it
 * (SecurityHeadersMiddleware::SITE_OUTSIDE): a name and not a number, so no IP address.
 */
export const SITE_OUTSIDE = /^(?:https|wss):\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,20}[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
/** How many an app may name (SecurityHeadersMiddleware::SITE_OUTSIDE_MOST). */
export const SITE_OUTSIDE_MOST = 20;
/** No address of a site is longer (SecurityHeadersMiddleware::SITE_OUTSIDE_LENGTH). */
export const SITE_OUTSIDE_LENGTH = 300;

/** One entry of a list as the server reads it: trimmed, in lower case, and a site's address or nothing. */
function outsideSiteAsTaken(one: unknown): string | null {
  if (typeof one !== 'string') return null;
  const site = one.trim().toLowerCase();
  return site.length <= SITE_OUTSIDE_LENGTH && SITE_OUTSIDE.test(site) ? site : null;
}

/**
 * Whether an outside site is this site itself, which an app is never given
 * (SecurityHeadersMiddleware::siteOutsideIsOwn): its own name on any port, with or without "*."
 * before it, or "*." before a name above it, which a browser reads as covering it. `ownHost` is
 * the name this page is on.
 */
export function outsideSiteIsOwn(site: string, ownHost: string): boolean {
  const found = /^[a-z]+:\/\/(\*\.)?([^:/]+)/.exec(site.trim().toLowerCase());
  const own = ownHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!found || !own) return false;
  const name = found[2].replace(/\.$/, '');
  return name === own || (found[1] !== undefined && own.endsWith(`.${name}`));
}

/**
 * What a person typed or pasted, as a site's address: an address copied whole from a browser
 * (https://fonts.example.com/css2?family=Inter) is cut down to its site, and a bare name
 * (api.example.com) is taken as https. Null when it is no site: plain http, a name with no dot,
 * a number where a name should be (127.0.0.1), anything else.
 */
export function readOutsideSite(typed: string): string | null {
  const text = typed.trim().toLowerCase();
  if (!text) return null;
  const whole = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  const site = whole.replace(/^((?:https|wss):\/\/[^/?#\s]+).*$/, '$1');
  return outsideSiteAsTaken(site);
}

/** The outside sites a project's manifest lets its app reach (site.outside), as the server would take them. */
export function siteOutsideOf(project: Pick<NativeProject, 'files'>): string[] {
  try {
    const outside = record(record(JSON.parse(project.files['manifest.json'] ?? '{}'))?.site)?.outside;
    // As the server reads each one (a manifest written by hand or by another program may say
    // "HTTPS://API.Example.com"): what is shown as allowed is what the policy allows.
    return Array.isArray(outside) ? [...new Set(outside.map(outsideSiteAsTaken).filter((one): one is string => one !== null))].slice(0, SITE_OUTSIDE_MOST) : [];
  } catch { return []; }
}

/** A project whose app may reach these outside sites and no others. The rest of its manifest is as it was. */
export function withOutsideSites(project: NativeProject, sites: string[]): NativeProject {
  let manifest: Record<string, unknown> = {};
  try { manifest = record(JSON.parse(project.files['manifest.json'] ?? '{}')) ?? {}; } catch { /* Written afresh below. */ }
  const site = { ...(record(manifest.site) ?? {}) };
  if (sites.length) site.outside = sites; else delete site.outside;
  return { ...project, files: { ...project.files, 'manifest.json': `${JSON.stringify({ ...manifest, site }, null, 2)}\n` } };
}

/** No more of one file is read for the warnings. */
const SCAN_BYTES = 2 * MB;
const SCANNED = /\.(?:html?|js|mjs|css)$/;
const TAG = /<(script|link)\b[^>]{0,4000}>/gi;
const SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const REL = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
/** The links that fetch a file: a stylesheet, a preload (a font, a script), an icon, a web manifest. */
const LOADS = /(?:^|\s)(?:stylesheet|preload|modulepreload|prefetch|manifest|(?:[a-z-]*-)?icon)(?:\s|$)/i;
const OUTSIDE = /^(?:https?:)?\/\//i;
const HISTORY = /\b(createBrowserRouter|BrowserRouter|createWebHistory)\b/;
const WORKER = /serviceWorker\s*(?:\?\.|\.)\s*register\b/;

/** The start of a file kept in base64, as text: no more of it than is scanned. */
function scanText(encoded: string): string {
  try {
    const binary = atob(encoded.slice(0, Math.floor(SCAN_BYTES / 3) * 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    return strFromU8(bytes);
  } catch { return ''; }
}

/** A page without its comments: a tag commented out loads nothing. */
function withoutComments(html: string): string {
  let kept = '';
  let at = 0;
  for (;;) {
    const open = html.indexOf('<!--', at);
    if (open < 0) return kept + html.slice(at);
    kept += html.slice(at, open);
    const close = html.indexOf('-->', open + 4);
    if (close < 0) return kept;
    at = close + 3;
  }
}

const attribute = (text: string, pattern: RegExp): string | null => {
  const match = pattern.exec(text);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '').trim() : null;
};

/** The first script, stylesheet, font or icon a page loads from another site: its address. */
function outsideLoad(html: string): string | null {
  for (const [tag, kind] of html.matchAll(TAG)) {
    const link = kind.toLowerCase() === 'link';
    if (link && !LOADS.test(attribute(tag, REL) ?? '')) continue;
    const address = attribute(tag, link ? HREF : SRC);
    if (address && OUTSIDE.test(address)) return address;
  }
  return null;
}

const brief = (found: string) => found.length > 80 ? `${found.slice(0, 79)}…` : found;

/**
 * What in a build will not work when it is hosted, in its owner's words: at most one warning of
 * each kind, each naming the file it was found in and what to do. Found by reading the site's
 * pages, scripts and stylesheets, the first page before the rest; nothing is run. A build that
 * warns is still installed: these are for its owner to act on.
 */
export function siteBuildWarnings(project: Pick<NativeProject, 'files' | 'assets'>): string[] {
  const entry = `site/${siteOf(project)?.entry ?? 'index.html'}`;
  // A file the page holds by name alone (lib/nativeMedia) is one an earlier build had: it was read when that was uploaded.
  const texts = Object.fromEntries(Object.entries(project.assets).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const paths = Object.keys(texts).filter(path => path.startsWith('site/') && SCANNED.test(path) && path !== entry).sort();
  if (typeof texts[entry] === 'string') paths.unshift(entry);
  let outside = '', history = '', worker = '';
  for (const path of paths) {
    if (history && worker && path !== entry) break;
    const shown = path.slice('site/'.length);
    const page = /\.html?$/.test(path), script = /\.m?js$/.test(path);
    const text = page ? withoutComments(scanText(texts[path])) : scanText(texts[path]);
    if (path === entry) {
      const address = outsideLoad(text);
      if (address) outside = `${shown} loads ${brief(address)} from another site. A hosted app reaches another site only when you name it: put the file in your build, or allow the site in Settings, Outside sites.`;
    }
    if (!history && (page || script)) {
      const found = HISTORY.exec(text)?.[1];
      // Chrome, Edge and Firefox let a hosted app's page change its own path, so such a router
      // works there as built. Safari does not, and there the app stays on its first screen.
      if (found) history = `${shown} picks its screens from the address path (${found}). That works as built in Chrome, Edge and Firefox. Safari, on Mac and iPhone, does not let a hosted app change its path, so there it stays on its first screen: for Safari, use hash routing (createHashRouter / createWebHashHistory).`;
    }
    if (!worker && (page || script) && WORKER.test(text)) worker = `${shown} registers a service worker, and service workers do not run in a hosted app: take the registration out.`;
  }
  return [outside, history, worker].filter(Boolean);
}

/** Why the shared demo cannot add a JavaScript app. */
const SITE_NEEDS_ACCOUNT = 'JavaScript apps are hosted on the server, so they are available after sign-up.';

/** Take back an app whose build could not be saved. False when it is still there. */
async function removeApp(id: string): Promise<boolean> {
  try {
    if ((await api.deleteApp(id)).error) return false;
  } catch { return false; }
  useAppStore.setState(state => ({ apps: state.apps.filter(listed => listed.id !== id) }));
  return true;
}

/**
 * Create a JavaScript app from the .zip of its build. The zip is read before the app is created,
 * so one this host cannot take creates nothing. An app whose build the server then refuses is
 * taken back: without its build it has nothing to show, and no starter stands in for one.
 * `warnings`: what in the build will not work when hosted (siteBuildWarnings).
 */
export async function createSiteApp(name: string, file: File): Promise<{ app: App; warnings: string[] }> {
  // The demo keeps its apps in this browser; a hosted app runs on the server, so nothing is created.
  if (api.isDemoMode()) throw new Error(SITE_NEEDS_ACCOUNT);
  const named = name.trim();
  if (!named) throw new Error('Give the app a name.');
  const notes: string[] = [];
  const project = await importSiteBuild(file, named, notes);
  // Kept as a SoftN app's project is, so it is one to the workspace, the app list and the server.
  const app = await useAppStore.getState().createApp({ name: named, settings: { softnApp: true } });
  if (!app) throw new Error(useAppStore.getState().error || 'Could not create the app. Please try again.');
  let failure: string | null = null;
  try {
    const result = await api.saveNativeProject(app.id, project, 0, { how: 'upload' });
    if (result.error || !result.data) failure = result.error || 'The app\'s files could not be saved. Please try again.';
  } catch (reason) {
    failure = reason instanceof Error && reason.message ? reason.message : 'The app\'s files could not be saved. Please try again.';
  }
  if (failure !== null) {
    if (await removeApp(app.id)) throw new Error(failure);
    throw new Error(`${failure} An empty app named ${app.name} was left in Apps: delete it there before trying again.`);
  }
  return { app, warnings: [...notes, ...siteBuildWarnings(project)] };
}
