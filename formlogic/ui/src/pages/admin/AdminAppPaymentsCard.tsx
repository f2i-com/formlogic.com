// Admin → Platform: "App payments" card (GET/PUT /api/admin/app-payments, POST …/wallets/{id}/adjust).
//
// Whether apps (only administrators' apps, in this version: the money goes to this site's own PayPal) may take
// payments from their visitors' prepaid balances, the top-ups offered ($2 at least), the most one charge may be
// and one wallet may spend in a day; the latest top-ups with PayPal's order and capture ids, wallets held after a
// refund or dispute, and a correction for one. See docs/FREE_PLANS_AND_AI_SETUP.md, "App payments".
import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Panel } from '../../components/ui/Panel';
import { Switch } from '../../components/ui/Switch';
import { api } from '../../lib/api';
import { formatCents, type AppPaymentsAdminView, type AppPaymentsSiteSettings } from '../../lib/appPayments';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';
import { LIST_BODY, LIST_BOX, LIST_CELL, LIST_HEAD, LIST_LABEL, LIST_ROW, LIST_TABLE, LIST_TH, ROW_BOX } from '../../components/ui/listLook';

const field = 'mt-1 block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white max-sm:min-h-11';

export function AdminAppPaymentsCard() {
  const [view, setView] = useState<AppPaymentsAdminView | null>(null);
  const [draft, setDraft] = useState<AppPaymentsSiteSettings | null>(null);
  const [packages, setPackages] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.adminGetAppPayments().then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setLoadError(result.error ?? 'Could not read this setting.'); return; }
      setView(result.data);
      setDraft(result.data.settings);
      setPackages(result.data.settings.packages.map((c) => (c / 100).toFixed(2)).join(', '));
    });
    return () => { cancelled = true; };
  }, [attempt]);

  if (loadError) return <Panel title="App payments" icon={<Wallet className="h-4 w-4" />}><AdminError message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} /></Panel>;
  if (!view || !draft) return <Panel title="App payments" icon={<Wallet className="h-4 w-4" />}><AdminSpinner label="Loading app payments" /></Panel>;

  const save = async () => {
    const cents = packages.split(',').map((p) => Math.round(Number(p.trim().replace(/^\$/, '')) * 100)).filter((c) => Number.isFinite(c) && c > 0);
    setSaving(true);
    const result = await api.adminPutAppPayments({ ...draft, packages: cents });
    setSaving(false);
    if (result.error || !result.data) { toast.error('Not saved', result.error ?? ''); return; }
    setView(result.data);
    setDraft(result.data.settings);
    setPackages(result.data.settings.packages.map((c) => (c / 100).toFixed(2)).join(', '));
    toast.success('Saved');
  };
  const adjust = async (walletId: string) => {
    const amount = window.prompt('Credit (or, with a minus sign, debit) this wallet by how many dollars?');
    if (!amount) return;
    const note = window.prompt('Why? The note is kept on the wallet\'s ledger.') ?? '';
    const result = await api.adminAdjustAppWallet(walletId, Math.round(Number(amount) * 100), note);
    if (result.error) { toast.error('Not changed', result.error); return; }
    toast.success('Done', `The balance is now ${formatCents(result.data?.balanceCents ?? 0)}.`);
    setAttempt((n) => n + 1);
  };

  return (
    // The panel takes the page's whole width: the settings in a row, then the top-ups as a table.
    <Panel
      className="@container"
      title="App payments"
      icon={<Wallet className="h-4 w-4" />}
      description="SoftN apps can charge their visitors a few cents (a download, say) from a balance the visitors top up through this site's PayPal. The money is the site's, so only administrators' apps take payments. Payments also need the Plans switch above, and are off whenever BETA_MODE is on."
    >
      <div className="space-y-4" data-testid="admin-app-payments">
        <Switch label="Apps may take payments" description="Each app's owner still turns them on for their app, at prices up to what it declares." checked={draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} />
        <div className="grid max-w-5xl items-start gap-3 @2xl:grid-cols-3">
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Top-ups offered (dollars)</span>
            <input className={field} value={packages} onChange={(e) => setPackages(e.target.value)} placeholder="2.00, 5.00, 10.00" />
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-slate-400">At least $2: PayPal&apos;s fixed fee makes less poor value.</span>
          </label>
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Most one charge may be (cents)</span>
            <input type="number" min={1} max={500} className={field} value={draft.maxChargeCents} onChange={(e) => setDraft({ ...draft, maxChargeCents: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
          </label>
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Most one wallet may spend a day (cents)</span>
            <input type="number" min={1} className={field} value={draft.dailyLimitCents} onChange={(e) => setDraft({ ...draft, dailyLimitCents: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" isLoading={saving} onClick={() => void save()}>Save</Button>
          <p className="text-sm tabular-nums text-gray-600 dark:text-slate-300">Topped up in all: {formatCents(view.totals.topupsCents)}. Spent: {formatCents(view.totals.spentCents)}.</p>
        </div>
        {view.held.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Wallets held</h3>
            <ul className={cn('mt-2 max-w-3xl text-sm text-gray-700 dark:text-slate-300', ROW_BOX)}>
              {view.held.map((w) => <li key={w.walletId} className="flex items-center justify-between gap-2 px-3 py-1"><span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">{w.appName ?? w.appId}: {formatCents(w.balanceCents)} ({w.status})</span><Button size="sm" variant="ghost" onClick={() => void adjust(w.walletId)}>Correct</Button></li>)}
            </ul>
          </div>
        )}
        {view.topups.length > 0 && (
          <div className="@container/list">
            <div className={LIST_BOX}>
              <table className={LIST_TABLE}>
                <caption className="sr-only">Top-ups</caption>
                {/* Two lines a row, so the table needs four columns, not six: the app over PayPal's
                    ids (long, and wanted whole for a search at PayPal), the time over the status. */}
                <thead className={LIST_HEAD}>
                  <tr>
                    <th scope="col" className={cn(LIST_TH, 'w-36 pl-3')}>When</th>
                    <th scope="col" className={LIST_TH}>App, PayPal order / capture</th>
                    <th scope="col" className={cn(LIST_TH, 'w-40 text-right')}>Amount</th>
                    <th scope="col" className={cn(LIST_TH, 'w-24 pr-3')}><span className="sr-only">Correct</span></th>
                  </tr>
                </thead>
                <tbody className={LIST_BODY}>
                  {view.topups.map((t) => (
                    <tr key={t.id} className={cn(LIST_ROW, 'grid grid-cols-2 items-start gap-x-3 gap-y-1.5')}>
                      <td className={cn(LIST_CELL, 'tabular-nums @xl/list:py-0.5 @xl/list:pl-3')}>
                        <span className={LIST_LABEL}>When</span>
                        <span className="block whitespace-nowrap text-gray-700 dark:text-slate-300">{t.at.slice(0, 16)}</span>
                        <span className="block text-xs leading-4 text-gray-500 dark:text-slate-400">{t.status}</span>
                      </td>
                      {/* (first on a card: the app names the card) */}
                      <th scope="row" className={cn(LIST_CELL, 'order-first col-span-2 font-normal @xl/list:py-0.5')}>
                        <span className="block font-semibold text-gray-900 [overflow-wrap:anywhere] dark:text-white">{t.appName ?? t.appId}</span>
                        <span className="block font-mono text-xs leading-4 text-gray-500 [overflow-wrap:anywhere] dark:text-slate-400">{t.orderId}{t.captureId ? ` / ${t.captureId}` : ''}</span>
                      </th>
                      <td className={cn(LIST_CELL, 'tabular-nums text-gray-700 dark:text-slate-300 @xl/list:py-0.5 @xl/list:text-right')}>
                        <span className={LIST_LABEL}>Amount</span>
                        <span className="block">{formatCents(t.amountCents)}</span>
                        {t.refundedCents > 0 && <span className="block text-xs leading-4 text-gray-500 dark:text-slate-400">({formatCents(t.refundedCents)} given back)</span>}
                      </td>
                      <td className={cn(LIST_CELL, 'col-span-2 @xl/list:py-0.5 @xl/list:pr-2 @xl/list:text-right')}><Button size="sm" variant="ghost" onClick={() => void adjust(t.walletId)}>Correct</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
