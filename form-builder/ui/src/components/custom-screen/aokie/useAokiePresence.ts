// Aokie Receptionist — the presence hook behind the remote-viewer banner.
//
// Wraps aokiePresence's pure resolution in the screens' lifecycle: local bridge state
// comes from the shared desktop detection/pairing modules (reactive, demand-driven);
// when there is NO local bridge the hook probes the remote signals immediately and then
// every PRESENCE_POLL_MS while the tab is visible (plus a probe on tab re-focus), so a
// receptionist started at home shows up here within a poll tick. All probes are
// best-effort — failures resolve to 'none' (the current install/demo state).
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { getDesktopInfo, subscribeDesktopStatus } from '../../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired } from '../../../client-runtime/desktop/desktopPairing';
import {
  PRESENCE_POLL_MS,
  resolveRemoteRuntime,
  type AokiePresence,
  type RemoteRuntimeInfo,
} from './aokiePresence';

export function useAokiePresence(): AokiePresence {
  const appId = useAppRuntimeStore((s) => s.config?.app.id);
  // The shared Demo account is ALWAYS the install/demo state ('none' → mock
  // bridge + simulate button): a paired FormLogic Desktop running on the same
  // machine must never read as the demo's receptionist (live report
  // 2026-07-14 — "Calls" showed Listening off the operator's real radio), and
  // remote probes are skipped too (the demo account owns no desktops).
  const demoMode = api.isDemoMode();
  const [localBridge, setLocalBridge] = useState(() => !demoMode && getDesktopInfo().available && isDesktopPaired());
  const [remote, setRemote] = useState<RemoteRuntimeInfo | null>(null);

  useEffect(() => {
    if (demoMode) return;
    return subscribeDesktopStatus((info) => {
      const local = info.available && isDesktopPaired();
      setLocalBridge(local);
      // A local bridge supersedes any previously-probed remote signal.
      if (local) setRemote(null);
    });
  }, [demoMode]);

  useEffect(() => {
    if (demoMode || localBridge) return;
    let cancelled = false;
    const probe = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const info = await resolveRemoteRuntime(appId);
      if (!cancelled) setRemote(info);
    };
    void probe();
    const timer = setInterval(() => void probe(), PRESENCE_POLL_MS);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [demoMode, localBridge, appId]);

  if (demoMode) return { kind: 'none' };
  if (localBridge) return { kind: 'local' };
  return remote ? { kind: 'remote', ...remote } : { kind: 'none' };
}
