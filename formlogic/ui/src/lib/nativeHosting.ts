import { reviewAppArchive } from './appImportReview';
import { strFromU8, strToU8, zipSync } from 'fflate';
import type { NativeStorageScope } from './nativeAppStorage';

export interface NativeProject { home?: boolean; version: number; updatedAt?: string; files: Record<string,string>; assets: Record<string,string>; access: 'application' | 'members' }
/**
 * What a member's page runs. `media`, from FormLogic v0.1.24, names the app's media pack, fetched
 * whole and unpacked into `assets` before the frame is given them (readMediaPack); a server before
 * it sends `assets` in the JSON itself.
 */
export interface NativeRuntimeProject { version: number; client: Record<string,string>; assets: Record<string,string>; media?: { url: string; sha256: string; size: number; count: number }; access: 'application' | 'members'; storageScope: NativeStorageScope; origins?: string[]; files?: 'ask' | 'allow'; formlogic?: NativeFormlogic }

/**
 * What an app asks of FormLogic itself (its manifest's formlogicAi and formlogicPayments), as the
 * runtime GET says: `visitors` has this page mark the app's requests (X-FormLogic-Visitor), so its
 * visitors are known by their browser's cookie; `payments` lets it open FormLogic's wallet.
 */
export interface NativeFormlogic { visitors?: boolean; ai?: boolean; payments?: boolean }

const AI_USE_WORDS: Record<string, string> = { pictures: 'pictures', 'picture-edits': 'picture edits', chat: 'chat' };

/**
 * What an app's manifest asks of FormLogic itself, in the owner's words, for the review before it
 * is installed: its AI (formlogicAi) and its payments (formlogicPayments). The server holds an
 * install to their rules (AppFormlogicManifest); this only says what they ask.
 */
export function formlogicAsks(project: Pick<NativeProject, 'files'>): string[] {
  let manifest: Record<string, unknown>;
  try { manifest = record(JSON.parse(project.files['manifest.json'] ?? '{}')) ?? {}; } catch { return []; }
  const asks: string[] = [];
  const ai = record(manifest.formlogicAi);
  if (ai) {
    const uses = Array.isArray(ai.uses) ? ai.uses.map(use => AI_USE_WORDS[String(use)] ?? String(use)) : [];
    const list = uses.length > 1 ? `${uses.slice(0, -1).join(', ')} and ${uses[uses.length - 1]}` : uses.join('');
    asks.push(`Uses AI for ${list || 'its requests'}, once you choose where its AI comes from${typeof ai.purpose === 'string' ? `: ${ai.purpose}` : '.'}`);
  }
  const payments = record(manifest.formlogicPayments);
  if (payments) {
    const items = Array.isArray(payments.items) ? payments.items.map(record).filter((item): item is Record<string, unknown> => !!item)
      .map(item => `${String(item.label ?? item.id)} (${typeof item.priceCents === 'number' ? `${item.priceCents}¢` : '?'})`) : [];
    asks.push(`Takes payments from its visitors' prepaid balance${items.length ? `: ${items.join(', ')}` : ''}${typeof payments.purpose === 'string' ? `. ${payments.purpose}` : ''}`);
  }
  return asks;
}

/** Whether an app's manifest asks for FormLogic's AI (formlogicAi): its owner then chooses where that AI comes from. */
export function declaresFormlogicAi(project: Pick<NativeProject, 'files'>): boolean {
  try { return record(record(JSON.parse(project.files['manifest.json'] ?? '{}'))?.formlogicAi) !== null; } catch { return false; }
}

/** Whether an app's manifest asks to take payments (formlogicPayments): its owner then confirms the prices. */
export function declaresFormlogicPayments(project: Pick<NativeProject, 'files'>): boolean {
  try { return record(record(JSON.parse(project.files['manifest.json'] ?? '{}'))?.formlogicPayments) !== null; } catch { return false; }
}

/**
 * What a project may hold, which the server holds an install to as well (NativeAppService's
 * MAX_* constants; nativeHosting.limits.test.ts keeps the two equal). A game's art and sound run
 * to hundreds of files and tens of megabytes.
 */
export const NATIVE_LIMITS = Object.freeze({
  sourceFiles: 200,
  // An app's server logic is one file: 1.5 MB holds a studio's whole library.
  sourceFileBytes: 1_500_000,
  // The runner reads no more of one migration.
  migrationBytes: 1_000_000,
  mediaFiles: 1000,
  mediaFileBytes: 8 * 1024 * 1024,
  projectBytes: 64 * 1024 * 1024,
});

/** The pack's first eight bytes (NativeAppService::MEDIA_PACK_MAGIC). */
const MEDIA_PACK_MAGIC = 'FLMEDIA1';

