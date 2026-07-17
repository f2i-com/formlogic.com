import { useEffect, useState } from 'react';
import {
  isTauri,
  models,
  pairing,
  plugins,
  python,
  services,
  trustedOrigins,
  formlogic,
  type DownloadProgress,
  type FormLogicConfigView,
  type FlowRuntimeStatus,
  type ModelsSnapshot,
  type PairingRequestInfo,
  type PluginsListResponse,
  type PythonSnapshot,
  type RegistrySnapshot,
  type TrustedOrigin,
} from './api';
import { primeServicesStore } from './servicesStore';

/**
 * Aggregate snapshot for the Overview workspace (redesign 2026-07).
 *
 * Fetched with Promise.allSettled so one failing endpoint degrades ITS card
 * only — the rest of the page keeps rendering. Every field is undefined until
 * its source has answered at least once (and stays at the last good value on
 * later failures, so cards don't flicker blank on a transient miss).
 */
export interface DesktopOverviewData {
  services?: RegistrySnapshot;
  models?: ModelsSnapshot;
  downloads?: DownloadProgress[];
  python?: PythonSnapshot;
  plugins?: PluginsListResponse;
  cloud?: FormLogicConfigView;
  runtime?: FlowRuntimeStatus;
  pendingPairing?: PairingRequestInfo[];
  origins?: TrustedOrigin[];
  /** True once the first fetch round has settled (drives skeleton states). */
  loaded: boolean;
}

const POLL_MS = 5000;

/**
 * Visibility-aware Overview polling: about every five seconds while the
 * window is visible AND the hook is mounted; zero timers while hidden
 * (tray-resident app — same discipline as the health poll in App.tsx).
 */
export function useDesktopOverview(): DesktopOverviewData {
  const [data, setData] = useState<DesktopOverviewData>({ loaded: false });

  useEffect(() => {
    let cancelled = false;
    let id: number | undefined;

    const tick = async () => {
      const inTauri = isTauri();
      const [svc, mdl, dl, py, plg, cloud, runtime, pend, orig] = await Promise.allSettled([
        services.list(),
        models.list(),
        models.downloads(),
        python.status(),
        plugins.list(),
        // Tauri invokes fail fast in a plain-browser dev tab — skip cleanly.
        inTauri ? formlogic.getConfig() : Promise.reject(new Error('not tauri')),
        inTauri ? formlogic.status() : Promise.reject(new Error('not tauri')),
        pairing.pending(),
        trustedOrigins.list(),
      ]);
      if (cancelled) return;
      // SRV-002: feed the services snapshot into the shared store so a
      // navigation Overview → Services paints instantly with fresh data.
      if (svc.status === 'fulfilled') primeServicesStore(svc.value);
      setData((prev) => {
        const next: DesktopOverviewData = {
          loaded: true,
          services: svc.status === 'fulfilled' ? svc.value : prev.services,
          models: mdl.status === 'fulfilled' ? mdl.value : prev.models,
          downloads: dl.status === 'fulfilled' ? dl.value : prev.downloads,
          python: py.status === 'fulfilled' ? py.value : prev.python,
          plugins: plg.status === 'fulfilled' ? plg.value : prev.plugins,
          cloud: cloud.status === 'fulfilled' ? cloud.value : prev.cloud,
          runtime: runtime.status === 'fulfilled' ? runtime.value : prev.runtime,
          pendingPairing: pend.status === 'fulfilled' ? pend.value : prev.pendingPairing,
          origins: orig.status === 'fulfilled' ? orig.value : prev.origins,
        };
        // Identical aggregate keeps the previous object so React bails out:
        // this hook lives at the App root, so an unconditional new object
        // re-rendered the ENTIRE tree (whichever panel was mounted included)
        // every 5 s and could restart an in-flight section transition. The
        // stringify costs a few ms; the avoided tree render cost far more.
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    };

    const start = () => {
      if (id !== undefined) return;
      void tick();
      id = window.setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return data;
}
