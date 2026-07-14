import { useEffect, useRef } from 'react';
import { API_BASE } from '../api';

/** The phone/dongle lifecycle events that should refresh connection readouts
 *  the moment they happen (the SSE `event:` field carries the aokie.* name). */
export const AOKIE_LINK_EVENTS = [
  'aokie.dongle.ready',
  'aokie.phone.connected',
  'aokie.phone.disconnected',
  'aokie.phone.paired',
] as const;

/**
 * Subscribe to the desktop's live event stream (`GET /api/events`, SSE) and
 * invoke `onEvent` whenever one of `names` lands. Powers INSTANT UI updates
 * when the phone connects/disconnects/pairs, instead of waiting out the idle
 * poll (live report 2026-07-13: the phone-connected readout lagged the actual
 * Bluetooth connection by up to 12s). The polls stay as the fallback truth —
 * this only makes them fire immediately when something actually changed.
 *
 * EventSource reconnects automatically; the webview origin passes the
 * `/api/events` auth guard, and consumers stay trivially cheap because the
 * stream only wakes them for the named events.
 */
export function useAokieEvents(
  enabled: boolean,
  names: readonly string[],
  onEvent: (name: string) => void,
): void {
  // The latest callback without resubscribing per render.
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  const namesKey = names.join('|');
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource(`${API_BASE}/api/events`);
    const listeners = namesKey
      .split('|')
      .filter(Boolean)
      .map((name) => {
        const fn = () => handlerRef.current(name);
        source.addEventListener(name, fn);
        return [name, fn] as const;
      });
    return () => {
      for (const [name, fn] of listeners) source.removeEventListener(name, fn);
      source.close();
    };
  }, [enabled, namesKey]);
}
