import { useEffect, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { STRENGTH_WORDS } from '../../lib/passes';
import type { AccessReceipt } from '../../types/app';

/** What a pass says, in its plugin's words: "Age 18+". */
const valueOf = (receipt: AccessReceipt) => `${receipt.label} ${receipt.value}+`;

/**
 * The member's passes on this site, from its plugins: what each says, which plugin issued it, and a
 * way to withdraw it. What is kept is only what is listed here; withdrawing one closes the apps it
 * opened until they get it again. One of Settings' Security panels, at …/settings#passes.
 */
export function PassesPanel() {
  const [receipts, setReceipts] = useState<AccessReceipt[] | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getAccessReceipts().then((result) => {
      if (!cancelled) setReceipts(result.data?.receipts ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  const withdraw = async (receipt: AccessReceipt) => {
    setWithdrawing(receipt.id);
    const result = await api.revokeAccessReceipt(receipt.id);
    setWithdrawing(null);
    if (result.error) { toast.error('Could not withdraw it', result.error); return; }
    setReceipts((all) => (all ?? []).map((r) => (r.id === receipt.id ? { ...r, live: false, revokedAt: new Date().toISOString() } : r)));
    toast.success('Withdrawn', 'Apps that ask for it will ask you again.');
  };

  const live = (receipts ?? []).filter((r) => r.live);
  return (
    <Panel id="passes" title="Passes" icon={<BadgeCheck className="h-4 w-4" />}>
      <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
        Apps on this site that ask for something before they open ask you once, through one of the site&apos;s plugins.
        Only what is listed here is kept: what it says, how it was shown, which plugin and when.
      </p>
      {receipts === null ? (
        <p role="status" className="mt-2 text-sm text-gray-500 dark:text-slate-400">Loading…</p>
      ) : live.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">You have none.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {live.map((receipt) => (
            <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 px-3 py-2 dark:border-slate-700">
              <span className="text-sm text-gray-900 dark:text-white">
                {valueOf(receipt)} · {STRENGTH_WORDS[receipt.strength]?.held ?? receipt.strength} · {receipt.pluginName} · until {new Date(receipt.expiresAt.replace(' ', 'T') + 'Z').toLocaleDateString()}
              </span>
              <Button size="sm" variant="outline" isLoading={withdrawing === receipt.id} onClick={() => void withdraw(receipt)}>Withdraw</Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
