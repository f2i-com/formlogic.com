import { useEffect, useState } from 'react';
import {
  desktopClient,
  type DesktopServiceCatalog,
  type DesktopServiceDefinitionAction,
} from '../client-runtime/desktop/desktopClient';
import {
  currentSessionGeneration,
  isSessionGenerationCurrent,
  subscribeSessionGeneration,
} from '../lib/sessionGeneration';

/**
 * The paired Desktop's v3 Service Definition catalog, fetched once per session.
 *
 * Shared by every surface that needs to name a service: the flow editor's `service_action`
 * pickers and the SRV-405 binding UI on an installed extension. One module-level promise
 * means opening several of them costs one request.
 */

let serviceCatalogPromise: Promise<DesktopServiceCatalog | null> | null = null;

export function clearServiceCatalogCache(): void {
  serviceCatalogPromise = null;
}

subscribeSessionGeneration(() => {
  serviceCatalogPromise = null;
});

export function fetchServiceCatalogOnce(): Promise<DesktopServiceCatalog | null> {
  if (!serviceCatalogPromise) {
    const gen = currentSessionGeneration();
    const pending = desktopClient.servicePlatform.catalog().then(
      (res) => (isSessionGenerationCurrent(gen) && res.ok ? res.data : null),
      () => null,
    );
    serviceCatalogPromise = pending;
    // A transient failure (Desktop not paired yet) or stale session must not poison the cache.
    void pending.then((catalog) => {
      if (catalog === null && serviceCatalogPromise === pending) {
        serviceCatalogPromise = null;
      }
    });
  }
  return serviceCatalogPromise;
}

/** undefined = loading, null = no paired Desktop / catalog unavailable. */
export function useServiceCatalog(): DesktopServiceCatalog | null | undefined {
  const [catalog, setCatalog] = useState<DesktopServiceCatalog | null | undefined>(undefined);
  const [sessionTick, setSessionTick] = useState(0);
  useEffect(() => subscribeSessionGeneration(() => {
    setCatalog(undefined);
    setSessionTick((t) => t + 1);
  }), []);
  useEffect(() => {
    let cancelled = false;
    const gen = currentSessionGeneration();
    void fetchServiceCatalogOnce().then((next) => {
      if (!cancelled && isSessionGenerationCurrent(gen)) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionTick]);
  return catalog;
}

export function catalogAction(
  catalog: DesktopServiceCatalog | null | undefined,
  definitionId: unknown,
  actionId: unknown,
): DesktopServiceDefinitionAction | null {
  if (!catalog || typeof definitionId !== 'string' || typeof actionId !== 'string') return null;
  const definition = catalog.definitions.find((d) => d.id === definitionId);
  return definition?.actions.find((a) => a.id === actionId) ?? null;
}
