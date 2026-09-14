// FormLogic Flows — desktop presence for the /flows workspace.
//
// The workspace only needs the desktop_connections registry signal: local loopback + pairing
// wins, otherwise a fresh linked Desktop heartbeat (< 90s, parsed with Aokie's MySQL-local
// timestamp convention) marks Desktop-powered nodes as online. Every failed probe degrades to
// 'none' so authoring stays usable even when the registry is unreadable.
import { useEffect, useState } from 'react';
import { getDesktopInfo, subscribeDesktopStatus } from '../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired, subscribeDesktopPaired } from '../../client-runtime/desktop/desktopPairing';
import { isOaiyPaired, oaiyRouteAvailable, subscribeOaiyPaired } from '../../client-runtime/oaiy/oaiyRuntime';
import { subscribeOaiyStatus } from '../../client-runtime/oaiy/oaiyDetection';
import { api } from '../../lib/api';
import {
  PRESENCE_POLL_MS,
  parseDbTimestamp,
  pickFreshConnection,
} from '../custom-screen/connector/runtimePresence';

export type FlowsDesktopPresenceKind = 'local' | 'remote' | 'none';

export type FlowsDesktopPresence =
  | { kind: 'local'; runtime?: 'oaiy'; label?: string; lastSeenMs?: undefined }
  | { kind: 'remote'; label: string; lastSeenMs?: number }
  | { kind: 'none'; label?: undefined; lastSeenMs?: undefined };

export function hasLocalDesktopBridge(): boolean {
  // FormLogic-Desktop-specific on purpose: this signal drives the header
  // DesktopConnectionPopover, which issues FormLogic Desktop loopback calls when
  // it reads 'local'. OAIY is preferred by the connector layer independently (via
  // oaiyRouteAvailable()); folding OAIY in here would make the popover claim a
  // local bridge and then call the wrong runtime.
  return getDesktopInfo().available && isDesktopPaired();
}

export function deriveFlowsDesktopPresence(
  input: { localBridge: boolean; connections: unknown[] | null },
  now: number = Date.now()
): FlowsDesktopPresence {
  if (input.localBridge) return { kind: 'local' };
  const remote = pickFreshConnection(input.connections, now);
  if (!remote) return { kind: 'none' };
  const lastSeenMs = parseDbTimestamp(remote.lastSeenAt);
  return lastSeenMs === null
    ? { kind: 'remote', label: remote.deviceName }
    : { kind: 'remote', label: remote.deviceName, lastSeenMs };
}

export async function fetchFlowsDesktopConnections(): Promise<unknown[] | null> {
  try {
    const res = await api.getDesktopConnections();
    return Array.isArray(res.data?.connections) ? res.data.connections : null;
  } catch {
    return null;
  }
}

export async function resolveFlowsDesktopPresence(
  options: {
    localBridge?: boolean;
    fetchConnections?: () => Promise<unknown[] | null>;
    now?: number;
  } = {}
): Promise<FlowsDesktopPresence> {
  const localBridge = options.localBridge ?? hasLocalDesktopBridge();
  if (localBridge) return { kind: 'local' };
  const fetchConnections = options.fetchConnections ?? fetchFlowsDesktopConnections;
  try {
    return deriveFlowsDesktopPresence({ localBridge: false, connections: await fetchConnections() }, options.now);
  } catch {
    return { kind: 'none' };
  }
}

export function describeFlowsLastSeen(lastSeenMs: number | undefined, now: number = Date.now()): string | null {
  if (typeof lastSeenMs !== 'number' || !Number.isFinite(lastSeenMs)) return null;
  const seconds = Math.max(0, Math.round((now - lastSeenMs) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** The legacy popover opts out because its controls use the legacy transport. */
export function localFlowRuntime(includeOaiy = false): FlowsDesktopPresence {
  if (includeOaiy && oaiyRouteAvailable()) return { kind: 'local', runtime: 'oaiy', label: 'OAIY' };
  return hasLocalDesktopBridge() ? { kind: 'local' } : { kind: 'none' };
}

export function useFlowsDesktopPresence(includeOaiy = false, discoverLocal = true, remoteOnly = false): FlowsDesktopPresence {
  const [local, setLocal] = useState(() => localFlowRuntime(includeOaiy));
  const localBridge = !remoteOnly && local.kind === 'local';
  const legacyPaired = isDesktopPaired();
  const oaiyPaired = isOaiyPaired();
  const [remote, setRemote] = useState<FlowsDesktopPresence | null>(null);

  // Pairing and detection changes update the editor immediately. The legacy
  // connection popover keeps its own transport-specific presence by opting out.
  useEffect(() => {
    const recompute = () => {
      const next = localFlowRuntime(includeOaiy);
      setLocal(next);
      if (!remoteOnly && next.kind === 'local') setRemote(null);
    };
    const unsubs = [
      subscribeDesktopStatus(recompute, { probe: !remoteOnly && (discoverLocal || legacyPaired) }),
      subscribeDesktopPaired(recompute),
      subscribeOaiyStatus(recompute, { probe: !remoteOnly && (discoverLocal || oaiyPaired) }),
      subscribeOaiyPaired(recompute),
    ];
    return () => unsubs.forEach((u) => u());
  }, [includeOaiy, discoverLocal, legacyPaired, oaiyPaired, remoteOnly]);

  useEffect(() => {
    if (localBridge) return;
    let cancelled = false;
    const probe = async () => {
      const next = await resolveFlowsDesktopPresence({ localBridge: false });
      if (!cancelled) setRemote(next.kind === 'remote' ? next : null);
    };
    void probe();
    const timer = setInterval(() => void probe(), PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [localBridge]);

  if (localBridge) return local;
  return remote ?? { kind: 'none' };
}
