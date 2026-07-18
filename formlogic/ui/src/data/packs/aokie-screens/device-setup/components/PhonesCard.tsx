/** @jsxImportSource preact */
// Paired-phone card: the bonded list with per-row Reconnect/Disconnect.
// Commands are ACCEPTED-only - the caller polls the bonded list for the real
// outcome, so the row's busy label persists while the link settles.
import { Loading } from './Loading';
import type { PhoneRow } from '../types';

interface Props {
  access: boolean | null;
  rows: PhoneRow[] | null;
  busyPhone: string | null;
  onConnect: (row: PhoneRow) => void;
  onDisconnect: (row: PhoneRow) => void;
}

export function PhonesCard({ access, rows, busyPhone, onConnect, onDisconnect }: Props) {
  let body;
  if (access === false) {
    body = <p class="faint">This app has not been granted phone status access.</p>;
  } else if (rows === null) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = <p class="faint">No phones paired yet. On your phone, open Bluetooth settings and pair with "Aokie AI Assistant" once the dongle driver is installed.</p>;
  } else {
    body = (
      <div>
        <ul>
          {rows.map((r) => {
            const busy = busyPhone === r.address;
            return (
              <li key={r.address}>
                <div class="rowmain">
                  <span class="rowname">{r.name || 'Paired phone'}</span>
                  {' '}
                  <span class={r.connected ? 'pill ok' : 'pill'}>{r.connected ? 'Connected' : 'Not connected'}</span>
                  <div class="mono faint">{r.address}</div>
                </div>
                {r.connected ? (
                  <button
                    type="button" class="btn" disabled={busy}
                    title="Disconnect this phone. It usually reconnects on its own - use this to clear a stuck connection."
                    onClick={() => onDisconnect(r)}
                  >
                    {busy ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    type="button" class="btn" disabled={busy}
                    title="Reconnect this phone - the dongle pages it and re-establishes the hands-free link."
                    onClick={() => onConnect(r)}
                  >
                    {busy ? 'Reconnecting...' : 'Reconnect'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p class="faint footnote">Disconnecting keeps the pairing - the phone normally reconnects on its own within a few seconds. To add a new phone, pair it from the phone's Bluetooth settings.</p>
      </div>
    );
  }
  return (
    <section class="card" id="phones">
      <h2>Paired phone</h2>
      {body}
    </section>
  );
}
