import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type AppEngine, type NativeRuntimePreflight, type OwnerEnginePolicy } from '../../lib/api';
import { importNativeProject, type NativeProject } from '../../lib/nativeHosting';
import { nativeDraftStore, type NativeDraftCheckpoint, type NativeDraftWrite } from '../../lib/nativeDraft';
import { useAuthStore } from '../../stores/authStore';

/** A checkpoint is written this long after the last change, so typing does not serialise the project per keystroke. */
const CHECKPOINT_DELAY = 400;

/**
 * Audit FL-S08: the footer label and leave prompt for a dirty draft, from what
 * its last checkpoint actually did. 'waiting' is an open draft held back while
 * an earlier stored draft awaits Recover or Discard.
 */
export const DRAFT_KEEPING: Record<NativeDraftWrite | 'waiting', readonly [label: string, leave: string]> = {
  kept: ['kept in this browser', 'Your draft is kept in this browser and offered again when you reopen this app.'],
  waiting: ['not kept until the earlier draft is recovered or discarded', 'Your current changes are not kept in this browser until the earlier draft is recovered or discarded, so they will be lost if you leave.'],
  'too-large': ['not kept in this browser: too large', 'This draft is too large to keep in this browser, so your latest changes will be lost if you leave.'],
  full: ['not kept in this browser: no room left for drafts', 'Unpublished drafts for other apps or accounts already fill the room this browser keeps for drafts, so your latest changes will be lost if you leave. Publishing or discarding those drafts makes room.'],
  unavailable: ['not kept in this browser: storage refused it', 'This browser refused to store the draft, so your latest changes will be lost if you leave.'],
  unscoped: ['not kept in this browser', 'This draft is not kept in this browser, so your changes will be lost if you leave.'],
};

export interface NativeProjectDraft {
  /** The first read has answered (with the project or an error). */
  ready: boolean;
  /** The server can run native apps: artifacts prepared and the runtime starts. */
  available: boolean;
  preflight: NativeRuntimePreflight | null;
  readOnly: boolean;
  engine: AppEngine | undefined;
  enginePolicy: OwnerEnginePolicy | undefined;
  /** The open project: the installed one, or the draft being edited. */
  project: NativeProject | null;
  /** The installed version; 0 when nothing is installed. */
  version: number;
  dirty: boolean;
  /** The version the open draft is based on (a recovered draft keeps its own). */
  base: number | null;
  /** The draft is based on a version older than the installed one. */
  conflict: boolean;
  /** What the open draft's checkpoint did, or 'waiting' while an earlier draft awaits a decision. */
  keeping: NativeDraftWrite | 'waiting' | null;
  /** An earlier unpublished draft kept in this browser, awaiting Recover or Discard. */
  recoverable: NativeDraftCheckpoint | null;
  busy: boolean;
  error: string;
  notice: string;
  setError(message: string): void;
  setNotice(message: string): void;
  /** Every change to the open draft; the first on a clean draft bases it on the installed version. */
  edit(next: NativeProject): void;
  /** Take the earlier draft; returns it, or null when there is none or the owner declined. */
  recoverDraft(): NativeProject | null;
  discardDraft(): void;
  /** Import a .softn file into the draft; returns it, or null when it could not be read. */
  importFile(file: File | undefined, notice?: string): Promise<NativeProject | null>;
  /**
   * Install the draft (or `project`, a draft just made with edit()) as the next version;
   * returns the installed project, or null (the error is set). With `raise`, a save that did
   * not happen throws its reason instead, for a caller that reports it itself (an editor).
   */
  save(options?: { confirmConflict?: boolean; project?: NativeProject; notice?: string; raise?: boolean }): Promise<NativeProject | null>;
  /** Drop the open draft and its checkpoint, back to the installed version. */
  revert(): void;
  /** Re-read the engine block after the owner changed their choice. */
  refreshEngine(): Promise<void>;
  /** Write a pending checkpoint at once; returns what it did. */
  flush(): NativeDraftWrite | null;
  /** The question to ask before leaving a dirty draft. */
  leaveMessage(prefix?: string): string;
  /** True while an import or install is in flight: nothing else may start. */
  isLocked(): boolean;
}

/**
 * An app's native project as its owner edits it: read from the server, edited as
 * a draft that is checkpointed in this browser for this account and app (audit
 * FL-S08) and offered back on reopen, and installed as the next version only when
 * the owner publishes. A draft is never published by itself.
 */
