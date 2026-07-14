// Aokie Receptionist — Device Setup / Pairing screen (trusted host-rendered SDK screen).
//
// Everything hardware-side in one place: FormLogic Desktop detection + pairing (the
// shared DesktopStatusPanel building block), the dongle table (`dongle.list`) with a
// permission-gated WinUSB driver install action and typed error display, the paired
// phone's status (`phone.status`), and the recent Hardware Events records the app
// logic writes from `aokie.hardware.error` envelopes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bluetooth, Cast, Download, Link2, Link2Off, RefreshCw, Smartphone, Trash2, TriangleAlert, Usb } from 'lucide-react';
import { EmptyState, useConnector, useConnectorPermission, useResponses } from '../../../sdk';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { toast } from '../../../stores/toastStore';
import { api } from '../../../lib/api';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { DesktopStatusPanel } from '../../desktop/DesktopStatusPanel';
import { ConnectorError } from '../../../client-runtime/connectors/connectorTypes';
import { getDesktopInfo, subscribeDesktopStatus } from '../../../client-runtime/desktop/desktopDetection';
import { isDesktopPaired, subscribeDesktopPaired } from '../../../client-runtime/desktop/desktopPairing';
import { performRelayCommand } from './aokieRelay';
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

/** One bonded phone (phone.listPaired row): address, captured model name, live-connected flag. */
interface BondedPhone {
  address: string;
  name?: string;
  connected: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * When a hardware event happened, for the list. `occurred_at` is the plugin's
 * ISO-Z instant (authoritative); the row's zone-less sqlite `submittedAt`
 * (stored UTC) is the fallback and gets an explicit Z so it never shifts.
 */
function formatEventTime(answers: Record<string, unknown>, submittedAt: string): { short: string; full: string } | null {
  const occurred = typeof answers.occurred_at === 'string' && answers.occurred_at !== '' ? answers.occurred_at : null;
  const fallback = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(submittedAt)
    ? submittedAt.replace(' ', 'T') + 'Z'
    : submittedAt;
  const ms = Date.parse(occurred ?? fallback);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return {
    short: d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    full: d.toLocaleString(),
  };
}

/** Typed connector failure for display: friendly copy for the codes a user can act on. */
function describeError(err: unknown): string {
  if (err instanceof ConnectorError) {
    // The access token refreshes with the page (and we auto-retry once first).
    if (err.code === 'capability_denied') {
      return 'Your device access needed a refresh and could not be renewed automatically — reload this page to continue.';
    }
    // Desktop not running/paired — the raw code + "was not performed" internals
    // read like a crash; say what it means and what to do instead.
    if (err.code === 'connector_unavailable') {
      return 'FormLogic Desktop isn’t running on this computer, so the dongle and phone can’t be reached right now. Start FormLogic Desktop (and pair it via “Connect FormLogic Desktop” above if asked), then press Refresh.';
    }
    return `${err.code} — ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';

export function AokiePairingScreen({ params }: { params?: Record<string, unknown> }) {
  const eventsFormId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', eventsFormId ? { formId: eventsFormId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, eventsFormId ? { formId: eventsFormId } : undefined);

  const [dongles, setDongles] = useState<DongleRow[] | null>(null);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [bonded, setBonded] = useState<BondedPhone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState<string | null>(null);
  // One automatic recovery from an expired/stale access token: the client
  // re-mints capabilities per request, so a short wait + reload usually
  // clears capability_denied without bothering the user. Reset on success.
  const capabilityRetryUsed = useRef(false);
  const events = useResponses(eventsFormId ?? '', { limit: 8 });
  // Clear-history controls for the hardware-event log (delete-gated like any
  // record delete; the log is diagnostic, so wiping it is routine hygiene).
  const deleteEventResponse = useAppRuntimeStore((s) => s.deleteResponse);
  const fetchRecentRows = useAppRuntimeStore((s) => s.fetchRecentRows);
  const canDeleteEvents = useAppRuntimeStore((s) => s.canDelete);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearingEvents, setClearingEvents] = useState(false);
  // Start-fresh (testing) reset: wipes RECORDS across the app's forms —
  // never forms/flows/settings. Gated by an INLINE type-to-confirm (no
  // modal, per the standing pages-not-popups preference).
  const appForms = useAppRuntimeStore((st) => st.config?.forms);
  const [freshConfirm, setFreshConfirm] = useState('');
  const [freshBusy, setFreshBusy] = useState(false);
  const [freshProgress, setFreshProgress] = useState<string | null>(null);

  // Runtime presence: when the receptionist runs on ANOTHER machine's Desktop, the device
  // status card below names that device instead of pushing a local install (§14).
  const presence = useAokiePresence();
  const appSlug = useAppRuntimeStore((s) => s.appSlug);
  const remoteMode = presence.kind === 'remote';
  // Shared Demo account: everything on this screen is the simulated bridge
  // (the connector + presence layers already refuse the real desktop route),
  // the desktop detection panel is replaced with an honest demo card, and the
  // destructive controls (Start fresh, Clear events) are disabled — the
  // server's demo_readonly guard would refuse them anyway.
  const demoMode = api.isDemoMode();
  const [enumerationNote, setEnumerationNote] = useState<string | null>(null);

  // Clear the hardware-event log: delete EVERY row, not just the 8 shown.
  // New events may land mid-clear, so loop until the form reads empty
  // (bounded — this is hygiene, not a guarantee against a live event storm).
  const handleClearEvents = useCallback(async () => {
    // Demo defense-in-depth: the button is hidden in demo mode and the server
    // 403s demo mutations anyway — but a stale render must still be a no-op.
    if (!eventsFormId || api.isDemoMode()) return;
    setClearingEvents(true);
    try {
      let deleted = 0;
      for (let pass = 0; pass < 5; pass++) {
        const rows = await fetchRecentRows(eventsFormId, 200);
        if (rows.length === 0) break;
        for (const row of rows) {
          if (await deleteEventResponse(eventsFormId, row.id)) deleted++;
        }
      }
      toast.success('Hardware events cleared', `${deleted} ${deleted === 1 ? 'entry' : 'entries'} removed`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setClearingEvents(false);
      setConfirmClearOpen(false);
      events.reload();
    }
  }, [eventsFormId, fetchRecentRows, deleteEventResponse, events]);

  // Start fresh: delete every RECORD in the app's forms, except the
  // Receptionist Settings singleton (that is CONFIG — persona, greeting,
  // business info — not test data). Only response rows in the per-form
  // databases are touched: forms, flows, roles and settings all survive.
  const clearFormResponses = useAppRuntimeStore((st) => st.clearFormResponses);
  const handleStartFresh = useCallback(async () => {
    // Demo defense-in-depth: the controls are replaced with a note in demo
    // mode and the server 403s the bulk clear anyway — never even try.
    if (!appForms || freshBusy || api.isDemoMode()) return;
    setFreshBusy(true);
    setFreshProgress(null);
    let deleted = 0;
    const skipped: string[] = [];
    try {
      const targets = appForms.filter((f) => f.packFormId !== 'receptionist-settings' && f.displayName !== 'Receptionist Settings');
      for (const form of targets) {
        if (!canDeleteEvents(form.formId)) {
          skipped.push(form.displayName);
          continue;
        }
        setFreshProgress(`Clearing ${form.displayName}…`);
        // ONE backend operation per form (bulk clear) — the per-row loop this
        // replaces sent hundreds of requests and its bounded passes stalled
        // out on Transcript Turns (983 rows, live report 2026-07-14).
        deleted += await clearFormResponses(form.formId);
      }
      toast.success(
        'Fresh start',
        `${deleted} record${deleted === 1 ? '' : 's'} removed${skipped.length ? ` — no delete permission on: ${skipped.join(', ')}` : ''}. Settings, forms and flows untouched.`
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setFreshBusy(false);
      setFreshProgress(null);
      setFreshConfirm('');
      events.reload();
    }
  }, [appForms, freshBusy, canDeleteEvents, clearFormResponses, events]);

  // Route a connector command to the RIGHT transport: local desktop bridge
  // (connector.request) when the receptionist runs on THIS machine, or the
  // command relay (performRelayCommand) when it runs on another machine — so
  // the operator can disconnect/reconnect a phone remotely too. Returns the
  // command result object (or throws with a readable message).
  const runPhoneCommand = useCallback(
    async (command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (remoteMode) {
        if (!appSlug) throw new Error('No app context for the remote command');
        const outcome = await performRelayCommand(api, appSlug, command, undefined, payload);
        if (outcome.status !== 'done') {
          const msg = typeof outcome.error?.message === 'string' ? outcome.error.message : outcome.status;
          throw new Error(`The desktop did not complete the command (${msg})`);
        }
        return asRecord(outcome.result);
      }
      return asRecord(await connector.request(command, payload));
    },
    [remoteMode, appSlug, connector]
  );

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
        // Phone bits route local-or-remote so the "Paired phone" section
        // reflects the REAL receptionist machine, and disconnect/reconnect
        // work remotely too.
        const res = await runPhoneCommand('phone.status');
        // Canonical shape (audit C-02): the paired device is nested under
        // `device` ({address, name}); a root deviceName only ever existed in
        // the old mock — kept as a legacy fallback for older plugin builds.
        const device = asRecord(res.device);
        setPhone({
          connected: res.connected === true,
          deviceName:
            typeof device.name === 'string'
              ? device.name
              : typeof res.deviceName === 'string'
                ? res.deviceName
                : undefined,
          battery: typeof res.battery === 'number' ? res.battery : undefined,
          signal: typeof res.signal === 'number' ? res.signal : undefined,
        });
      }
      if (can('phone.listPaired')) {
        // The bonded phones (revocable identities) with their captured model
        // names + a live-connected flag — the disambiguation list.
        const res = await runPhoneCommand('phone.listPaired');
        const rows = Array.isArray(res.devices) ? res.devices : [];
        setBonded(
          rows
            .map((d) => asRecord(d))
            .filter((d) => typeof d.address === 'string' && d.address !== '')
            .map((d) => ({
              address: d.address as string,
              name: typeof d.name === 'string' && d.name !== '' ? d.name : undefined,
              connected: d.connected === true,
            }))
        );
      }
      capabilityRetryUsed.current = false;
    } catch (err) {
      if (
        err instanceof ConnectorError &&
        err.code === 'capability_denied' &&
        !capabilityRetryUsed.current
      ) {
        // Stale access token (e.g. permissions just changed) — refresh it
        // quietly once before asking the user to do anything.
        capabilityRetryUsed.current = true;
        setError('Refreshing your device access…');
        setTimeout(() => void load(), 2000);
        return;
      }
      setError(describeError(err));
    } finally {
      setRefreshing(false);
    }
  }, [connector, can, runPhoneCommand]);

  // Reconnect a bonded phone: the dongle pages the phone and re-establishes the
  // HFP link (outbound SLC). The command returns accepted/queued — the CONNECTED
  // event is the authoritative outcome — so we poll the bonded list briefly and
  // report what actually happened. Routes local or via the relay like disconnect.
  const handleConnectPhone = useCallback(
    async (row: BondedPhone) => {
      setPhoneBusy(row.address);
      setError(null);
      try {
        await runPhoneCommand('phone.connect', { address: row.address });
        // Paging + the service-level handshake take a few seconds; watch for the
        // link to come up rather than pretending the accepted result is final.
        let connected = false;
        for (let i = 0; i < 8 && !connected; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const res = await runPhoneCommand('phone.listPaired');
            const rows = Array.isArray(res.devices) ? res.devices : [];
            connected = rows.some((d) => {
              const rec = asRecord(d);
              return rec.address === row.address && rec.connected === true;
            });
          } catch {
            // transient — keep waiting
          }
        }
        if (connected) {
          toast.success('Phone connected', row.name ?? row.address);
        } else {
          toast.info(
            'Still trying to reconnect',
            'If it does not connect, make sure the phone is nearby with Bluetooth on, or tap “Aokie AI Assistant” in its Bluetooth settings.'
          );
        }
        await load();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setPhoneBusy(null);
      }
    },
    [runPhoneCommand, load]
  );

  // Disconnect a bonded phone but KEEP the pairing — clears a wedged link; the
  // phone reconnects on its own (the working inbound direction). Doubles as the
  // remote "reconnect if audio is stuck". Routes local or via the relay.
  // The command is accepted-only (the ACL teardown lands a moment later), so
  // poll the bonded list until the link actually reads down before repainting —
  // an immediate reload still showed "Connected" and looked like a no-op.
  const handleDisconnectPhone = useCallback(
    async (row: BondedPhone) => {
      setPhoneBusy(row.address);
      setError(null);
      try {
        await runPhoneCommand('phone.disconnect', { address: row.address });
        let disconnected = false;
        for (let i = 0; i < 5 && !disconnected; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const res = await runPhoneCommand('phone.listPaired');
            const rows = Array.isArray(res.devices) ? res.devices : [];
            disconnected = rows.some((d) => {
              const rec = asRecord(d);
              return rec.address === row.address && rec.connected !== true;
            });
          } catch {
            // transient — keep waiting
          }
        }
        if (disconnected) {
          toast.success('Phone disconnected', `${row.name ?? row.address} will usually reconnect on its own.`);
        } else {
          toast.info('Disconnect sent', 'The link is taking a moment to drop — press Refresh if the list looks stale.');
        }
        await load();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setPhoneBusy(null);
      }
    },
    [runPhoneCommand, load]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Re-fetch the hardware sections the moment the desktop becomes reachable —
  // detection recovering, or a silent reconnect landing a token — so a page
  // opened before the desktop was paired fills in without a manual Refresh
  // (the connector calls above just fail with connector_unavailable until then).
  useEffect(() => {
    let reachable = getDesktopInfo().available && isDesktopPaired();
    const reload = () => {
      const now = getDesktopInfo().available && isDesktopPaired();
      if (now && !reachable) void load();
      reachable = now;
    };
    const offStatus = subscribeDesktopStatus(reload);
    const offPaired = subscribeDesktopPaired(reload);
    return () => {
      offStatus();
      offPaired();
    };
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

      {/* Desktop detection + pairing — the shared building block. In demo mode the
          panel is replaced outright: it would truthfully report a locally-running
          FormLogic Desktop, which reads as "the demo is connected to real hardware"
          (live report 2026-07-14) — and the demo must never touch one anyway. */}
      {demoMode ? (
        <div className={`${card} p-5`}>
          <div className="mb-1 flex items-center gap-2">
            <Cast className="h-4 w-4 text-gray-400 dark:text-slate-500" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">Demo bridge</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            This is the shared demo, so the hardware below is simulated — FormLogic Desktop and real
            phones are never used here, even if the Desktop app is running on this machine. Use
            "Simulate incoming call" on the Calls screen to see the receptionist in action.
          </p>
        </div>
      ) : (
        <DesktopStatusPanel />
      )}

      {error && (
        <div className="break-words rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
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

      {/* Paired phones */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Paired phone</h2>
        </div>
        {!can('phone.listPaired') && !can('phone.status') ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">This app has not been granted phone status access.</p>
        ) : bonded === null && phone === null ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">Loading…</p>
        ) : (bonded?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            No phones paired yet. On your phone, open Bluetooth settings and pair with{' '}
            <span className="font-medium">“Aokie AI Assistant”</span> once the dongle driver is installed.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {(bonded ?? []).map((row) => {
              const busy = phoneBusy === row.address;
              return (
                <li key={row.address} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-gray-900 dark:text-white">
                        {row.name ?? 'Paired phone'}
                      </span>
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                          row.connected
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'
                        }`}
                      >
                        {row.connected ? 'Connected' : 'Not connected'}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-gray-400 dark:text-slate-500">{row.address}</span>
                  </div>
                  {row.connected && can('phone.disconnect') && (
                    <button
                      type="button"
                      onClick={() => void handleDisconnectPhone(row)}
                      disabled={busy}
                      title="Disconnect this phone. It usually reconnects on its own — use this to clear a stuck connection."
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Link2Off className="h-3.5 w-3.5" />
                      {busy ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  )}
                  {!row.connected && can('phone.connect') && (
                    <button
                      type="button"
                      onClick={() => void handleConnectPhone(row)}
                      disabled={busy}
                      title="Reconnect this phone — the dongle pages it and re-establishes the hands-free link. The phone must be nearby with Bluetooth on."
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {busy ? 'Reconnecting…' : 'Reconnect'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">
          Disconnecting keeps the pairing — the phone normally reconnects on its own within a few seconds. If it doesn't,
          press <span className="font-medium">Reconnect</span> (the phone must be nearby with Bluetooth on) or tap{' '}
          <span className="font-medium">“Aokie AI Assistant”</span> in the phone's Bluetooth settings. To add a new phone,
          pair it from the phone's Bluetooth settings.
        </p>
      </div>

      {/* Recent hardware events (records written by the app logic) */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Recent hardware events</h2>
          {eventsFormId && events.rows.length > 0 && canDeleteEvents(eventsFormId) && !demoMode && (
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              disabled={clearingEvents}
              title="Delete every recorded hardware event — new events keep landing here afterwards."
              className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {clearingEvents ? 'Clearing…' : 'Clear'}
            </button>
          )}
        </div>
        {!eventsFormId ? (
          <EmptyState title="No Hardware Events form" message="This screen expects to be attached to the Hardware Events form." />
        ) : events.rows.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {events.loading ? 'Loading…' : 'No hardware events recorded. Errors from the dongle/plugin land here automatically.'}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-slate-800">
            {events.rows.map((r) => {
              const when = formatEventTime(r.answers, r.submittedAt);
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0 break-words">
                    <span className="font-medium text-gray-900 dark:text-white">{String(r.answers.event_name || 'event')}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">{String(r.answers.message || '')}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {when && (
                      <span
                        title={when.full}
                        className="text-xs tabular-nums text-gray-400 dark:text-slate-500"
                      >
                        {when.short}
                      </span>
                    )}
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
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <ConfirmDialog
          isOpen={confirmClearOpen}
          onClose={() => { if (!clearingEvents) setConfirmClearOpen(false); }}
          onConfirm={() => void handleClearEvents()}
          title="Clear hardware events?"
          message="This deletes every recorded hardware event for this app. New events will keep landing here automatically."
          confirmLabel="Clear events"
          variant="danger"
          isLoading={clearingEvents}
        />
      </div>

      {/* Start fresh (testing): wipe all RECORDS, keep config. Inline
          type-to-confirm — deliberately not a modal. */}
      {appForms && appForms.length > 0 && (
        <div className={`${card} border-red-200/70 p-5 dark:border-red-900/40`}>
          <div className="mb-2 flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-red-400 dark:text-red-500/80" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">Start fresh</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Deletes <span className="font-semibold">every record</span> in this app — calls, transcripts, appointments,
            customers, follow-up tasks, messages and hardware events — so testing starts from a clean slate. Your
            Receptionist Settings, forms and flows are <span className="font-semibold">not</span> touched.
          </p>
          {demoMode ? (
            <p className="mt-3 text-xs text-gray-400 dark:text-slate-500">
              Not available in the shared demo — the demo's records are managed automatically, and nothing
              you do here changes them for other visitors.
            </p>
          ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={freshConfirm}
              onChange={(e) => setFreshConfirm(e.target.value)}
              disabled={freshBusy}
              placeholder='Type "delete all" to enable'
              spellCheck={false}
              autoComplete="off"
              className="w-56 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-red-400 focus:outline-none disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={() => void handleStartFresh()}
              disabled={freshBusy || freshConfirm.trim().toLowerCase() !== 'delete all'}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-red-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
              {freshBusy ? 'Deleting…' : 'Delete all records'}
            </button>
            {freshProgress && (
              <span className="text-xs text-gray-500 dark:text-slate-400">{freshProgress}</span>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
