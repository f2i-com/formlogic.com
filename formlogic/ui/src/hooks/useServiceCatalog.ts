import { useEffect, useState } from 'react';
import {
  desktopClient,
  type DesktopServiceCatalog,
  type DesktopServiceDefinitionAction,
} from '../client-runtime/desktop/desktopClient';

/**
 * The paired Desktop's v3 Service Definition catalog, fetched once per session.
 *
 * Shared by every surface that needs to name a service: the flow editor's `service_action`
 * pickers and the SRV-405 binding UI on an installed extension. One module-level promise
 * means opening several of them costs one request.
 */

let serviceCatalogPromise: Promise<DesktopServiceCatalog | null> | null = null;

export function fetchServiceCatalogOnce(): Promise<DesktopServiceCatalog | null> {
  if (!serviceCatalogPromise) {
    serviceCatalogPromise = desktopClient.servicePlatform.catalog().then(
      (res) => (res.ok ? res.data : null),
      () => null,
    );
    // A transient failure (Desktop not paired yet) must not poison the session.
    void serviceCatalogPromise.then((catalog) => {
      if (catalog === null) serviceCatalogPromise = null;
    });
  }
  return serviceCatalogPromise;
}

/** undefined = loading, null = no paired Desktop / catalog unavailable. */
export function useServiceCatalog(): DesktopServiceCatalog | null | undefined {
  const [catalog, setCatalog] = useState<DesktopServiceCatalog | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void fetchServiceCatalogOnce().then((next) => {
      if (!cancelled) setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
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
