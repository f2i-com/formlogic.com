import { useCallback, useEffect, useRef, useState } from 'react';
import { plugins } from '../api';
import { AlertTriangleIcon, CheckIcon } from '../Icons';
import { useConfirm } from '../ConfirmDialog';
import { useToast } from '../Toasts';
import { DongleSetupWizard } from './DongleSetupWizard';

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

/** `settings.get` / `settings.set` response data shape: the whole live config bag. */
interface AokieSettingsResponse {
  settings?: Record<string, unknown>;
}

/**
 * Every key the Aokie connector's settings bag understands (persona,
 * greeting, voice, model, barge-in tuning, …) — see aokie.com
 * `crates/aokie-plugin/src/connector.rs`. Kept flat and fully defaulted so
 * every field below is always a controlled input.
 */
interface AokieConnectorSettings {
  aiReceptionist: boolean;
  autoAnswer: boolean;
  answerTone: boolean;
  greeting: string;
  persona: string;
  ttsVoice: string;
  aiModel: string;
  aiEndpoint: string;
  sttEndpoint: string;
  ttsEndpoint: string;
  sttEndpointMs: number;
  bargeIn: boolean;
  bargeSensitivity: number;
  hfpCodec: 'auto' | 'cvsd' | 'wbs';
  reenumerateHwid: string;
}

const AOKIE_SETTINGS_DEFAULTS: AokieConnectorSettings = {
  aiReceptionist: false,
  autoAnswer: true,
  answerTone: false,
  greeting: '',
  persona: '',
  ttsVoice: '',
  aiModel: '',
  aiEndpoint: '',
  sttEndpoint: '',
  ttsEndpoint: '',
  sttEndpointMs: 450,
  bargeIn: false,
  bargeSensitivity: 650,
  hfpCodec: 'auto',
  reenumerateHwid: '',
};

const AOKIE_VOICE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'alba', label: 'Alba' },
  { value: 'cosette', label: 'Cosette' },
  { value: 'eponine', label: 'Eponine' },
  { value: 'fantine', label: 'Fantine' },
  { value: 'javert', label: 'Javert' },
  { value: 'jean', label: 'Jean' },
  { value: 'marius', label: 'Marius' },
];

const AOKIE_CODEC_OPTIONS: Array<{ value: AokieConnectorSettings['hfpCodec']; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'cvsd', label: 'CVSD (8kHz)' },
  { value: 'wbs', label: 'mSBC (16kHz, wideband)' },
];

/**
 * Merge a raw `settings.get`/`settings.set` payload over the client-side
 * defaults so every field is always defined (never leave a controlled input
 * `undefined`), tolerating missing/mistyped keys from an older plugin build.
 */
