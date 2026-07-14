import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToastStore } from '../stores/toastStore';
import { usePublicConfig } from './usePublicConfig';

/**
 * Signed-in broadcast channel (admin panel): polls /api/notices while the tab
 * is visible and toasts every notice this browser hasn't shown yet (dedup via
 * localStorage, so a notice pops once per device, not once per poll). The same
 * poll doubles as LIVE maintenance detection — when the admin closes the site,
 * the poll starts answering 503 {maintenance:true} and the shell can react
 * immediately instead of waiting for a reload.
 */

const POLL_MS = 45_000;
const SEEN_KEY = 'formlogic_seen_notices';

function seenIds(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function markSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-100)));
  } catch {
    /* storage full/unavailable — the toast may repeat, which is harmless */
  }
}

export interface MaintenanceState {
  active: boolean;
  message: string;
}

export function useBroadcastNotices(enabled: boolean): MaintenanceState {
  const cfg = usePublicConfig();
  const [maintenance, setMaintenance] = useState<MaintenanceState>({ active: false, message: '' });
  const pollingRef = useRef(false);

  // Page-load state from the pre-auth config (covers opening the app mid-window).
  useEffect(() => {
    if (cfg.maintenanceMode) {
      setMaintenance({ active: true, message: cfg.maintenanceMessage || 'The site is briefly down for maintenance.' });
    }
  }, [cfg.maintenanceMode, cfg.maintenanceMessage]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let id: number | undefined;

    const tick = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const res = await api.getNotices();
        if (cancelled) return;
        if (res.status === 503) {
          // MaintenanceMiddleware's 503 carries the admin's message as `message`,
          // which the api client flattens into `error`.
          setMaintenance({ active: true, message: res.error || 'The site is briefly down for maintenance.' });
          return;
        }
        if (res.data) {
          setMaintenance((m) => (m.active ? { active: false, message: '' } : m));
          const seen = seenIds();
          const fresh = (res.data.notices || []).filter((n) => !seen.includes(n.id));
          if (fresh.length > 0) {
            const addToast = useToastStore.getState().addToast;
            // Oldest first so stacked toasts read chronologically.
            for (const n of [...fresh].reverse()) {
              const title = 'Message from the administrator';
              if (n.level === 'warning') {
                // Persistent (manual dismiss) — warnings usually announce downtime.
                addToast({ type: 'warning', title, message: n.message, duration: 0 });
              } else if (n.level === 'success') {
                addToast({ type: 'success', title, message: n.message, duration: 12_000 });
              } else {
                addToast({ type: 'info', title, message: n.message, duration: 12_000 });
              }
            }
            markSeen([...seen, ...fresh.map((n) => n.id)]);
          }
        }
      } finally {
        pollingRef.current = false;
      }
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
  }, [enabled]);

  return maintenance;
}
