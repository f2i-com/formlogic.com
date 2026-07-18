/** @jsxImportSource preact */
// Bluetooth dongle inventory: live USB scan rows with driver install + the
// preferred-dongle pick. Gated on the connector.aokie.dongle.list grant
// (advisory can() - the native bridge and the server stay the trust boundary).
import { Loading } from './Loading';
import type { DongleRow } from '../types';

interface Props {
  access: boolean | null;
  rows: DongleRow[] | null;
  enumNote: string | null;
  busyDriver: string | null;
  onInstallDriver: (row: DongleRow) => void;
  onSetPreferred: (row: DongleRow) => void;
}

export function DonglesCard({ access, rows, enumNote, busyDriver, onInstallDriver, onSetPreferred }: Props) {
  let body;
  if (access === false) {
    body = <p class="faint">This app has not been granted dongle access.</p>;
  } else if (rows === null) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = (
      <p class="faint">
        {enumNote
          ? 'Live USB scan unavailable: ' + enumNote
          : 'No supported dongles detected. Plug in the certified USB dongle (or one with the WinUSB driver bound).'}
      </p>
    );
  } else {
    body = (
      <div class="tscroll">
        <table>
          <thead>
            <tr><th>Dongle</th><th>USB id</th><th>Driver</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  <span class="rowname">{d.name}</span>
                  {d.preferred && <span> <span class="pill accent">preferred</span></span>}
                  {d.matchesCatalog && <span> <span class="pill ok">supported</span></span>}
                </td>
                <td class="mono">{d.usbId}</td>
                <td>
                  <span class={d.driverInstalled ? 'pill ok' : 'pill warn'}>
                    {d.driverInstalled ? 'Installed' : 'Required'}
                  </span>
                </td>
                <td class="actions">
                  {!d.driverInstalled && (
                    <button type="button" class="btn" disabled={!!busyDriver} onClick={() => onInstallDriver(d)}>
                      {busyDriver === d.id ? 'Installing...' : 'Install driver'}
                    </button>
                  )}
                  {!d.preferred && (
                    <button type="button" class="btn" onClick={() => onSetPreferred(d)}>Set preferred</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section class="card" id="dongles">
      <h2>Bluetooth dongles</h2>
      {body}
    </section>
  );
}
