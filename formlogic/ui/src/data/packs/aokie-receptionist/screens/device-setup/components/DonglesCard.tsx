/** @jsxImportSource preact */
// Bluetooth dongle inventory: live USB scan rows with driver install + the
// preferred-dongle pick, and "Reset the dongle" (dongle.reset: a software
// reset, no unplugging; refused during a call; an older plugin answers
// unknown-command and the card says to update it). Gated on the
// connector.aokie.dongle.list / .reset grants (advisory can() - the native
// bridge and the server stay the trust boundary).
import { Loading } from './Loading';
import type { ResetNote } from '../format';
import type { DongleRow } from '../types';

interface Props {
  /** A linked OAIY is offline: nothing here can be read until it is back. */
  offline: boolean;
  access: boolean | null;
  rows: DongleRow[] | null;
  enumNote: string | null;
  busyDriver: string | null;
  onInstallDriver: (row: DongleRow) => void;
  onSetPreferred: (row: DongleRow) => void;
  /** The dongle.reset grant: null = still checking. */
  resetAccess: boolean | null;
  resetting: boolean;
  resetNote: ResetNote | null;
  onReset: () => void;
}

export function DonglesCard(props: Props) {
  const { offline, access, rows, enumNote, busyDriver, onInstallDriver, onSetPreferred, resetting, resetNote, onReset } = props;
  const resetAccess = offline ? null : props.resetAccess;
  let body;
  if (offline) {
    body = <p class="faint" data-dongle-offline>The dongle can't be read while OAIY is offline. It shows here again when OAIY reconnects.</p>;
  } else if (access === false) {
    body = <p class="faint">This app has not been granted dongle access.</p>;
  } else if (rows === null) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = (
      <div class="empty">
        <p class="empty-title">No dongle found</p>
        <p class="faint">
          {enumNote
            ? 'Live USB scan unavailable: ' + enumNote
            : 'Plug the supported USB Bluetooth dongle into the computer running OAIY (or one with the WinUSB driver bound), then press Refresh.'}
        </p>
      </div>
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
      <div class="sectionrow">
        <h2>Bluetooth dongle</h2>
        {resetAccess ? (
          <button type="button" class="btn" data-act="reset-dongle" disabled={resetting} onClick={onReset}>
            {resetting ? 'Resetting...' : 'Reset the dongle'}
          </button>
        ) : null}
      </div>
      {body}
      {resetAccess ? (
        <p class="faint footnote">
          Reset the dongle if calls or the phone link stop working: Aokie restarts it in software, no unplugging, and the phone reconnects by itself. It waits until no call is in progress.
        </p>
      ) : resetAccess === false ? (
        <p class="faint footnote" data-reset-unavailable>
          This app cannot reset the dongle from here (it has no dongle reset permission). Unplug the dongle and plug it back in instead.
        </p>
      ) : null}
      {resetNote ? (
        <div class={'notice ' + resetNote.tone} role={resetNote.tone === 'ok' ? 'status' : 'alert'} data-reset-note={resetNote.needsUpdate ? 'update' : resetNote.tone}>
          {resetNote.text}
        </div>
      ) : null}
    </section>
  );
}
