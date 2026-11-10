import { useCallback, useEffect, useRef, useState } from 'react';
import { Wallet, X } from 'lucide-react';
import { api } from '../../lib/api';
import { formatCents, LEDGER_WORDS, type WalletSheetData } from '../../lib/appPayments';
import { loadPayPalSdk } from '../../lib/paypalSdk';
import { logger } from '../../lib/logger';
import { Button } from '../ui/Button';

/**
 * FormLogic's wallet for an app (its `formlogicWallet` bridge: HostedAppFrame), over the app's frame,
 * which can have no pop-ups and so no PayPal: the person's balance with the app, what it was spent
 * on, a top-up through the site's PayPal, and saving the balance under an email to use it in another
 * browser. The app never sees any of it: it hears the balance in its context, and that the sheet closed.
 */
export function WalletSheet({ slug, appName, visitor, onClose }: { slug: string; appName: string; visitor: boolean; onClose: (balanceCents: number) => void }) {
  const [sheet, setSheet] = useState<WalletSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cents, setCents] = useState<number | null>(null);
  const centsRef = useRef<number | null>(null);
  const [pendingOrder, setPendingOrder] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailStep, setEmailStep] = useState<{ purpose: 'save' | 'restore'; sent: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const buttons = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);

  const take = useCallback((result: Awaited<ReturnType<typeof api.getAppWallet>>) => {
    if (result.error || !result.data) { setError(result.error ?? 'Your balance could not be read.'); return; }
    setSheet(result.data);
    if (centsRef.current === null && result.data.packages.length > 0) { centsRef.current = result.data.packages[0]; setCents(result.data.packages[0]); }
  }, []);
  const load = useCallback(async () => take(await api.getAppWallet(slug, visitor)), [slug, visitor, take]);

  useEffect(() => {
    let cancelled = false;
    void api.getAppWallet(slug, visitor).then((result) => { if (!cancelled) take(result); });
    return () => { cancelled = true; };
  }, [slug, visitor, take]);

  const close = useCallback(() => onClose(sheet?.balanceCents ?? 0), [onClose, sheet]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const captured = useCallback(async (orderId: string) => {
    setBusy(true);
    const result = await api.captureAppWalletOrder(slug, orderId, visitor);
    setBusy(false);
    if (result.error || !result.data) {
      // Kept, so the person can confirm again: capturing is idempotent, and a new order would pay twice.
      setPendingOrder(orderId);
      setNotice(result.error ?? 'We could not confirm the payment yet.');
      return;
    }
    setPendingOrder(null);
    setNotice(result.data.status === 'processing' ? 'Your payment is processing. It is added as soon as it clears.' : `Added. Your balance is ${formatCents(result.data.balanceCents)}.`);
    await load();
  }, [slug, visitor, load]);

  // Development only: this site's PayPal is a stand-in, which PayPal's own script knows nothing of.
  // The same three steps as PayPal's buttons take, with the approval a buyer gives in PayPal's
  // window made at the stand-in instead.
  const payAtStandIn = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const order = await api.createAppWalletOrder(slug, centsRef.current ?? 0, visitor);
    if (order.error || !order.data) { setBusy(false); setNotice(order.error ?? 'Could not start the payment.'); return; }
    const approved = await api.approveAppWalletStandIn(slug, order.data.orderId, visitor);
    if (approved.error) { setBusy(false); setNotice(approved.error); return; }
    await captured(order.data.orderId);
  }, [slug, visitor, captured]);

  // PayPal's buttons, once there is something to pay for: createOrder reads the chosen amount from a ref.
  useEffect(() => {
    if (!sheet?.available || sheet.paypalStandIn || !sheet.paypalClientId || rendered.current || !buttons.current) return;
    rendered.current = true;
    let cancelled = false;
    loadPayPalSdk(sheet.paypalClientId, sheet.currency).then((paypal) => {
      if (cancelled || !buttons.current) return;
      void paypal.Buttons({
        style: { layout: 'horizontal', tagline: false, height: 40 },
        createOrder: async () => {
          const result = await api.createAppWalletOrder(slug, centsRef.current ?? 0, visitor);
          if (result.error || !result.data) { setNotice(result.error ?? 'Could not start the payment.'); throw new Error(result.error ?? 'Could not start the payment'); }
          return result.data.orderId;
        },
        onApprove: async (data: { orderID: string }) => { await captured(data.orderID); },
        onError: (reason: unknown) => { logger.error('PayPal error in an app wallet:', reason); setNotice('Something went wrong with PayPal. Try again.'); },
      }).render(buttons.current);
    }).catch(() => { if (!cancelled) setNotice('PayPal could not be loaded. Check your connection and try again.'); });
    return () => { cancelled = true; };
  }, [sheet, slug, visitor, captured]);

  const sendCode = async () => {
    if (!emailStep) return;
    setBusy(true);
    const result = await api.sendAppWalletCode(slug, emailStep.purpose, email, visitor);
    setBusy(false);
    if (result.error) { setNotice(result.error); return; }
    setEmailStep({ ...emailStep, sent: true });
    setNotice(emailStep.purpose === 'save' ? 'We sent a code to that address.' : 'If a balance is saved under that address, we sent it a code.');
  };
  const confirmCode = async () => {
    if (!emailStep) return;
    setBusy(true);
    const result = await api.confirmAppWalletCode(slug, emailStep.purpose, email, code, visitor);
    setBusy(false);
    if (result.error || !result.data) { setNotice(result.error ?? 'That code did not work.'); return; }
    setEmailStep(null);
    setCode('');
    setNotice(emailStep.purpose === 'save' ? 'Saved. Use this email to bring your balance to another browser.' : `Your saved balance is here: ${formatCents(result.data.balanceCents)}.`);
    await load();
  };

  const field = 'block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
  // What a top-up buys, at the app's cheapest price.
  const prices = sheet ? Object.values(sheet.items).filter((price) => price > 0) : [];
  const cheapest = prices.length > 0 ? Math.min(...prices) : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="fl-wallet-title" className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-slate-900 sm:rounded-2xl" data-testid="wallet-sheet">
        <div className="flex items-start justify-between gap-3">
          <h2 id="fl-wallet-title" className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white"><Wallet className="h-5 w-5" aria-hidden="true" />Your balance with {appName}</h2>
          <button type="button" aria-label="Close" className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800" onClick={close}><X className="h-5 w-5" /></button>
        </div>
        {!sheet ? (error ? <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p> : <p className="mt-4 text-sm text-gray-500" role="status">Reading your balance…</p>) : (
          <div className="mt-4 space-y-4">
            <p className="text-3xl font-semibold text-gray-900 dark:text-white" data-testid="wallet-balance">{formatCents(sheet.balanceCents)}</p>
            {sheet.status !== 'active' && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{sheet.status === 'disputed' ? 'This balance is held while a payment is disputed.' : 'A payment was given back, so this balance is held until a top-up settles it.'}</p>}
            {!sheet.available && sheet.reasonText && <p className="text-sm text-gray-600 dark:text-slate-300">{sheet.reasonText}</p>}
            {sheet.available && (
              <div className="space-y-3">
                <fieldset>
                  <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">Add to it</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {sheet.packages.map((p) => (
                      <label key={p} className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${cents === p ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200' : 'border-gray-300 dark:border-slate-600'}`}>
                        <input type="radio" name="fl-wallet-package" className="sr-only" checked={cents === p} onChange={() => { centsRef.current = p; setCents(p); }} />{formatCents(p)}
                      </label>
                    ))}
                  </div>
                  {cents !== null && cheapest > 0 && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">{formatCents(cents)} pays for {Math.floor(cents / cheapest)} at {formatCents(cheapest)} each.</p>
                  )}
                </fieldset>
                {sheet.paypalStandIn ? (
                  <div className="space-y-1.5 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-3 dark:border-amber-500/60 dark:bg-amber-500/10" data-testid="wallet-stand-in">
                    <Button size="sm" isLoading={busy && !pendingOrder} disabled={busy || cents === null} onClick={() => void payAtStandIn()}>Pay with the stand-in PayPal</Button>
                    <p className="text-xs text-amber-900 dark:text-amber-200">This site is in development: a stand-in answers for PayPal here, and no money moves.</p>
                  </div>
                ) : <div ref={buttons} id="fl-wallet-paypal" data-testid="wallet-paypal" />}
                {pendingOrder && <Button size="sm" variant="outline" isLoading={busy} onClick={() => void captured(pendingOrder)}>Confirm the payment again</Button>}
                <p className="text-xs text-gray-500 dark:text-slate-400">Paid to this site through PayPal. Your balance is kept for you; ask the site to refund what is left.</p>
              </div>
            )}
            {notice && <p role="status" className="text-sm text-gray-700 dark:text-slate-200">{notice}</p>}
            {sheet.email.possible && (
              <div className="rounded-lg border border-gray-200 p-3 dark:border-slate-700">
                {!emailStep ? (
                  <div className="flex flex-wrap gap-2">
                    {!sheet.email.saved && <Button size="sm" variant="ghost" onClick={() => setEmailStep({ purpose: 'save', sent: false })}>Save my balance with an email</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setEmailStep({ purpose: 'restore', sent: false })}>Restore a saved balance</Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="block text-sm">Email<input type="email" autoComplete="email" className={field} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
                    {emailStep.sent && <label className="block text-sm">The code we sent<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={field} value={code} onChange={(event) => setCode(event.target.value)} /></label>}
                    <div className="flex gap-2">
                      {!emailStep.sent ? <Button size="sm" isLoading={busy} disabled={email.trim() === ''} onClick={() => void sendCode()}>Send a code</Button>
                        : <Button size="sm" isLoading={busy} disabled={code.trim().length !== 6} onClick={() => void confirmCode()}>Confirm</Button>}
                      <Button size="sm" variant="ghost" onClick={() => { setEmailStep(null); setCode(''); }}>Cancel</Button>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-slate-400">The address itself is not kept: only a fingerprint of it, to find your balance again.</p>
                  </div>
                )}
              </div>
            )}
            {sheet.ledger.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-slate-300">Lately</h3>
                <ul className="mt-1 divide-y divide-gray-100 text-sm dark:divide-slate-800">
                  {sheet.ledger.map((line, index) => (
                    <li key={index} className="flex justify-between gap-3 py-1.5">
                      <span>{LEDGER_WORDS[line.kind] ?? line.kind}{line.label ? `: ${line.label}` : ''}</span>
                      <span className={line.amountCents < 0 ? 'text-gray-600 dark:text-slate-300' : 'text-green-700 dark:text-green-300'}>{line.amountCents > 0 ? '+' : ''}{formatCents(line.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
