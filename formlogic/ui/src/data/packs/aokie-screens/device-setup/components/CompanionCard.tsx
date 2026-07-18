/** @jsxImportSource preact */
// Companion access administration: the remote-access policy checkboxes and the
// linked endpoints with revoke (double-gated: ask -> confirm) / approve-again.
// Routing groups + session history stay in FormLogic Desktop's Companion admin.
import { useEffect, useState } from 'preact/hooks';
import { agoLabel } from '../format';
import { POLICY_KEYS } from '../types';
import type { CompanionDevice, CompanionState } from '../types';
import { Loading } from './Loading';

interface Props {
  demo: boolean;
  companion: CompanionState | null;
  busyCompanion: string | null;
  confirmRevoke: string | null;
  busyPolicy: boolean;
  onRevokeAsk: (deviceId: string) => void;
  onRevokeCancel: () => void;
  onRevoke: (device: CompanionDevice) => void;
  onApprove: (device: CompanionDevice) => void;
  onSavePolicy: (draft: Record<string, boolean>) => void;
}

export function CompanionCard({
  demo, companion, busyCompanion, confirmRevoke, busyPolicy,
  onRevokeAsk, onRevokeCancel, onRevoke, onApprove, onSavePolicy,
}: Props) {
  // The checkbox draft mirrors the served policy until the user toggles; a
  // reload (fresh companion state) reseeds it from the server's truth.
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const p = companion && companion.policy ? companion.policy : {};
    const next: Record<string, boolean> = {};
    for (const [key] of POLICY_KEYS) next[key] = !!p[key];
    setDraft(next);
  }, [companion]);

  if (demo) {
    return (
      <section class="card" id="companion">
        <h2>Companion access</h2>
        <p class="faint">Not available in the shared demo.</p>
      </section>
    );
  }
  if (companion === null) {
    return (
      <section class="card" id="companion">
        <h2>Companion access</h2>
        <Loading />
      </section>
    );
  }
  if (companion.hidden) {
    return (
      <section class="card" id="companion">
        <h2>Companion access</h2>
        <p class="faint">Your role does not include Companion administration.</p>
      </section>
    );
  }

  const c = companion;
  return (
    <section class="card" id="companion">
      <h2>Companion access</h2>
      {c.policy && (
        <div>
          <p class="muted intro">Remote access policy - what linked Companion endpoints may do on live calls.</p>
          <div class="policy">
            {POLICY_KEYS.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  data-policy={key}
                  checked={!!draft[key]}
                  disabled={!c.canEdit}
                  onInput={(e) => setDraft({ ...draft, [key]: e.currentTarget.checked })}
                />
                {' ' + label}
              </label>
            ))}
          </div>
          {!c.policy.configured && (
            <p class="faint unset">No explicit policy is set yet - everything stays OFF until one is saved.</p>
          )}
          {c.canEdit && (
            <button type="button" class="btn" disabled={busyPolicy} onClick={() => onSavePolicy({ ...draft })}>
              {busyPolicy ? 'Saving...' : 'Save policy'}
            </button>
          )}
        </div>
      )}
      {c.devices && (
        <div>
          <p class="faint listhead">Linked endpoints</p>
          {c.devices.length === 0 ? (
            <p class="faint">No Companion endpoints are linked to this app.</p>
          ) : (
            <ul>
              {c.devices.map((d) => {
                const revoked = !!d.revokedAt;
                const seen = agoLabel(d.lastSeenAt);
                const busy = busyCompanion === d.id;
                return (
                  <li key={d.id}>
                    <div class="rowmain">
                      <span class="rowname">{d.displayName || d.id}</span>
                      {' '}
                      <span class="pill">{d.role || ''}</span>
                      {' '}
                      <span class={revoked ? 'pill bad' : 'pill ok'}>{revoked ? 'Revoked' : 'Active'}</span>
                      {seen && <div class="faint">{'Last seen ' + seen}</div>}
                    </div>
                    {revoked ? (
                      <button type="button" class="btn" disabled={busy} onClick={() => onApprove(d)}>
                        {busy ? 'Working...' : 'Approve again'}
                      </button>
                    ) : confirmRevoke === d.id ? (
                      <span>
                        <button type="button" class="btn danger-btn" disabled={busy} onClick={() => onRevoke(d)}>
                          {busy ? 'Revoking...' : 'Confirm revoke'}
                        </button>
                        {' '}
                        <button type="button" class="btn" onClick={onRevokeCancel}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" class="btn" onClick={() => onRevokeAsk(d.id)}>Revoke</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p class="faint footnote">Routing groups and the session history live in FormLogic Desktop's Companion admin.</p>
        </div>
      )}
    </section>
  );
}
