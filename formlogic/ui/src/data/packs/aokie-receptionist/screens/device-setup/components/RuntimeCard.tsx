/** @jsxImportSource preact */
// FormLogic Desktop presence card: local / remote / not-connected states, the
// 'Connect FormLogic Desktop' host ceremony trigger, and the owner's linked
// desktop registry (owner-only; a member's refusal simply hides the list).
import { agoLabel } from '../format';
import type { DesktopRow } from '../types';

interface Props {
  demo: boolean;
  presence: FlPresence | null;
  desktops: DesktopRow[] | null;
  connecting: boolean;
  onConnectDesktop: () => void;
}

export function RuntimeCard({ demo, presence, desktops, connecting, onConnectDesktop }: Props) {
  if (demo) {
    return (
      <section class="card" id="runtime">
        <h2>Demo bridge</h2>
        <p class="muted">This is the shared demo, so the hardware below is simulated - FormLogic Desktop and real phones are never used here. Use "Simulate incoming call" on the Calls screen to see the receptionist in action.</p>
      </section>
    );
  }
  const p = presence;
  const ago = p && p.kind === 'remote' ? agoLabel(p.lastSeenAt) : null;
  return (
    <section class="card" id="runtime">
      <div class="sectionrow">
        <h2>FormLogic Desktop</h2>
        {p && p.kind === 'local' && <span class="pill ok">Connected on this computer</span>}
        {p && p.kind === 'remote' && <span class="pill accent">{'Running on ' + (p.deviceName || 'another machine')}</span>}
        {p && p.kind === 'none' && <span class="pill warn">Not connected</span>}
      </div>
      {p === null && (
        <div class="loadwrap" role="status" aria-label="Checking for FormLogic Desktop">
          <span class="skeleton" />
          <span class="skeleton short" />
        </div>
      )}
      {p && p.kind === 'remote' && (
        <p class="muted">
          {'The receptionist runs on '}
          <strong>{p.deviceName || 'another machine'}</strong>
          {(ago ? ' (last seen ' + ago + ')' : '') + ' - phone commands below are relayed to that machine.'}
        </p>
      )}
      {p && p.kind === 'local' && (
        <p class="muted">Device plugins and hardware connectors are served by the FormLogic Desktop on this computer.</p>
      )}
      {p && p.kind === 'none' && (
        <div>
          <p class="muted">FormLogic Desktop hosts the phone bridge and hardware connectors. Start it on this computer, then connect it - approving the request on the desktop issues a token bound to this site.</p>
          <p class="cta">
            <button type="button" class="btn primary" disabled={connecting} onClick={onConnectDesktop}>
              {connecting ? 'Waiting for approval on the desktop...' : 'Connect FormLogic Desktop'}
            </button>
          </p>
        </div>
      )}
      {desktops && desktops.length > 0 && (
        <div>
          <p class="faint listhead">Linked desktops</p>
          <ul>
            {desktops.map((d, i) => {
              const seen = agoLabel(d.lastSeenAt);
              return (
                <li key={i}>
                  <div class="rowmain"><span class="rowname">{d.deviceName || 'Desktop'}</span></div>
                  <span class="faint">{seen ? 'Last seen ' + seen : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
