import { useCallback, useEffect, useRef, useState } from 'react';
import { aiSources, plugins, type AiSourceEntry } from '../api';
import { AlertTriangleIcon, CheckIcon } from '../Icons';
import { useConfirm } from '../ConfirmDialog';
import { useToast } from '../Toasts';
import { PANEL_CACHE_KEYS, getPanelCache, primePanelCache } from '../panelCache';
import { ConsentSection } from './ConsentWizard';
import { DongleSetupWizard } from './DongleSetupWizard';
import { AOKIE_LINK_EVENTS, useAokieEvents } from './useAokieEvents';
import {
  AOKIE_SETTINGS_DEFAULTS,
  CUSTOM_BUNDLE_DIR,
  DEFAULT_ENGINES,
  bundleSelectionUpdate,
  composeLaneUrl,
  engineOptionLabel,
  inferLaneSource,
  parseTtsVoiceCatalog,
  pocketVoiceOptions,
  prettifyBundleName,
  settingsPatch,
  withAokieDefaults,
  type AokieConnectorSettings,
  type AokieLane,
  type TtsCatalogEngine,
} from './aokieSettings';

/**
 * The Aokie receptionist feature UI (audit/redesign 2026-07): live phone
 * status, dev-mode simulate, and the connector settings editor. Extracted
 * verbatim from PluginsPanel so the Plugins page and the AI Receptionist
 * workspace share ONE implementation.
 */
/** `phone.status` response data (aokie connector). */
interface AokiePhoneStatus {
  paired: boolean;
  device?: { name?: string; address?: string } | null;
  connected?: boolean;
  /** AOK-BT-001 bounded pairing window — discoverable ONLY while this is open. */
  pairingOpen?: boolean;
  pairingSecondsRemaining?: number;
  /** PAIR-001: the held SSP numeric comparison awaiting the operator, if any. */
  pairingConfirm?: {
    address?: string;
    numericValue?: number;
    expiresEpochSecs?: number;
  } | null;
}

/** `phone.startPairing` response data. */
interface AokieStartPairingResult {
  windowSeconds?: number;
  simulated?: boolean;
}

/** `phone.listPaired` response data — radio mode returns `{address}` objects,
 *  the no-radio config fallback may hold richer legacy device records. */
interface AokieListPairedResult {
  devices?: Array<{ address?: string } | string>;
}

/** `dongle.diagnostics {simulate:"call"}` response data. */
interface AokieSimulateResult {
  simulated?: string;
  correlationId?: string;
  events?: string[];
}

/** `settings.get` / `settings.set` response data shape: the whole live config
 *  bag, plus the OPTIONAL installed-voice catalog side key (older plugins
 *  never return it — the voice picker degrades to a hardcoded list). */
interface AokieSettingsResponse {
  settings?: Record<string, unknown>;
  ttsVoiceCatalog?: unknown;
}


const AOKIE_CODEC_OPTIONS: Array<{ value: AokieConnectorSettings['hfpCodec']; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'cvsd', label: 'CVSD (8kHz)' },
  { value: 'wbs', label: 'mSBC (16kHz, wideband)' },
];

// ----- endpoint source lanes (CON-301 desktop side) ------------------------

/** Which /api/ai/sources capability a lane's service must declare. */
const LANE_CAPABILITY: Record<AokieLane, string> = {
  llm: 'chat',
  stt: 'transcription',
  tts: 'speech',
};

/** Aokie's own split speech service per lane — listed FIRST (it hosts the
 *  plugin's default engines). The LLM lane has no dedicated default. */
const LANE_DEFAULT_SERVICE: Record<AokieLane, string | null> = {
  llm: null,
  stt: 'aokie-stt',
  tts: 'aokie-tts',
};

const LANE_SETTING_KEY: Record<AokieLane, 'aiEndpoint' | 'sttEndpoint' | 'ttsEndpoint'> = {
  llm: 'aiEndpoint',
  stt: 'sttEndpoint',
  tts: 'ttsEndpoint',
};

const LANE_LABEL: Record<AokieLane, string> = {
  llm: 'LLM source',
  stt: 'Speech-to-text source',
  tts: 'Text-to-speech source',
};

/**
 * The option list for one lane's source select: the Aokie default speech
 * service first (STT/TTS), then the other capability-matching local services
 * ('(stopped)' suffix when not running), AI providers on the LLM lane ONLY
 * (the gateway serves no audio routes yet; empty provider capabilities =
 * all), then Custom URL… and Automatic (built-in) = ''.
 */
