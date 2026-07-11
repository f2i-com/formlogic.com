import { useCallback, useEffect, useRef, useState } from 'react';
import { plugins } from '../api';
import { AlertTriangleIcon, CheckIcon } from '../Icons';
import { useConfirm } from '../ConfirmDialog';
import { useToast } from '../Toasts';

/**
 * Guided WinUSB driver setup for the Aokie Bluetooth dongle (AOK-DRIVER-001
 * backend): a three-step wizard — pick the dongle, install the driver
 * (elevated helper behind a UAC prompt), verify the rebind — plus an advanced
 * "restore the Windows driver" escape hatch. All device work happens in the
 * plugin/host (`dongle.list` / `dongle.installDriver` / `dongle.restoreDriver`);
 * this component only sequences it and narrates what to expect.
 */

/** One live USB device row from `dongle.list`'s `connected[]`. */
interface ConnectedDongle {
  vid: number;
  pid: number;
  vidHex?: string;
  pidHex?: string;
  description?: string;
  driver?: string;
  hardwareId?: string;
  /** In the supported-dongle catalog (Certified/Beta chipset). */
  matchesCatalog?: boolean;
  /** Already rebound to WinUSB (i.e. ready for Aokie). */
  driverBound?: boolean;
}

interface DongleListResult {
  dongles?: Array<{ name?: string; vidHex?: string; pidHex?: string; tier?: string }>;
  connected?: ConnectedDongle[];
  liveEnumeration?: boolean;
  note?: string;
}

type WizardStep = 'select' | 'install' | 'verify' | 'done';

const key = (d: Pick<ConnectedDongle, 'vid' | 'pid'>) => `${d.vid}:${d.pid}`;

function dongleLabel(d: ConnectedDongle): string {
  return d.description || d.hardwareId || 'USB Bluetooth adapter';
}

function idLabel(d: ConnectedDongle): string {
  if (d.vidHex && d.pidHex) return `${d.vidHex}:${d.pidHex}`;
  return `${d.vid.toString(16).padStart(4, '0')}:${d.pid.toString(16).padStart(4, '0')}`;
}

