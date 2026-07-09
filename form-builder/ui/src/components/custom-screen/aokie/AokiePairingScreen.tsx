// Aokie Receptionist — Device Setup / Pairing screen (trusted host-rendered SDK screen).
//
// Everything hardware-side in one place: FormLogic Desktop detection + pairing (the
// shared DesktopStatusPanel building block), the dongle table (`dongle.list`) with a
// permission-gated WinUSB driver install action and typed error display, the paired
// phone's status (`phone.status`), and the recent Hardware Events records the app
// logic writes from `aokie.hardware.error` envelopes.
import { useCallback, useEffect, useState } from 'react';
import { Bluetooth, Cast, Download, RefreshCw, Smartphone, TriangleAlert, Usb } from 'lucide-react';
import { EmptyState, useConnector, useConnectorPermission, useResponses } from '../../../sdk';
import { toast } from '../../../stores/toastStore';
import { DesktopStatusPanel } from '../../desktop/DesktopStatusPanel';
import { ConnectorError } from '../../../client-runtime/connectors/connectorTypes';
import { describeLastSeen } from './aokiePresence';
import { useAokiePresence } from './useAokiePresence';

interface DongleRow {
  id: string;
  name: string;
  vid: number;
  pid: number;
  usbId: string;
  driverInstalled: boolean;
  matchesCatalog: boolean;
  preferred: boolean;
}