function withAokieDefaults(raw: unknown): AokieConnectorSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = AOKIE_SETTINGS_DEFAULTS;
  const codec = src.hfpCodec;
  return {
    aiReceptionist: typeof src.aiReceptionist === 'boolean' ? src.aiReceptionist : d.aiReceptionist,
    autoAnswer: typeof src.autoAnswer === 'boolean' ? src.autoAnswer : d.autoAnswer,
    answerTone: typeof src.answerTone === 'boolean' ? src.answerTone : d.answerTone,
    greeting: typeof src.greeting === 'string' ? src.greeting : d.greeting,
    persona: typeof src.persona === 'string' ? src.persona : d.persona,
    ttsVoice: typeof src.ttsVoice === 'string' ? src.ttsVoice : d.ttsVoice,
    aiModel: typeof src.aiModel === 'string' ? src.aiModel : d.aiModel,
    aiEndpoint: typeof src.aiEndpoint === 'string' ? src.aiEndpoint : d.aiEndpoint,
    sttEndpoint: typeof src.sttEndpoint === 'string' ? src.sttEndpoint : d.sttEndpoint,
    ttsEndpoint: typeof src.ttsEndpoint === 'string' ? src.ttsEndpoint : d.ttsEndpoint,
    sttEndpointMs:
      typeof src.sttEndpointMs === 'number' && Number.isFinite(src.sttEndpointMs)
        ? src.sttEndpointMs
        : d.sttEndpointMs,
    bargeIn: typeof src.bargeIn === 'boolean' ? src.bargeIn : d.bargeIn,
    bargeSensitivity:
      typeof src.bargeSensitivity === 'number' && Number.isFinite(src.bargeSensitivity)
        ? src.bargeSensitivity
        : d.bargeSensitivity,
    hfpCodec: codec === 'cvsd' || codec === 'wbs' || codec === 'auto' ? codec : d.hfpCodec,
    reenumerateHwid: typeof src.reenumerateHwid === 'string' ? src.reenumerateHwid : d.reenumerateHwid,
  };
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
  const bondedRef = useRef<string[]>([]);
  // Snapshot when a window opens, so "the phone arrived" is a TRANSITION
  // (new bond / fresh reconnect), not just "something was already connected".
  const baselineBonds = useRef(0);
  const baselineConnected = useRef(false);
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

  // Baseline at window-open — also covers windows opened OUTSIDE this UI
  // (flows, the command relay), which this card still renders a countdown for.
  const windowOpen = secondsLeft > 0;
  useEffect(() => {
    if (!windowOpen) return;
    baselineConnected.current = connected;
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
  // phone actually arriving. A NEW bond (listPaired grew) or a fresh reconnect
  // (connected flipped on since the window opened) is success — close the
  // window (the radio auto-closes on a bond; Stop covers the reconnect case)
  // and say so, instead of letting the timer silently run out.
  useEffect(() => {
    if (!running || !windowOpen) return;
    const t = window.setInterval(async () => {
      try {
        const s = await pollStatus();
        const bondsNow = (await loadBonded()).length;
        const success =
          bondsNow > baselineBonds.current || (s.connected && !baselineConnected.current);
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
      // Pre-window baseline so the poller can spot the new bond / reconnect.
      const before = await loadBonded();
      baselineBonds.current = before.length;
      baselineConnected.current = connected;
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
      {windowOpen ? (
        <>
          <div className="service-meta">
            Discoverable as “Aokie AI Assistant” — {formatSeconds(secondsLeft)} left. On your
            phone: Bluetooth → Pair new device.
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

/**
 * Editable form over Aokie's live connector settings (persona, greeting,
 * voice, model, barge-in tuning, …) — reads via `settings.get`, writes the
 * FULL settings bag via `settings.set` (so booleans round-trip correctly
 * even when unchecked), no plugin restart required to take effect.
 * Collapsed by default; only fetches on first expand (or an explicit
 * Reload), never while the plugin isn't running.
 */
function AokieSettingsForm({ running }: { running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AokieConnectorSettings>(AOKIE_SETTINGS_DEFAULTS);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await plugins.command('aokie', 'settings.get');
      const data = (res.data ?? {}) as AokieSettingsResponse;
      setSettings(withAokieDefaults(data.settings));
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
    setSaving(true);
    setError(null);
    try {
      const res = await plugins.command('aokie', 'settings.set', settings);
      const data = (res.data ?? {}) as AokieSettingsResponse;
      setSettings(withAokieDefaults(data.settings));
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
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>Voice</span>
                <select
                  value={settings.ttsVoice}
                  onChange={(e) => setSettings((s) => ({ ...s, ttsVoice: e.target.value }))}
                >
                  {AOKIE_VOICE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
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
              <label className="form-row" style={{ marginTop: 8 }}>
                <span>LLM endpoint</span>
                <input
                  type="text"
                  placeholder="blank = auto-detect (tries :8080 then :11434)"
                  value={settings.aiEndpoint}
                  onChange={(e) => setSettings((s) => ({ ...s, aiEndpoint: e.target.value }))}
                />
              </label>
              <label className="form-row">
                <span>Speech-to-text endpoint</span>
                <input
                  type="text"
                  placeholder="blank = built-in engine"
                  value={settings.sttEndpoint}
                  onChange={(e) => setSettings((s) => ({ ...s, sttEndpoint: e.target.value }))}
                />
              </label>
              <label className="form-row">
                <span>Text-to-speech endpoint</span>
                <input
                  type="text"
                  placeholder="blank = built-in engine"
                  value={settings.ttsEndpoint}
                  onChange={(e) => setSettings((s) => ({ ...s, ttsEndpoint: e.target.value }))}
                />
              </label>
              <p className="form-hint">
                Optional OpenAI-compatible speech endpoints (e.g. the Aokie Voice service:
                http://127.0.0.1:17920/v1/audio/transcriptions and /v1/audio/speech). Blank uses the
                plugin's built-in engines; on endpoint failure it falls back automatically.
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
