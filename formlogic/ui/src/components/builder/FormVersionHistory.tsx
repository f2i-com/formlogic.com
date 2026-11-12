import { deferEffect } from '../../lib/deferredEffect';
import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, History, RotateCcw, Loader2, Inbox } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { formatRelativeTime } from '../../lib/utils';

// One read's worth of rows. Every autosave adds a row, so the older ones are a page away.
const VERSIONS_PAGE = 50;

interface VersionRow {
  id: string;
  version: number;
  changelog: string | null;
  createdAt: string;
}

interface FormVersionHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  onRestored?: () => void;
}

/**
 * Lists a form's saved version snapshots (created on every save) and lets the
 * author roll back to a previous version. Wires the previously dead
 * getFormVersions / restoreFormVersion endpoints.
 */
export function FormVersionHistory(props: FormVersionHistoryProps) {
  return <FormVersionHistoryVisit key={props.formId} {...props} />;
}
function FormVersionHistoryVisit({ isOpen, onClose, formId, onRestored }: FormVersionHistoryProps) {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Set when the last page came back full, so older versions may remain.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  /** One page of versions, after the `offset` newest. A failure comes back as `{ error }`. */
  const readPage = useCallback(async (offset: number) => {
    try {
      const result = await api.getFormVersions(formId, { limit: VERSIONS_PAGE, offset });
      if (result.error || !result.data) return { error: typeof result.error === 'string' ? result.error : 'Could not load version history.' };
      return { rows: result.data.versions as VersionRow[] };
    } catch {
      return { error: 'Could not load version history.' };
    }
  }, [formId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const page = await readPage(0);
    if (page.rows) {
      setVersions(page.rows);
      setHasOlder(page.rows.length === VERSIONS_PAGE);
    } else {
      setLoadError(page.error);
    }
    setLoading(false);
  }, [readPage]);

  const loadOlder = async () => {
    setLoadingOlder(true);
    const page = await readPage(versions.length);
    if (page.rows) {
      // A save in the meantime moves every row down one, so the next page can repeat the last.
      const shown = new Set(versions.map((v) => v.id));
      setVersions([...versions, ...page.rows.filter((v) => !shown.has(v.id))]);
      setHasOlder(page.rows.length === VERSIONS_PAGE);
    } else {
      toast.error('Failed to load history', page.error);
    }
    setLoadingOlder(false);
  };

  useEffect(() => deferEffect(() => {
    if (isOpen) void load();
  }), [isOpen, load]);

  const handleRestore = async (version: number) => {
    setRestoring(true);
    try {
      // The confirm dialog already warns this overwrites the current (possibly
      // published) form, so pass force to satisfy the backend's published-form guard.
      const result = await api.restoreFormVersion(formId, version, true);
      if (result.error) {
        toast.error('Restore failed', result.error);
      } else {
        toast.success('Version restored', `Restored to version ${version}.`);
        onRestored?.();
        onClose();
      }
    } catch (err) {
      toast.error('Restore failed', err instanceof Error ? err.message : 'Could not restore this version.');
    } finally {
      setRestoring(false);
      setRestoreTarget(null);
    }
  };

  return (
    <>
      {/* Taken before each save, so even the newest row is not what the form holds now. */}
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Version history"
        description="Each version is the form as it was just before a save, newest first."
        size="lg"
      >
        <div className="p-4 sm:p-6">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400 dark:text-slate-500" />
            </div>
          ) : loadError ? (
            <div role="alert" className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-amber-500" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">Could not load version history</p>
                <p className="text-xs mt-1 text-gray-500 dark:text-slate-400">{loadError}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>Try again</Button>
              </div>
            </div>
          ) : versions.length === 0 ? (
            <div className="flex items-start gap-3 text-gray-500 dark:text-slate-400">
              <Inbox className="mt-0.5 h-5 w-5 flex-none text-gray-400 dark:text-slate-500" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">No version history yet</p>
                <p className="text-xs mt-1">A snapshot is saved each time you edit the form.</p>
              </div>
            </div>
          ) : (
            // A list: one line a version, hairlines between, the number in tabular figures.
            <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-slate-700">
              <ul className="divide-y divide-gray-200 dark:divide-slate-700">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 py-1.5 pl-3 pr-2 hover:bg-gray-50 dark:hover:bg-slate-800/50">
                    <History className="h-3.5 w-3.5 flex-none text-gray-400 dark:text-slate-500" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-medium tabular-nums text-gray-900 dark:text-white">Version {v.version}</span>
                        <span className="text-xs text-gray-500 dark:text-slate-400">{formatRelativeTime(v.createdAt)}</span>
                      </p>
                      {v.changelog && <p className="text-xs text-gray-500 dark:text-slate-400 line-clamp-2">{v.changelog}</p>}
                    </div>
                    <Button variant="outline" size="sm" className="flex-none" onClick={() => setRestoreTarget(v.version)} leftIcon={<RotateCcw className="h-3.5 w-3.5" />}>
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
              {hasOlder && (
                <div className="border-t border-gray-200 p-1 dark:border-slate-700">
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => void loadOlder()} isLoading={loadingOlder}>
                    Show older versions
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => { if (restoreTarget !== null) handleRestore(restoreTarget); }}
        title="Restore this version?"
        message={`This replaces the current form with version ${restoreTarget}. The current state is saved as a new version first, so you can undo this.`}
        confirmLabel="Restore"
        isLoading={restoring}
      />
    </>
  );
}