interface PhoneStatus {
  connected?: boolean;
  deviceName?: string;
  battery?: number;
  signal?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Typed connector failure for display: "capability_denied — …" beats a bare message. */
function describeError(err: unknown): string {
  if (err instanceof ConnectorError) return `${err.code} — ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';

export function AokiePairingScreen({ params }: { params?: Record<string, unknown> }) {
  const eventsFormId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', eventsFormId ? { formId: eventsFormId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, eventsFormId ? { formId: eventsFormId } : undefined);

  const [dongles, setDongles] = useState<DongleRow[] | null>(null);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const events = useResponses(eventsFormId ?? '', { limit: 8 });

  // Runtime presence: when the receptionist runs on ANOTHER machine's Desktop, the device
  // status card below names that device instead of pushing a local install (§14).
  const presence = useAokiePresence();
  const [enumerationNote, setEnumerationNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      if (can('dongle.list')) {
        // The plugin returns { dongles: <compat catalog>, connected: <live USB
        // devices>, liveEnumeration, note } - the LIVE list is what we show.
        const res = asRecord(await connector.request('dongle.list'));
        let preferred: { vid?: number; pid?: number } = {};
        if (can('dongle.getPreferred')) {
          const pref = asRecord(await connector.request('dongle.getPreferred'));
          preferred = asRecord(pref.preferred) as { vid?: number; pid?: number };
        }
        const live = Array.isArray(res.connected) ? res.connected : [];
        setEnumerationNote(res.liveEnumeration === false && typeof res.note === 'string' ? res.note : null);
        setDongles(
          live
            .map((d) => asRecord(d))
            .filter((d) => typeof d.vid === 'number' && typeof d.pid === 'number')
            .map((d) => {
              const vid = d.vid as number;
              const pid = d.pid as number;
              const usbId = `${typeof d.vidHex === 'string' ? d.vidHex : vid}:${typeof d.pidHex === 'string' ? d.pidHex : pid}`;
              return {
                id: typeof d.hardwareId === 'string' && d.hardwareId !== '' ? d.hardwareId : usbId,
                name: typeof d.description === 'string' && d.description !== '' ? d.description : `USB device ${usbId}`,
                vid,
                pid,
                usbId,
                driverInstalled: d.driverBound === true,
                matchesCatalog: d.matchesCatalog === true,
                preferred: preferred.vid === vid && preferred.pid === pid,
              };
            })
        );
      }
      if (can('phone.status')) {
        const res = asRecord(await connector.request('phone.status'));
        setPhone({
          connected: res.connected === true,
          deviceName: typeof res.deviceName === 'string' ? res.deviceName : undefined,
          battery: typeof res.battery === 'number' ? res.battery : undefined,
          signal: typeof res.signal === 'number' ? res.signal : undefined,
        });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRefreshing(false);
    }
  }, [connector, can]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleInstallDriver = useCallback(
    async (row: DongleRow) => {
      setInstalling(row.id);
      setError(null);
      try {
        await connector.request('dongle.installDriver', { vid: row.vid, pid: row.pid });
        toast.success('Driver install started', 'Follow the WinUSB prompt on this machine.');
        await load();
      } catch (err) {
        // Typed display: capability_denied / command_failed / connector_unavailable stay distinguishable.
        setError(describeError(err));
      } finally {
        setInstalling(null);
      }
    },
    [connector, load]
  );

  const handleSetPreferred = useCallback(
    async (row: DongleRow) => {
      setError(null);
      try {
        await connector.request('dongle.setPreferred', { vid: row.vid, pid: row.pid });
        toast.success('Preferred dongle set', row.name);
        await load();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [connector, load]
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Bluetooth className="h-5 w-5 text-primary-600 dark:text-primary-400" />
          <h1 className="text-lg font-semibold tracking-tight text-gray-900 dark:text-white">Device Setup</h1>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-45 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* Remote runtime: the receptionist's Desktop lives on another machine. */}
      {presence.kind === 'remote' && (
        <div className={`${card} p-5`}>
          <div className="flex items-start gap-3">
            <Cast className="mt-0.5 h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  Receptionist running on {presence.deviceName} — viewing remotely
                </p>
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
                  {describeLastSeen(presence.lastSeenAt) ? `Last seen ${describeLastSeen(presence.lastSeenAt)}` : 'Online'}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                The dongle and paired phone are attached to that machine, so the hardware sections
                below reflect this browser's (mock) bridge — manage the real devices on {presence.deviceName}.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Desktop detection + pairing — the shared building block. */}
      <DesktopStatusPanel />

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Dongles */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Usb className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Bluetooth dongles</h2>
        </div>
        {!can('dongle.list') ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">This app has not been granted dongle access.</p>
        ) : dongles === null ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
        ) : dongles.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {enumerationNote
              ? `Live USB scan unavailable: ${enumerationNote}`
              : 'No supported dongles detected. Plug in the certified USB dongle (or one with the WinUSB driver bound).'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-gray-400 dark:text-slate-500">
                  <th className="py-1.5 pr-3 font-medium">Dongle</th>
                  <th className="py-1.5 pr-3 font-medium">USB id</th>
                  <th className="py-1.5 pr-3 font-medium">Driver</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                {dongles.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2 pr-3 font-medium text-gray-900 dark:text-white">
                      {d.name}
                      {d.preferred && (
                        <span className="ml-2 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-[10px] font-medium text-primary-700 dark:border-primary-500/20 dark:bg-primary-500/10 dark:text-primary-400">
                          preferred
                        </span>
                      )}
                      {d.matchesCatalog && (
                        <span className="ml-2 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
                          supported
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {d.usbId}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`text-xs font-medium ${
                          d.driverInstalled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {d.driverInstalled ? 'Installed' : 'Required'}
                      </span>
                    </td>
                    <td className="py-2 text-right">
                      <div className="inline-flex items-center gap-2">
                        {!d.driverInstalled && (
                          <button
                            type="button"
                            onClick={() => void handleInstallDriver(d)}
                            disabled={!can('dongle.installDriver') || installing !== null}
                            title={can('dongle.installDriver') ? undefined : 'Not granted to this app / role'}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <Download className="h-3.5 w-3.5" />
                            {installing === d.id ? 'Installing…' : 'Install driver'}
                          </button>
                        )}
                        {!d.preferred && can('dongle.setPreferred') && (
                          <button
                            type="button"
                            onClick={() => void handleSetPreferred(d)}
                            disabled={installing !== null}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            Set preferred
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Phone status */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Paired phone</h2>
        </div>
        {!can('phone.status') ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">This app has not been granted phone status access.</p>
        ) : phone === null ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className={`font-medium ${phone.connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-slate-400'}`}>
              {phone.connected ? 'Connected' : 'Not connected'}
            </span>
            <span className="text-gray-700 dark:text-slate-300">{phone.deviceName ?? 'No device'}</span>
            {typeof phone.battery === 'number' && <span className="text-gray-500 dark:text-slate-400">Battery {phone.battery}%</span>}
            {typeof phone.signal === 'number' && <span className="text-gray-500 dark:text-slate-400">Signal {phone.signal}/5</span>}
          </div>
        )}
        <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">
          Pair your phone to “Aokie AI Assistant” from your phone's Bluetooth settings once the dongle driver is installed.
        </p>
      </div>

      {/* Recent hardware events (records written by the app logic) */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Recent hardware events</h2>
        </div>
        {!eventsFormId ? (
          <EmptyState title="No Hardware Events form" message="This screen expects to be attached to the Hardware Events form." />
        ) : events.rows.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {events.loading ? 'Loading…' : 'No hardware events recorded. Errors from the dongle/plugin land here automatically.'}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {events.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-gray-900 dark:text-white">{String(r.answers.event_name || 'event')}</span>
                  <span className="ml-2 truncate text-xs text-gray-500 dark:text-slate-400">{String(r.answers.message || '')}</span>
                </div>
                <span
                  className={`text-xs font-medium capitalize ${
                    r.answers.severity === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : r.answers.severity === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-gray-500 dark:text-slate-400'
                  }`}
                >
                  {String(r.answers.severity || 'info')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
