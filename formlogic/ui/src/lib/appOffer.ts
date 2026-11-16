// An app that a hosted app made, offered to the person using it (the `formlogicAddApp` bridge:
// HostedAppFrame hands it on, NativeAppView asks the person in FormLogic's own sheet). Once they
// agree, the offering app's backend is asked for the new app's files, and they become what a
// chosen .softn file is: a zip of them goes through the same importer and the same create an
// upload does, so nothing an upload would be refused for is let in this way.
import { strToU8, zipSync } from 'fflate';
import { importNativeProject } from './nativeHosting';
import type { AppReader } from './nativeHost';
import { createSoftnApp } from './softnApps';

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
  return new File([new Uint8Array(zipSync(files))], `${base}.softn`, { type: 'application/zip' });
}

/** The server's refusal of an account whose cloud time has run out (CloudWriteGateMiddleware's 402). */
const PLAN_REFUSAL = /cloud access has expired/i;
const messageOf = (reason: unknown, otherwise: string) => reason instanceof Error && reason.message ? reason.message : otherwise;

/** `message` is for the person, in the sheet; the offering app hears only `reason`. */
export type OfferOutcome =
  | { added: { id: string; name: string; slug: string } }
  | { reason: 'invalid' | 'limit' | 'failed'; message: string };

/**
 * Adds the offered app to the account of the person who agreed. `read` fetches `from` on the
 * offering app's backend as that person; `shownName` is the name they were shown, used only where
 * neither the answer nor the app's manifest names it; `stillTheirs` says whether the person asked is
 * still the one signed in, read again before anything is created. Never throws.
 */
export async function addOfferedApp(read: AppReader, from: string, shownName: string, stillTheirs: () => boolean): Promise<OfferOutcome> {
  const failed = (message: string): OfferOutcome => ({ reason: PLAN_REFUSAL.test(message) ? 'limit' : 'failed', message });
  try {
    const answer = await read(from);
    const sent = answer.data?.result;
    if (answer.error || !sent || typeof sent.status !== 'number' || sent.status < 200 || sent.status > 299) {
      return { reason: 'failed', message: 'The app did not hand over its files. Try again in a moment.' };
    }
    const offered = offeredFiles(sent.body);
    if (!offered) return { reason: 'invalid', message: `What was handed over is not an app FormLogic can add: its files as text, up to ${OFFER_LIMITS.files} of them and ${OFFER_LIMITS.bytes / 1024 / 1024} MB in all.` };
    const file = offeredAppFile(offered.files, offered.name || shownName);
    // Read as an upload is, before any app exists: a file the importer refuses makes nothing.
    try { await importNativeProject(file); }
    catch (reason) { return { reason: 'invalid', message: messageOf(reason, 'These files are not an app FormLogic can add.') }; }
    if (!stillTheirs()) return { reason: 'failed', message: 'You are no longer signed in as the person who was asked.' };
    const created = await createSoftnApp({ name: offered.name, start: { kind: 'upload', file } });
    if (created.error || !created.project) return failed(`${created.app.name} was created, but its files could not be installed: ${created.error ?? 'try again from its page.'}`);
    return { added: { id: created.app.id, name: created.app.name, slug: created.app.slug } };
  } catch (reason) {
    return failed(messageOf(reason, 'The app could not be added. Try again in a moment.'));
  }
}
