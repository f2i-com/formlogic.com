import { useEffect, useState } from 'react';
import { listAiSources, type AiSourceListing } from '../client-runtime/flows/desktopService';

/**
 * The paired Desktop's configured AI provider profiles, fetched once per session.
 *
 * A `connection` anywhere in the service-action world is one of these profiles — an opaque
 * id that the Desktop resolves to a credential-holding gateway. Asking a user to type that
 * id from memory is a needless trap, so every surface that takes a connection (the SRV-405
 * slot binding UI, the `service_action` node's property panel) offers this list and falls
 * back to free text only when there is nothing to offer.
 *
 * Disabled profiles are filtered out: binding to one would produce a node that resolves and
 * then fails at invocation.
 */

let providerProfilesPromise: Promise<AiSourceListing[]> | null = null;

export function fetchProviderProfilesOnce(): Promise<AiSourceListing[]> {
  if (!providerProfilesPromise) {
    providerProfilesPromise = listAiSources().then(
      (sources) => sources.filter((source) => source.kind === 'provider' && source.enabled),
      () => [],
    );
    // An empty result usually means "no Desktop paired yet" — don't poison the session.
    void providerProfilesPromise.then((profiles) => {
      if (profiles.length === 0) providerProfilesPromise = null;
    });
  }
  return providerProfilesPromise;
}

/** undefined = still loading; [] = no paired Desktop or no configured providers. */
export function useProviderProfiles(): AiSourceListing[] | undefined {
  const [profiles, setProfiles] = useState<AiSourceListing[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void fetchProviderProfilesOnce().then((next) => {
      if (!cancelled) setProfiles(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return profiles;
}
