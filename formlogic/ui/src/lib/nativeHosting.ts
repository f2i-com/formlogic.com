import { reviewAppArchive } from './appImportReview';
import { strFromU8, strToU8, zipSync } from 'fflate';
import type { NativeStorageScope } from './nativeAppStorage';

export interface NativeProject { home?: boolean; version: number; updatedAt?: string; files: Record<string,string>; assets: Record<string,string>; access: 'application' | 'members' }
export interface NativeRuntimeProject { version: number; client: Record<string,string>; assets: Record<string,string>; access: 'application' | 'members'; storageScope: NativeStorageScope; origins?: string[] }
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
/** A source file name the app host keeps (the server holds uploads to the same rule). */
const SOURCE_PATH = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:ui|logic|py|json|sql|xdb)$/;
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
    if (/\.(ui|logic|py|json|sql|xdb)$/.test(path)) {
      if (!SOURCE_PATH.test(path) || path.includes('..')) throw new Error(`${path}: this host keeps file names made of letters, digits, '-', '_' and '.' (never two dots together). Rename it and try again.`);
      if (bytes.length > 1_000_000) throw new Error(`${path} is larger than this host keeps (1 MB per source file).`);
      source[path] = strFromU8(bytes);
    } else if (path.startsWith('assets/')) {
      if (path.includes('..')) throw new Error(`${path}: this host keeps file names without two dots together. Rename it and try again.`);
      if (!HOSTED_MEDIA.test(path)) throw new Error(`${path} cannot be hosted with this app: its media can be pictures (PNG, JPEG, GIF, WebP, AVIF, ICO, BMP, SVG, HDR, EXR), sound (MP3, WAV, Ogg, Opus, AAC, FLAC, M4A), video (MP4, WebM), fonts (WOFF, WOFF2, TTF, OTF), 3D models (glTF, GLB, BIN, OBJ, STL, FBX), and WGSL, text and Markdown files.`);
      if (bytes.length > 8 * 1024 * 1024) throw new Error(`${path} is larger than this host keeps (8 MB per media file).`);
      let binary = '';
      for (let offset=0;offset<bytes.length;offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
      assets[path] = btoa(binary);
    } else if (!/^(README|LICENSE|NOTICE)(\.|$)/.test(path)) throw new Error(`${path} is a kind of file this host cannot keep with an app. Remove it from the .softn file and try again.`);
    else continue;
    total += bytes.length;
  }
  const sources = Object.keys(source).length, media = Object.keys(assets).length;
  if (sources > 200) throw new Error(`This app has ${sources} source files; this host keeps up to 200.`);
  if (media > 100) throw new Error(`This app has ${media} media files; this host keeps up to 100.`);
  if (total > 16 * 1024 * 1024) throw new Error(`This app is ${(total / 1024 / 1024).toFixed(1)} MB; this host keeps apps up to 16 MB.`);
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
