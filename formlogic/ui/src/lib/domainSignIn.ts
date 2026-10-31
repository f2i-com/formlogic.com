// Signing in to an app on its own domain. Whoever owns a domain decides what its name points at, so
// no password goes in there: a browser would offer it again to whatever the name points at next.
// The member signs in on FormLogic, agrees to continue, and comes back with a one-time code for
// this app on this domain (AppDomainSignInService on the server).
import { createContext } from 'react';
import { api } from './api';
import { signInDestination } from './authRedirect';

const KEY = 'formlogic:domain-sign-in';

/** On an app's own domain: FormLogic's address, where the sign-in forms are. Elsewhere null. */
export const DomainSignInContext = createContext<string | null>(null);

/** `page` is FormLogic's page for someone with no session there yet. */
export function startDomainSignIn(platformUrl: string, page: 'login' | 'signup', returnTo: string): void {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ state, returnTo }));
  } catch { /* the return below says so: state won't match */ }
  const query = new URLSearchParams({ origin: window.location.origin, state, page });
  window.location.assign(`${platformUrl}/sign-in/domain?${query}`);
}

/** What this tab set out with, once. */
function takePending(): { state?: unknown; returnTo?: unknown } | null {
  try {
    const pending = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { state?: unknown; returnTo?: unknown } | null;
    sessionStorage.removeItem(KEY);
    return pending;
  } catch {
    return null;
  }
}

/**
 * Spends the code from the return trip. The address to go on to, or null when it can't be used.
 * The state proves this tab set out: without it, a link holding someone else's code would sign
 * whoever opened it in as that someone.
 */
export async function finishDomainSignIn(code: string | null, state: string | null): Promise<string | null> {
  const pending = takePending();
  if (!code || !state || pending?.state !== state) return null;
  const result = await api.exchangeAppDomainCode(code);
  if (result.error) return null;
  return signInDestination(typeof pending.returnTo === 'string' ? pending.returnTo : null);
}
