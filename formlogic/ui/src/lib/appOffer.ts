// An app that a hosted app made, offered to the person using it (the `formlogicAddApp` bridge:
// HostedAppFrame hands it on, NativeAppView asks the person in FormLogic's own sheet). Once they
// agree, the offering app's backend is asked for the new app's files, and they become what a
// chosen .softn file is: a zip of them goes through the same importer and the same create an
// upload does, so nothing an upload would be refused for is let in this way.
import { strToU8, zipSync } from 'fflate';
import { importNativeProject } from './nativeHosting';
import type { AppReader } from './nativeHost';
import { createSoftnApp } from './softnApps';
import { api } from './api';
import type { AppListItem } from '../types/app';

/**
 * What an offer may be. `from` and `name` are the offering app's words: an address no longer than
 * this, and a name shown no longer than this. `files` and `bytes` are what its backend may hand
 * over: an app small enough to have been made in a page, well under what an upload may hold.
 */
export const OFFER_LIMITS = Object.freeze({ from: 300, name: 60, files: 200, bytes: 4 * 1024 * 1024 });

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Whether `from` is an address on the offering app's own backend: a path under /api/, never the
 * site's own routes (/api/site/), never another site's address and never a step up out of the app.
 * The server holds the request to its own rule as well; this refuses before the person is asked.
 */
export function isOfferSource(from: unknown): from is string {
  return typeof from === 'string' && from.length <= OFFER_LIMITS.from && from.startsWith('/api/') &&
    !from.toLowerCase().startsWith('/api/site/') && !from.includes('://') && !from.includes('..');
}

/** The name an offer gives the app, as the sheet shows it: one line of text, no longer than the limit. Display only. */
export function offeredName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, OFFER_LIMITS.name).join('').trim();
}

/**
 * The files an app's backend answered with, as bytes by path, and the name it gave beside them:
 * `files` and `name` at the top of the answer or under its `data`. Null where there are no files,
 * one of them is not text, or there are more or larger than an offer may hold. Their names and what
 * is in them are the importer's to check.
 */
export function offeredFiles(body: unknown): { files: Record<string, Uint8Array>; name: string } | null {
  let answer: unknown = body;
  if (typeof answer === 'string') { try { answer = JSON.parse(answer); } catch { return null; } }
  const top = record(answer);
  const holder = record(top?.files) ? top : record(top?.data);
  const listed = record(holder?.files);
  if (!holder || !listed) return null;
  const entries = Object.entries(listed);
  if (entries.length > OFFER_LIMITS.files) return null;
  // No prototype: a path is whatever the app's backend said, and `__proto__` would otherwise vanish into one.
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const [path, text] of entries) {
    // (Text over the limit is over it in bytes too: no character is less than one.)
    if (typeof text !== 'string' || text.length > OFFER_LIMITS.bytes || path === '__proto__') return null;
    const bytes = strToU8(text);
    total += bytes.length;
    if (total > OFFER_LIMITS.bytes) return null;
    files[path] = bytes;
  }
  return { files, name: typeof holder.name === 'string' ? holder.name.replace(/\s+/g, ' ').trim().slice(0, 120) : '' };
}

/** Those files as the .softn file an upload is, named for the app (an upload with no name of its own goes by its file's). */
export function offeredAppFile(files: Record<string, Uint8Array>, name: string): File {
  const base = name.replace(/[\\/:]+/g, ' ').trim() || 'app';
  return new File([new Uint8Array(zipSync(files))], `${base}.zip`, { type: 'application/zip' });
}

/** The server's refusal of an account whose cloud time has run out (CloudWriteGateMiddleware's 402). */
const PLAN_REFUSAL = /cloud access has expired/i;
const messageOf = (reason: unknown, otherwise: string) => reason instanceof Error && reason.message ? reason.message : otherwise;

/** `message` is for the person, in the sheet; the offering app hears only `reason`. `updated`: an app of theirs was updated, not added. */
export type OfferOutcome =
  | { added: { id: string; name: string; slug: string }; updated?: true }
  | { reason: 'invalid' | 'limit' | 'failed'; message: string };

/** Where an offered app comes from: the offering app's id, and the address its files are fetched from. Kept as the added app's settings.softnMadeBy. */
export interface OfferSource { app: string; from: string }

/** An app of the person's own that an earlier offer from the same place added: what an offer may update. */
export interface OfferedBefore { id: string; name: string; slug: string }

/**
 * Of the person's apps (the apps list), the one an earlier offer from this app and this address
 * added, and that they own: the newest such. Null where there is none. An app they only use, an
 * archived one and one that says it came from somewhere else are never it.
 */
