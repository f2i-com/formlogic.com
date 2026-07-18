/** @jsxImportSource preact */
// Pack-owned Device Setup section screen - TSX edition (bundled in the sandbox on Preact).
//
// The behavioral twin of the original embedded-JS console: desktop runtime
// presence, Bluetooth dongles + driver install, the paired phone with
// reconnect/disconnect, Companion endpoint administration, the hardware-event
// log, and the Start-fresh reset. Every card paints a Loading state up front so
// a slow relayed read never leaves a card blank.
//
// Runtime contract (CustomScreenRuntime in the APP runtime):
//  - opaque-origin iframe; window.FormLogic is the only capability;
//  - uses the FULL bridge: connector() (dongle/phone commands, local-or-relay
//    routing is transparent), service() (linked desktops + Companion admin),
//    records()/deleteRecords() (hardware-event log), presence(), can()
//    (advisory button gating), host.ceremony() ('connect-desktop' pairing,
//    'start-fresh' reset - both host-owned with the host's own consent UI);
//  - every one of those actions is TRUSTED_ONLY, so the form's
//    custom_screen_trust must be owner/verified;
//  - PARITY GAPS vs the compiled screen (deliberate, documented): no desktop
//    plugin list (desktop-app detail), and Companion routing groups / history
//    live in FormLogic Desktop's Companion admin - this screen covers
//    endpoints (revoke/approve) + the remote-access policy.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cmd, svc } from './bridge';
import { asRecord } from './format';
import type { CompanionDevice, CompanionState, DesktopRow, DongleRow, PhoneRow } from './types';
import { RuntimeCard } from './components/RuntimeCard';
import { DonglesCard } from './components/DonglesCard';
import { PhonesCard } from './components/PhonesCard';
import { CompanionCard } from './components/CompanionCard';
import { EventsCard } from './components/EventsCard';
import { FreshCard } from './components/FreshCard';

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e));

