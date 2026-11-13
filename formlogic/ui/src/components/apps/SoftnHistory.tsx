// The History section of an app's own page, for SoftN and JavaScript apps alike: every version
// a later one replaced, what each changed, what differs between one and the app as it is now
// (file by file, a text file's two versions side by side), going back to one, pinning one so it
// is kept, and removing one from the history for good. The server keeps the versions and does
// the going back (NativeAppVersions); this shows them and asks. What is open is in the address
// (…/history/<version>?file=<path>), so Back returns to the list and a copied link lands on the
// same version.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronRight, Database, Globe, History as HistoryIcon, Pin, Trash2, Undo2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { LoadFailure } from '../ui/LoadFailure';
import { Panel } from '../ui/Panel';
import { HELP, ROW_BOX } from '../ui/listLook';
import { formatAbsoluteTimeTitle, formatRelativeTime } from '../flows/relativeTime';
import { api, type NativeVersion, type NativeVersionDetail, type NativeVersionList, type NativeVersionPath, type NativeVersionRestore } from '../../lib/api';
import { changesInWords, databaseChangeName as changeName, gapInWords, howInWords, sitesInWords, whoInWords } from '../../lib/nativeVersions';
import { softnWorkspacePath } from '../../lib/softnApps';
import { diffText, textLines, type DiffRow } from '../../lib/textDiff';
import { cn, formatBytes } from '../../lib/utils';
import type { App } from '../../types/app';

const link = 'font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300';
const pill = 'rounded-full px-2 py-0.5 text-[11px] font-semibold';
/** How many paths of one kind are listed before the rest are counted, and how many lines of a whole file are shown. */
const PATHS_SHOWN = 60;
const LINES_SHOWN = 400;
/** Said of a version one of whose kept files is gone: in its row, and where it is open. */
const DAMAGED = 'Damaged: one of this version’s files is missing from the history, so you cannot go back to it. You can remove it from the history.';
const rowButton = 'inline-flex w-11 flex-none items-center justify-center hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 disabled:opacity-50 dark:hover:bg-white/[0.03]';
const rowNote = 'px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200';

