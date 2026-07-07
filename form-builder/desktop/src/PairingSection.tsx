import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pairing,
  trustedOrigins,
  type PairingRequestInfo,
  type TrustedOrigin,
} from './api';
import { useToast } from './Toasts';

/**
 * Web connections — pairing approvals + trusted origins. Rendered inside the
 * Settings panel.
 *
 * A FormLogic web app that wants to use local plugins/connectors POSTs a
 * pairing request naming its origin; it shows up here for the user to
 * Approve (mints an origin-bound bearer token) or Deny. Approved origins are
 * listed below with a Revoke that deletes all their tokens.
 */
export default function PairingSection() {
  const [requests, setRequests] = useState<PairingRequestInfo[] | null>(null);
  const [origins, setOrigins] = useState<TrustedOrigin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const toast = useToast();
  const reqSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const [reqs, origs] = await Promise.all([
        pairing.pending(),
        trustedOrigins.list(),
      ]);
      if (seq !== reqSeqRef.current) return;
      setRequests(reqs);
      setOrigins(origs);
      setError(null);
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    // 3s poll: fast enough that an approval prompt feels immediate.
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusyIds((p) => new Set(p).add(key));
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyIds((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    },
    [refresh],
  );

  return (
    <section className="model-section">
      <h3 className="section-title">Web connections</h3>
      <p className="form-hint" style={{ marginBottom: 12 }}>
        FormLogic web apps must pair with this desktop before they can use
        local plugins and connectors. Approving a request gives that exact
        website (origin) a private token — nothing else on your machine or the
        web can use it. Revoke an origin any time to cut it off.
      </p>
      {error && <div className="banner banner-err">⚠ {error}</div>}

      {requests && requests.length > 0 && (
        <div className="settings-grid" style={{ marginBottom: 14 }}>
          {requests.map((r) => (
            <div className="settings-row" key={r.id}>
              <span className="settings-label">
                <span className="badge badge-pending">pairing request</span>
              </span>
              <div className="settings-value">
                <code className="path-code">{r.origin}</code>
                <span className="form-hint">
                  asked {new Date(r.createdAt).toLocaleTimeString()}
                </span>
                <button
                  className="btn btn-primary"
                  disabled={busyIds.has(r.id)}
                  onClick={() =>
                    act(r.id, async () => {
                      await pairing.approve(r.id);
                      toast.push({
                        kind: 'success',
                        title: 'Pairing approved',
                        body: `${r.origin} can now use local plugins.`,
                      });
                    })
                  }
                >
                  Approve
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busyIds.has(r.id)}
                  onClick={() =>
                    act(r.id, async () => {
                      await pairing.deny(r.id);
                      toast.push({
                        kind: 'info',
                        title: 'Pairing denied',
                        body: r.origin,
                        timeoutMs: 5000,
                      });
                    })
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {requests && requests.length === 0 && (
        <p className="form-hint" style={{ marginBottom: 10 }}>
          No pending pairing requests.
        </p>
      )}

      <h3 className="section-title" style={{ marginTop: 8 }}>
        Trusted origins
      </h3>
      {origins && origins.length > 0 ? (
        <div className="settings-grid">
          {origins.map((o) => (
            <div className="settings-row" key={o.origin}>
              <div className="settings-value">
                <code className="path-code">{o.origin}</code>
                <span className="form-hint">
                  paired {new Date(o.createdAt).toLocaleDateString()} ·{' '}
                  {o.tokens} token{o.tokens === 1 ? '' : 's'}
                </span>
                <button
                  className="btn-tiny"
                  disabled={busyIds.has(o.origin)}
                  title="Delete this origin's tokens — it must pair again to reconnect"
                  onClick={() => {
                    if (
                      confirm(
                        `Revoke "${o.origin}"? It loses access to local plugins until it pairs again.`,
                      )
                    ) {
                      act(o.origin, async () => {
                        const res = await trustedOrigins.revoke(o.origin);
                        toast.push({
                          kind: 'info',
                          title: `Revoked ${o.origin}`,
                          body: `${res.removed} token(s) deleted.`,
                          timeoutMs: 5000,
                        });
                      });
                    }
                  }}
                >
                  revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="form-hint">
          No web apps are paired yet. When a FormLogic app asks to connect, the
          request appears above.
        </p>
      )}
    </section>
  );
}