/**
 * An app's media pack as the frame takes its media: each file's path to its bytes in base64.
 * Refused whole when it is not a pack, when a file runs past its end, or when a path is not one
 * the frame serves; the server wrote it from a project it had checked, so either is a damaged copy.
 */
export function readMediaPack(buffer: ArrayBuffer): Record<string, string> {
  const bytes = new Uint8Array(buffer);
  const bad = (why: string) => new Error(`The app's media could not be read (${why}).`);
  if (bytes.length < 12 || strFromU8(bytes.subarray(0, 8)) !== MEDIA_PACK_MAGIC) throw bad('not a media pack');
  const headerLength = new DataView(buffer, bytes.byteOffset + 8, 4).getUint32(0, false);
  if (12 + headerLength > bytes.length) throw bad('its index runs past its end');
  let header: unknown;
  try { header = JSON.parse(strFromU8(bytes.subarray(12, 12 + headerLength))); } catch { throw bad('its index is not JSON'); }
  const files = (record(header)?.files);
  if (!Array.isArray(files)) throw bad('it has no index of files');
  const body = 12 + headerLength;
  const assets: Record<string, string> = {};
  for (const entry of files) {
    const file = record(entry);
    const path = file?.path, offset = file?.offset, size = file?.size;
    if (typeof path !== 'string' || !HOSTED_MEDIA.test(path) || path.includes('..') || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || (offset as number) < 0 || (size as number) < 0) throw bad('a file in it is not one an app may have');
    const start = body + (offset as number), end = start + (size as number);
    if (end > bytes.length) throw bad(`${path} runs past its end`);
    let binary = '';
    for (let at = start; at < end; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, Math.min(at + 8192, end)));
    assets[path] = btoa(binary);
  }
  return assets;
}
export interface NativeRecordField { name: string; type: string; primary: boolean; required: boolean; defaultValue: string | null; auto: boolean; readOnly: boolean }
export interface NativeRecordDetail { values: Record<string, string | null>; revision: string; fields: NativeRecordField[] }
/**
 * A page of records. `offset` is the offset the server actually used (it
 * clamps requests past its browsing window), `limit` is the page size and
 * `offsetLimit` the window: the furthest offset a page may start at. `end`
 * says why the page ends: more pages follow, the table ended, or the window's
 * limit was reached with rows beyond it. Older servers send only `hasMore`.
 * `readOnly` is true for the shared demo: records can be browsed, not changed.
 */
export interface NativeRecords { schema?: { fields: NativeRecordField[]; primaryKey: string[]; canCreate: boolean }; keys?: (Record<string, string> | null)[]; installed?: boolean; tables: string[]; columns?: string[]; rows?: Record<string, unknown>[]; hasMore?: boolean; offset?: number; end?: 'more' | 'end' | 'limit'; limit?: number; offsetLimit?: number; readOnly?: boolean }
/**
 * The app's tables with their sizes (GET …/native/records?summary=1). `summary` is absent for an
 * app with no database: `backend: false` then says its data is kept in each person's browser.
 */
export interface NativeDataSummary { installed?: boolean; tables: string[]; backend?: boolean; readOnly?: boolean; summary?: { tables: { name: string; rows: number; columns: number }[]; bytes: number; hiddenTables: number } }
/** How a filter compares a column with its value. `empty` (NULL or no text) and `notEmpty` take no value. */
export type NativeFilterOp = 'eq' | 'ne' | 'contains' | 'starts' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';
export interface NativeFilter { column: string; op: NativeFilterOp; value?: string }
export interface NativeSort { column: string; dir: 'asc' | 'desc' }
/** What the data manager asks of a table: which page, in what order, and which rows (`q` and every filter must hold). */
export interface NativeBrowseQuery { offset?: number; limit?: number; sort?: NativeSort | null; q?: string; filters?: NativeFilter[] }
/**
 * A page of a table for the data manager: a page of records, plus `total` (rows in the table),
 * `matching` (rows that pass the search and filters), `stamps` (one per row, in step with `rows`
 * and `keys`: what deleting several rows sends back, null where the row has no usable key), `cut`
 * (row index to the columns whose text is a 400-character preview), `sort` (what was applied, null
 * for the table's own order) and `hiddenColumns` (how many columns are never shown).
 */
