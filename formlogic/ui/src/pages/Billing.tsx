import { Link } from 'react-router-dom';
import { useEffect, useRef, useState, useCallback } from 'react';
import { BadgeCheck, Gauge, Heart, Minus, Plus, Loader2, Info, Sparkles } from 'lucide-react';
import { api, DEFAULT_PLATFORM_PLANS, type AiUsageInfo, type BillingStatus } from '../lib/api';
import { parseServerDate } from '../lib/utils';
import { toast } from '../stores/toastStore';
import { logger } from '../lib/logger';
import { Header } from '../components/layout/Header';
import { PageBody } from '../components/layout/PageBody';
import { Panel } from '../components/ui/Panel';
import { loadPayPalSdk } from '../lib/paypalSdk';

export function Billing() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Site AI usage (Phase 2): undefined = still loading, null = not tracked on this instance.
  const [aiUsage, setAiUsage] = useState<AiUsageInfo | null | undefined>(undefined);
  const [aiUsageError, setAiUsageError] = useState<string | null>(null);
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
    toast.success(res.data?.processing ? 'Payment received' : 'Support recorded', 'Your cloud status has been updated.');
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
    // Site AI usage rides the AI preferences endpoint (Phase 2); a pre-Phase-2
    // backend just leaves the "not tracked" / unavailable state, never an error page.
    api.getAiPreferences().then((res) => {
      if (!active) return;
      if (res.data) setAiUsage(res.data.usage ?? null);
      else setAiUsageError(res.error ?? 'Could not load Site AI usage');
    });
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
              toast.success('Support recorded', res.data?.monthsAdded ? `Added ${res.data.monthsAdded * 30} days.` : 'Your cloud access has been extended.');
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
    return (
      <div className="min-h-screen">
        <Header title="Your plan" />
        <PageBody>
          <p className="flex items-center gap-2.5 py-2 text-sm text-gray-500 dark:text-slate-400"><Loader2 className="h-5 w-5 animate-spin text-primary-500" aria-hidden="true" />Loading your plan…</p>
        </PageBody>
      </div>
    );
  }

  // Couldn't load billing status — show a real error + retry instead of a misleading
  // "free plan / not configured" view derived from missing data.
  if (error && !status) {
    return (
      <div className="min-h-screen">
        <Header title="Your plan" />
        <PageBody>
          <div className="flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-900/20">
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Couldn't load billing</p>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-slate-300">{error}</p>
              <button type="button" onClick={reload} className="mt-3 inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-500 max-sm:min-h-11">Try again</button>
            </div>
          </div>
        </PageBody>
      </div>
    );
  }

  const plans = status?.plans ?? DEFAULT_PLATFORM_PLANS;
  const cloudUntilLabel = status?.cloudUntil ? parseServerDate(status.cloudUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;

  return (
    <div className="min-h-screen">
      <Header title="Your plan" />
      <PageBody>
      <p className="text-sm text-gray-500 dark:text-slate-400">FormLogic is free. Bring your own AI, or use the visual builders without AI.</p>

      {/* The plan first, then what else this site shows beside it (usage, the paid plan): side by
          side with room for them, one under the other on a phone. */}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      <Panel
        title={`${plans.freeName} workspace`}
        icon={<BadgeCheck className="h-4 w-4 text-green-600 dark:text-green-400" />}
        className="border-green-300/70 bg-green-50/60 dark:border-green-500/30 dark:bg-green-500/[0.07]"
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-slate-300">{plans.freeDescription}</p>
          <Link to="/connect-ai" className="inline-flex min-h-9 items-center rounded-lg bg-primary-600 px-4 text-sm font-medium text-primary-foreground hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:hover:bg-primary-500 dark:focus-visible:ring-offset-slate-950 max-sm:min-h-11">Set up your AI</Link>
          {!status?.paypalEnabled && <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">Payments are currently disabled. No card is needed.</p>}
          {cloudUntilLabel && <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">Your existing account credit is recorded through {cloudUntilLabel}. Free access continues after this date.</p>}
        </div>
      </Panel>

      {/* Plan usage (only when the hosted instance enforces limits) */}
      {status?.usage?.enforced && (
        <Panel title="Plan usage" icon={<Gauge className="h-4 w-4" />} actions={<span className="text-xs fl-mono text-gray-500 dark:text-slate-400 capitalize">{status.usage.plan}</span>}>
          <UsageBar label="Forms" used={status.usage.forms.used} limit={status.usage.forms.limit} format={(n) => String(n)} />
          <div className="h-3" />
          <UsageBar label="Storage" used={status.usage.storage.usedBytes} limit={status.usage.storage.limitBytes} format={formatBytes} />
        </Panel>
      )}

      {/* Site AI usage (Phase 2) — ai_messages metered against the plan allowance. */}
      {status?.plans?.siteAiEnabled && <Panel title="Site AI usage" icon={<Sparkles className="h-4 w-4" />}>
        {aiUsageError ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">Site AI usage couldn&apos;t be loaded — {aiUsageError}</p>
        ) : aiUsage === undefined ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : aiUsage === null ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">AI messages aren&apos;t tracked on this instance yet.</p>
        ) : (
          <UsageBar label="AI messages" used={aiUsage.used} limit={aiUsage.limit} format={(n) => String(n)} />
        )}
      </Panel>}

      {/* Buy cloud months — hidden on self-hosted instances (nothing to purchase). */}
      {status?.paypalEnabled && (
      <Panel
        title={status?.plans?.paidName ?? 'Supporter'}
        icon={<Heart className="h-4 w-4" />}
        actions={<span className="whitespace-nowrap"><span className="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">{fmt(price)}</span><span className="text-xs text-gray-500 dark:text-slate-400"> / 30 days</span></span>}
      >
        <p className="mb-4 text-sm text-gray-500 dark:text-slate-400">{status?.plans?.paidDescription} Optional prepaid support: {fmt(price)} USD per 30 days, with no auto-renewal. AI provider charges are separate.</p>

        {/* Quantity stepper */}
        <div className="mb-3 flex items-center justify-between gap-4 rounded-xl bg-gray-50 px-3 py-2 dark:bg-slate-800/60">
          <span className="text-sm font-medium text-gray-700 dark:text-slate-300">30-day periods</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setMonths((m) => Math.max(1, m - 1))} disabled={months <= 1}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors max-sm:h-11 max-sm:w-11" aria-label="Fewer 30-day periods">
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-10 text-center text-lg font-semibold text-gray-900 dark:text-white tabular-nums">{months}</span>
            <button type="button" onClick={() => setMonths((m) => Math.min(max, m + 1))} disabled={months >= max}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors max-sm:h-11 max-sm:w-11" aria-label="More 30-day periods">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mb-4 flex items-baseline justify-between px-3">
          <span className="text-sm text-gray-500 dark:text-slate-400">Total ({months * 30} days)</span>
          <span className="text-lg font-semibold tabular-nums text-gray-900 dark:text-white">{fmt(parseFloat(total))}</span>
        </div>

        {/* An approved-but-unconfirmed payment — let the user re-confirm without paying again. */}
        {pendingOrderId && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-3">
            <p className="min-w-0 flex-1 basis-48 text-sm text-amber-800 dark:text-amber-300">A payment was approved but not confirmed. Re-confirm it — you won't be charged again.</p>
            <button type="button" onClick={retryCapture} disabled={capturing}
              className="shrink-0 inline-flex min-h-9 items-center gap-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium disabled:opacity-60 cursor-pointer transition-colors max-sm:min-h-11">
              {capturing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Confirm payment
            </button>
          </div>
        )}

        {/* Payment */}
        {status?.paypalEnabled ? (
          paypalError ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-3">
              <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800 dark:text-amber-300">PayPal couldn't load — check your connection or any ad/script blocker, then refresh the page to try again.</p>
            </div>
          ) : (
          <>
            {!paypalReady && <div className="flex items-center py-3 text-sm text-gray-500 dark:text-slate-400"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading PayPal…</div>}
            <div id="fl-paypal-buttons" />
          </>
          )
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 p-3">
            <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800 dark:text-amber-300">Cloud billing isn't configured on this instance yet. Set your PayPal credentials in the backend <code className="font-mono text-xs bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> to enable purchases.</p>
          </div>
        )}

        <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-slate-400">
          Payments are one-time and processed securely by PayPal. No subscription is created and nothing auto-renews.
        </p>
      </Panel>
      )}
      </div>
      </PageBody>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function UsageBar({ label, used, limit, format }: { label: string; used: number; limit: number | null; format: (n: number) => string }) {
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const near = pct >= 90;
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1.5">
        <span className="text-gray-600 dark:text-slate-300">{label}</span>
        <span className="fl-mono text-xs text-gray-500 dark:text-slate-400">
          {format(used)}{limit !== null ? ` / ${format(limit)}` : ''}
        </span>
      </div>
      {limit !== null && (
        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full ${near ? 'bg-amber-500' : 'bg-primary-500'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
