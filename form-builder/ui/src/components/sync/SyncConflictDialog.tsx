import { useEffect, useState } from 'react';
import { CloudOff, Cloud, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { formatDate } from '../../lib/utils';

type Choice = 'mine' | 'cloud';

// Server timestamps are MySQL UTC ("Y-m-d H:i:s"); normalize to UTC ISO so the displayed time is right.
function showTime(s: string): string {
  try {
    return formatDate(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  } catch {
    return s;
  }
}

/**
 * Shown when reconnecting to the cloud finds forms that changed BOTH offline and in the cloud.
 * The user picks which version to keep per form; the store applies the choices (and finishes
 * switching to cloud if this was a reconnect).
 */
export function SyncConflictDialog() {
  const conflicts = useFormStore((s) => s.syncConflicts);
  const resolveSyncConflicts = useFormStore((s) => s.resolveSyncConflicts);
  const [decisions, setDecisions] = useState<Record<string, Choice>>({});
  const [applying, setApplying] = useState(false);
  // FL-SYNC-001: Escape/backdrop/X must be NON-MUTATING — it used to apply the default
  // resolution (push every offline copy over the cloud). Dismissing now just postpones:
  // both copies stay untouched and the conflicts resurface on the next sync/reconnect.
  const [postponed, setPostponed] = useState(false);
  useEffect(() => {
    setPostponed(false); // a fresh conflict set (next sync attempt) re-opens the dialog
  }, [conflicts]);

  const open = !!conflicts && conflicts.length > 0 && !postponed;
  const choiceFor = (id: string): Choice => decisions[id] ?? 'mine';

  const setAll = (v: Choice) => {
    const next: Record<string, Choice> = {};
    (conflicts ?? []).forEach((c) => { next[c.id] = v; });
    setDecisions(next);
  };

  const apply = async () => {
    if (!conflicts || applying) return;
    setApplying(true);
    const full: Record<string, Choice> = {};
    conflicts.forEach((c) => { full[c.id] = choiceFor(c.id); });
    try {
      // Failures keep their conflicts in the store, so the dialog simply stays open
      // showing what's left (the store toasts the operation-level report).
      await resolveSyncConflicts(full);
    } finally {
      setApplying(false);
    }
  };

  const postpone = () => {
    if (applying) return;
    setPostponed(true);
    toast.info(
      'Sync conflicts postponed',
      'Nothing was changed — your offline and cloud copies are both untouched. They will come up again on the next sync.'
    );
  };

  const choiceBtn = (active: boolean) =>
    `flex-1 text-left rounded-lg border p-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 ${
      active
        ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
        : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
    }`;

  return (
    <Modal
      isOpen={open}
      // Non-mutating close (FL-SYNC-001): dismissal postpones, it never applies defaults.
      onClose={postpone}
      title="Resolve sync conflicts"
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 text-sm text-gray-600 dark:text-slate-300">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <p>These forms were changed both on this device (offline) and in the cloud. Choose which version to keep for each.</p>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-400 dark:text-slate-500">Quick:</span>
          <button type="button" onClick={() => setAll('mine')} className="font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">Keep all mine</button>
          <button type="button" onClick={() => setAll('cloud')} className="font-medium text-primary-600 dark:text-primary-400 hover:underline cursor-pointer">Keep all cloud</button>
        </div>

        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {(conflicts ?? []).map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-3">
              <p className="font-medium text-gray-900 dark:text-white text-sm mb-2.5 truncate">{c.title || 'Untitled form'}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setDecisions((d) => ({ ...d, [c.id]: 'mine' }))} className={choiceBtn(choiceFor(c.id) === 'mine')} aria-pressed={choiceFor(c.id) === 'mine'}>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white"><CloudOff className="h-4 w-4 text-gray-500 dark:text-slate-400" /> Keep mine</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">Offline · {showTime(c.localUpdatedAt)}</span>
                </button>
                <button type="button" onClick={() => setDecisions((d) => ({ ...d, [c.id]: 'cloud' }))} className={choiceBtn(choiceFor(c.id) === 'cloud')} aria-pressed={choiceFor(c.id) === 'cloud'}>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-white"><Cloud className="h-4 w-4 text-gray-500 dark:text-slate-400" /> Keep cloud</span>
                  <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">Cloud · {showTime(c.serverUpdatedAt)}</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" onClick={postpone} disabled={applying}>Decide later</Button>
          <Button onClick={apply} isLoading={applying}>Apply</Button>
        </div>
      </div>
    </Modal>
  );
}
