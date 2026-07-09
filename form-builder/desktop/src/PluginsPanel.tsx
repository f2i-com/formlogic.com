import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  openInExplorer,
  plugins,
  type BuiltinPluginInfo,
  type PluginSnapshot,
  type PluginState,
  type PluginsListResponse,
} from './api';
import { AlertTriangleIcon, CheckIcon, XIcon } from './Icons';
import LogsViewer from './LogsViewer';
import { useToast } from './Toasts';

/**
 * Plugins panel — FormLogic Desktop's plugin host UI. Lists every plugin
 * found under `<dataDir>/plugins/`, with lifecycle state, start/stop/restart,
 * a logs tail, and the visible reason when a plugin is disabled (invalid
 * manifest / version incompatibility) or crashed. Polls /api/plugins every
 * 2s — the list endpoint rescans the folder, so dropping a plugin dir in
 * shows up without a restart.
 *
 * Bundled TEMPLATES (e.g. the Aokie phone bridge) are offered below the
 * installed plugins: Install materialises the manifest into the plugins
 * folder; the plugin then shows "binary … not installed" until the built
 * executable is dropped alongside it. The Aokie plugin additionally gets a
 * live dongle/phone status card (via connector requests) and, in dev mode,
 * a "Simulate incoming call" button (dongle.diagnostics {simulate:"call"}).
 */
