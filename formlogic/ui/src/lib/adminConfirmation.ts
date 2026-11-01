// An administrator's confirmation, for what takes over or opens someone else's account: their
// password and code, good for a quarter of an hour of this session (AdminConfirmationMiddleware).
// Held in memory, so a reload asks again. The request that needed it waits for the answer and
// goes again, so no page has to know about any of this.

export const ADMIN_CONFIRMATION_REQUIRED = 'admin_confirmation_required';
/** What a refusal says once the dialog has asked. The server's own words go on to a page that can't. */
export const ADMIN_CONFIRMATION_DECLINED = 'Confirm your password to continue';

let held: { token: string; expires: number } | null = null;
let ask: (() => Promise<boolean>) | null = null;
let asking: Promise<boolean> | null = null;

export function adminConfirmationHeaders(): Record<string, string> {
  return held && held.expires > Date.now() ? { 'X-Admin-Confirmation': held.token } : {};
}

export function rememberAdminConfirmation(token: string, seconds: number): void {
  held = { token, expires: Date.now() + seconds * 1000 };
}

/** AdminConfirmHost registers the dialog here while it is mounted. */
export function setAdminConfirmationPrompt(prompt: (() => Promise<boolean>) | null): void {
  ask = prompt;
}

/**
 * False before the dialog's chunk has arrived, or when it couldn't. A refusal then keeps the server's
 * words, which are for a page where nothing asks.
 */
export function canAskForAdminConfirmation(): boolean {
  return ask !== null;
}

/** Several requests refused at once share one dialog. False: cancelled, or nothing to ask with. */
export function askForAdminConfirmation(): Promise<boolean> {
  held = null;
  if (!ask) return Promise.resolve(false);
  asking ??= ask().finally(() => { asking = null; });
  return asking;
}

/** Test-only. */
export function __resetAdminConfirmationForTests(): void {
  held = null;
  ask = null;
  asking = null;
}
