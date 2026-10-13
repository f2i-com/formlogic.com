import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { HostedDeployment } from './hosting';
import { admitHostedActor, captureHostedRequest, HOSTED_ACTOR_ERROR, isHostedRequestCurrent, type HostedAdmission } from './hostedActor';
import { currentSessionGeneration, currentSessionOwner, subscribeSessionGeneration } from './sessionGeneration';

type Runtime = { slug: string; generation: number; userId: string | null; name?: string; deployment?: HostedDeployment; engine?: { id: string; revision: string }; admission?: HostedAdmission; error?: string };
/** One admission path for the standalone page and embedded dashboard. */
export function useHostedRuntime(slug: string) {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const userId = currentSessionOwner();
  const [result, setResult] = useState<Runtime | null>(null);
  useEffect(() => {
    let active = true;
    const request = captureHostedRequest();
    void api.getHostedRuntime(slug).then(response => {
      if (!active || !isHostedRequestCurrent(request)) return;
      const admission = admitHostedActor(response.error ? response.actor : response.data?.actor, request, slug);
      const data = response.data;
      const error = !admission ? HOSTED_ACTOR_ERROR : response.error || (!data?.deployment ? HOSTED_ACTOR_ERROR : undefined);
      setResult({ slug, ...request, ...(error ? { error } : { name: data?.name, deployment: data?.deployment, engine: data?.engine, admission: admission! }) });
    }).catch(() => {
      if (active && isHostedRequestCurrent(request)) setResult({ slug, ...request, error: 'This app could not be opened. Reload to try again.' });
    });
    return () => { active = false; };
  }, [slug, generation, userId]);
  return result?.slug === slug && result.generation === generation && result.userId === userId ? result : null;
}