function App() {
  const [banner, setBanner] = useState('');
  const [demo, setDemo] = useState(false);
  const [presence, setPresence] = useState<FlPresence | null>(null);
  const [desktops, setDesktops] = useState<DesktopRow[] | null>(null);
  const [dongleAccess, setDongleAccess] = useState<boolean | null>(null);
  const [dongles, setDongles] = useState<DongleRow[] | null>(null);
  const [enumNote, setEnumNote] = useState<string | null>(null);
  const [phoneAccess, setPhoneAccess] = useState<boolean | null>(null);
  const [phones, setPhones] = useState<PhoneRow[] | null>(null);
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [events, setEvents] = useState<FlScreenRecord[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busyDriver, setBusyDriver] = useState<string | null>(null);
  const [busyPhone, setBusyPhone] = useState<string | null>(null);
  const [busyCompanion, setBusyCompanion] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [busyPolicy, setBusyPolicy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busyFresh, setBusyFresh] = useState(false);
  const [freshNote, setFreshNote] = useState('');
  // Bumped per loadAll: remounts the Start-fresh card, so a Refresh clears the
  // typed confirm phrase + note exactly like the original repaint did.
  const [freshGen, setFreshGen] = useState(0);
  // Async-flow guards that must not lag a render (stale-closure-proof).
  const demoRef = useRef(false);
  const freshBusyRef = useRef(false);

  // ---- loaders -----------------------------------------------------------

  const loadRuntime = async (isDemo: boolean) => {
    const p = await FormLogic.presence();
    setPresence(p);
    if (isDemo) { setDesktops(null); return; }
    // Owner-only registry - a member's refusal just hides the list.
    try {
      const r = await svc('desktop.connections.list');
      const list = Array.isArray(r.connections) ? r.connections : [];
      setDesktops(list.map((row): DesktopRow => {
        const d = asRecord(row);
        return {
          deviceName: typeof d.deviceName === 'string' && d.deviceName !== '' ? d.deviceName : null,
          lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
        };
      }));
    } catch {
      setDesktops(null);
    }
  };

  const loadDongles = async () => {
    const allowed = await FormLogic.can('connector.aokie.dongle.list');
    setDongleAccess(allowed);
    if (!allowed) return;
    try {
      const res = await cmd('dongle.list');
      let pref: Record<string, unknown> = {};
      const canPref = await FormLogic.can('connector.aokie.dongle.getPreferred');
      if (canPref) {
        try {
          const p = await cmd('dongle.getPreferred');
          pref = asRecord(p.preferred);
        } catch { /* no preferred pick available - rows render without it */ }
      }
      const live = Array.isArray(res.connected) ? res.connected : [];
      setEnumNote(res.liveEnumeration === false && typeof res.note === 'string' ? res.note : null);
      const rows: DongleRow[] = [];
      for (const item of live) {
        const d = asRecord(item);
        if (typeof d.vid !== 'number' || typeof d.pid !== 'number') continue;
        const usbId = (typeof d.vidHex === 'string' ? d.vidHex : String(d.vid))
          + ':' + (typeof d.pidHex === 'string' ? d.pidHex : String(d.pid));
        rows.push({
          id: typeof d.hardwareId === 'string' && d.hardwareId !== '' ? d.hardwareId : usbId,
          name: typeof d.description === 'string' && d.description !== '' ? d.description : 'USB device ' + usbId,
          vid: d.vid,
          pid: d.pid,
          usbId,
          driverInstalled: d.driverBound === true,
          matchesCatalog: d.matchesCatalog === true,
          preferred: pref.vid === d.vid && pref.pid === d.pid,
        });
      }
      setDongles(rows);
    } catch (e) {
      setBanner(errText(e));
      setDongles([]);
    }
  };

  const loadPhones = async () => {
    const allowed = await FormLogic.can('connector.aokie.phone.listPaired');
    setPhoneAccess(allowed);
    if (!allowed) return;
    try {
      const res = await cmd('phone.listPaired');
      const list = Array.isArray(res.devices) ? res.devices : [];
      const out: PhoneRow[] = [];
      for (const item of list) {
        const d = asRecord(item);
        if (typeof d.address !== 'string' || d.address === '') continue;
        out.push({
          address: d.address,
          name: typeof d.name === 'string' && d.name !== '' ? d.name : null,
          connected: d.connected === true,
        });
      }
      setPhones(out);
    } catch (e) {
      setBanner(errText(e));
      setPhones([]);
    }
  };

  const loadCompanion = async (isDemo: boolean) => {
    if (isDemo) return;
    // policy.get is the section's admission ticket (member + connector grant);
    // devices need audit rights - each degrades independently.
    try {
      const policy = await svc('aokie.companion.policy.get');
      let devices: CompanionDevice[] | null = null;
      try {
        const r = await svc('aokie.companion.devices.list');
        const raw = Array.isArray(r.devices) ? r.devices : [];
        devices = raw.map((item): CompanionDevice => {
          const d = asRecord(item);
          return {
            id: typeof d.id === 'string' ? d.id : String(d.id ?? ''),
            displayName: typeof d.displayName === 'string' && d.displayName !== '' ? d.displayName : null,
            role: typeof d.role === 'string' ? d.role : null,
            revokedAt: typeof d.revokedAt === 'string' && d.revokedAt !== '' ? d.revokedAt : null,
            lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
          };
        });
      } catch {
        devices = null;
      }
      // Edit rights are probed by attempting a save only when the user acts;
      // show the controls to everyone the DEVICES list admits (audit is not a
      // subset of manage, so a save may still refuse - surfaced honestly then).
      setCompanion({ hidden: false, policy, devices, canEdit: devices !== null });
    } catch {
      setCompanion({ hidden: true, policy: null, devices: null, canEdit: false });
    }
  };

  const refreshEvents = async () => {
    try {
      const rows = await FormLogic.records({ limit: 100 });
      setEvents(rows || []);
    } catch (e) {
      setEvents([]);
      setBanner(e instanceof Error && e.message ? e.message : 'Failed to load events');
    }
  };

  const loadAll = async () => {
    setBanner('');
    // Paint every card in its null/Loading state up front so nothing sits blank
    // while a command is in flight - a relayed dongle/phone read against a
    // remote desktop can take several seconds.
    setDongles(null);
    setPhones(null);
    setCompanion(null);
    setEvents(null);
    setFreshNote('');
    setFreshGen((g) => g + 1);
    let isDemo = demoRef.current;
    try {
      const u = await FormLogic.currentUser();
      isDemo = !!(u && typeof u.email === 'string' && u.email === 'demo@formlogic.local');
    } catch { /* keep the previous demo verdict */ }
    demoRef.current = isDemo;
    setDemo(isDemo);
    await Promise.all([loadRuntime(isDemo), loadDongles(), loadPhones(), loadCompanion(isDemo), refreshEvents()]);
  };

  // Mount-only initial load (loadAll's identity changes per render; re-running it per
  // render would hammer the bridge — the Refresh affordances re-trigger it explicitly).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAll(); }, []);

  // ---- actions -----------------------------------------------------------

  const connectDesktop = () => {
    setConnecting(true);
    FormLogic.host.ceremony('connect-desktop').then((out) => {
      if (out.status !== 'done' && out.message) setBanner(out.message);
      setConnecting(false);
      return loadAll();
    }).catch((err: unknown) => {
      setBanner(errText(err));
      setConnecting(false);
    });
  };

  const installDriver = async (d: DongleRow) => {
    setBusyDriver(d.id);
    try {
      await cmd('dongle.installDriver', { vid: d.vid, pid: d.pid });
      setBanner('');
      await loadDongles();
    } catch (err) {
      setBanner(errText(err));
    }
    setBusyDriver(null);
  };

  const setPreferred = async (d: DongleRow) => {
    try {
      await cmd('dongle.setPreferred', { vid: d.vid, pid: d.pid });
      await loadDongles();
    } catch (err) {
      setBanner(errText(err));
    }
  };

  const pollPhone = async (address: string, wantConnected: boolean, tries: number, delayMs: number): Promise<boolean> => {
    for (let left = tries; left > 0; left--) {
      await sleep(delayMs);
      try {
        const res = await cmd('phone.listPaired');
        const list = Array.isArray(res.devices) ? res.devices : [];
        for (const item of list) {
          const d = asRecord(item);
          if (d.address === address && (d.connected === true) === wantConnected) return true;
        }
      } catch { /* transient poll failure - it costs the attempt, like a miss */ }
    }
    return false;
  };

  const phoneAction = async (row: PhoneRow, connect: boolean) => {
    setBusyPhone(row.address);
    setBanner('');
    try {
      await cmd(connect ? 'phone.connect' : 'phone.disconnect', { address: row.address });
      // Accepted-only command - watch the bonded list for the real outcome.
      const ok = await pollPhone(row.address, connect, connect ? 6 : 4, connect ? 2000 : 1500);
      if (!ok) {
        setBanner(connect
          ? 'Still trying to reconnect - if it does not connect, make sure the phone is nearby with Bluetooth on, or tap "Aokie AI Assistant" in its Bluetooth settings.'
          : 'Disconnect sent - the link is taking a moment to drop. Press Refresh if the list looks stale.');
      }
    } catch (err) {
      setBanner(errText(err));
    }
    setBusyPhone(null);
    await loadPhones();
  };

  const revokeDevice = async (dev: CompanionDevice) => {
    setBusyCompanion(dev.id);
    try {
      await svc('aokie.companion.devices.revoke', { deviceId: dev.id });
      setConfirmRevoke(null);
      await loadCompanion(demoRef.current);
    } catch (err) {
      setBanner(errText(err));
    }
    setBusyCompanion(null);
  };

  const approveDevice = async (dev: CompanionDevice) => {
    setBusyCompanion(dev.id);
    try {
      await svc('aokie.companion.devices.approve', { deviceId: dev.id });
      await loadCompanion(demoRef.current);
    } catch (err) {
      setBanner(errText(err));
    }
    setBusyCompanion(null);
  };

  const savePolicy = async (draft: Record<string, boolean>) => {
    setBusyPolicy(true);
    try {
      await svc('aokie.companion.policy.update', { remoteConsent: draft });
      setBanner('');
      await loadCompanion(demoRef.current);
    } catch (err) {
      setBanner(errText(err));
    }
    setBusyPolicy(false);
  };

  const clearEvents = async () => {
    setClearing(true);
    // Bounded passes of 25 explicit ids (the bridge's batch cap); a huge log
    // may need another press - honest, never a firehose.
    try {
      for (let pass = 0; pass < 8; pass++) {
        const rows = await FormLogic.records({ limit: 25 });
        if (!rows || rows.length === 0) break;
        const out = await FormLogic.deleteRecords(rows.map((r) => r.id));
        if (out.failed && out.failed.length > 0) {
          throw new Error(out.failed[0].error || 'Some events could not be deleted');
        }
      }
    } catch (err) {
      setBanner(errText(err));
    }
    setClearing(false);
    setConfirmClear(false);
    await refreshEvents();
  };

  const startFresh = async () => {
    if (freshBusyRef.current) return;
    freshBusyRef.current = true;
    setBusyFresh(true);
    // The HOST owns the reset: its own confirm dialog, its own bulk clear -
    // this screen only asks. denied = the operator cancelled the dialog.
    try {
      const out = await FormLogic.host.ceremony('start-fresh');
      if (out.status === 'done') {
        setFreshNote((out.deleted || 0) + ' records removed.');
        await refreshEvents();
      } else {
        setFreshNote(out.status === 'denied' ? '' : (out.message || 'The reset did not run.'));
      }
    } catch (err) {
      setBanner(err instanceof Error && err.message ? err.message : 'The reset failed.');
    }
    freshBusyRef.current = false;
    setBusyFresh(false);
  };

  // ---- layout ------------------------------------------------------------

  return (
    <div id="ds" aria-label="Device setup">
      <div class="head">
        <h1>Device Setup</h1>
        <button type="button" id="refresh" class="btn" onClick={() => { void loadAll(); }}>Refresh</button>
      </div>
      {banner !== '' && <div id="banner" class="banner" role="alert">{banner}</div>}
      <RuntimeCard
        demo={demo}
        presence={presence}
        desktops={desktops}
        connecting={connecting}
        onConnectDesktop={connectDesktop}
      />
      <DonglesCard
        access={dongleAccess}
        rows={dongles}
        enumNote={enumNote}
        busyDriver={busyDriver}
        onInstallDriver={(d) => { void installDriver(d); }}
        onSetPreferred={(d) => { void setPreferred(d); }}
      />
      <PhonesCard
        access={phoneAccess}
        rows={phones}
        busyPhone={busyPhone}
        onConnect={(r) => { void phoneAction(r, true); }}
        onDisconnect={(r) => { void phoneAction(r, false); }}
      />
      <CompanionCard
        demo={demo}
        companion={companion}
        busyCompanion={busyCompanion}
        confirmRevoke={confirmRevoke}
        busyPolicy={busyPolicy}
        onRevokeAsk={(id) => setConfirmRevoke(id)}
        onRevokeCancel={() => setConfirmRevoke(null)}
        onRevoke={(dev) => { void revokeDevice(dev); }}
        onApprove={(dev) => { void approveDevice(dev); }}
        onSavePolicy={(draft) => { void savePolicy(draft); }}
      />
      <EventsCard
        demo={demo}
        rows={events}
        confirmClear={confirmClear}
        clearing={clearing}
        onClearAsk={() => setConfirmClear(true)}
        onClearCancel={() => setConfirmClear(false)}
        onClear={() => { void clearEvents(); }}
      />
      <FreshCard
        key={freshGen}
        demo={demo}
        busy={busyFresh}
        note={freshNote}
        onStartFresh={() => { void startFresh(); }}
      />
    </div>
  );
}

render(<App />, document.getElementById('root')!);
