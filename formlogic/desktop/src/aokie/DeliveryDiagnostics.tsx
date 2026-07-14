import { useCallback, useEffect, useState } from 'react';
import { plugins } from '../api';
import { useToast } from '../Toasts';

interface OutboxCounts {
  pending?: number;
  failed?: number;
  dead?: number;
  keyCollisions?: number;
}

/**
 * Event-delivery diagnostics (redesign 2026-07, deferred follow-up): the
 * plugin's durable outbox counts from `dongle.diagnostics`, with the
 * operator redrive for dead-lettered events. Dead events NEVER retry
 * automatically — that would make the dead-letter state meaningless — so the
 * redrive is an explicit button, shown only when there is something to
 * revive.
 */
export function DeliveryDiagnostics() {
  const [counts, setCounts] = useState<OutboxCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const res = await plugins.command('aokie', 'dongle.diagnostics');
      const data = res.data as { outbox?: OutboxCounts } | undefined;
      setCounts(data?.outbox ?? null);
    } catch {
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    let id: number | undefined;
    const start = () => {
      if (id !== undefined) return;
      void refresh();
      id = window.setInterval(refresh, 10000);
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
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  const redrive = async () => {
    setBusy(true);
    try {
      const res = await plugins.command('aokie', 'outbox.redrive', { all: true });
      const revived = (res.data as { revived?: number } | undefined)?.revived ?? 0;
      toast.push({
        kind: revived > 0 ? 'success' : 'info',
        title: revived > 0 ? `Redriving ${revived} dead event${revived === 1 ? '' : 's'}` : 'Nothing to redrive',
        body: revived > 0 ? 'They re-enter the delivery pipeline now.' : 'No dead events left.',
      });
      await refresh();
    } catch (e) {
      toast.push({ kind: 'error', title: 'Redrive failed', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const dead = counts?.dead ?? 0;
  const failed = counts?.failed ?? 0;
  const pending = counts?.pending ?? 0;
  const collisions = counts?.keyCollisions ?? 0;
  const healthy = counts != null && dead === 0 && failed === 0;

  return (
    <section className="desktop-panel-card desktop-delivery-card">
      <div className="desktop-panel-card__heading">
        <div>
          <small>DATA DELIVERY</small>
          <h3>
            {counts == null
              ? 'Outbox unavailable'
              : healthy
                ? pending > 0
                  ? 'Delivering…'
                  : 'All events delivered'
                : 'Delivery needs attention'}
          </h3>
        </div>
        <span className={`desktop-status-pill ${counts == null ? 'is-neutral' : healthy ? 'is-ok' : 'is-warn'}`}>
          <i />
          {counts == null ? 'Unknown' : healthy ? 'Healthy' : dead > 0 ? `${dead} dead` : `${failed} failed`}
        </span>
      </div>
      <div className="desktop-delivery-counts">
        <span>
          <strong>{counts ? pending : '—'}</strong>
          <small>Pending</small>
        </span>
        <span>
          <strong>{counts ? failed : '—'}</strong>
          <small>Failed</small>
        </span>
        <span>
          <strong>{counts ? dead : '—'}</strong>
          <small>Dead</small>
        </span>
      </div>
      {collisions > 0 && (
        <p className="desktop-delivery-note is-warn">
          {collisions} idempotency key collision{collisions === 1 ? '' : 's'} rejected — a
          key-derivation bug; check the plugin logs.
        </p>
      )}
      {dead > 0 && (
        <div className="desktop-delivery-actions">
          <button type="button" className="desktop-button" disabled={busy} onClick={() => void redrive()}>
            {busy ? 'Redriving…' : `Redrive ${dead} dead event${dead === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </section>
  );
}
