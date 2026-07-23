/**
 * Monotonic auth-session generation (audit FL-11).
 *
 * Every session boundary (logout, session expiry, account switch, account deletion,
 * sign-in) bumps the generation. Authenticated stores capture it BEFORE a request and
 * apply the result only while it still matches — so a response authorized for user A
 * that resolves late can never repopulate in-memory state (or persisted storage, via
 * zustand persist) after A signed out or B signed in.
 */
let generation = 0;

export function currentSessionGeneration(): number {
  return generation;
}

/** Called by the auth store on every session boundary. Returns the new generation. */
export function bumpSessionGeneration(): number {
  generation += 1;
  return generation;
}

/** True when a request captured at `captured` may still apply its result. */
export function isSessionGenerationCurrent(captured: number): boolean {
  return captured === generation;
}

/**
 * The signed-in user's id, mirrored here by the auth store (audit FL-09) so
 * low-level modules (offline queue) can stamp/scope by owner WITHOUT importing
 * the auth store (which would create an import cycle through the app stores).
 */
let sessionOwnerUserId: string | null = null;

export function setSessionOwner(userId: string | null): void {
  sessionOwnerUserId = userId;
}

export function currentSessionOwner(): string | null {
  return sessionOwnerUserId;
}
