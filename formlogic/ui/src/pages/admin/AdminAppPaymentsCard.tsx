// Admin → Platform: "App payments" card (GET/PUT /api/admin/app-payments, POST …/wallets/{id}/adjust).
//
// Whether apps (only administrators' apps, in this version: the money goes to this site's own PayPal) may take
// payments from their visitors' prepaid balances, the top-ups offered ($2 at least), the most one charge may be
// and one wallet may spend in a day; the latest top-ups with PayPal's order and capture ids, wallets held after a
// refund or dispute, and a correction for one. See docs/FREE_PLANS_AND_AI_SETUP.md, "App payments".
import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api } from '../../lib/api';
import { formatCents, type AppPaymentsAdminView, type AppPaymentsSiteSettings } from '../../lib/appPayments';
import { toast } from '../../stores/toastStore';
import { AdminError, AdminSpinner } from './adminUi';

const field = 'mt-1 block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';

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

  if (loadError) return <Card><CardContent className="p-5"><AdminError message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} /></CardContent></Card>;
  if (!view || !draft) return <Card><CardContent className="p-5"><AdminSpinner label="Loading app payments" /></CardContent></Card>;

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
    <Card>
      <CardContent className="space-y-5 p-5" data-testid="admin-app-payments">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white"><Wallet className="h-5 w-5" aria-hidden="true" />App payments</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            SoftN apps can charge their visitors a few cents (a download, say) from a balance the visitors top up through this site&apos;s PayPal.
            The money is the site&apos;s, so only administrators&apos; apps take payments. Payments also need the Plans switch above, and are off whenever BETA_MODE is on.
          </p>
        </div>
        <Switch label="Apps may take payments" description="Each app's owner still turns them on for their app, at prices up to what it declares." checked={draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Top-ups offered (dollars)</span>
            <input className={field} value={packages} onChange={(e) => setPackages(e.target.value)} placeholder="2.00, 5.00, 10.00" />
            <span className="mt-1 block text-xs text-gray-500 dark:text-slate-400">At least $2: PayPal&apos;s fixed fee makes less poor value.</span>
          </label>
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Most one charge may be (cents)</span>
            <input type="number" min={1} max={500} className={field} value={draft.maxChargeCents} onChange={(e) => setDraft({ ...draft, maxChargeCents: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
          </label>
          <label className="block text-sm"><span className="font-medium text-gray-700 dark:text-slate-300">Most one wallet may spend a day (cents)</span>
            <input type="number" min={1} className={field} value={draft.dailyLimitCents} onChange={(e) => setDraft({ ...draft, dailyLimitCents: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
          </label>
        </div>
        <Button size="sm" isLoading={saving} onClick={() => void save()}>Save</Button>
        <p className="text-sm text-gray-600 dark:text-slate-300">Topped up in all: {formatCents(view.totals.topupsCents)}. Spent: {formatCents(view.totals.spentCents)}.</p>
        {view.held.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Wallets held</h3>
            <ul className="mt-1 text-sm">
              {view.held.map((w) => <li key={w.walletId} className="flex items-center justify-between gap-2 py-1"><span>{w.appName ?? w.appId}: {formatCents(w.balanceCents)} ({w.status})</span><Button size="sm" variant="ghost" onClick={() => void adjust(w.walletId)}>Correct</Button></li>)}
            </ul>
          </div>
        )}
        {view.topups.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 text-gray-500 dark:bg-slate-800 dark:text-slate-400"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">App</th><th className="px-2 py-1">Amount</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">PayPal order / capture</th><th className="px-2 py-1"><span className="sr-only">Correct</span></th></tr></thead>
              <tbody>
                {view.topups.map((t) => (
                  <tr key={t.id} className="border-t border-gray-100 dark:border-slate-800">
                    <td className="px-2 py-1">{t.at.slice(0, 16)}</td><td className="px-2 py-1">{t.appName ?? t.appId}</td><td className="px-2 py-1">{formatCents(t.amountCents)}{t.refundedCents > 0 ? ` (${formatCents(t.refundedCents)} given back)` : ''}</td>
                    <td className="px-2 py-1">{t.status}</td><td className="px-2 py-1 font-mono">{t.orderId}{t.captureId ? ` / ${t.captureId}` : ''}</td>
                    <td className="px-2 py-1 text-right"><Button size="sm" variant="ghost" onClick={() => void adjust(t.walletId)}>Correct</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
