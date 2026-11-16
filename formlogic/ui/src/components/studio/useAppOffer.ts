// An app offering the person an app it made (its `formlogicAddApp` bridge: HostedAppFrame hands
// the calls on, NativeAppView shows the sheet this returns). One offer at a time. FormLogic asks the
// person in its own sheet (AddAppSheet); only on their yes are the files fetched and the app made
// (lib/appOffer), in their account. The offering app learns how it went by asking, and no more.
import { useCallback, useEffect, useRef, useState } from 'react';
import { addOfferedApp, isOfferSource, offeredName } from '../../lib/appOffer';
import type { AddAppAnswer, AppReader } from '../../lib/nativeHost';
import { currentSessionGeneration, isSessionGenerationCurrent } from '../../lib/sessionGeneration';
import { useAuthStore } from '../../stores/authStore';

/**
 * An offer as the sheet shows it. `shown`: the name the offering app gave, display text only.
 * `open`: the sheet is on screen (an offer that is over stays, closed, for the app to read).
 * `added`: the app that was made. `message`: why it was not, in the person's words.
 */
export interface AppOffer {
  state: 'asking' | 'adding' | 'added' | 'declined' | 'failed';
  shown: string;
  open: boolean;
  added?: { id: string; name: string; slug: string };
  reason?: 'invalid' | 'limit' | 'failed';
  message?: string;
}

/**
 * `enabled`: the app's owner lets it offer the apps it makes (the runtime GET's `project.offers`).
 * `who`: the person and session the page is open for; an offer made to one is never shown to the next.
 */
export function useAppOffer({ slug, enabled, who }: { slug: string; enabled: boolean; who: string }) {
  const [offer, setOffer] = useState<AppOffer | null>(null);
  // The same offer, read at once when the app asks; and what the person's yes will fetch, and for whom.
  const live = useRef<AppOffer | null>(null);
  const asked = useRef<{ from: string; read: AppReader; userId: string; generation: number } | null>(null);
  const put = useCallback((next: AppOffer | null) => { live.current = next; setOffer(next); }, []);

  /** The app's call. An `op` it does not know is thrown, and the app hears the message. */
  const call = useCallback((input: Record<string, unknown>, read: AppReader): AddAppAnswer => {
    const now = live.current;
    switch (input.op) {
      case 'offer': {
        if (!enabled) return { state: 'refused', reason: 'off' };
        // An app is added to an account: a visitor has none, and a session on an app's own domain
        // opens that app and nothing else.
        const user = useAuthStore.getState().user;
        if (!user?.id || user.domainSession) return { state: 'refused', reason: 'signed_out' };
        if (!isOfferSource(input.from)) return { state: 'refused', reason: 'invalid' };
        if (now?.open) return { state: 'refused', reason: 'busy' };
        asked.current = { from: input.from, read, userId: user.id, generation: currentSessionGeneration() };
        put({ state: 'asking', shown: offeredName(input.name), open: true });
        return { state: 'asking' };
      }
      case 'status': {
        if (!now) return { state: 'idle' };
        if (now.state === 'added') return { state: 'added', name: now.added?.name ?? now.shown };
        if (now.state === 'declined') return { state: 'declined', reason: 'declined' };
        if (now.state === 'failed') return { state: 'failed', reason: now.reason ?? 'failed' };
        return { state: now.state };
      }
      default:
        throw new Error('Unknown add-app action.');
    }
  }, [enabled, put]);

  /** The person's yes: the files are fetched and the app is made, in the account they were asked in. */
  const add = useCallback(async () => {
    const now = live.current;
    const source = asked.current;
    if (!now || now.state !== 'asking' || !source) return;
    const adding: AppOffer = { ...now, state: 'adding' };
    put(adding);
    const stillTheirs = () => isSessionGenerationCurrent(source.generation) && useAuthStore.getState().user?.id === source.userId;
    const outcome = stillTheirs()
      ? await addOfferedApp(source.read, source.from, now.shown, stillTheirs)
      : { reason: 'failed' as const, message: 'You are no longer signed in as the person who was asked.' };
    // The page moved on meanwhile (another person, another app): this is no longer its offer.
    if (live.current !== adding) return;
    put('added' in outcome ? { state: 'added', shown: now.shown, open: true, added: outcome.added }
      : { state: 'failed', shown: now.shown, open: true, reason: outcome.reason, message: outcome.message });
  }, [put]);

  /** The sheet put away: Not now on a question is a no, and an answer already given stays as it is. */
  const close = useCallback(() => {
    const now = live.current;
    // Not while the app is being made: the person said yes, and is shown how it went.
    if (!now || !now.open || now.state === 'adding') return;
    put(now.state === 'asking' ? { state: 'declined', shown: now.shown, open: false } : { ...now, open: false });
  }, [put]);

  // Another app or another person in this page: what was offered to the last one is forgotten.
  useEffect(() => () => { asked.current = null; put(null); }, [slug, who, put]);

  return { offer, call, add, close };
}