export function DongleSetupWizard({ running }: { running: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('select');
  const [list, setList] = useState<DongleListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ConnectedDongle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verifyTimer = useRef<number | undefined>(undefined);
  const toast = useToast();
  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await plugins.command('aokie', 'dongle.list');
      const data = (res.data ?? {}) as DongleListResult;
      setList(data);
      setError(null);
      // Keep the selection pinned to the same physical id across refreshes.
      setSelected((prev) => {
        if (!prev) return prev;
        return (data.connected ?? []).find((d) => key(d) === key(prev)) ?? null;
      });
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the device list when the wizard opens; clear transient state when the
  // plugin stops (commands would fail anyway).
  useEffect(() => {
    if (open && running) void refresh();
  }, [open, running, refresh]);
  useEffect(() => {
    if (!running) {
      setOpen(false);
      setStep('select');
      setSelected(null);
      setError(null);
    }
  }, [running]);
  useEffect(() => () => window.clearTimeout(verifyTimer.current), []);

  /** Post-install verification: poll the list until the target shows up as
   *  WinUSB-bound (the rebind + re-enumeration can lag the helper's exit). */
  const verifySelected = useCallback(
    async (target: ConnectedDongle) => {
      setStep('verify');
      setError(null);
      let attempts = 0;
      const poll = async () => {
        const data = await refresh();
        const now = (data?.connected ?? []).find((d) => key(d) === key(target));
        if (now?.driverBound) {
          setStep('done');
          toast.push({
            kind: 'success',
            title: 'Dongle driver installed',
            body: `${dongleLabel(target)} is now bound to WinUSB and ready for Aokie.`,
          });
          return;
        }
        attempts += 1;
        if (attempts < 6) {
          verifyTimer.current = window.setTimeout(() => void poll(), 2000);
        } else {
          setError(
            'The driver install finished but the dongle has not re-appeared as WinUSB-bound yet. ' +
              'Unplug and replug the dongle, then press "Check again".',
          );
        }
      };
      await poll();
    },
    [refresh, toast],
  );

  const install = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.command('aokie', 'dongle.installDriver', {
        vid: selected.vid,
        pid: selected.pid,
      });
      await verifySelected(selected);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The declined-UAC case comes back as a typed, human error from the host.
      setError(msg);
      setStep('install');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (d: ConnectedDongle) => {
    const ok = await confirm({
      title: 'Restore the Windows Bluetooth driver?',
      body:
        `${dongleLabel(d)} will be handed back to the standard Windows driver (BTHUSB). ` +
        'Aokie will no longer be able to use it until you install the WinUSB driver again. ' +
        'Windows will show an elevation prompt.',
      confirmLabel: 'Restore driver',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.command('aokie', 'dongle.restoreDriver', { vid: d.vid, pid: d.pid });
      toast.push({
        kind: 'success',
        title: 'Windows driver restored',
        body: 'The dongle is back on the standard Windows Bluetooth driver.',
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = list?.connected ?? [];
  const stepIndex = step === 'select' ? 1 : step === 'install' ? 2 : 3;

  return (
    <div>
      <div className="aokie-card-head">
        <span className="section-title aokie-card-title">Dongle setup</span>
        {running && (
          <button className="btn-tiny" onClick={() => setOpen((v) => !v)}>
            {open ? 'close' : 'set up'}
          </button>
        )}
      </div>
      {!open ? (
        <div className="service-meta">
          Guided setup for the USB Bluetooth dongle: pick the device, install the WinUSB driver
          (one Windows prompt), and verify it&apos;s ready.
        </div>
      ) : (
        <div className="dongle-wizard">
          <div className="service-meta">
            <strong>
              Step {stepIndex} of 3 —{' '}
              {step === 'select'
                ? 'Choose your Bluetooth dongle'
                : step === 'install'
                  ? 'Install the WinUSB driver'
                  : step === 'verify'
                    ? 'Verifying the driver'
                    : 'Dongle ready'}
            </strong>
          </div>

          {step === 'select' && (
            <>
              {list && list.liveEnumeration === false && (
                <div className="service-error">
                  <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
                  Live USB scan unavailable{list.note ? `: ${list.note}` : ''}.
                </div>
              )}
              {connected.length === 0 ? (
                <div className="service-meta">
                  {loading
                    ? 'Scanning USB devices…'
                    : 'No supported dongle detected. Plug the USB Bluetooth dongle in, then rescan. ' +
                      'Supported chipsets: Broadcom BCM20702 (certified), Realtek RTL8761/RTL8821CE and CSR8510 (beta).'}
                </div>
              ) : (
                <div className="dongle-wizard-list">
                  {connected.map((d) => {
                    const isSel = selected != null && key(selected) === key(d);
                    return (
                      <label key={key(d)} className={`dongle-wizard-row${isSel ? ' is-selected' : ''}`}>
                        <input
                          type="radio"
                          name="dongle-pick"
                          checked={isSel}
                          onChange={() => setSelected(d)}
                        />
                        <span className="dongle-wizard-row__name">
                          {dongleLabel(d)}
                          <small> · USB {idLabel(d)}</small>
                        </span>
                        <span className="dongle-wizard-row__badges">
                          {d.matchesCatalog ? (
                            <span className="badge badge-ok">supported</span>
                          ) : (
                            <span className="badge badge-neutral">unknown chipset</span>
                          )}
                          {d.driverBound ? (
                            <span className="badge badge-ok">WinUSB installed</span>
                          ) : (
                            <span className="badge badge-pending">driver required</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="aokie-card-actions">
                <button className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
                  {loading ? 'Scanning…' : 'Rescan'}
                </button>
                {selected && !selected.driverBound && (
                  <button className="btn btn-primary" onClick={() => setStep('install')}>
                    Continue
                  </button>
                )}
                {selected && selected.driverBound && (
                  <>
                    <span className="service-meta">
                      <CheckIcon className="inline-icon icon-leading" size={13} />
                      This dongle already has the WinUSB driver — it&apos;s ready for Aokie.
                    </span>
                    <button className="btn btn-warn" onClick={() => void restore(selected)} disabled={busy}>
                      Restore Windows driver
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {step === 'install' && selected && (
            <>
              <div className="service-meta">
                Installing for <strong>{dongleLabel(selected)}</strong> (USB {idLabel(selected)}).
                {!selected.matchesCatalog && (
                  <>
                    {' '}
                    <AlertTriangleIcon className="inline-icon icon-leading" size={13} />
                    This chipset isn&apos;t in the supported catalog — the host will refuse the
                    install unless the unknown-dongle override is set.
                  </>
                )}
              </div>
              <div className="service-meta">
                Windows will show a <strong>User Account Control</strong> prompt — choose{' '}
                <strong>Yes</strong>. Only this exact device is rebound (the installer pins its
                hardware identity), and you can restore the standard Windows driver at any time.
              </div>
              <div className="aokie-card-actions">
                <button className="btn btn-ghost" onClick={() => setStep('select')} disabled={busy}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={() => void install()} disabled={busy}>
                  {busy ? 'Installing — watch for the Windows prompt…' : 'Install WinUSB driver'}
                </button>
              </div>
            </>
          )}

          {step === 'verify' && (
            <div className="service-meta">Checking that the dongle re-appeared as WinUSB-bound…</div>
          )}

          {step === 'done' && selected && (
            <>
              <div className="service-meta">
                <CheckIcon className="inline-icon icon-leading" size={13} />
                <strong>{dongleLabel(selected)}</strong> is bound to WinUSB and ready. Next: open a
                pairing window below (Bluetooth pairing → &quot;Pair a phone&quot;) and pair your
                handset.
              </div>
              <div className="aokie-card-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setStep('select');
                    void refresh();
                  }}
                >
                  Set up another dongle
                </button>
                <button className="btn btn-ghost" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {error && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {error}
              {step === 'verify' && selected && (
                <button className="btn-tiny" onClick={() => void verifySelected(selected)} disabled={busy}>
                  Check again
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