export function SoftnHistory({ app, version, open, file, backend, readOnly, waiting, onRestored }: {
  app: App;
  /** The version the page has installed: when it moves (a publish, an upload), the list is read again. */
  version: number;
  /** The version the address names (…/history/<n>), and the file open in it (?file=). */
  open?: number;
  file?: string;
  /** The app has a backend: a database, whose records a going back leaves alone. */
  backend: boolean;
  readOnly: boolean;
  /** Why going back has to wait (unpublished changes on the page), or null. */
  waiting: string | null;
  /** A version was gone back to: the page reads its project again and reloads its preview. */
  onRestored(result: NativeVersionRestore): void;
}) {
  const navigate = useNavigate();
  const [list, setList] = useState<NativeVersionList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The list, or why it could not be read: a failed read is not "no versions".
  useEffect(() => {
    let current = true;
    void api.getNativeVersions(app.id).then(result => {
      if (!current) return;
      if (result.error || !result.data) { setFailed(result.error || 'The server did not answer.'); return; }
      setFailed(null);
      setList(result.data);
    });
    return () => { current = false; };
  }, [app.id, version, attempt]);

  // The open version: its record, and what differs between it and the app now.
  const [detail, setDetail] = useState<{ of: number; data: NativeVersionDetail } | null>(null);
  const [detailFailed, setDetailFailed] = useState<{ of: number; message: string; gone: boolean } | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    if (open === undefined) return;
    let current = true;
    void api.getNativeVersionDetail(app.id, open).then(result => {
      if (!current) return;
      if (result.error || !result.data) { setDetailFailed({ of: open, message: result.error || 'The server did not answer.', gone: result.status === 404 }); return; }
      setDetailFailed(null);
      setDetail({ of: open, data: result.data });
    });
    return () => { current = false; };
  }, [app.id, open, version, detailAttempt]);
  const shown = detail && detail.of === open ? detail.data : null;
  const shownFailed = detailFailed && detailFailed.of === open ? detailFailed : null;

  const [error, setError] = useState('');
  const [pinning, setPinning] = useState<number | null>(null);
  const togglePin = useCallback(async (target: NativeVersion) => {
    setPinning(target.version); setError('');
    const result = await api.pinNativeVersion(app.id, target.version, !target.pinned);
    setPinning(null);
    if (result.error || !result.data) { setError(result.error || 'The pin could not be changed.'); return; }
    const pinned = result.data.pinned;
    setList(now => now && { ...now, versions: now.versions.map(row => row.version === target.version ? { ...row, pinned } : row) });
    setDetail(now => now && now.data.version.version === target.version ? { ...now, data: { ...now.data, version: { ...now.data.version, pinned } } } : now);
    // What is kept may have changed with it (an unpinned version past the newest ones is marked as going).
    setAttempt(n => n + 1);
  }, [app.id]);

  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restored, setRestored] = useState<NativeVersionRestore | null>(null);
  const goBack = async () => {
    if (!shown || restoring) return;
    setRestoring(true); setRestoreError('');
    // From the version this section is looking at: one published meanwhile is not gone back over unseen.
    const result = await api.restoreNativeVersion(app.id, shown.version.version, shown.current);
    setRestoring(false);
    if (result.error || !result.data) { setRestoreError(result.error || 'Going back did not happen. The app is as it was.'); return; }
    setConfirming(false);
    setRemoved(null);
    setRestored(result.data);
    onRestored(result.data);
    setAttempt(n => n + 1);
    navigate(softnWorkspacePath(app.id, 'history'), { replace: true });
  };

  // Removing a version from the history: asked first, since it cannot be undone.
  const [removing, setRemoving] = useState<NativeVersion | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [removed, setRemoved] = useState<number | null>(null);
  const askToRemove = (target: NativeVersion) => { setRemoveError(''); setRemoving(target); };
  const remove = async () => {
    if (!removing || removeBusy) return;
    const target = removing.version;
    setRemoveBusy(true); setRemoveError('');
    const result = await api.removeNativeVersion(app.id, target);
    setRemoveBusy(false);
    if (result.error || !result.data) { setRemoveError(result.error || 'The version was not removed. The history is as it was.'); return; }
    setRemoving(null);
    setRestored(null);
    setRemoved(target);
    setList(now => now && { ...now, versions: now.versions.filter(row => row.version !== target) });
    // What the history takes, and any note that went with the version, are read again.
    setAttempt(n => n + 1);
    if (open === target) navigate(softnWorkspacePath(app.id, 'history'), { replace: true });
  };

  const address = useCallback((target?: number, path?: string) => softnWorkspacePath(app.id, 'history', ...(target ? [String(target)] : [])) + (path ? `?file=${encodeURIComponent(path)}` : ''), [app.id]);

  if (failed && !list) {
    return <div className="mt-4"><LoadFailure compact title="The app’s history could not be loaded" message={failed} onRetry={() => { setFailed(null); setAttempt(n => n + 1); }} /></div>;
  }
  if (!list) return <p role="status" className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading history…</p>;

  const limits = list.limits;
  return (
    <div className="mt-4" data-testid="softn-history">
      <p className="mb-4 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
        Each time this app is published, the version it replaced is kept here. Open one to see what differs from the app as it is now, and go back to it if you need to.
      </p>
      {restored && <p role="status" className="mb-4 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        The app is as it was in version {restored.restored} again, saved as version {restored.version}.
        {restored.databaseAhead.length > 0 && <> Its database keeps the {restored.databaseAhead.length === 1 ? 'change' : 'changes'} made since: {restored.databaseAhead.map(changeName).join(', ')}.</>}
        {' '}<Link to={softnWorkspacePath(app.id, 'edit')} className="font-medium underline underline-offset-2">See it running</Link>
      </p>}
      {removed !== null && <p role="status" className="mb-4 rounded-xl bg-emerald-50 p-3 text-sm leading-6 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        Version {removed} was removed from the history. The app as it is now was not changed.
      </p>}
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {list.unreadable && <p role="note" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
        This app’s history could not be read, so only the current version is shown. The next time the app is published, the history starts again.
      </p>}

      {/* Wide: the versions beside the one that is open. Narrow: the list, then the open version in its place. */}
      <div className={cn('grid items-start gap-4', open !== undefined ? 'lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]')}>
        <Panel title="Versions" icon={<HistoryIcon className="h-4 w-4" />} className={cn(open !== undefined && 'max-lg:hidden')}>
          <ul className={ROW_BOX} aria-label="Versions">
            {list.versions.map(row => <VersionRow key={row.version} row={row} to={address(row.version)} isOpen={open === row.version} readOnly={readOnly}
              busy={pinning !== null || removeBusy} onPin={() => void togglePin(row)} onRemove={() => askToRemove(row)} />)}
          </ul>
          {/* Not where a version was replaced and could not be kept, or the history could not be read: that is said for what it is. */}
          {list.versions.length <= 1 && !list.unreadable && !list.versions[0]?.gap && <p className={cn(HELP, 'mt-3')}>Nothing has been replaced yet. The next time this app is published, the version it replaces is kept here.</p>}
          {/* What is kept, said whole: the size limit is the one thing that takes a pinned version. */}
          <p className={cn(HELP, 'mt-3')}>
            The newest {limits.versions} versions are kept. A pinned version is kept past the {limits.versions}.
            {' '}All within {formatBytes(limits.bytes)}: past that the oldest go, pinned ones last{list.bytes > 0 && <> (the history takes {formatBytes(list.bytes)} now)</>}.
          </p>
        </Panel>

        {open === undefined
          ? (list.versions.length > 1 && <p className="hidden pt-3 text-sm text-slate-500 dark:text-slate-400 lg:block">Choose a version to see what differs from the app as it is now.</p>)
          : <div className="min-w-0">
            <Link to={address()} className="mb-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary-600 dark:text-primary-300 lg:hidden"><ArrowLeft className="h-4 w-4" aria-hidden="true" />All versions</Link>
            {shownFailed?.gone && <Panel title={`Version ${open}`} icon={<HistoryIcon className="h-4 w-4" />}>
              <p className="text-sm text-slate-600 dark:text-slate-300">Version {open} is not kept any more. <Link to={address()} className={link}>All versions</Link></p>
            </Panel>}
            {shownFailed && !shownFailed.gone && <LoadFailure compact title={`Version ${open} could not be loaded`} message={shownFailed.message} onRetry={() => { setDetailFailed(null); setDetailAttempt(n => n + 1); }} />}
            {!shown && !shownFailed && <p role="status" className="pt-3 text-sm text-slate-500 dark:text-slate-400">Loading version {open}…</p>}
            {shown && <VersionPanel appId={app.id} detail={shown} file={file} address={address} readOnly={readOnly} waiting={waiting} limit={limits.versions}
              busy={pinning !== null || removeBusy} onPin={() => void togglePin(shown.version)} onGoBack={() => { setRestoreError(''); setConfirming(true); }} onRemove={() => askToRemove(shown.version)} />}
          </div>}
      </div>

      {shown && <ConfirmDialog isOpen={confirming} onClose={() => { if (!restoring) setConfirming(false); }} onConfirm={() => void goBack()} isLoading={restoring}
        title={`Go back to version ${shown.version.version}?`} confirmLabel={`Go back to version ${shown.version.version}`}
        message={`The app becomes what it was in version ${shown.version.version}. That is saved as a new version, ${shown.current + 1}, so version ${shown.current} stays in the history and you can return to it.`}>
        <ul className="list-disc space-y-1.5 pl-4 text-sm text-gray-600 dark:text-slate-300">
          <li>{backend ? 'Records in the app’s database stay as they are. Nothing is deleted.' : 'What people have saved in their browsers stays as it is.'}</li>
          {/* The manifest is one of the app's files: what it lets the app do comes back with it. */}
          <li>The app’s settings that are kept in its files go back too: what it asks this server for, and the outside sites it may reach, become what version {shown.version.version} had.</li>
          <li>Who can use the app, and its address, stay as they are now.</li>
          {app.status === 'published' && <li>The app is live, so visitors get this version at once.</li>}
        </ul>
        {(shown.differs.outside || shown.differs.asks) && <div role="note" data-testid="softn-history-settings-back" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {shown.differs.outside && <>
            <p className="font-semibold">The outside sites the app may reach go back to version {shown.version.version}’s.</p>
            <p className="mt-1 break-all">Version {shown.version.version} may reach: {sitesInWords(shown.outside.version)}.</p>
            <p className="break-all">The app now may reach: {sitesInWords(shown.outside.now)}.</p>
          </>}
          {shown.differs.asks && <p className={cn(shown.differs.outside && 'mt-2', 'font-semibold')}>What the app asks this server for goes back to what version {shown.version.version} asked for.</p>}
        </div>}
        {shown.databaseAhead.length > 0 && <div role="note" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="font-semibold">Version {shown.version.version} was written before {shown.databaseAhead.length === 1 ? 'this database change' : 'these database changes'}:</p>
          <ul className="mt-1 list-disc pl-4 font-mono">{shown.databaseAhead.map(path => <li key={path} className="break-all">{changeName(path)}</li>)}</ul>
          <p className="mt-1">{shown.databaseAhead.length === 1 ? 'It stays' : 'They stay'} applied to the database, and this version’s code may not expect {shown.databaseAhead.length === 1 ? 'it' : 'them'}. Check the app after going back.</p>
        </div>}
        {restoreError && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{restoreError}</p>}
      </ConfirmDialog>}

      {removing && <ConfirmDialog isOpen onClose={() => { if (!removeBusy) setRemoving(null); }} onConfirm={() => void remove()} isLoading={removeBusy} variant="danger"
        title={`Remove version ${removing.version} from the history?`} confirmLabel="Remove from history"
        message={`Version ${removing.version}’s files are deleted from the history.`}>
        <ul className="list-disc space-y-1.5 pl-4 text-sm text-gray-600 dark:text-slate-300">
          <li>The app as it is now is not changed.</li>
          <li>You will not be able to look at version {removing.version} or go back to it.</li>
          <li>This cannot be undone.</li>
        </ul>
        {removeError && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{removeError}</p>}
      </ConfirmDialog>}
    </div>
  );
}

