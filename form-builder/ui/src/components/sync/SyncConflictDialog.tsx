import { useState } from 'react';
import { CloudOff, Cloud, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useFormStore } from '../../stores/formStore';
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

  const open = !!conflicts && conflicts.length > 0;
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
      await resolveSyncConflicts(full);
    } finally {
      setApplying(false);
      setDecisions({});
    }
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
      // Closing keeps the current choices (default: keep mine) so the user is never stuck mid-reconnect.
      onClose={() => { void apply(); }}
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

        <div className="flex justify-end pt-1">
          <Button onClick={apply} isLoading={applying}>Apply</Button>
        </div>
      </div>
    </Modal>
  );
}
