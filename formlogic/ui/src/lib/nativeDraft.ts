import type { NativeProject } from './nativeHosting';

/**
 * Audit FL-S08: a recoverable checkpoint of the native editor's unpublished
 * draft, kept in this browser so a reload, a closed tab or a crash does not
 * cost an afternoon of edits. It is scoped to the signed-in account and the
 * app, records the installed version the draft was based on (so a publish
 * elsewhere in the meantime is shown as a conflict, not silently replaced),
 * and is never published by itself: the owner recovers or discards it.
 *
 * Three states stay distinct: this local recoverable draft, the draft held in
 * the open editor, and the installed (published) project on the server.
 */
export interface NativeDraftCheckpoint {
  baseVersion: number;
  savedAt: string;
  project: NativeProject;
}

/**
 * What a write did: kept, or why nothing was kept (no account; the draft is
 * too large, alone or beside the other drafts; storage refused it). The
 * editor tells the owner exactly this, so a refused draft is never promised.
 */
export type NativeDraftWrite = 'kept' | 'unscoped' | 'too-large' | 'full' | 'unavailable';

const PREFIX = 'formlogic:native-draft:';
/**
 * An origin gets about 5 MiB of localStorage, shared with the studio's own
 * keys and every hosted app's nativeAppStorage (256 KiB each, same origin).
 * Drafts take at most 1 MiB each and 2 MiB together, leaving room for a dozen
 * hosted apps at their limit. A draft that does not fit is refused, never
 * made room for by evicting another draft: every other account's and app's
 * draft counts, including one an earlier version kept under a larger limit,
 * since it takes the same room until its owner publishes or discards it.
 */
const LIMIT = 1024 * 1024;
const BUDGET = 2 * 1024 * 1024;

/** Sources and media alone: a lower bound on the serialised length, as JSON only adds to them. */
function characters(project: NativeProject): number {
  let total = 0;
  for (const entries of [project.files, project.assets]) {
    for (const [name, value] of Object.entries(entries)) total += name.length + (typeof value === 'string' ? value.length : 0);
  }
  return total;
}

export function nativeDraftStore(userId: string | undefined, appId: string) {
  const key = userId ? `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(appId)}` : null;
  function read(): NativeDraftCheckpoint | null {
    if (!key) return null;
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<NativeDraftCheckpoint>;
      const project = value?.project;
      if (!value || typeof value.baseVersion !== 'number' || typeof value.savedAt !== 'string' || !project || typeof project !== 'object') return null;
      if (!project.files || typeof project.files !== 'object' || !project.assets || typeof project.assets !== 'object') return null;
      return { baseVersion: value.baseVersion, savedAt: value.savedAt, project: project as NativeProject };
    } catch { return null; }
  }
  /** A refused write leaves the previous checkpoint as it was. */
  function write(checkpoint: NativeDraftCheckpoint): NativeDraftWrite {
    if (!key) return 'unscoped';
    // Media-heavy drafts are refused before the whole project is serialised on every change.
    if (characters(checkpoint.project) > LIMIT) return 'too-large';
    const data = JSON.stringify(checkpoint);
    if (data.length > LIMIT) return 'too-large';
    try {
      let others = 0;
      for (let index = 0; index < localStorage.length; index++) {
        const name = localStorage.key(index);
        if (name && name !== key && name.startsWith(PREFIX)) others += name.length + (localStorage.getItem(name)?.length ?? 0);
      }
      if (others + key.length + data.length > BUDGET) return 'full';
      localStorage.setItem(key, data);
      return 'kept';
    } catch { return 'unavailable'; }
  }
  function clear(): void {
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* nothing to clear, or storage is unavailable */ }
  }
  return { read, write, clear };
}
