// What an app's History section says of a version (components/apps/SoftnHistory), in words: how
// it came to be, who made it, and what it changed. The server keeps these as values
// (NativeAppVersions); a person reads a sentence.
import type { NativeVersion, NativeVersionChanges } from './api';

/** How a version came to be. */
export function howInWords(version: Pick<NativeVersion, 'how' | 'restored'>): string {
  switch (version.how) {
    case 'page': return 'Published from this page';
    case 'upload': return 'Uploaded';
    case 'mcp': return 'Changed by an AI over MCP';
    case 'chat': return 'Changed by an AI in the chat';
    case 'rollback': return version.restored ? `Went back to version ${version.restored}` : 'Went back to an earlier version';
    case 'import': return 'Data brought in from another host';
    case 'pack': return 'Installed from a pack';
    case 'plugin': return 'Installed as a plugin';
    default: return 'How it was made was not recorded';
  }
}

/** Who made a version: the person looking, someone the site can name, or someone else. Null when nobody is recorded. */
export function whoInWords(version: Pick<NativeVersion, 'by' | 'byYou' | 'byName'>): string | null {
  if (version.byYou) return 'You';
  return version.byName ?? (version.by ? 'Someone else' : null);
}

/** What a version changed, in a few words: "3 files changed, 1 added · API routes changed · Outside sites changed". Null when it was not recorded. */
export function changesInWords(changes: NativeVersionChanges | null): string | null {
  if (!changes) return null;
  const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;
  if (changes.first) return `First version · ${files(changes.added)}`;
  const counts: string[] = [];
  for (const [count, word] of [[changes.changed, 'changed'], [changes.added, 'added'], [changes.removed, 'removed']] as const) {
    if (count > 0) counts.push(counts.length ? `${count} ${word}` : `${files(count)} ${word}`);
  }
  // What the manifest lets the app reach and ask for is said apart: it is one changed file like any other otherwise.
  const flags = [changes.routes && 'API routes changed', changes.database && 'Database changes added', changes.outside && 'Outside sites changed',
    changes.asks && 'What it asks for changed', changes.access && 'Who can use it changed', changes.home && 'Address changed'].filter(Boolean) as string[];
  if (!counts.length && !flags.length) return 'Nothing changed in its files';
  return [counts.join(', '), ...flags].filter(Boolean).join(' · ');
}

/**
 * The versions that were replaced without being kept, as a sentence. The server keeps the reason
 * in its log (the history's folder could not be written, or its list could not be read just then);
 * a person is told what it means for them.
 */
export function gapInWords(gap: { from: number; to: number }): string {
  return gap.from === gap.to
    ? `Version ${gap.from} was not kept. It could not be saved in the history when it was replaced.`
    : `Versions ${gap.from} to ${gap.to} were not kept. They could not be saved in the history when they were replaced.`;
}

/** Sites an app may reach, as words: their addresses, or "none". */
export const sitesInWords = (sites: string[]): string => (sites.length ? sites.join(', ') : 'none');

/** A database change by the name of its file: server/migrations/002_tags.sql is 002_tags.sql. */
export const databaseChangeName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