/**
 * One version in the list: the row that opens it, its pin, and for an earlier version the way to
 * remove it from the history. Under it, what the history says is missing before it.
 */
function VersionRow({ row, to, isOpen, readOnly, busy, onPin, onRemove }: {
  row: NativeVersion; to: string; isOpen: boolean; readOnly: boolean; busy: boolean; onPin(): void; onRemove(): void;
}) {
  return <>
    <li className="flex items-stretch">
      <Link to={to} aria-current={isOpen ? 'true' : undefined}
        className={cn('min-h-11 min-w-0 flex-1 px-3 py-2.5 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-white/[0.03]',
          isOpen && 'bg-primary-50/60 dark:bg-primary-500/10')}>
        <VersionLines row={row} />
      </Link>
      {!readOnly && <button type="button" aria-pressed={row.pinned} disabled={busy}
        aria-label={row.pinned ? `Unpin version ${row.version}` : `Pin version ${row.version}`} title={row.pinned ? 'Pinned: kept past the newest versions. Unpin' : 'Pin: keep this version'}
        onClick={onPin} className={cn(rowButton, row.pinned ? 'text-primary-600 dark:text-primary-300' : 'text-slate-400 dark:text-slate-500')}>
        <Pin className={cn('h-4 w-4', row.pinned && 'fill-current')} aria-hidden="true" />
      </button>}
      {/* The current version is the app, not its history: it has nothing to remove, and keeps the column. */}
      {!readOnly && (row.current
        ? <span className="w-11 flex-none" aria-hidden="true" />
        : <button type="button" disabled={busy || row.pinned} data-remove={row.version}
          aria-label={row.pinned ? `Version ${row.version} is pinned: unpin it to remove it from the history` : `Remove version ${row.version} from the history`}
          title={row.pinned ? 'Pinned: unpin it to remove it' : 'Remove from history'}
          onClick={onRemove} className={cn(rowButton, 'text-slate-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400')}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>)}
    </li>
    {row.gap && <li className={rowNote}>{gapInWords(row.gap)}</li>}
    {row.startedAgain && <li className={rowNote}>The history from before version {row.version} could not be read, so it starts again here.</li>}
  </>;
}