export default function PluginsPanel() {
  const [snapshot, setSnapshot] = useState<PluginsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Ids with an action in flight so double-clicks can't double-fire.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const toast = useToast();
  // Toast on state transitions (crashed / unhealthy / running), not on every
  // poll; the first poll seeds silently.
  const seenStateRef = useRef<Map<string, PluginState>>(new Map());
  const firstPollRef = useRef(true);
  const reqSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const next = await plugins.list();
      if (seq !== reqSeqRef.current) return; // superseded
      const seen = seenStateRef.current;
      const firstPoll = firstPollRef.current;
      for (const p of next.plugins) {
        const prev = seen.get(p.id);
        if (prev !== p.state && !firstPoll && prev !== undefined) {
          if (p.state === 'crashed') {
            toast.push({
              kind: 'error',
              title: `Plugin "${p.name}" crashed`,
              body: p.reason ?? undefined,
              timeoutMs: 8000,
            });
          } else if (p.state === 'unhealthy') {
            toast.push({
              kind: 'error',
              title: `Plugin "${p.name}" is unhealthy`,
              body: 'Health probes are being missed; the process is still running.',
              timeoutMs: 8000,
            });
          } else if (p.state === 'running' && prev !== 'running') {
            toast.push({ kind: 'success', title: `Plugin "${p.name}" is running` });
          }
        }
        seen.set(p.id, p.state);
      }
      firstPollRef.current = false;
      setSnapshot(next);
      setError(null);
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const runAction = useCallback(
    async (fn: () => Promise<void>, key: string) => {
      setActionError(null);
      setPendingIds((p) => new Set(p).add(key));
      try {
        await fn();
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingIds((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    },
    [refresh],
  );

  return (
    <div className="panel">
      {error && (
        <div className="banner banner-err">
          Couldn't reach the FormLogic Desktop API: {error}
        </div>
      )}
      {actionError && (
        <div className="banner banner-err banner-dismissable">
          <span>
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
            {actionError}
          </span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss error"
            onClick={() => setActionError(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
      {snapshot && (
        <div className="datadir-note">
          Plugins live under <code>{snapshot.pluginsDir}</code>.{' '}
          <button
            className="btn-tiny"
            onClick={() =>
              openInExplorer(snapshot.pluginsDir).catch((e) =>
                setActionError(e instanceof Error ? e.message : String(e)),
              )
            }
            title="Open plugins folder in file explorer"
          >
            open
          </button>{' '}
          Each plugin is a folder with a <code>manifest.json</code> and an
          executable, supervised by FormLogic Desktop and reachable from
          FormLogic apps through connectors. Drop a plugin folder in and it
          appears here — see <code>plugin-template/</code> in the repo for a
          minimal example.
        </div>
      )}
      {snapshot && snapshot.plugins.length === 0 && !error && (
        <div className="empty-state">
          No plugins installed yet. Copy a plugin folder (with its{' '}
          <code>manifest.json</code>) into the plugins directory above to
          register one.
        </div>
      )}
      {!snapshot && !error && <div className="empty-state">Loading plugins…</div>}

      <section className="service-section">
        {snapshot?.plugins.map((p) => (
          <PluginCard
            key={p.id}
            plugin={p}
            devMode={snapshot.devMode}
            expanded={expandedId === p.id}
            pending={pendingIds.has(p.id)}
            onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onStart={() => runAction(() => plugins.start(p.id), p.id)}
            onStop={() => runAction(() => plugins.stop(p.id), p.id)}
            onRestart={() => runAction(() => plugins.restart(p.id), p.id)}
          />
        ))}
      </section>

      {(snapshot?.builtins ?? []).some((b) => !b.installed) && (
        <section className="service-section builtin-section">
          <h2 className="section-title">Built-in plugins</h2>
          {snapshot?.builtins
            .filter((b) => !b.installed)
            .map((b) => (
              <BuiltinCard
                key={b.id}
                builtin={b}
                pending={pendingIds.has(`install:${b.id}`)}
                onInstall={() =>
                  runAction(async () => {
                    await plugins.installBuiltin(b.id);
                    toast.push({
                      kind: 'success',
                      title: `Plugin "${b.name}" installed`,
                      body: 'Build its binary and place it in the plugin folder to start it.',
                      timeoutMs: 8000,
                    });
                  }, `install:${b.id}`)
                }
              />
            ))}
        </section>
      )}
    </div>
  );
}

/** One bundled, not-yet-installed template with its Install action. */
function BuiltinCard({
  builtin,
  pending,
  onInstall,
}: {
  builtin: BuiltinPluginInfo;
  pending: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="service-card">
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {builtin.name}
            <span className="badge badge-neutral">v{builtin.version}</span>
            <span className="badge badge-neutral">bundled</span>
          </div>
          {builtin.description && (
            <div className="service-desc" title={builtin.description}>
              {builtin.description}
            </div>
          )}
          <div className="service-meta">
            Installing writes the plugin's <code>manifest.json</code> into the
            plugins folder; build the plugin binary separately and drop it in
            the same folder.
          </div>
          {builtin.incompatible && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {builtin.incompatible}
            </div>
          )}
        </div>
        <div className="service-actions">
          <button
            onClick={onInstall}
            disabled={pending || !!builtin.incompatible}
            className="btn btn-primary"
          >
            Install {builtin.id === 'aokie' ? 'Aokie' : builtin.name} plugin
          </button>
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  plugin: PluginSnapshot;
  devMode: boolean;
  expanded: boolean;
  pending: boolean;
  onToggle: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}

function PluginCard({
  plugin,
  devMode,
  expanded,
  pending,
  onToggle,
  onStart,
  onStop,
  onRestart,
}: CardProps) {
  const loadLogs = useMemo(
    () => () => plugins.logs(plugin.id, 200),
    [plugin.id],
  );
  const active =
    plugin.state === 'running' ||
    plugin.state === 'starting' ||
    plugin.state === 'unhealthy';
  const startable =
    plugin.state === 'installed' ||
    plugin.state === 'stopped' ||
    plugin.state === 'crashed';

  return (
    <div className={`service-card service-card-${plugin.state}`}>
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {plugin.name}
            <StateBadge state={plugin.state} />
            {plugin.version && (
              <span className="badge badge-neutral">v{plugin.version}</span>
            )}
          </div>
          {plugin.description && (
            <div className="service-desc" title={plugin.description}>
              {plugin.description}
            </div>
          )}
          <div className="service-meta">
            {plugin.connectors.length > 0 && (
              <>
                connectors:{' '}
                {plugin.connectors
                  .map((c) => `${c.id} (${c.commands.length} cmd)`)
                  .join(', ')}
              </>
            )}
            {plugin.events.length > 0 && <> · {plugin.events.length} event type(s)</>}
            {plugin.pid != null && <> · pid {plugin.pid}</>}
            {plugin.startedAt && (
              <> · started {new Date(plugin.startedAt).toLocaleTimeString()}</>
            )}
            {plugin.restartAttempts > 0 && (
              <> · auto-restarted x{plugin.restartAttempts}</>
            )}
          </div>
          {plugin.lastHealth && active && (
            <div className="service-meta">
              health:{' '}
              {plugin.lastHealth.ok ? (
                <CheckIcon className="inline-icon icon-leading" size={13} />
              ) : (
                <AlertTriangleIcon className="inline-icon icon-leading" size={13} />
              )}
              {plugin.lastHealth.status}
              {plugin.lastHealth.detail ? ` — ${plugin.lastHealth.detail}` : ''}
              {' · '}
              {new Date(plugin.lastHealth.at).toLocaleTimeString()}
            </div>
          )}
          {plugin.reason && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {plugin.reason}
              {plugin.state === 'disabled' && plugin.minDesktopVersion && (
                <> (requires Desktop ≥ {plugin.minDesktopVersion})</>
              )}
            </div>
          )}
        </div>
        <div className="service-actions">
          {active ? (
            <>
              <button onClick={onStop} disabled={pending} className="btn btn-warn">
                Stop
              </button>
              <button
                onClick={onRestart}
                disabled={pending}
                className="btn btn-secondary"
              >
                Restart
              </button>
            </>
          ) : startable ? (
            <button onClick={onStart} disabled={pending} className="btn btn-primary">
              {plugin.state === 'crashed' ? 'Start again' : 'Start'}
            </button>
          ) : null}
          <button onClick={onToggle} className="btn btn-ghost">
            {expanded ? 'Hide logs' : 'Logs'}
          </button>
        </div>
      </div>
      {plugin.id === 'aokie' && (
        <AokieCard running={plugin.state === 'running'} devMode={devMode} />
      )}
      {expanded && (
        <LogsViewer
          load={loadLogs}
          title={`${plugin.name} · logs`}
          onClose={onToggle}
        />
      )}
    </div>
  );
}

/** `phone.status` response data (aokie connector). */
interface AokiePhoneStatus {
  paired: boolean;
  device?: { name?: string; address?: string } | null;
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

/**
 * Aokie-specific status card: dongle + phone readouts via connector
 * requests while the plugin runs, and the dev-mode "Simulate incoming call"
 * (the contract's scripted lifecycle — drives FormLogic integration tests
 * and demos without hardware).
 */
function AokieCard({ running, devMode }: { running: boolean; devMode: boolean }) {
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

function StateBadge({ state }: { state: PluginState }) {
  const cls =
    state === 'running'
      ? 'badge-ok'
      : state === 'crashed' || state === 'unhealthy'
        ? 'badge-err'
        : state === 'starting'
          ? 'badge-pending'
          : 'badge-neutral';
  return <span className={`badge ${cls}`}>{state}</span>;
}