export function useNativeProjectDraft(app: { id: string; slug: string; name: string }, options: { onInstalled?: (project: NativeProject) => void; reloadKey?: unknown } = {}): NativeProjectDraft {
  const [project, setProject] = useState<NativeProject | null>(null);
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  // Runtime preflight (audit FL-03): artifacts can be prepared while the runtime still cannot start.
  const [preflight, setPreflight] = useState<NativeRuntimePreflight | null>(null);
  // The server's engine decision for this app, and what this site lets the owner choose between.
  const [engine, setEngine] = useState<AppEngine | undefined>(undefined);
  const [enginePolicy, setEnginePolicy] = useState<OwnerEnginePolicy | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The shared demo browses the project, source and records read-only: the server says so, and
  // until it has (or if it could not) the account does. Nothing can be imported, edited or
  // published, so nothing is ever dirty, checkpointed or asked about when leaving.
  const isDemo = useAuthStore(state => !!state.user?.isDemo);
  const [serverReadOnly, setServerReadOnly] = useState<boolean | null>(null);
  const readOnly = serverReadOnly ?? isDemo;
  const userId = useAuthStore(state => state.user?.id);
  const drafts = useMemo(() => nativeDraftStore(userId, app.id), [userId, app.id]);
  const [recoverable, setRecoverable] = useState<NativeDraftCheckpoint | null>(null);
  // The version the open draft is based on, and what its last checkpoint write did: rendered,
  // and read at once by the leave prompt, which can run before that render commits.
  const [base, setBase] = useState<number | null>(null);
  const [kept, setKept] = useState<NativeDraftWrite | null>(null);
  const lastWrite = useRef<NativeDraftWrite | null>(null);
  const pending = useRef<NativeDraftCheckpoint | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lock = useRef(false);
  const alive = useRef(true);
  const onInstalled = useRef(options.onInstalled);
  useLayoutEffect(() => { onInstalled.current = options.onInstalled; });

  // Read by a reload (after the source editor installed a version): an open draft is kept, and
  // compared with what is installed now, rather than replaced by it.
  const dirtyNow = useRef(false);
  useLayoutEffect(() => { dirtyNow.current = dirty; }, [dirty]);
  useEffect(() => {
    let cancelled = false; alive.current = true;
    void api.getNativeProject(app.id).then(result => {
      if (cancelled) return;
      setReady(!result.error); setAvailable(!!result.data?.available && result.data?.ready !== false); setPreflight(result.data?.preflight ?? null);
      if (typeof result.data?.readOnly === 'boolean') setServerReadOnly(result.data.readOnly);
      setEngine(result.data?.engine); setEnginePolicy(result.data?.enginePolicy);
      if (result.error) setError(result.error);
      const keepDraft = dirtyNow.current;
      if (result.data?.project) { if (!keepDraft) setProject(result.data.project); setVersion(result.data.project.version); installed.current = result.data.project; }
      // A read-only editor has no draft to offer back; an open draft's checkpoint is its own.
      if (!result.error && !keepDraft && !(result.data?.readOnly ?? isDemo)) setRecoverable(drafts.read());
    });
    return () => { cancelled = true; alive.current = false; };
  }, [app.id, drafts, isDemo, options.reloadKey]);

  // A pending checkpoint is written at once before anything that could lose
  // it (leaving, closing, unmounting); the result says what was really kept.
  const flush = useCallback((): NativeDraftWrite | null => {
    clearTimeout(timer.current);
    const checkpoint = pending.current;
    if (!checkpoint) return null;
    pending.current = null;
    const result = lastWrite.current = drafts.write(checkpoint);
    if (alive.current) setKept(result);
    return result;
  }, [drafts]);
  // Changes to a dirty draft refresh its checkpoint shortly after the last one,
  // except while an earlier stored draft awaits Recover or Discard: that draft
  // is never overwritten by edits made before the owner decides. Leaving the
  // page with a dirty draft is asked about, as every other editor in the app does.
  useEffect(() => {
    if (!dirty || !project || recoverable || readOnly) { pending.current = null; return; }
    pending.current = { baseVersion: base ?? version, savedAt: new Date().toISOString(), project };
    timer.current = setTimeout(flush, CHECKPOINT_DELAY);
    return () => clearTimeout(timer.current);
  }, [dirty, project, base, version, recoverable, readOnly, flush]);
  useEffect(() => () => { flush(); }, [flush]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { flush(); event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('pagehide', flush); };
  }, [dirty, flush]);

  // The open project as of the latest edit, for a save that follows an edit in the same handler.
  const current = useRef<NativeProject | null>(null);
  useLayoutEffect(() => { current.current = project; }, [project]);
  const installed = useRef<NativeProject | null>(null);
  const edit = useCallback((next: NativeProject) => {
    if (readOnly) return;
    current.current = next;
    setProject(next); setBase(previous => previous ?? version); setDirty(true);
  }, [readOnly, version]);
  const revert = () => {
    clearTimeout(timer.current); pending.current = null; lastWrite.current = null;
    if (!recoverable) drafts.clear();
    setProject(installed.current); current.current = installed.current;
    setDirty(false); setBase(null); setKept(null); setError('');
    setNotice('Your unpublished changes were discarded.');
  };
  // The engine block from a server answer. Absent (an older server, or a resolver that could not
  // answer after an install) keeps what is already shown.
  const takeEngine = (data: { engine?: AppEngine; enginePolicy?: OwnerEnginePolicy }) => {
    if (!data.engine || !data.enginePolicy) return;
    setEngine(data.engine); setEnginePolicy(data.enginePolicy);
  };
  // After a choice is stored, the engine is re-read from this project's own GET rather than
  // shown from the PUT's answer: the PUT answers for the whole column (hosted and native
  // bundles merged), while this is about the native project alone.
  const refreshEngine = async () => {
    const result = await api.getNativeProject(app.id);
    if (!alive.current || result.error || !result.data) return;
    takeEngine(result.data);
  };
  const conflict = dirty && base !== null && base !== version;
  const leaveMessage = (prefix = 'Close without publishing?') => `${prefix} ${DRAFT_KEEPING[recoverable ? 'waiting' : flush() ?? lastWrite.current ?? 'unscoped'][1]}`;
  const recoverDraft = (): NativeProject | null => {
    if (!recoverable) return null;
    if (dirty && !window.confirm('Recover the earlier draft? It replaces your current changes, which are not kept in this browser.')) return null;
    const recovered = { ...recoverable.project, version };
    setProject(recovered);
    setBase(recoverable.baseVersion); setDirty(true); setRecoverable(null); setError('');
    setNotice('Recovered your unpublished draft. Review it, then publish when ready.');
    return recovered;
  };
  // The open draft waited on this decision, so it is checkpointed now rather than after its next change.
  const discardDraft = () => {
    drafts.clear(); setRecoverable(null); setNotice('The unpublished draft was discarded.');
    if (dirty && project) { pending.current = { baseVersion: base ?? version, savedAt: new Date().toISOString(), project }; flush(); }
  };
  async function importFile(file: File | undefined, message = 'Imported as a draft. Review its backend and access mode before installing.'): Promise<NativeProject | null> {
    if (!file || lock.current || readOnly) return null;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const imported = await importNativeProject(file);
      if (!alive.current) return null;
      // An import into a dirty draft keeps that draft's base: it may be the draft's own download, edited and brought back.
      const next = { ...imported, home: project?.home ?? false, access: project?.access ?? imported.access };
      edit(next);
      setNotice(message);
      return next;
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : 'Could not import the project.');
      return null;
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save({ confirmConflict = true, project: given, notice: message = 'Installed. The app uses its private SQLite database and ZIPP backend. Existing records were preserved.', raise = false }: { confirmConflict?: boolean; project?: NativeProject; notice?: string; raise?: boolean } = {}): Promise<NativeProject | null> {
    const project = given ?? current.current;
    if (!project || lock.current || !ready || readOnly) {
      if (raise) throw new Error(readOnly ? 'This app is read-only.' : 'The app is busy. Try again in a moment.');
      return null;
    }
    if (confirmConflict && conflict && !window.confirm(`Publish this draft? It is based on version ${base}, so publishing replaces version ${version}, which was published after it.`)) return null;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.saveNativeProject(app.id, project, version);
      if (!alive.current) return null;
      if (result.error || !result.data) {
        const reason = result.error || 'Installation failed. Your draft is still here.';
        if (raise) throw new Error(reason);
        setError(reason); return null;
      }
      // The published draft's checkpoint is spent; an earlier one still awaiting Recover or Discard is not it, and stays.
      clearTimeout(timer.current); pending.current = null; lastWrite.current = null;
      if (!recoverable) drafts.clear();
      setProject(result.data.project); setVersion(result.data.project.version); setDirty(false); setBase(null); setKept(null);
      installed.current = result.data.project; current.current = result.data.project;
      // The server decided the engine again from the project just installed (a `.py` added or removed changes it).
      takeEngine(result.data);
      setNotice(message);
      onInstalled.current?.(result.data.project);
      return result.data.project;
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }

  return {
    ready, available, preflight, readOnly, engine, enginePolicy, project, version, dirty, base, conflict,
    keeping: recoverable ? 'waiting' : kept, recoverable, busy, error, notice, setError, setNotice,
    edit, recoverDraft, discardDraft, importFile, save, revert, refreshEngine, flush, leaveMessage,
    isLocked: () => lock.current,
  };
}
