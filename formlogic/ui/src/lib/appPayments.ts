/**
 * App payments, as FormLogic answers them (docs/HOSTED_APPS.md, "App payments"): a visitor's or
 * member's wallet with an app, the owner's "Payments", and the administrator's "App payments".
 */
export interface WalletLedgerLine { kind: 'topup' | 'charge' | 'refund' | 'reversal' | 'transfer_in' | 'transfer_out' | 'adjustment' | string; amountCents: number; balanceAfter: number; label: string | null; at: string }

/** The wallet sheet (GET /api/app/{slug}/wallet). */
export interface WalletSheetData {
  available: boolean;
  reason: string | null;
  reasonText: string | null;
  balanceCents: number;
  status: 'active' | 'blocked' | 'disputed' | string;
  currency: 'USD';
  packages: number[];
  items: Record<string, number>;
  paypalClientId: string | null;
  /**
   * Development only: a stand-in answers in PayPal's place on this site (PAYPAL_BASE_URL with
   * APP_ENV=development). The sheet then shows its own button, which approves the order at the
   * stand-in, and never loads PayPal's script. No money moves. Absent or false everywhere else.
   */
  paypalStandIn?: boolean;
  ledger: WalletLedgerLine[];
  email: { saved: boolean; possible: boolean };
}

export interface PaymentItem { id: string; label: string; priceCents: number }

/** The owner's "Payments" (GET /api/apps/{id}/payments). */
export interface AppPaymentsView {
  declared: { purpose: string; items: PaymentItem[]; routes: string[] } | null;
  /** `prices`: the items the owner has confirmed; `unconfirmed`: ones an update added, not sold until the owner saves a price. */
  settings?: { enabled: boolean; prices: Record<string, number>; unconfirmed?: Record<string, number> };
  available?: boolean;
  reason?: string | null;
  reasonText?: string | null;
  maxChargeCents?: number;
  sales?: { today: { cents: number; charges: number }; total: { cents: number; charges: number }; latest: { kind: string; amountCents: number; item: string | null; at: string }[] };
}

export interface AppPaymentsSiteSettings { enabled: boolean; packages: number[]; maxChargeCents: number; dailyLimitCents: number }

/** The administrator's "App payments" (GET /api/admin/app-payments). */
export interface AppPaymentsAdminView {
  settings: AppPaymentsSiteSettings;
  topups: { id: string; appId: string; appName: string | null; orderId: string; captureId: string | null; amountCents: number; status: string; refundedCents: number; walletId: string; at: string }[];
  held: { walletId: string; appId: string; appName: string | null; balanceCents: number; status: string }[];
  totals: { topupsCents: number; spentCents: number };
}

/** Cents as dollars: 5 → "5¢", 200 → "$2.00". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  if (Math.abs(cents) < 100 && cents !== 0) return `${sign}${Math.abs(cents)}¢`;
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** What a ledger line is called to the person whose wallet it is. */
export const LEDGER_WORDS: Record<string, string> = {
  topup: 'Top-up', charge: 'Paid', refund: 'Given back', reversal: 'Taken back by PayPal', transfer_in: 'Moved here', transfer_out: 'Moved away', adjustment: 'Correction',
};