export function offeredBefore(apps: ReadonlyArray<Pick<AppListItem, 'id' | 'name' | 'slug' | 'settings' | 'canManage' | 'status' | 'updatedAt'>>, source: OfferSource): OfferedBefore | null {
  let found: (typeof apps)[number] | null = null;
  for (const app of apps) {
    const made = app.settings?.softnMadeBy;
    if (app.canManage !== true || app.status === 'archived' || !made || made.app !== source.app || made.from !== source.from) continue;
    if (!found || String(app.updatedAt ?? '') > String(found.updatedAt ?? '')) found = app;
  }
  return found ? { id: found.id, name: found.name, slug: found.slug } : null;
}

type Fetched = { file: File; name: string; project: Awaited<ReturnType<typeof importNativeProject>> };

/** The offering app's files, fetched as the person and read as an upload is read; or why they cannot be had. */
async function fetchOffered(read: AppReader, from: string, shownName: string): Promise<Fetched | Extract<OfferOutcome, { reason: string }>> {
  const answer = await read(from);
  const sent = answer.data?.result;
  if (answer.error || !sent || typeof sent.status !== 'number' || sent.status < 200 || sent.status > 299) {
    return { reason: 'failed', message: 'The app did not hand over its files. Try again in a moment.' };
  }
  const offered = offeredFiles(sent.body);
  if (!offered) return { reason: 'invalid', message: `What was handed over is not an app FormLogic can add: its files as text, up to ${OFFER_LIMITS.files} of them and ${OFFER_LIMITS.bytes / 1024 / 1024} MB in all.` };
  const file = offeredAppFile(offered.files, offered.name || shownName);
  // Read as an upload is, before anything is made or changed: a file the importer refuses changes nothing.
  try { return { file, name: offered.name, project: await importNativeProject(file) }; }
  catch (reason) { return { reason: 'invalid', message: messageOf(reason, 'These files are not an app FormLogic can add.') }; }
}

/**
 * Adds the offered app to the account of the person who agreed. `read` fetches `from` on the
 * offering app's backend as that person; `shownName` is the name they were shown, used only where
 * neither the answer nor the app's manifest names it; `stillTheirs` says whether the person asked is
 * still the one signed in, read again before anything is created. Never throws.
 */
export async function addOfferedApp(read: AppReader, from: string, shownName: string, stillTheirs: () => boolean, source?: OfferSource): Promise<OfferOutcome> {
  const failed = (message: string): OfferOutcome => ({ reason: PLAN_REFUSAL.test(message) ? 'limit' : 'failed', message });
  try {
    const fetched = await fetchOffered(read, from, shownName);
    if ('reason' in fetched) return fetched;
    if (!stillTheirs()) return { reason: 'failed', message: 'You are no longer signed in as the person who was asked.' };
    // Where it came from is kept with it, so the next offer from the same place can update it.
    const created = await createSoftnApp({ name: fetched.name, start: { kind: 'upload', file: fetched.file }, ...(source ? { settings: { softnMadeBy: source } } : {}) });
    if (created.error || !created.project) return failed(`${created.app.name} was created, but its files could not be installed: ${created.error ?? 'try again from its page.'}`);
    return { added: { id: created.app.id, name: created.app.name, slug: created.app.slug } };
  } catch (reason) {
    return failed(messageOf(reason, 'The app could not be added. Try again in a moment.'));
  }
}

/**
 * Updates an app of the person's that an earlier offer from the same place added (offeredBefore)
 * with what the offering app hands over now. Its files are fetched and read as an upload is, and
 * become the app's next version as an owner's upload does: the app keeps its address, who may open
 * it and what has been entered in it, and its history keeps the version before. `hostName` is the
 * offering app's name, for that history. Never throws.
 */
export async function updateOfferedApp(read: AppReader, from: string, target: OfferedBefore, stillTheirs: () => boolean, hostName: string): Promise<OfferOutcome> {
  const failed = (message: string): OfferOutcome => ({ reason: PLAN_REFUSAL.test(message) ? 'limit' : 'failed', message });
  try {
    const fetched = await fetchOffered(read, from, target.name);
    if ('reason' in fetched) return fetched;
    if (!stillTheirs()) return { reason: 'failed', message: 'You are no longer signed in as the person who was asked.' };
    const now = await api.getNativeProject(target.id, { media: 'refs' });
    const installed = now.data?.project;
    if (now.error || !installed || now.data?.readOnly) return { reason: 'failed', message: `${target.name} could not be opened to update it${now.error ? `: ${now.error}` : '.'}` };
    const next = { ...fetched.project, home: installed.home ?? false, access: installed.access ?? fetched.project.access };
    const saved = await api.saveNativeProject(target.id, next, installed.version, { how: 'upload', summary: `Updated from ${hostName}`.slice(0, 120) });
    if (saved.error || !saved.data) return failed(`${target.name} could not be updated: ${saved.error || 'try again in a moment.'}`);
    return { added: target, updated: true };
  } catch (reason) {
    return failed(messageOf(reason, 'The app could not be updated. Try again in a moment.'));
  }
}