function laneSourceOptions(
  lane: AokieLane,
  sources: AiSourceEntry[],
): Array<{ value: string; label: string }> {
  const cap = LANE_CAPABILITY[lane];
  const def = LANE_DEFAULT_SERVICE[lane];
  const services = sources.filter(
    (s) => s.kind === 'service' && (s.capabilities ?? []).includes(cap),
  );
  const ordered = [
    ...services.filter((s) => s.serviceId === def),
    ...services.filter((s) => s.serviceId !== def),
  ];
  const opts = ordered.map((s) => ({
    value: s.id,
    label: `This computer: ${s.name}${s.status === 'running' ? '' : ' (stopped)'}`,
  }));
  if (lane === 'llm') {
    for (const p of sources) {
      if (p.kind !== 'provider') continue;
      const caps = p.capabilities ?? [];
      if (caps.length > 0 && !caps.includes(cap)) continue; // [] = all (legacy)
      opts.push({ value: p.id, label: `Provider: ${p.name}` });
    }
  }
  opts.push({ value: 'custom', label: 'Custom URL…' });
  opts.push({ value: '', label: 'Automatic (built-in)' });
  return opts;
}

/**
 * Seed one lane's select from the saved endpoint URL: inferLaneSource, but
 * anything the lane's option list can't represent (e.g. a gateway URL saved
 * on a speech lane, or a service that vanished) degrades to 'custom' so the
 * raw URL stays visible and editable — the pick is never silently lost.
 */
function seedLaneSource(saved: string, lane: AokieLane, sources: AiSourceEntry[]): string {
  const inferred = inferLaneSource(saved, lane, sources);
  if (inferred === '' || inferred === 'custom') return inferred;
  return laneSourceOptions(lane, sources).some((o) => o.value === inferred) ? inferred : 'custom';
}

/** Poll cadence while a pairing window is open (countdown + bond detection). */
const PAIRING_POLL_MS = 2000;

/** Gentle background cadence keeping the connected readout truthful at rest. */
const IDLE_POLL_MS = 12000;

/** New-phone pairing window: the plugin clamps to 30..=300s; ask for the max —
 *  the window auto-closes the moment one phone bonds and there's a live
 *  countdown + Stop button, so the longer window just gives people time to
 *  find their phone's Bluetooth menu. */
const PAIRING_WINDOW_SECONDS = 300;

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Bluetooth pairing controls (AOK-BT-001): the radio is connectable-only at
 * rest — a NEW phone can only see "Aokie AI Assistant" while an explicit
 * pairing window is open, and this is the UI that opens one. Shows a live
 * countdown while discoverable, and the revocable bonded phones (Forget =
 * `phone.removePaired`, so that phone must pair again before reconnecting).
 */
