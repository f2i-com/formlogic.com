// FormLogic Flows — desktop presence for the /flows workspace.
//
// The workspace only needs the desktop_connections registry signal: local loopback + pairing
// wins, otherwise a fresh linked Desktop heartbeat (< 90s, parsed with Aokie's MySQL-local
// timestamp convention) marks Desktop-powered nodes as online. Every failed probe degrades to
// 'none' so authoring stays usable even when the registry is unreadable.
import { useEffect, useState } from 'react';
import { getDesktopInfo, subscribeDesktopStatus } from '../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired } from '../../client-runtime/desktop/desktopPairing';
import { api } from '../../lib/api';
import {
  PRESENCE_POLL_MS,
  parseDbTimestamp,
  pickFreshConnection,
} from '../custom-screen/connector/runtimePresence';

export type FlowsDesktopPresenceKind = 'local' | 'remote' | 'none';

export type FlowsDesktopPresence =
  | { kind: 'local'; label?: string; lastSeenMs?: undefined }
  | { kind: 'remote'; label: string; lastSeenMs?: number }
  | { kind: 'none'; label?: undefined; lastSeenMs?: undefined };

export function hasLocalDesktopBridge(): boolean {
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

export function useFlowsDesktopPresence(): FlowsDesktopPresence {
  const [localBridge, setLocalBridge] = useState(() => hasLocalDesktopBridge());
  const [remote, setRemote] = useState<FlowsDesktopPresence | null>(null);

  useEffect(
    () =>
      subscribeDesktopStatus((info) => {
        const local = info.available && isDesktopPaired();
        setLocalBridge(local);
        if (local) setRemote(null);
      }),
    []
  );

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

  if (localBridge) return { kind: 'local' };
  return remote ?? { kind: 'none' };
}
