/** @jsxImportSource preact */
// OAIY presence card: local / remote / not-connected states, the 'Connect
// OAIY' host ceremony trigger, the owner's linked desktops, and - when a
// linked OAIY has gone quiet - when it was last seen and what it keeps doing
// while it is away (it answers calls on its own and syncs when it is back).
import { agoLabel } from '../format';
import type { DesktopRow } from '../types';

interface Props {
  demo: boolean;
  presence: FlPresence | null;
  desktops: DesktopRow[] | null;
  connecting: boolean;
  onConnectDesktop: () => void;
}

/** The linked desktop seen most recently (the registry's order is not). */
function newest(desktops: DesktopRow[] | null): DesktopRow | null {
  let best: DesktopRow | null = null;
  let bestAt = -1;
  for (const d of desktops || []) {
    const at = d.lastSeenAt ? Date.parse(d.lastSeenAt.length === 19 ? d.lastSeenAt.replace(' ', 'T') + 'Z' : d.lastSeenAt) : NaN;
    const t = isNaN(at) ? 0 : at;
    if (best === null || t > bestAt) { best = d; bestAt = t; }
  }
  return best;
}

export function RuntimeCard({ demo, presence, desktops, connecting, onConnectDesktop }: Props) {
  if (demo) {
    return (
      <section class="card" id="runtime">
        <h2>Demo bridge</h2>
        <p class="muted">This is the shared demo, so the hardware below is simulated - OAIY and real phones are never used here. Use "Simulate incoming call" on the Calls screen to see the receptionist in action.</p>
      </section>
    );
  }
  const p = presence;
  const ago = p && p.kind === 'remote' ? agoLabel(p.lastSeenAt) : null;
  const away = p && p.kind === 'none' ? newest(desktops) : null;
  const awayAgo = away ? agoLabel(away.lastSeenAt) : null;
  return (
    <section class="card" id="runtime">
      <div class="sectionrow">
        <h2>OAIY</h2>
        {p && p.kind === 'local' && <span class="pill ok">Connected on this computer</span>}
        {p && p.kind === 'remote' && <span class="pill accent">{'Running on ' + (p.deviceName || 'another machine')}</span>}
        {p && p.kind === 'none' && <span class="pill warn">{away ? 'Offline' : 'Not connected'}</span>}
      </div>
      {p === null && (
        <div class="loadwrap" role="status" aria-label="Checking for OAIY">
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
        <p class="muted">
          {'OAIY on this computer runs Aokie, the phone bridge: the dongle and phone below are its.'
            + (p.runtime === 'oaiy'
              ? ' This browser is paired with OAIY' + (p.address ? ' at ' + p.address : '') + ', so phone commands go straight to it, not through a relay.'
              : '')}
        </p>
      )}
      {away && (
        <div class="notice warn" role="status" data-offline>
          <strong>{"OAIY can't be reached." + ' ' + (away.deviceName || 'Your OAIY') + (awayAgo ? ' was last seen ' + awayAgo + '.' : ' has not been seen yet.')}</strong>
          <span>
            While it is away it keeps answering calls, lookups and appointment requests on that computer, and syncs its records here when it reconnects. The dongle and phone below can't be read until then.
          </span>
        </div>
      )}
      {p && p.kind === 'none' && (
        <div>
          {away ? null : (
            <p class="muted">OAIY runs Aokie, the phone bridge, on the computer the dongle is plugged into. Start OAIY there, then connect it - approving the request in OAIY issues a token bound to this site.</p>
          )}
          <p class="cta">
            <button type="button" class="btn primary" disabled={connecting} onClick={onConnectDesktop}>
              {connecting ? 'Waiting for approval in OAIY...' : 'Connect OAIY'}
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