function PhonePairingControls({ running, onPaired }: { running: boolean; onPaired: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [bonded, setBonded] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [device, setDevice] = useState<{ name?: string; address?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // PAIR-001: the held numeric-comparison prompt (address + 6-digit code).
  const [confirmPrompt, setConfirmPrompt] = useState<{
    address: string;
    numericValue: number;
  } | null>(null);
  const bondedRef = useRef<string[]>([]);
  // Snapshot the bonded-device COUNT when a window opens, so a genuinely new
  // phone shows up as a TRANSITION (the count grew).
  const baselineBonds = useRef(0);
  // PAIR-001: set once the operator accepts THIS window's numeric-comparison
  // prompt. Re-pairing a phone whose address is already stored doesn't grow the
  // bond count, so the operator's confirm + a live connection is what marks
  // that case a success. Reset per window.
  const confirmedRef = useRef(false);
  const toast = useToast();
  const { confirm } = useConfirm();

  const loadBonded = useCallback(async () => {
    const res = await plugins.command('aokie', 'phone.listPaired');
    const raw = (res.data as AokieListPairedResult | undefined)?.devices ?? [];
    const addrs = raw
      .map((d) => (typeof d === 'string' ? d : (d?.address ?? '')))
      .filter((a): a is string => a !== '');
    bondedRef.current = addrs;
    setBonded(addrs);
    return addrs;
  }, []);

  const pollStatus = useCallback(async () => {
    const res = await plugins.command('aokie', 'phone.status');
    const d = (res.data ?? {}) as AokiePhoneStatus;
    const secs =
      d.pairingOpen && typeof d.pairingSecondsRemaining === 'number'
        ? d.pairingSecondsRemaining
        : 0;
    const isConnected = !!d.connected || d.paired;
    setSecondsLeft(secs);
    setConnected(isConnected);
    setDevice(d.device ?? null);
    // PAIR-001: surface (or clear) the numeric-comparison prompt. The plugin
    // reports it only while the radio is actually holding the SSP reply.
    const pc = d.pairingConfirm;
    setConfirmPrompt(
      pc && pc.address && typeof pc.numericValue === 'number'
        ? { address: pc.address, numericValue: pc.numericValue }
        : null,
    );
    return { secs, connected: isConnected };
  }, []);

  // Initial snapshot when the plugin starts; drop stale readouts when it stops.
  useEffect(() => {
    if (!running) {
      setSecondsLeft(0);
      setBonded([]);
      bondedRef.current = [];
      setConnected(false);
      setDevice(null);
      setError(null);
      setConfirmPrompt(null);
      confirmedRef.current = false;
      return;
    }
    Promise.all([pollStatus(), loadBonded()]).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [running, pollStatus, loadBonded]);

  // Gentle idle poll so the connected readout stays truthful at rest — the
  // phone can connect or drop at any time without a pairing window open.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      pollStatus().catch(() => {});
    }, IDLE_POLL_MS);
    return () => window.clearInterval(t);
  }, [running, pollStatus]);

  // Event-driven refresh: a phone connecting/dropping/pairing updates the
  // readout IMMEDIATELY instead of waiting out the idle poll.
  useAokieEvents(
    running,
    AOKIE_LINK_EVENTS,
    useCallback(() => {
      pollStatus().catch(() => {});
      loadBonded().catch(() => {});
    }, [pollStatus, loadBonded]),
  );

  // Baseline at window-open — also covers windows opened OUTSIDE this UI
  // (flows, the command relay), which this card still renders a countdown for.
  const windowOpen = secondsLeft > 0;
  useEffect(() => {
    if (!windowOpen) return;
    confirmedRef.current = false;
    loadBonded()
      .then((addrs) => {
        baselineBonds.current = addrs.length;
      })
      .catch(() => {
        baselineBonds.current = bondedRef.current.length;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once per window-open flip
  }, [windowOpen, loadBonded]);

  // While the window is open, poll fast: tick the countdown and watch for the
  // phone to actually BOND. Success = the bonded list grew, OR the operator
  // accepted this window's numeric comparison and the phone is now connected
  // (re-pairing a stored address doesn't grow the count). We must NOT treat a
  // bare connection as success: the ACL for a fresh pairing comes up a beat
  // BEFORE the numeric-comparison prompt, so closing the window on "connected"
  // slammed it shut mid-SSP and every pairing failed with "incorrect PIN or
  // passkey" (PAIR-001).
  useEffect(() => {
    if (!running || !windowOpen) return;
    const t = window.setInterval(async () => {
      try {
        const s = await pollStatus();
        const bondsNow = (await loadBonded()).length;
        const success =
          bondsNow > baselineBonds.current || (confirmedRef.current && s.connected);
        if (!success) return;
        try {
          await plugins.command('aokie', 'phone.stopPairing');
        } catch {
          // The bond already auto-closed the window — fine.
        }
        setSecondsLeft(0);
        toast.push({
          kind: 'success',
          title: 'Phone connected',
          body: 'Aokie can take calls from this phone; it reconnects automatically from now on.',
        });
        onPaired();
      } catch {
        // Plugin stopping mid-poll — the running-flip effect clears state.
      }
    }, PAIRING_POLL_MS);
    return () => window.clearInterval(t);
  }, [running, windowOpen, pollStatus, loadBonded, toast, onPaired]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      // Pre-window baseline so the poller can spot the new bond.
      const before = await loadBonded();
      baselineBonds.current = before.length;
      confirmedRef.current = false;
      const res = await plugins.command('aokie', 'phone.startPairing', {
        seconds: PAIRING_WINDOW_SECONDS,
      });
      const d = (res.data ?? {}) as AokieStartPairingResult;
      if (d.simulated) {
        toast.push({
          kind: 'success',
          title: 'Simulated pairing session',
          body: 'Dev mode has no radio — no real pairing window was opened.',
        });
        return;
      }
      setSecondsLeft(d.windowSeconds ?? PAIRING_WINDOW_SECONDS);
      toast.push({
        kind: 'success',
        title: 'Discoverable for 5 minutes',
        body: 'On your phone: Bluetooth → Pair new device → "Aokie AI Assistant".',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stopPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      await plugins.command('aokie', 'phone.stopPairing');
      setSecondsLeft(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // PAIR-001: answer the numeric comparison — the code shown here must match
  // the one on the phone's pairing dialog before the operator confirms.
  const resolvePairing = async (accept: boolean) => {
    if (!confirmPrompt) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.command('aokie', 'phone.confirmPairing', {
        address: confirmPrompt.address,
        accept,
      });
      // PAIR-001: remember the operator accepted THIS window's comparison, so
      // the poller counts the phone reconnecting as success even when its
      // address was already stored (re-pair doesn't grow the bond count).
      if (accept) confirmedRef.current = true;
      setConfirmPrompt(null);
      if (!accept) {
        toast.push({
          kind: 'success',
          title: 'Pairing refused',
          body: 'The phone was not paired. The window stays open if you want to try again.',
        });
      }
    } catch (e) {
      // Most common cause: the prompt expired (~25s) before the click landed.
      setConfirmPrompt(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (address: string) => {
    const ok = await confirm({
      title: 'Forget this phone?',
      body: `${address} won't be able to reconnect until you pair it again.`,
      confirmLabel: 'Forget',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await plugins.command('aokie', 'phone.removePaired', { address });
      await loadBonded();
      onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!running) return null;

  return (
    <div>
      <div className="aokie-card-head">
        <span className="section-title aokie-card-title">Bluetooth pairing</span>
      </div>
      {confirmPrompt ? (
        <>
          <div className="service-meta">
            Phone <strong>{confirmPrompt.address}</strong> wants to pair. Confirm ONLY if your
            phone shows this same code:
          </div>
          <div className="aokie-pairing-code" style={{ fontSize: 24, fontWeight: 700, letterSpacing: 3, margin: '6px 0' }}>
            {String(confirmPrompt.numericValue).padStart(6, '0')}
          </div>
          <div className="aokie-card-actions">
            <button className="btn btn-primary" onClick={() => resolvePairing(true)} disabled={busy}>
              Codes match — pair
            </button>
            <button className="btn btn-secondary" onClick={() => resolvePairing(false)} disabled={busy}>
              Reject
            </button>
          </div>
        </>
      ) : windowOpen ? (
        <>
          <div className="service-meta">
            Discoverable as “Aokie AI Assistant” — {formatSeconds(secondsLeft)} left. On your
            phone: Bluetooth → Pair new device, then confirm the matching code here.
          </div>
          <div className="aokie-card-actions">
            <button className="btn btn-secondary" onClick={stopPairing} disabled={busy}>
              Stop pairing
            </button>
          </div>
        </>
      ) : connected ? (
        <>
          <div className="service-meta aokie-status-ok">
            <CheckIcon className="inline-icon icon-leading" size={14} />
            Phone connected{device?.address ? ` (${device.address})` : ''} — Aokie can take
            calls.
          </div>
          <div className="aokie-card-actions">
            <button className="btn btn-secondary" onClick={startPairing} disabled={busy}>
              {busy ? 'Opening…' : 'Pair another phone'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="service-meta">
            New phones can't see the dongle until you open a pairing window (already-paired
            phones reconnect on their own).
          </div>
          <div className="aokie-card-actions">
            <button className="btn btn-primary" onClick={startPairing} disabled={busy}>
              {busy ? 'Opening…' : 'Pair a phone'}
            </button>
          </div>
        </>
      )}
      {bonded.length > 0 && (
        <div className="aokie-paired-list">
          {bonded.map((address) => {
            const isConnected =
              connected &&
              !!device?.address &&
              address.toLowerCase() === device.address.toLowerCase();
            return (
              <div key={address} className="aokie-paired-row">
                <CheckIcon className="inline-icon icon-leading" size={14} />
                <span className="service-meta">
                  {address}
                  {isConnected ? ' · connected' : ''}
                </span>
                <button className="btn-tiny" onClick={() => forget(address)} disabled={busy}>
                  Forget
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Aokie-specific status card: dongle + phone readouts via connector
 * requests while the plugin runs, and the dev-mode "Simulate incoming call"
 * (the contract's scripted lifecycle — drives FormLogic integration tests
 * and demos without hardware).
 */
export function AokieCard({ running, devMode }: { running: boolean; devMode: boolean }) {
  const [phone, setPhone] = useState<AokiePhoneStatus | null>(null);
  const [dongleCount, setDongleCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simResult, setSimResult] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const ph = await plugins.command('aokie', 'phone.status');
      setPhone((ph.data ?? null) as AokiePhoneStatus | null);
      const dg = await plugins.command('aokie', 'dongle.list');
      const dongles = (dg.data as { dongles?: unknown[] } | undefined)?.dongles;
      setDongleCount(Array.isArray(dongles) ? dongles.length : 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Fetch on start; clear when the plugin stops (stale readouts mislead).
  useEffect(() => {
    if (running) {
      refresh();
    } else {
      setPhone(null);
      setDongleCount(null);
      setSimResult(null);
      setError(null);
    }
  }, [running, refresh]);

  // Event-driven refresh: the "phone: paired/connected" line updates the
  // moment the Bluetooth link actually changes (this card otherwise only
  // fetched once at plugin start — live report 2026-07-13).
  useAokieEvents(running, AOKIE_LINK_EVENTS, refresh);

  const simulate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await plugins.command('aokie', 'dongle.diagnostics', {
        simulate: 'call',
      });
      const d = (res.data ?? {}) as AokieSimulateResult;
      setSimResult(
        `${d.events?.length ?? 0} events emitted · ${d.correlationId ?? '?'}`,
      );
      toast.push({
        kind: 'success',
        title: 'Simulated call complete',
        body: `${d.events?.length ?? 0} aokie.* events published to the desktop event bus.`,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aokie-card">
      <div className="aokie-card-head">
        <span className="section-title aokie-card-title">Phone bridge</span>
        {running && (
          <button className="btn-tiny" onClick={refresh} disabled={busy}>
            refresh
          </button>
        )}
      </div>
      {!running ? (
        <div className="service-meta">
          Start the plugin to see dongle &amp; phone status.
        </div>
      ) : (
        <>
          <div className="service-meta">
            dongles: {dongleCount ?? '…'} known
            {' · '}
            phone:{' '}
            {phone == null
              ? '…'
              : phone.paired
                ? `paired${phone.device?.name ? ` (${phone.device.name})` : ''}`
                : 'not paired'}
          </div>
          {devMode && (
            <div className="aokie-card-actions">
              <button className="btn btn-secondary" onClick={simulate} disabled={busy}>
                {busy ? 'Simulating…' : 'Simulate incoming call'}
              </button>
              {simResult && <span className="service-meta">{simResult}</span>}
            </div>
          )}
          {/* CONSENT-001: the operator's scoped, signed, ENFORCED grant is
              the gate on every sensitive surface below — surface it first. */}
          <AokieConsentRow onChanged={refresh} />
          <DongleSetupWizard running={running} />
          <PhonePairingControls running={running} onPaired={refresh} />
          <AokieSettingsForm running={running} />
        </>
      )}
      {error && (
        <div className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

/** CONSENT-001: consent status + wizard, fed the live settings bag so the
 *  wizard can show exactly which endpoints call data goes to. */
function AokieConsentRow({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  useEffect(() => {
    plugins
      .command('aokie', 'settings.get')
      .then((r) => setSettings(((r.data as AokieSettingsResponse)?.settings) ?? {}))
      .catch(() => {
        /* plugin not reachable — ConsentSection hides itself too */
      });
  }, []);
  return <ConsentSection settings={settings} onChanged={onChanged} />;
}

/**
 * Editable form over Aokie's live connector settings (persona, greeting,
 * voice, model, barge-in tuning, …) — reads via `settings.get`, writes ONLY
 * the fields the operator changed via `settings.set` (the plugin merges per
 * key, so untouched safety keys like autoAnswer and unknown/newer plugin
 * keys are never rewritten by an unrelated edit — audit AOK-SAFE-001).
 * No plugin restart required to take effect. Collapsed by default; only
 * fetches on first expand (or an explicit Reload), never while the plugin
 * isn't running.
 */
function AokieSettingsForm({ running }: { running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AokieConnectorSettings>(AOKIE_SETTINGS_DEFAULTS);
  // The union source listing (local services + AI providers) behind the
  // endpoint lane dropdowns. Empty = listing unavailable (the selects still
  // offer Custom URL… / Automatic).
  const [sources, setSources] = useState<AiSourceEntry[]>([]);
  // Per-lane source pick: '' (automatic) | 'service:<id>' | 'provider:<id>' | 'custom'.
  const [laneSel, setLaneSel] = useState<Record<AokieLane, string>>({ llm: '', stt: '', tts: '' });
  // Installed voices/bundles reported by the plugin (settings.get side key);
  // null = older plugin → the voice picker degrades to the hardcoded list.
  const [catalog, setCatalog] = useState<TtsCatalogEngine[] | null>(null);
  // UI-only: the operator explicitly chose "Custom folder…" in the sherpa
  // bundle picker (a stored folder outside the catalog also renders as it).
  const [customDir, setCustomDir] = useState(false);
  // The bag as last loaded/saved — the diff base for dirty-field saves.
  const baseline = useRef<AokieConnectorSettings>(AOKIE_SETTINGS_DEFAULTS);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, srcRes] = await Promise.all([
        plugins.command('aokie', 'settings.get'),
        // Source listing is best-effort (panelCache-coalesced with the
        // app-start prefetch) — a failure must not block the settings form.
        primePanelCache(PANEL_CACHE_KEYS.aiSources, () => aiSources.list()),
      ]);
      const data = (res.data ?? {}) as AokieSettingsResponse;
      const merged = withAokieDefaults(data.settings);
      const srcs =
        srcRes?.sources ??
        getPanelCache<{ sources: AiSourceEntry[] }>(PANEL_CACHE_KEYS.aiSources)?.sources ??
        [];
      baseline.current = merged;
      setSettings(merged);
      setSources(srcs);
      setCatalog(parseTtsVoiceCatalog(data.ttsVoiceCatalog));
      setCustomDir(false);
      setLaneSel({
        llm: seedLaneSource(merged.aiEndpoint, 'llm', srcs),
        stt: seedLaneSource(merged.sttEndpoint, 'stt', srcs),
        tts: seedLaneSource(merged.ttsEndpoint, 'tts', srcs),
      });
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded) load();
  };

  const save = async () => {
    // Endpoint lanes save the COMPOSED URL (the plugin settings bag stores
    // URLs, not source ids): a running-service pick composes url + lane
    // path, a provider pick composes the gateway URL (LLM lane only), and a
    // stopped/vanished service composes '' — the plugin's built-in default —
    // with an honest toast below.
    const current: AokieConnectorSettings = {
      ...settings,
      aiEndpoint: composeLaneUrl(laneSel.llm, settings.aiEndpoint, 'llm', sources),
      sttEndpoint: composeLaneUrl(laneSel.stt, settings.sttEndpoint, 'stt', sources),
      ttsEndpoint: composeLaneUrl(laneSel.tts, settings.ttsEndpoint, 'tts', sources),
    };
    const patch = settingsPatch(baseline.current, current);
    if (Object.keys(patch).length === 0) {
      toast.push({ kind: 'success', title: 'No changes to save' });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await plugins.command('aokie', 'settings.set', patch);
      const data = (res.data ?? {}) as AokieSettingsResponse;
      const merged = withAokieDefaults(data.settings);
      baseline.current = merged;
      setSettings(merged);
      // The set response may not carry the catalog side key — keep the one
      // from the last settings.get rather than dropping to the fallback UI.
      const cat = parseTtsVoiceCatalog(data.ttsVoiceCatalog);
      if (cat) setCatalog(cat);
      setLaneSel({
        llm: seedLaneSource(merged.aiEndpoint, 'llm', sources),
        stt: seedLaneSource(merged.sttEndpoint, 'stt', sources),
        tts: seedLaneSource(merged.ttsEndpoint, 'tts', sources),
      });
      const stoppedPicks = (['llm', 'stt', 'tts'] as const).filter(
        (lane) => laneSel[lane].startsWith('service:') && current[LANE_SETTING_KEY[lane]] === '',
      );
      if (stoppedPicks.length > 0) {
        const names = stoppedPicks
          .map((lane) => {
            const src = sources.find((s) => s.id === laneSel[lane]);
            return src ? src.name : laneSel[lane].slice(8);
          })
          .join(', ');
        toast.push({
          kind: 'info',
          title: 'Selected service is not running',
          body: `${names}: saved as Automatic (built-in) — pick it again once the service is running.`,
        });
      }
      toast.push({
        kind: 'success',
        title: 'Receptionist settings saved',
        body: 'Takes effect on the next caller turn.',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Number inputs: guard against NaN AND a momentarily-empty field while
  // typing (`Number('')` is 0, not NaN, so it must be rejected explicitly)
  // so neither ever reaches local state or the save payload — keep the
  // last-known-good value instead.
  const setNumberField = (key: 'sttEndpointMs' | 'bargeSensitivity', raw: string) => {
    if (raw.trim() === '') return;
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    setSettings((s) => ({ ...s, [key]: n }));
  };

  // ----- engine-aware voice picker (mirrors the console's Voice card) ------
  // The voice option set follows the selected TTS engine: pocket voices are a
  // flat name list, sherpa voices are installed model-bundle folders (kokoro
  // bundles additionally take a numeric speaker id via ttsVoice).
  const ttsEngines = catalog && catalog.length > 0 ? catalog : DEFAULT_ENGINES;
  const isSherpa = settings.ttsEngine === 'sherpa';
  // Stored '' and 'pocket' both mean Pocket-TTS — the select's pocket option
  // keeps the legacy '' value so save semantics never change.
  const engineValue = settings.ttsEngine === 'pocket' ? '' : settings.ttsEngine;
  const bundles = catalog?.find((e) => e.id === 'sherpa')?.bundles ?? [];
  const voiceOptions = pocketVoiceOptions(catalog);
  const unlistedVoice = settings.ttsVoice !== '' && !voiceOptions.includes(settings.ttsVoice);
  const matchedBundle = bundles.find((b) => b.dir === settings.ttsModelDir);
  // A stored folder outside the catalog renders as the Custom choice with the
  // input pre-filled — never silently discarded.
  const bundleValue =
    customDir || (settings.ttsModelDir !== '' && !matchedBundle)
      ? CUSTOM_BUNDLE_DIR
      : matchedBundle
        ? matchedBundle.dir
        : '';
  const showCustomDir = isSherpa && (bundles.length === 0 || bundleValue === CUSTOM_BUNDLE_DIR);
  const isKokoro = isSherpa && matchedBundle?.kind === 'kokoro';

  if (!running) return null;

  return (
    <div>
      <div className="aokie-card-head">
        <span className="section-title aokie-card-title">Configure receptionist</span>
        <button type="button" className="btn-tiny" onClick={toggle}>
          {expanded ? 'Hide config' : 'Configure'}
        </button>
      </div>

      {expanded &&
        (loading ? (
          <div className="service-meta">Loading…</div>
        ) : !loaded ? (
          <div className="service-meta">
            Couldn't load receptionist settings.{' '}
            <button type="button" className="btn-tiny" onClick={load}>
              Retry
            </button>
          </div>
        ) : (
          <form
            className="dl-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div>
              <h4 className="form-group-title">AI receptionist</h4>
              <label className="form-row form-row-checkbox">
                <input
                  type="checkbox"
                  checked={settings.aiReceptionist}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, aiReceptionist: e.target.checked }))
                  }
                />
                <span>AI receptionist replies live</span>
              </label>
              <p className="form-hint">
                When on, the plugin answers callers itself in real time (speech-to-text →
                local LLM → text-to-speech). When off, a FormLogic flow must speak for it.
              </p>
              <label className="form-row form-row-checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.autoAnswer}
                  onChange={(e) => setSettings((s) => ({ ...s, autoAnswer: e.target.checked }))}
                />
                <span>Auto-answer incoming calls</span>
              </label>
            </div>

            <div>
              <h4 className="form-group-title">Persona &amp; voice</h4>
              <label className="form-row">
                <span>Greeting (spoken first)</span>
                <input
                  type="text"
                  placeholder="Thanks for calling! How can I help you today?"
                  value={settings.greeting}
                  onChange={(e) => setSettings((s) => ({ ...s, greeting: e.target.value }))}
                />
              </label>
              <p className="form-hint">Blank = a friendly built-in default.</p>
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>Persona / instructions</span>
                <textarea
                  rows={4}
                  placeholder="e.g. Be warm and concise. Offer to book Mon–Fri 9–5."
                  value={settings.persona}
                  onChange={(e) => setSettings((s) => ({ ...s, persona: e.target.value }))}
                />
              </label>
              <p className="form-hint">
                Blank = the built-in receptionist script (greet, ask the caller's name and
                reason, capture details, book or take a message).
              </p>
              {/* Engine-first voice picker: the voice options follow the
                  selected TTS engine, fed by the plugin's installed-voice
                  catalog (mirrors the console's Voice & replies card). */}
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>Speech engine</span>
                <select
                  value={engineValue}
                  onChange={(e) => setSettings((s) => ({ ...s, ttsEngine: e.target.value }))}
                >
                  {ttsEngines.map((eng) => (
                    <option key={eng.id} value={eng.id === 'pocket' ? '' : eng.id}>
                      {engineOptionLabel(eng)}
                    </option>
                  ))}
                  {!ttsEngines.some((eng) => (eng.id === 'pocket' ? '' : eng.id) === engineValue) && (
                    <option value={engineValue}>{engineValue}</option>
                  )}
                </select>
              </label>
              <p className="form-hint">
                Applies live. Sherpa speaks Piper/VITS/Kokoro voice bundles (much faster than
                Pocket-TTS); each engine has its own voice list below.
              </p>
              {!isSherpa && (
                <>
                  <label className="form-row" style={{ marginTop: 8 }}>
                    <span>Voice</span>
                    <select
                      value={settings.ttsVoice}
                      onChange={(e) => setSettings((s) => ({ ...s, ttsVoice: e.target.value }))}
                    >
                      {voiceOptions.map((v) => (
                        <option key={v || 'default'} value={v}>
                          {v === '' ? 'Default' : v.charAt(0).toUpperCase() + v.slice(1)}
                        </option>
                      ))}
                      {unlistedVoice && (
                        <option value={settings.ttsVoice}>{settings.ttsVoice} (current)</option>
                      )}
                    </select>
                  </label>
                  <p className="form-hint">
                    {catalog
                      ? 'Pocket-TTS voices installed on this machine.'
                      : 'Pocket-TTS voice — the plugin reports its installed list once it runs.'}
                  </p>
                </>
              )}
              {isSherpa && bundles.length > 0 && (
                <>
                  <label className="form-row" style={{ marginTop: 8 }}>
                    <span>Voice</span>
                    <select
                      value={bundleValue}
                      onChange={(e) => {
                        const u = bundleSelectionUpdate(e.target.value, bundles);
                        setCustomDir(u.engine.customDir ?? false);
                        setSettings((s) => ({
                          ...s,
                          ...(u.engine.modelDir !== undefined ? { ttsModelDir: u.engine.modelDir } : {}),
                          ...(u.voice !== undefined ? { ttsVoice: u.voice } : {}),
                        }));
                      }}
                    >
                      <option value="">Automatic (first installed voice)</option>
                      {bundles.map((b) => (
                        <option key={b.dir} value={b.dir}>
                          {prettifyBundleName(b.name)}
                        </option>
                      ))}
                      <option value={CUSTOM_BUNDLE_DIR}>Custom folder…</option>
                    </select>
                  </label>
                  <p className="form-hint">
                    Installed sherpa voice bundles — a pick sets the live voice and the in-process
                    fallback engine's model folder together.
                  </p>
                </>
              )}
              {showCustomDir && (
                <>
                  <label className="form-row" style={{ marginTop: 8 }}>
                    <span>Voice model folder</span>
                    <input
                      type="text"
                      placeholder={'blank = first voice under models\\tts'}
                      value={settings.ttsModelDir}
                      onChange={(e) => {
                        setCustomDir(true);
                        setSettings((s) => ({ ...s, ttsModelDir: e.target.value }));
                      }}
                    />
                  </label>
                  <p className="form-hint">
                    A sherpa voice bundle folder on this machine (the voice's .onnx + tokens.txt,
                    e.g. vits-piper-en_US-lessac-medium).
                  </p>
                </>
              )}
              {isKokoro && (
                <>
                  <label className="form-row" style={{ marginTop: 8 }}>
                    <span>Speaker id</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="e.g. 0"
                      value={settings.ttsVoice}
                      onChange={(e) => setSettings((s) => ({ ...s, ttsVoice: e.target.value }))}
                    />
                  </label>
                  <p className="form-hint">
                    Kokoro bundles hold many speakers — the numeric id picks one.
                  </p>
                </>
              )}
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>LLM model</span>
                <input
                  type="text"
                  placeholder="blank = auto-detect"
                  value={settings.aiModel}
                  onChange={(e) => setSettings((s) => ({ ...s, aiModel: e.target.value }))}
                />
              </label>
              <p className="form-hint">
                e.g. llama3.1:8b or qwen2.5:7b — leave blank to use whatever the desktop's
                running LLM service has loaded.
              </p>
              {(['llm', 'stt', 'tts'] as const).map((lane) => {
                const key = LANE_SETTING_KEY[lane];
                return (
                  <div key={lane}>
                    <label className="form-row" style={{ marginTop: 8 }}>
                      <span>{LANE_LABEL[lane]}</span>
                      <select
                        value={laneSel[lane]}
                        onChange={(e) =>
                          setLaneSel((v) => ({ ...v, [lane]: e.target.value }))
                        }
                      >
                        {laneSourceOptions(lane, sources).map((o) => (
                          <option key={o.value || 'auto'} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {laneSel[lane] === 'custom' && (
                      <label className="form-row" style={{ marginTop: 8 }}>
                        <span>Custom URL</span>
                        <input
                          type="text"
                          placeholder={
                            lane === 'llm'
                              ? 'e.g. http://127.0.0.1:8080/v1/chat/completions'
                              : `e.g. http://127.0.0.1:17920${
                                  lane === 'stt' ? '/v1/audio/transcriptions' : '/v1/audio/speech'
                                }`
                          }
                          value={settings[key]}
                          onChange={(e) =>
                            setSettings((s) => ({ ...s, [key]: e.target.value }))
                          }
                        />
                      </label>
                    )}
                  </div>
                );
              })}
              <p className="form-hint">
                Composed from the selected service now; if the FormLogic receptionist app is
                connected, its per-call settings take precedence.
              </p>
            </div>

            <div>
              <h4 className="form-group-title">Conversation tuning</h4>
              <label className="form-row">
                <span>Reply delay (ms)</span>
                <input
                  type="number"
                  min={150}
                  max={2000}
                  step={50}
                  value={settings.sttEndpointMs}
                  onChange={(e) => setNumberField('sttEndpointMs', e.target.value)}
                />
              </label>
              <p className="form-hint">
                How long the caller must pause before Aokie treats their turn as finished.
                Lower = snappier, but risks cutting off mid-sentence pauses.
              </p>
              <label className="form-row form-row-checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.bargeIn}
                  onChange={(e) => setSettings((s) => ({ ...s, bargeIn: e.target.checked }))}
                />
                <span>Full-duplex (barge-in)</span>
              </label>
              <p className="form-hint">
                Let the caller talk over Aokie — it stops the instant they speak, using echo
                cancellation.
              </p>
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>Barge-in sensitivity</span>
                <input
                  type="number"
                  min={100}
                  max={2000}
                  step={25}
                  value={settings.bargeSensitivity}
                  onChange={(e) => setNumberField('bargeSensitivity', e.target.value)}
                />
              </label>
              <p className="form-hint">
                Lower = easier to interrupt. Only used when barge-in is on.
              </p>
            </div>

            <div>
              <h4 className="form-group-title">Advanced</h4>
              <label className="form-row">
                <span>Bluetooth audio codec</span>
                <select
                  value={settings.hfpCodec}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      hfpCodec: e.target.value as AokieConnectorSettings['hfpCodec'],
                    }))
                  }
                >
                  {AOKIE_CODEC_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="form-hint">
                Some dongles only work reliably with CVSD; mSBC gives better
                speech-recognition accuracy where supported.
              </p>
              <label className="form-row form-row-checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.answerTone}
                  onChange={(e) => setSettings((s) => ({ ...s, answerTone: e.target.checked }))}
                />
                <span>Play a test tone on answer</span>
              </label>
              <p className="form-hint">
                Diagnostic: verifies the outbound audio path reaches the caller. Leave off for
                normal use.
              </p>
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>Re-enumerate hardware id on start</span>
                <input
                  type="text"
                  placeholder="e.g. USB\\VID_0A5C&PID_21EC"
                  value={settings.reenumerateHwid}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, reenumerateHwid: e.target.value }))
                  }
                />
              </label>
              <p className="form-hint">
                Workaround for dongles whose audio is dead after a cold boot until replugged.
                Leave blank unless you've hit that issue.
              </p>
              <label className="form-row form-row-checkbox" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.legacyPairingPin}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, legacyPairingPin: e.target.checked }))
                  }
                />
                <span>Allow legacy PIN pairing (compatibility)</span>
              </label>
              <p className="form-hint">
                ⚠️ Uses the fixed PIN 0000 for very old devices that can't do modern
                code-confirmation pairing — it provides no protection against a nearby
                impostor. Enable only while pairing such a device, then turn it back off.
              </p>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={load}
                disabled={loading || saving}
              >
                Reload
              </button>
            </div>
          </form>
        ))}
      {error && (
        <div className="service-error">
          <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
          {error}
        </div>
      )}
    </div>
  );
}
