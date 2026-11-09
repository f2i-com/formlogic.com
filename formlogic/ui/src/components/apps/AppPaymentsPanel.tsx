import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatCents, type AppPaymentsView } from '../../lib/appPayments';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';

/**
 * "Payments" (the owner, in the SoftN app's settings): what the app sells and for how much, as its
 * manifest declares it; the owner confirms or lowers each price and turns payments on, and sees what
 * was sold. Shown only for an app whose manifest declares formlogicPayments.
 */
export function AppPaymentsPanel({ appId }: { appId: string }) {
  const [view, setView] = useState<AppPaymentsView | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getAppPayments(appId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'This setting could not be read.'); return; }
      setView(result.data);
      setPrices(result.data.settings?.prices ?? {});
      setEnabled(result.data.settings?.enabled ?? false);
    });
    return () => { cancelled = true; };
  }, [appId]);

  if (!view) return error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null;
  if (!view.declared) return null;
  const declared = view.declared;
  const ceiling = (asked: number) => Math.min(asked, view.maxChargeCents ?? asked);
  const unconfirmed = view.settings?.unconfirmed ?? {};
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    // Every item at the price shown, so saving confirms the ones an update added as well.
    const all = Object.fromEntries(declared.items.map((item) => [item.id, prices[item.id] ?? ceiling(item.priceCents)]));
    const result = await api.putAppPayments(appId, { enabled, prices: all });
    setBusy(false);
    if (result.error || !result.data) { setError(result.error ?? 'It could not be saved.'); return; }
    setView(result.data);
    setPrices(result.data.settings?.prices ?? {});
    setEnabled(result.data.settings?.enabled ?? false);
    setSaved(true);
  };

  return (
    <div className="space-y-4" data-testid="app-payments-panel">
      <p className="text-sm text-gray-600 dark:text-slate-300">{view.declared.purpose}</p>
      <p className="text-sm" role="status">{view.available ? 'Taking payments: visitors pay from a balance they top up through this site\'s PayPal.' : view.reasonText ?? 'Not taking payments.'}</p>
      <Switch label="Take payments" description="Visitors pay these prices from their balance with this app." checked={enabled} onChange={setEnabled} />
      <div className="space-y-2">
        {declared.items.map((item) => (
          <label key={item.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="font-medium">{item.label}</span>
              <span className="block text-xs text-gray-500 dark:text-slate-400">The app asks {formatCents(item.priceCents)}; you may lower it.</span>
              {item.id in unconfirmed && <span className="block text-xs text-amber-700 dark:text-amber-300">New in this version: not sold until you save its price.</span>}
            </span>
            <span className="flex items-center gap-1">
              <input type="number" min={1} max={ceiling(item.priceCents)} className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-right dark:border-slate-600 dark:bg-slate-800" value={prices[item.id] ?? ceiling(item.priceCents)}
                onChange={(event) => setPrices((current) => ({ ...current, [item.id]: Math.max(1, Math.min(ceiling(item.priceCents), Math.floor(Number(event.target.value) || 1))) }))} />¢
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" isLoading={busy} onClick={() => void save()}>Save</Button>
        {saved && <span className="text-sm text-green-700 dark:text-green-300" role="status">Saved.</span>}
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {view.sales && (
        <p className="text-sm text-gray-600 dark:text-slate-300">
          Today: {formatCents(view.sales.today.cents)} from {view.sales.today.charges} {view.sales.today.charges === 1 ? 'sale' : 'sales'}. In all: {formatCents(view.sales.total.cents)}.
        </p>
      )}
    </div>
  );
}
