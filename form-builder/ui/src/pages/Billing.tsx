import { useEffect, useRef, useState, useCallback } from 'react';
import { Cloud, Check, Minus, Plus, Loader2, Info } from 'lucide-react';
import { api, type BillingStatus } from '../lib/api';
import { parseServerDate } from '../lib/utils';
import { toast } from '../stores/toastStore';
import { logger } from '../lib/logger';

// Minimal typing for the PayPal JS SDK (loaded on demand).
interface PayPalButtonsInstance { render: (sel: string) => Promise<void>; }
interface PayPalNamespace { Buttons: (opts: Record<string, unknown>) => PayPalButtonsInstance; }
declare global { interface Window { paypal?: PayPalNamespace } }

function loadPayPalSdk(clientId: string, currency: string): Promise<PayPalNamespace> {
  return new Promise((resolve, reject) => {
    if (window.paypal) { resolve(window.paypal); return; }
    const s = document.createElement('script');
    s.id = 'paypal-sdk';
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&disable-funding=credit,card`;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK unavailable')));
    s.onerror = () => reject(new Error('PayPal SDK failed to load'));
    document.head.appendChild(s);
  });
}

export function Billing() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(1);
  const monthsRef = useRef(1);
  const [paypalReady, setPaypalReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paypalError, setPaypalError] = useState(false);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const buttonsRendered = useRef(false);

  const refresh = useCallback(async () => {
    const res = await api.getBillingStatus();
    if (res.data) setStatus(res.data);
  }, []);

  // Used by the error-card retry button (not in an effect, so setState is fine here).
  const reload = async () => {
    setLoading(true);
    setError(null);
    const res = await api.getBillingStatus();
    if (res.data) setStatus(res.data);
    else setError(typeof res.error === 'string' ? res.error : 'Could not load billing status');
    setLoading(false);
  };

  // Re-confirm an approved-but-unconfirmed payment (capture is idempotent server-side).
  const retryCapture = async () => {
    if (!pendingOrderId || capturing) return;
    setCapturing(true);
    const res = await api.capturePaypalOrder(pendingOrderId);
    setCapturing(false);
    if (res.error) { toast.error('Still could not confirm', typeof res.error === 'string' ? res.error : undefined); return; }
    setPendingOrderId(null);
    toast.success(res.data?.processing ? 'Payment received' : 'Cloud time added', 'Your cloud status has been updated.');
    refresh();
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await api.getBillingStatus();
      if (!active) return;
      if (res.data) setStatus(res.data);
      else setError(typeof res.error === 'string' ? res.error : 'Could not load billing status');
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { monthsRef.current = months; }, [months]);

  // Render the PayPal buttons once the SDK + a client id are available. createOrder
  // reads the live month count from a ref, so the buttons don't need re-rendering.
  useEffect(() => {
    if (!status?.paypalEnabled || !status.paypalClientId || buttonsRendered.current) return;
    let cancelled = false;
    loadPayPalSdk(status.paypalClientId, status.currency)
      .then((paypal) => {
        if (cancelled || buttonsRendered.current || !document.getElementById('fl-paypal-buttons')) return;
        buttonsRendered.current = true;
        paypal.Buttons({
          style: { layout: 'vertical', shape: 'pill', label: 'paypal', height: 44 },
          createOrder: async () => {
            const res = await api.createPaypalOrder(monthsRef.current);
            if (res.error || !res.data?.orderId) throw new Error(res.error || 'Could not start payment');
            return res.data.orderId;
          },
          onApprove: async (data: { orderID: string }) => {
            const res = await api.capturePaypalOrder(data.orderID);
            if (res.error) {
              // Keep the approved order so the user can re-confirm (capture is idempotent)
              // instead of paying again through a fresh order.
              setPendingOrderId(data.orderID);
              toast.error('Payment not confirmed', typeof res.error === 'string' ? res.error : 'We couldn’t confirm it — use "Confirm payment" to retry.');
              return;
            }
            setPendingOrderId(null);
            if (res.data?.processing) {
              toast.success('Payment received', res.data.message || 'Your cloud time will be added once it clears.');
            } else {
              toast.success('Cloud time added', res.data?.monthsAdded ? `Added ${res.data.monthsAdded} month${res.data.monthsAdded === 1 ? '' : 's'}.` : 'Your cloud access has been extended.');
            }
            refresh();
          },
          onError: (err: unknown) => { logger.error('PayPal error:', err); toast.error('Payment error', 'Something went wrong with PayPal. Please try again.'); },
        }).render('#fl-paypal-buttons')
          .then(() => { if (!cancelled) setPaypalReady(true); })
          .catch((e) => { logger.error('PayPal render failed:', e); if (!cancelled) setPaypalError(true); });
      })
      .catch((e) => { if (!cancelled) { logger.error('PayPal SDK load failed:', e); setPaypalError(true); } });
    return () => { cancelled = true; };
  }, [status, refresh]);

  const price = (status?.pricePerMonthCents ?? 500) / 100;
  const currency = status?.currency ?? 'USD';
  const max = status?.maxMonths ?? 12;
  const total = (price * months).toFixed(2);
  const fmt = (n: number) => `${currency === 'USD' ? '$' : ''}${n.toFixed(2)}${currency !== 'USD' ? ' ' + currency : ''}`;

  if (loading) {
    return <div className="flex-1 flex items-center justify-center py-24"><Loader2 className="h-7 w-7 animate-spin text-primary-500" /></div>;
  }

  // Couldn't load billing status — show a real error + retry instead of a misleading
  // "free plan / not configured" view derived from missing data.
  if (error && !status) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <Info className="h-8 w-8 mx-auto text-amber-500 mb-3" />
        <p className="font-medium text-gray-900 dark:text-white">Couldn't load billing</p>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1 mb-5">{error}</p>
        <button type="button" onClick={reload} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-primary-foreground text-sm font-medium cursor-pointer transition-colors">Try again</button>
      </div>
    );
  }

  const cloudActive = status?.active;
  const cloudUntilLabel = status?.cloudUntil ? parseServerDate(status.cloudUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center gap-3 mb-2">
        <div className="h-10 w-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
          <Cloud className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white tracking-tight">Cloud</h1>
      </div>
      <p className="text-gray-500 dark:text-slate-400 mb-8">Pay only for the months you use — no subscription, no auto-renew.</p>

      {/* Current status */}
      <div className={`rounded-2xl border p-5 mb-6 ${cloudActive ? 'border-green-300/70 dark:border-green-500/30 bg-green-50/60 dark:bg-green-500/[0.07]' : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/50'}`}>
        {cloudActive ? (
          <div className="flex items-start gap-3">
            <Check className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-gray-900 dark:text-white">Cloud is active</p>
              <p className="text-sm text-gray-600 dark:text-slate-400 mt-0.5">Your cloud access runs until <strong className="text-gray-900 dark:text-white">{cloudUntilLabel}</strong>. Add more months anytime — they stack onto this date.</p>
            </div>
          </div>
        ) : (
          <div>
            <p className="font-medium text-gray-900 dark:text-white">You're on the free plan</p>
            <p className="text-sm text-gray-600 dark:text-slate-400 mt-0.5">Everything still works for free. Add cloud months below for managed hosting and backups.</p>
          </div>
        )}
      </div>

      {/* Buy cloud months */}
      <div className="rounded-2xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900/50 p-6">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Add cloud months</h2>
          <div className="text-right">
            <span className="text-2xl font-bold text-gray-900 dark:text-white">{fmt(price)}</span>
            <span className="text-sm text-gray-400 dark:text-slate-500"> / month</span>
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-slate-400 mb-5">One-time payment via PayPal. Each {fmt(price)} adds one month.</p>

        {/* Quantity stepper */}
        <div className="flex items-center justify-between gap-4 rounded-xl bg-gray-50 dark:bg-slate-800/60 p-4 mb-5">
          <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Months</span>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setMonths((m) => Math.max(1, m - 1))} disabled={months <= 1}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors" aria-label="Fewer months">
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-10 text-center text-lg font-semibold text-gray-900 dark:text-white tabular-nums">{months}</span>
            <button type="button" onClick={() => setMonths((m) => Math.min(max, m + 1))} disabled={months >= max}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors" aria-label="More months">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-baseline justify-between mb-5">
          <span className="text-sm text-gray-500 dark:text-slate-400">Total ({months} month{months === 1 ? '' : 's'})</span>
          <span className="text-xl font-bold text-gray-900 dark:text-white">{fmt(parseFloat(total))}</span>
        </div>

        {/* An approved-but-unconfirmed payment — let the user re-confirm without paying again. */}
        {pendingOrderId && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-4">
            <p className="text-sm text-amber-800 dark:text-amber-300">A payment was approved but not confirmed. Re-confirm it — you won't be charged again.</p>
            <button type="button" onClick={retryCapture} disabled={capturing}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium disabled:opacity-60 cursor-pointer transition-colors">
              {capturing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Confirm payment
            </button>
          </div>
        )}

        {/* Payment */}
        {status?.paypalEnabled ? (
          paypalError ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-4">
              <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800 dark:text-amber-300">PayPal couldn't load — check your connection or any ad/script blocker, then refresh the page to try again.</p>
            </div>
          ) : (
          <>
            {!paypalReady && <div className="flex items-center justify-center py-4 text-sm text-gray-500 dark:text-slate-400"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading PayPal…</div>}
            <div id="fl-paypal-buttons" />
          </>
          )
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-4">
            <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 dark:text-amber-300">Cloud billing isn't configured on this instance yet. Set your PayPal credentials in the backend <code className="font-mono text-xs bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> to enable purchases.</p>
          </div>
        )}
      </div>

      <p className="text-center text-xs text-gray-400 dark:text-slate-500 mt-5">
        Payments are one-time and processed securely by PayPal. No subscription is created and nothing auto-renews.
      </p>
    </div>
  );
}