/** One version in a few lines a person can scan: its number and when, how and who, its summary, what it changed. */
function VersionLines({ row }: { row: NativeVersion }) {
  const who = whoInWords(row);
  const changes = changesInWords(row.changes);
  return <>
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-sm font-semibold text-slate-900 dark:text-white">Version {row.version}</span>
      {row.current && <span className={cn(pill, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300')}>Current</span>}
      {row.pinned && <span className={cn(pill, 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')}>Pinned</span>}
      {row.madeAt && <time dateTime={row.madeAt} title={formatAbsoluteTimeTitle(row.madeAt)} className="text-xs text-slate-500 dark:text-slate-400">{formatRelativeTime(row.madeAt)}</time>}
    </span>
    <span className="mt-0.5 block text-xs leading-5 text-slate-600 dark:text-slate-300">{howInWords(row)}{who && <> · {who}</>}</span>
    {row.summary && row.how !== 'rollback' && <span className="block break-words text-xs leading-5 text-slate-900 dark:text-slate-100">{row.summary}</span>}
    {changes && <span className="block text-xs leading-5 text-slate-500 dark:text-slate-400">{changes}</span>}
    {row.expires && <span className="block text-xs leading-5 text-amber-700 dark:text-amber-300">Not pinned and past the newest kept: it goes at the next publish.</span>}
    {row.damaged && <span className="block text-xs leading-5 text-red-700 dark:text-red-300">{DAMAGED}</span>}
  </>;
}

function VersionPanel({ appId, detail, file, address, readOnly, waiting, limit, busy, onPin, onGoBack, onRemove }: {
  appId: string; detail: NativeVersionDetail; file?: string; address(target?: number, path?: string): string;
  readOnly: boolean; waiting: string | null; limit: number; busy: boolean; onPin(): void; onGoBack(): void; onRemove(): void;
}) {
  const row = detail.version;
  const { differs } = detail;
  const total = differs.added.length + differs.removed.length + differs.changed.length;
  const paths = row.changes?.paths;
  return <Panel title={<span className="flex flex-wrap items-center gap-2">Version {row.version}{row.current && <span className={cn(pill, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300')}>Current</span>}</span>}
    icon={<HistoryIcon className="h-4 w-4" />}>
    <div className="text-xs leading-5 text-slate-600 dark:text-slate-300">
      <p>{howInWords(row)}{whoInWords(row) && <> · {whoInWords(row)}</>}{row.madeAt && <> · <time dateTime={row.madeAt} title={formatAbsoluteTimeTitle(row.madeAt)}>{formatRelativeTime(row.madeAt)}</time></>}</p>
      {row.summary && row.how !== 'rollback' && <p className="break-words text-slate-900 dark:text-slate-100">{row.summary}</p>}
      {changesInWords(row.changes) && <p className="text-slate-500 dark:text-slate-400">{row.changes?.first ? '' : 'It changed: '}{changesInWords(row.changes)}</p>}
    </div>

    {!readOnly && <div className="mt-3 flex flex-wrap items-center gap-2">
      {!row.current && <Button size="sm" leftIcon={<Undo2 className="h-4 w-4" />} disabled={waiting !== null || row.damaged} onClick={onGoBack}>Go back to this version</Button>}
      <Button size="sm" variant="secondary" leftIcon={<Pin className={cn('h-4 w-4', row.pinned && 'fill-current')} />} disabled={busy} aria-pressed={row.pinned} onClick={onPin}>{row.pinned ? 'Unpin' : 'Pin this version'}</Button>
      {!row.current && <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-4 w-4" />} disabled={busy || row.pinned} onClick={onRemove}>Remove from history</Button>}
    </div>}
    {row.damaged && <p role="note" className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{DAMAGED}</p>}
    {!readOnly && !row.current && waiting && <p className={cn(HELP, 'mt-2')}>{waiting}</p>}
    {!readOnly && <p className={cn(HELP, 'mt-2')}>{row.pinned ? `Pinned: it is kept past the newest ${limit}.${row.current ? '' : ' Unpin it to remove it from the history.'}` : `Pinned versions are kept past the newest ${limit}.`}</p>}

    {!row.current && (differs.outside || differs.asks) && <p role="note" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
      <Globe className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <span>
        {differs.outside && <>This version may reach other outside sites than the app does now (<span className="break-all">{sitesInWords(detail.outside.version)}</span>, against <span className="break-all">{sitesInWords(detail.outside.now)}</span> now). </>}
        {differs.asks && <>This version asks this server for other things than the app does now. </>}
        Going back brings this version’s own back.
      </span>
    </p>}

    {detail.databaseAhead.length > 0 && <p role="note" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
      <Database className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <span>The app’s database has {detail.databaseAhead.length === 1 ? 'a change' : 'changes'} made after this version: <span className="break-all font-mono">{detail.databaseAhead.map(changeName).join(', ')}</span>. Going back keeps {detail.databaseAhead.length === 1 ? 'it' : 'them'}, and the records.</span>
    </p>}

    {row.current
      ? <div className="mt-4 border-t border-slate-100 pt-3 dark:border-white/5">
        <p className="text-sm text-slate-600 dark:text-slate-300">This is the app as it is now.</p>
        {paths && !row.changes?.first && <>
          <PathNames title="Changed" paths={paths.changed} count={row.changes!.changed} />
          <PathNames title="Added" paths={paths.added} count={row.changes!.added} />
          <PathNames title="Removed" paths={paths.removed} count={row.changes!.removed} />
        </>}
      </div>
      : <section aria-label="What differs from the app now" className="mt-4 border-t border-slate-100 pt-3 dark:border-white/5">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">What differs from the app now (version {detail.current})</h3>
        {total === 0 && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Nothing: this version holds the same files as the app now.{(differs.access || differs.home) && ' Who can use the app or its address has changed since, and going back leaves those as they are.'}</p>}
        <PathGroup appId={appId} detail={detail} kind="changed" title="Changed since" entries={differs.changed} file={file} address={address} />
        <PathGroup appId={appId} detail={detail} kind="removed" title={`Only in version ${row.version}`} hint="removed since" entries={differs.removed} file={file} address={address} />
        <PathGroup appId={appId} detail={detail} kind="added" title="Only in the app now" hint="added since" entries={differs.added} file={file} address={address} />
      </section>}
  </Panel>;
}

/** The paths one version changed, by name alone (the current version has nothing to be compared with). */
function PathNames({ title, paths, count }: { title: string; paths: string[]; count: number }) {
  if (count === 0) return null;
  const listed = paths.slice(0, PATHS_SHOWN);
  return <div className="mt-3">
    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title} · {count}</h4>
    <ul className="mt-1 space-y-0.5 font-mono text-xs leading-5 text-slate-700 dark:text-slate-200">{listed.map(path => <li key={path} className="break-all">{path}</li>)}</ul>
    {count > listed.length && <p className={cn(HELP, 'mt-1')}>and {count - listed.length} more</p>}
  </div>;
}

type DifferKind = 'changed' | 'removed' | 'added';

/** One kind of difference, path by path: a text file opens in place, a media or built file is named. */
function PathGroup({ appId, detail, kind, title, hint, entries, file, address }: {
  appId: string; detail: NativeVersionDetail; kind: DifferKind; title: string; hint?: string; entries: NativeVersionPath[]; file?: string; address(target?: number, path?: string): string;
}) {
  if (entries.length === 0) return null;
  // The file the address names is always among those listed, wherever it stands in the list.
  const at = file ? entries.findIndex(entry => entry.path === file) : -1;
  const listed = entries.slice(0, PATHS_SHOWN);
  if (at >= PATHS_SHOWN) listed.push(entries[at]);
  return <div className="mt-3">
    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title} · {entries.length}{hint && <span className="font-normal normal-case tracking-normal"> ({hint})</span>}</h4>
    <ul className={cn(ROW_BOX, 'mt-1')}>
      {listed.map(entry => {
        const isOpen = entry.text && entry.path === file;
        return <li key={entry.path}>
          {entry.text
            ? <Link to={address(detail.version.version, isOpen ? undefined : entry.path)} replace aria-expanded={isOpen}
              className="flex min-h-11 items-center gap-2 px-3 py-2 font-mono text-xs text-slate-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:text-slate-100 dark:hover:bg-white/[0.03]">
              {isOpen ? <ChevronDown className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />}
              <span className="min-w-0 break-all">{entry.path}</span>
            </Link>
            : <p className="flex min-h-11 flex-wrap items-center gap-x-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
              <span className="min-w-0 break-all font-mono">{entry.path}</span><span className="text-slate-500 dark:text-slate-400">media or built file, not shown</span>
            </p>}
          {isOpen && <FileCompare key={`${detail.version.version}:${entry.path}`} appId={appId} version={detail.version.version} current={detail.current} path={entry.path} kind={kind} />}
        </li>;
      })}
    </ul>
    {entries.length > listed.length && <p className={cn(HELP, 'mt-1')}>and {entries.length - listed.length} more</p>}
  </div>;
}

/**
 * A text file's two versions: side by side where there is room, one above the other on a phone.
 * Both are read from the server (the version's, and the app's as it is now), so what is compared
 * is what the server holds, whatever this page last read.
 */
function FileCompare({ appId, version, current, path, kind }: { appId: string; version: number; current: number; path: string; kind: DifferKind }) {
  const [texts, setTexts] = useState<{ before: string | null; after: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // A file only one of the two holds is read from that one alone.
    void Promise.all([
      kind === 'added' ? null : api.getNativeVersionFile(appId, version, path),
      kind === 'removed' ? null : api.getNativeVersionFile(appId, current, path),
    ]).then(([before, after]) => {
      if (!live) return;
      const problem = before?.error || after?.error;
      if (problem || (before && !before.data) || (after && !after.data)) { setFailed(problem || 'The server did not answer.'); return; }
      setFailed(null);
      setTexts({ before: before?.data?.text ?? null, after: after?.data?.text ?? null });
    });
    return () => { live = false; };
  }, [appId, version, current, path, kind, attempt]);

  const diff = useMemo(() => texts && texts.before !== null && texts.after !== null ? diffText(texts.before, texts.after) : null, [texts]);
  if (failed) return <div className="p-3"><LoadFailure compact title="This file could not be loaded" message={failed} onRetry={() => { setFailed(null); setAttempt(n => n + 1); }} /></div>;
  if (!texts) return <p role="status" className="p-3 text-xs text-slate-500 dark:text-slate-400">Loading the file…</p>;

  const beforeLabel = `Version ${version}`;
  const afterLabel = `Now (version ${current})`;
  if (!diff) {
    const whole = texts.before ?? texts.after ?? '';
    const lines = textLines(whole);
    return <div className="border-t border-slate-100 p-3 dark:border-white/5" data-testid="softn-history-file">
      <Pane label={texts.before !== null ? `${beforeLabel}, not in the app now` : `${afterLabel}, not in version ${version}`}
        rows={lines.slice(0, LINES_SHOWN).map((text, index) => ({ line: index + 1, text, changed: false }))} tone="before" />
      {lines.length > LINES_SHOWN && <p className={cn(HELP, 'mt-2')}>and {lines.length - LINES_SHOWN} more lines</p>}
    </div>;
  }
  return <div className="border-t border-slate-100 p-3 @container/compare dark:border-white/5" data-testid="softn-history-file">
    {diff.hunks.length === 0 && <p className="text-xs text-slate-600 dark:text-slate-300">The two have the same lines: they differ only in their line endings or a final line break.</p>}
    {!diff.exact && <p className={cn(HELP, 'mb-2')}>This file is too long to compare line by line: the part that differs is shown whole.</p>}
    <div className="space-y-3">
      {diff.hunks.map((hunk, index) => <div key={index} className="grid gap-2 @xl/compare:grid-cols-2">
        <Pane label={beforeLabel} rows={hunk.before} tone="before" />
        <Pane label={afterLabel} rows={hunk.after} tone="after" />
      </div>)}
    </div>
    {diff.hunks.length > 0 && <p className={cn(HELP, 'mt-2')}>
      {diff.removed} {diff.removed === 1 ? 'line' : 'lines'} only in version {version}, {diff.added} only in the app now.{diff.cut && ' There are more differences further down than are shown here.'}
    </p>}
  </div>;
}

/** One side of a comparison: its lines, numbered, wrapped (never scrolled sideways), the differing ones marked. */
function Pane({ label, rows, tone }: { label: string; rows: DiffRow[]; tone: 'before' | 'after' }): ReactNode {
  const marked = tone === 'before' ? 'bg-red-50 dark:bg-red-950/40' : 'bg-emerald-50 dark:bg-emerald-950/30';
  return <div role="group" aria-label={label} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
    <p className="border-b border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">{label}</p>
    {rows.length === 0
      ? <p className="px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">No lines here.</p>
      : <div className="font-mono text-xs leading-5 text-slate-800 dark:text-slate-100">
        {rows.map(row => <div key={row.line} className={cn('flex', row.changed && marked)}>
          <span className="w-10 flex-none select-none pr-2 text-right text-slate-400 dark:text-slate-500" aria-hidden="true">{row.line}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">{row.text === '' ? ' ' : row.text}</span>
        </div>)}
      </div>}
  </div>;
}