export interface NativeBrowse extends NativeRecords { total?: number; matching?: number; stamps?: (string | null)[]; cut?: Record<string, string[]>; sort?: NativeSort | null; hiddenColumns?: number }
/** `primaryKey` is the column's place in the key (from 1) or 0. `hidden`: its values are never shown. */
export interface NativeStructureColumn { name: string; type: string; notNull: boolean; defaultValue: string | null; primaryKey: number; hidden: boolean; generated: boolean }
/** `origin` is SQLite's: `c` (CREATE INDEX), `u` (a UNIQUE constraint), `pk`. */
export interface NativeStructureIndex { name: string; unique: boolean; origin: string; columns: string[] }
export interface NativeForeignKey { columns: string[]; table: string; to: string[]; onUpdate: string; onDelete: string }
/** A table's shape (GET …/native/records?table=T&view=structure). `referencedBy`: the shown tables whose foreign keys point here. */
export interface NativeStructure { table: string; rows: number; columns: NativeStructureColumn[]; indexes: NativeStructureIndex[]; foreignKeys: NativeForeignKey[]; referencedBy: { table: string; columns: string[]; to: string[] }[]; readOnly?: boolean }
/**
 * A source file name the app host keeps (the server holds uploads to the same rule,
 * NativeAppService::SOURCE_PATH): a SoftN app's pages (.html, or .ui in an app made before SoftN's
 * HTML pages), page logic (.js, or .logic; .py), stylesheets, JSON, seed data, and a backend's
 * .logic and .sql. All of it is text the app's frame or runner is handed, never a file this site serves.
 */
const SOURCE_KINDS = /\.(html|ui|js|logic|py|css|json|sql|xdb)$/;
const SOURCE_PATH = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:html|ui|js|logic|py|css|json|sql|xdb)$/;
/** The private tree: backend code, which runs only under a server block. */
const PRIVATE_TREE = /^(server|backend|private)\//i;
/**
 * The media the app host serves an app's page: the SoftN frame's own list (Softn v0.0.28's
 * apps/formlogic-host/src/media.ts), and the server holds uploads to the same one.
 */
export const HOSTED_MEDIA = /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg|hdr|exr|mp3|wav|ogg|opus|aac|flac|m4a|mp4|webm|woff2?|ttf|otf|glb|gltf|obj|stl|fbx|bin|wgsl|txt|md)$/i;

const NATIVE_CAPABILITIES = ['sql', 'crypto', 'time', 'trusted-client-ip', 'transaction-scope', 'photos'];
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Why a manifest's backend is not one this host runs, in the owner's words, or null when it is.
 * The server holds an install to the same rules; read here first, a file it would refuse is
 * refused before any app is made for it.
 */
export function backendProblem(manifest: Record<string, unknown>, files: Record<string, unknown>): string | null {
  if (!('server' in manifest)) return null;
  const server = record(manifest.server);
  const requires = record(server?.requires);
  const database = record(server?.database);
  const lead = 'This app\'s backend is not one FormLogic runs';
  const needs = 'FormLogic runs a SoftN backend whose manifest.json server block has "requires": { "apiVersion": 1, "capabilities": [...] }, an "entry" under server/ ending in .logic, and "database": { "kind": "private-sqlite" }.';
  if (!server || requires?.apiVersion !== 1) return `${lead}: it was written for another SoftN host. ${needs}`;
  // JSON reads 1.0 as 1 here, but the server reads it as a fraction and refuses it.
  if (typeof files['manifest.json'] === 'string' && /"apiVersion"\s*:\s*1[.eE]/.test(files['manifest.json'])) return `${lead}: write its "apiVersion" as 1, a whole number.`;
  const entry = server.entry;
  if (typeof entry !== 'string' || !entry.startsWith('server/') || !entry.endsWith('.logic') || !(entry in files)) return `${lead}: its entry should be a server/….logic file in the app. ${needs}`;
  const capabilities = requires.capabilities;
  const unknown = Array.isArray(capabilities) ? capabilities.filter(name => !NATIVE_CAPABILITIES.includes(String(name))) : null;
  if (!unknown) return `${lead}: it lists no capabilities. ${needs}`;
  if (unknown.length) return `${lead}: it asks for ${unknown.map(String).join(', ')}, which this host does not offer (it offers ${NATIVE_CAPABILITIES.join(', ')}).`;
  if (record(server.sync)?.enabled) return `${lead}: it turns on server sync, which this host does not offer.`;
  if (database?.kind !== 'private-sqlite') return `${lead}: it needs "database": { "kind": "private-sqlite" }. ${needs}`;
  const missing = (Array.isArray(database.migrations) ? database.migrations : []).find(path => typeof path !== 'string' || !path.startsWith('server/migrations/') || !path.endsWith('.sql') || !(path in files));
  if (missing !== undefined) return `${lead}: its migration ${String(missing)} is not a server/migrations/….sql file in the app.`;
  return null;
}

