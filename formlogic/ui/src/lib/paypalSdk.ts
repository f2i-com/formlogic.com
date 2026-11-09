// The PayPal JS SDK, loaded on demand (Billing, and an app's wallet sheet). The site's CSP allows it.

/** Minimal typing for the SDK's Buttons. */
export interface PayPalButtonsInstance { render: (selector: string | HTMLElement) => Promise<void>; close?: () => Promise<void> }
export interface PayPalNamespace { Buttons: (options: Record<string, unknown>) => PayPalButtonsInstance }
declare global { interface Window { paypal?: PayPalNamespace } }

/** The SDK for this client id and currency: capture intent, PayPal itself only (no card fields, no credit). */
export function loadPayPalSdk(clientId: string, currency: string): Promise<PayPalNamespace> {
  return new Promise((resolve, reject) => {
    if (window.paypal) { resolve(window.paypal); return; }
    const existing = document.getElementById('paypal-sdk') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const done = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK unavailable')));
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => reject(new Error('PayPal SDK failed to load')), { once: true });
    if (existing) return;
    script.id = 'paypal-sdk';
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&disable-funding=credit,card`;
    document.head.appendChild(script);
  });
}