/**
 * A .softn file as a project this host installs: a SoftN app with a backend of its own, or one
 * with none (all client, run in the member's page). Every refusal names the file it is about.
 */
export async function importNativeProject(file: File): Promise<NativeProject> {
  const { files, review } = reviewAppArchive(new Uint8Array(await file.arrayBuffer()));
  // FormLogic's own named backend actions belong to a Forms app's App Studio.
  if (review.backend === 'actions') throw new Error('This file is a FormLogic app project with backend actions, not a SoftN app. Add it to a Forms app instead: open its App Studio, then Screens → Hosting & app tools.');
  const source: Record<string,string> = {};
  const assets: Record<string,string> = {};
  // The server's limits, read here first so a file it would refuse makes no app.
  let total = 0;
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith('.py') && PRIVATE_TREE.test(path)) throw new Error('Python is a client logic language; the app backend stays JavaScript.');
    // .xdb is the app's seed data: JSON text kept with it.
    if (SOURCE_KINDS.test(path)) {
      if (!SOURCE_PATH.test(path) || path.includes('..')) throw new Error(`${path}: this host keeps file names made of letters, digits, '-', '_' and '.' (never two dots together). Rename it and try again.`);
      if (bytes.length > NATIVE_LIMITS.sourceFileBytes) throw new Error(`${path} is larger than this host keeps (1.5 MB per source file).`);
      if (path.startsWith('server/migrations/') && path.endsWith('.sql') && bytes.length > NATIVE_LIMITS.migrationBytes) throw new Error(`${path} is larger than a migration may be (1 MB). Split it into two migrations.`);
      source[path] = strFromU8(bytes);
    } else if (path.startsWith('assets/')) {
      if (path.includes('..')) throw new Error(`${path}: this host keeps file names without two dots together. Rename it and try again.`);
      if (!HOSTED_MEDIA.test(path)) throw new Error(`${path} cannot be hosted with this app: its media can be pictures (PNG, JPEG, GIF, WebP, AVIF, ICO, BMP, SVG, HDR, EXR), sound (MP3, WAV, Ogg, Opus, AAC, FLAC, M4A), video (MP4, WebM), fonts (WOFF, WOFF2, TTF, OTF), 3D models (glTF, GLB, BIN, OBJ, STL, FBX), and WGSL, text and Markdown files.`);
      if (bytes.length > NATIVE_LIMITS.mediaFileBytes) throw new Error(`${path} is larger than this host keeps (8 MB per media file).`);
      let binary = '';
      for (let offset=0;offset<bytes.length;offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
      assets[path] = btoa(binary);
    } else if (!/^(README|LICENSE|NOTICE)(\.|$)/.test(path)) throw new Error(`${path} is a kind of file this host cannot keep with an app. Remove it from the .softn file and try again.`);
    else continue;
    total += bytes.length;
  }
  const sources = Object.keys(source).length, media = Object.keys(assets).length;
  if (sources > NATIVE_LIMITS.sourceFiles) throw new Error(`This app has ${sources} source files; this host keeps up to ${NATIVE_LIMITS.sourceFiles}.`);
  if (media > NATIVE_LIMITS.mediaFiles) throw new Error(`This app has ${media} media files; this host keeps up to ${NATIVE_LIMITS.mediaFiles}.`);
  if (total > NATIVE_LIMITS.projectBytes) throw new Error(`This app is ${(total / 1024 / 1024).toFixed(1)} MB; this host keeps apps up to ${NATIVE_LIMITS.projectBytes / 1024 / 1024} MB.`);
  let manifest: Record<string, unknown> = {};
  try { manifest = record(JSON.parse(source['manifest.json'] ?? '{}')) ?? {}; } catch { /* the review above read it */ }
  if (manifest.id != null && (typeof manifest.id !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(manifest.id))) throw new Error('manifest.json\'s id can only be letters, digits, \'.\', \'_\' and \'-\' (up to 120 of them).');
  if (!('server' in manifest)) {
    const backendFile = Object.keys(source).find(path => PRIVATE_TREE.test(path));
    if (backendFile) throw new Error(`${backendFile} is backend code, but manifest.json has no server block to run it. Add one, or remove the file.`);
  }
  const problem = backendProblem(manifest, source);
  if (problem) throw new Error(problem);
  return { version: 0, files: source, assets, access: 'application' };
}

/** Owner project export: source and media, without databases or host credentials. */
export function exportNativeProject(project: NativeProject): Uint8Array {
  const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(project.files).map(([path, source]) => [path, strToU8(source)]));
  for (const [path, encoded] of Object.entries(project.assets)) files[path] = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  return zipSync(files);
}
