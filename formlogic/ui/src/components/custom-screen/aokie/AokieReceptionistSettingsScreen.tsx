// Receptionist Settings console (SDK screen `aokie-receptionist-settings`).
//
// A friendly, mobile-first face over the singleton Receptionist Settings
// record: grouped cards (business & greeting / personality / voice & reply
// mode / advanced AI plumbing), a single Save action, and — the part that
// makes the settings TRUSTWORTHY — a "running now" readout of the config the
// Aokie plugin is actually using (settings.get, local or via the relay) plus
// a "Save & apply now" that pushes the exact same settings.set payload the
// Configure Receptionist flow sends on every incoming call. So the answer to
// "is the bot using my settings?" is always on screen, not a matter of faith.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquareText, Mic, RefreshCw, Save, Settings2, Sparkles } from 'lucide-react';
import { useConnector, useConnectorPermission, useResponses } from '../../../sdk';
import { toast } from '../../../stores/toastStore';
import { api } from '../../../lib/api';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { performRelayCommand } from './aokieRelay';
import { useAokiePresence } from './useAokiePresence';
import { DEFAULT_PERSONA } from '../../../data/packs/aokieReceptionistPack';
import { listDesktopServices } from '../../../client-runtime/flows/desktopService';

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';
const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-800/60 dark:text-white dark:placeholder:text-slate-500';
const labelCls = 'mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300';
const hintCls = 'mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500';

/** The pack's voice options (pocket-tts voices shipped with Aokie Voice). */
const VOICES = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];

interface Draft {
  business_name: string;
  instructions: string;
  business_info: string;
  greeting: string;
  model: string;
  llm_endpoint: string;
  stt_endpoint: string;
  tts_endpoint: string;
  llm_source: string;
  stt_source: string;
  tts_source: string;
  voice: string;
  reply_mode: string;
  active: string;
}

const EMPTY_DRAFT: Draft = {
  business_name: '',
  instructions: '',
  business_info: '',
  greeting: '',
  model: '',
  llm_endpoint: '',
  stt_endpoint: '',
  tts_endpoint: '',
  llm_source: '',
  stt_source: '',
  tts_source: '',
  voice: '',
  reply_mode: 'agent',
  active: 'yes',
};

function draftFromAnswers(a: Record<string, unknown>): Draft {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  return {
    business_name: s('business_name'),
    instructions: s('instructions'),
    business_info: s('business_info'),
    greeting: s('greeting'),
    model: s('model'),
    llm_endpoint: s('llm_endpoint'),
    stt_endpoint: s('stt_endpoint'),
    tts_endpoint: s('tts_endpoint'),
    llm_source: s('llm_source'),
    stt_source: s('stt_source'),
    tts_source: s('tts_source'),
    voice: s('voice'),
    reply_mode: s('reply_mode') || 'agent',
    active: s('active') || 'yes',
  };
}

/** The lane shape buildAgentPayload resolves `service:<id>` picks against —
 *  the flow node's listing (id + loopback url while running). */
export interface SourceService {
  id: string;
  name: string;
  category: string;
  status: string;
  url: string;
}

/**
 * Resolve one lane's endpoint — the SAME rule as the pack flow's laneUrl
 * (FLOW_AGENT_CONFIG): 'service:<id>' → the running service's URL + the
 * lane's conventional path ('' while stopped — the plugin falls back to its
 * default); blank/'custom' → the legacy custom-endpoint field. `undefined`
 * services (no Desktop list available, e.g. a remote console) → undefined:
 * the caller OMITS the key and lets the per-call flow (which can resolve)
 * own it.
 */
function laneUrl(
  source: string,
  custom: string,
  path: string,
  services: SourceService[] | undefined,
): string | undefined {
  const src = source.trim();
  const url = custom.trim();
  if (!src || src === 'custom') return url;
  if (src.startsWith('service:')) {
    if (!services) return undefined;
    const sid = src.slice(8);
    const svc = services.find((x) => x.id === sid && x.url);
    return svc ? svc.url + path : '';
  }
  return url;
}

/**
 * The settings.set payload for a draft — the SAME composition rule as the
 * pack's Configure Receptionist flow (FLOW_AGENT_CONFIG), so "apply now" and
 * the per-call flow can never disagree about what the bot should run.
 */
// Kept exported for the contract test that pins the UI and pack-flow payloads together.
// eslint-disable-next-line react-refresh/only-export-components
export function buildAgentPayload(d: Draft, services?: SourceService[]): Record<string, unknown> {
  let persona = d.instructions.trim() || DEFAULT_PERSONA;
  const business = d.business_name.trim();
  if (business) persona = `You are the phone receptionist for ${business}.\n` + persona;
  // BUSINESS INFO grounding — SAME composition as the pack flows
  // (BUSINESS_INFO_BLOCK_JS in aokieReceptionistPack.ts); keep in lock-step.
  const info = d.business_info.trim().slice(0, 4000);
  if (info) {
    persona +=
      '\n\nBUSINESS INFO - the ONLY facts about the business you may share:\n' + info +
      '\nAnswer questions about services, menu, prices, opening hours or policies ONLY from this info, quoting details exactly. If something is not covered here, say you will have the team confirm it - NEVER invent business details.';
  }
  let greeting = d.greeting.trim();
  if (!greeting) {
    greeting = business
      ? `Thank you for calling ${business}! How can I help you today?`
      : 'Thanks for calling! How can I help you today?';
  }
  const payload: Record<string, unknown> = {
    persona,
    greeting,
    ttsVoice: d.voice.trim(),
    aiModel: d.model.trim(),
    aiEndpoint: laneUrl(d.llm_source, d.llm_endpoint, '/v1/chat/completions', services),
    sttEndpoint: laneUrl(d.stt_source, d.stt_endpoint, '/v1/audio/transcriptions', services),
    ttsEndpoint: laneUrl(d.tts_source, d.tts_endpoint, '/v1/audio/speech', services),
    aiReceptionist: d.reply_mode !== 'flow',
  };
  // An unresolvable service pick (no Desktop list here — remote console)
  // omits its key: the per-call Configure flow resolves it on the desktop.
  for (const k of ['aiEndpoint', 'sttEndpoint', 'ttsEndpoint']) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}

interface RunningConfig {
  greeting?: string;
  persona?: string;
  voice?: string;
  model?: string;
  aiReceptionist?: boolean;
  configVersion?: number;
}

/**
 * One lane's source picker (CON-303): Automatic / a FormLogic Desktop service
 * (resolved to its live URL per call) / Custom URL. A saved `service:` pick
 * that isn't in the current listing (desktop away, service removed) stays
 * selectable so the record never silently changes just by opening the page.
 */
function SourceLane({
  label,
  idPrefix,
  source,
  endpoint,
  services,
  listed,
  placeholder,
  onSource,
  onEndpoint,
}: {
  label: string;
  idPrefix: string;
  source: string;
  endpoint: string;
  services: SourceService[];
  listed: boolean;
  placeholder: string;
  onSource: (v: string) => void;
  onEndpoint: (v: string) => void;
}) {
  const savedServiceId = source.startsWith('service:') ? source.slice(8) : null;
  const savedMissing = savedServiceId !== null && !services.some((s) => s.id === savedServiceId);
  const showUrl = source === 'custom' || (source === '' && endpoint.trim() !== '');
  return (
    <div>
      <label className={labelCls} htmlFor={idPrefix + '-source'}>{label}</label>
      <select
        id={idPrefix + '-source'}
        value={source}
        onChange={(e) => onSource(e.target.value)}
        className={inputCls + ' cursor-pointer'}
      >
        <option value="">Automatic (plugin default{endpoint.trim() ? ' — custom URL below wins' : ''})</option>
        {services.map((s) => (
          <option key={s.id} value={`service:${s.id}`}>
            This computer: {s.name}
            {s.status === 'running' ? '' : ` (${s.status})`}
          </option>
        ))}
        {savedMissing && (
          <option value={source}>
            Desktop service: {savedServiceId}
            {listed ? ' (not found)' : ' (saved)'}
          </option>
        )}
        <option value="custom">Custom URL…</option>
      </select>
      {savedMissing && listed && (
        <p className={hintCls}>
          This service isn't on the connected desktop — calls fall back to the plugin default until it exists again.
        </p>
      )}
      {showUrl && (
        <input
          id={idPrefix}
          type="text"
          value={endpoint}
          onChange={(e) => onEndpoint(e.target.value)}
          placeholder={placeholder}
          className={inputCls + ' mt-2 font-mono text-xs'}
        />
      )}
    </div>
  );
}

export function AokieReceptionistSettingsScreen({ params }: { params?: Record<string, unknown> }) {
  const formId = typeof params?.formId === 'string' ? params.formId : undefined;
  const connector = useConnector('aokie', formId ? { formId } : undefined);
  const { can } = useConnectorPermission('aokie', undefined, formId ? { formId } : undefined);
  const presence = useAokiePresence();
  const appSlug = useAppRuntimeStore((s) => s.appSlug);
  const createResponse = useAppRuntimeStore((s) => s.createResponse);
  const updateResponse = useAppRuntimeStore((s) => s.updateResponse);
  const canSubmit = useAppRuntimeStore((s) => s.canSubmit);
  const canEdit = useAppRuntimeStore((s) => s.canEdit);
  const records = useResponses(formId ?? '', { limit: 5 });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [running, setRunning] = useState<RunningConfig | null>(null);
  const [runningError, setRunningError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remoteMode = presence.kind === 'remote';

  // Route a plugin command locally (connector.request) or via the relay when
  // the receptionist runs on another machine — same pattern as Device Setup.
  const runCommand = useCallback(
    async (command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (remoteMode) {
        if (!appSlug) throw new Error('No app context for the remote command');
        const outcome = await performRelayCommand(api, appSlug, command, undefined, payload);
        if (outcome.status !== 'done') {
          const msg = typeof outcome.error?.message === 'string' ? outcome.error.message : outcome.status;
          throw new Error(`The desktop did not complete the command (${msg})`);
        }
        return (outcome.result && typeof outcome.result === 'object' ? outcome.result : {}) as Record<string, unknown>;
      }
      const res = await connector.request(command, payload);
      return (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
    },
    [remoteMode, appSlug, connector]
  );

  // Hydrate the draft from the newest record ONCE per load (never clobber
  // in-progress edits — Discard rehydrates explicitly).
  useEffect(() => {
    if (draft !== null || records.loading) return;
    const newest = records.rows[0];
    setDraft(newest ? draftFromAnswers(newest.answers) : { ...EMPTY_DRAFT });
    setRecordId(newest ? newest.id : null);
  }, [records.loading, records.rows, draft]);

  const saved = useMemo(() => {
    const newest = records.rows[0];
    return newest ? draftFromAnswers(newest.answers) : { ...EMPTY_DRAFT };
  }, [records.rows]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const refreshRunning = useCallback(async () => {
    if (!can('settings.get')) return;
    setRunningError(null);
    try {
      const res = await runCommand('settings.get');
      const settings = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
      // Seed the call-screening card once from the live plugin settings
      // (these are PLUGIN settings, not part of the persona record).
      setAudioCfg((prev) =>
        prev.loaded
          ? prev
          : {
              loaded: true,
              sendAudio: settings.sendAudio === true || settings.sendAudio === 'true',
              audioTranscript: settings.audioTranscript === true || settings.audioTranscript === 'true',
              transcriptEndpoint:
                typeof settings.audioTranscriptEndpoint === 'string' ? settings.audioTranscriptEndpoint : '',
              transcriptModel:
                typeof settings.audioTranscriptModel === 'string' ? settings.audioTranscriptModel : '',
            }
      );
      setWaitingCfg((prev) =>
        prev.loaded
          ? prev
          : {
              loaded: true,
              holdAndCallWaiting:
                settings.holdAndCallWaiting === true || settings.holdAndCallWaiting === 'true',
              autoHoldQueue: settings.autoHoldQueue === true || settings.autoHoldQueue === 'true',
              // Defaults ON — absent means enabled.
              autoConnectPhone:
                settings.autoConnectPhone !== false && settings.autoConnectPhone !== 'false',
            }
      );
      setScreening((prev) =>
        prev.loaded
          ? prev
          : {
              ...prev,
              loaded: true,
              blockedNumbers: typeof settings.blockedNumbers === 'string' ? settings.blockedNumbers : '',
              acceptPattern: typeof settings.acceptPattern === 'string' ? settings.acceptPattern : '',
              rejectPrivate: settings.rejectPrivate === true || settings.rejectPrivate === 'true',
              screenMessage: typeof settings.screenMessage === 'string' ? settings.screenMessage : '',
              blockedMessage: typeof settings.blockedMessage === 'string' ? settings.blockedMessage : '',
              autoBlockAbuse: !(settings.autoBlockAbuse === false || settings.autoBlockAbuse === 'false'),
              managerNumbers: typeof settings.managerNumbers === 'string' ? settings.managerNumbers : '',
              // AOK-304A: the PIN is never returned; only whether one is set.
              managerPin: '',
              managerPinSet: res.managerPinSet === true,
            }
      );
      setEngineCfg((prev) =>
        prev.loaded
          ? prev
          : {
              loaded: true,
              engine: typeof settings.ttsEngine === 'string' ? settings.ttsEngine : '',
              modelDir: typeof settings.ttsModelDir === 'string' ? settings.ttsModelDir : '',
            }
      );
      setRunning({
        greeting: typeof settings.greeting === 'string' ? settings.greeting : undefined,
        persona: typeof settings.persona === 'string' ? settings.persona : undefined,
        voice: typeof settings.ttsVoice === 'string' ? settings.ttsVoice : undefined,
        model: typeof settings.aiModel === 'string' ? settings.aiModel : undefined,
        aiReceptionist: settings.aiReceptionist === true,
        configVersion: typeof res.configVersion === 'number' ? res.configVersion : undefined,
      });
    } catch (err) {
      setRunning(null);
      setRunningError(err instanceof Error ? err.message : String(err));
    }
  }, [can, runCommand]);

  useEffect(() => {
    void refreshRunning();
  }, [refreshRunning]);

  const persistDraft = useCallback(async (): Promise<boolean> => {
    if (!formId || !draft) return false;
    const answers: Record<string, unknown> = { ...draft };
    try {
      if (recordId) {
        await updateResponse(formId, recordId, { answers });
      } else {
        const created = (await createResponse(formId, answers)) as { id?: string } | undefined;
        if (created && typeof created.id === 'string') setRecordId(created.id);
      }
      records.reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [formId, draft, recordId, updateResponse, createResponse, records]);

  // ── Desktop services for the source pickers ──
  // The same listing the per-call flow's `desktop_services` node reads, so the
  // picker and the flow resolve identically. null = no local Desktop listing
  // here (remote console / demo / unpaired): pickers still save source ids —
  // resolution then happens per call on the desktop runner.
  const [sources, setSources] = useState<SourceService[] | null>(null);
  useEffect(() => {
    let alive = true;
    listDesktopServices()
      .then((list) => {
        if (alive) setSources(list.length > 0 ? list : null);
      })
      .catch(() => {
        /* unavailable — pickers fall back to saved ids */
      });
    return () => {
      alive = false;
    };
  }, []);
  const laneServices = useCallback(
    (want: 'chat' | 'speech') =>
      (sources ?? []).filter((s) => {
        const c = s.category.toLowerCase();
        return want === 'chat' ? c.includes('llm') : c.includes('speech') || c.includes('voice');
      }),
    [sources],
  );

  // ── Speech engine (plugin settings — which in-process TTS speaks) ──
  // ttsEngine: '' / 'pocket' = Pocket-TTS; 'sherpa' = sherpa-onnx running a
  // Piper/VITS (or Kokoro) voice bundle from ttsModelDir. Applies LIVE (the
  // plugin reloads its synth engine on save).
  const [engineCfg, setEngineCfg] = useState({ loaded: false, engine: '', modelDir: '' });
  const [savingEngine, setSavingEngine] = useState(false);
  const handleSaveEngine = useCallback(async () => {
    setSavingEngine(true);
    try {
      await runCommand('settings.set', {
        ttsEngine: engineCfg.engine,
        ttsModelDir: engineCfg.modelDir.trim(),
      });
      toast.success('Speech engine updated', 'Applies immediately — the next reply uses it.');
    } catch (err) {
      toast.error('Could not save the speech engine', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEngine(false);
    }
  }, [engineCfg, runCommand]);

  // ── Audio understanding (plugin settings — audio-capable models only) ──
  // sendAudio ships the caller-turn audio to the LLM alongside the STT text;
  // audioTranscript additionally has the model CORRECT each turn's transcript
  // from that audio (a small detached request — replies never wait on it).
  // Both read once at radio start, so saves apply at the next reconnect.
  const [audioCfg, setAudioCfg] = useState({
    loaded: false,
    sendAudio: false,
    audioTranscript: false,
    // Correction-lane overrides: an optional separate endpoint and/or lighter
    // audio model for the transcript corrections (blank = the main model).
    transcriptEndpoint: '',
    transcriptModel: '',
  });
  const [audioSaving, setAudioSaving] = useState(false);
  const handleSaveAudio = useCallback(async () => {
    setAudioSaving(true);
    setError(null);
    try {
      await runCommand('settings.set', {
        sendAudio: audioCfg.sendAudio,
        audioTranscript: audioCfg.audioTranscript,
        audioTranscriptEndpoint: audioCfg.transcriptEndpoint.trim(),
        audioTranscriptModel: audioCfg.transcriptModel.trim(),
      });
      try {
        const res = await runCommand('settings.get');
        const s = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
        setAudioCfg((prev) => ({
          ...prev,
          sendAudio: s.sendAudio === true || s.sendAudio === 'true',
          audioTranscript: s.audioTranscript === true || s.audioTranscript === 'true',
          transcriptEndpoint: typeof s.audioTranscriptEndpoint === 'string' ? s.audioTranscriptEndpoint : '',
          transcriptModel: typeof s.audioTranscriptModel === 'string' ? s.audioTranscriptModel : '',
        }));
      } catch {
        // Read-back is confirmation only — the save above already succeeded.
      }
      toast.success('Audio settings saved', 'Applies when the receptionist next reconnects.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAudioSaving(false);
    }
  }, [runCommand, audioCfg]);

  // ── Call waiting & hold queue (plugin settings) ──
  // holdAndCallWaiting negotiates the phone capability (a second caller
  // becomes a visible "waiting" episode instead of disturbing the call);
  // autoHoldQueue additionally answers them with a spoken "please hold,
  // you're next in the queue", parks them, and returns to the first caller
  // (FIFO as calls end). Both read at radio start → apply at next reconnect.
  const [waitingCfg, setWaitingCfg] = useState({
    loaded: false,
    holdAndCallWaiting: false,
    autoHoldQueue: false,
    // Auto-connect the last phone when the receptionist starts. Default ON.
    autoConnectPhone: true,
  });
  const [waitingSaving, setWaitingSaving] = useState(false);
  const handleSaveWaiting = useCallback(async () => {
    setWaitingSaving(true);
    setError(null);
    try {
      await runCommand('settings.set', {
        holdAndCallWaiting: waitingCfg.holdAndCallWaiting,
        autoHoldQueue: waitingCfg.autoHoldQueue,
        autoConnectPhone: waitingCfg.autoConnectPhone,
      });
      try {
        const res = await runCommand('settings.get');
        const s = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
        setWaitingCfg((prev) => ({
          ...prev,
          holdAndCallWaiting: s.holdAndCallWaiting === true || s.holdAndCallWaiting === 'true',
          autoHoldQueue: s.autoHoldQueue === true || s.autoHoldQueue === 'true',
          autoConnectPhone: s.autoConnectPhone !== false && s.autoConnectPhone !== 'false',
        }));
      } catch {
        // Read-back is confirmation only — the save above already succeeded.
      }
      toast.success('Call waiting saved', 'Applies when the receptionist next reconnects.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWaitingSaving(false);
    }
  }, [runCommand, waitingCfg]);

  // ── Call screening (plugin settings — block list / filters / private) ──
  // whitelistOnly + defaultCountryCode are RECORD fields (Phase 0.5: the
  // personalize-caller / SMS flows read them per call), seeded from the
  // singleton record and saved by the same Save-screening button so every
  // screening control lives behind one save.
  const [screening, setScreening] = useState({
    loaded: false,
    recordLoaded: false,
    blockedNumbers: '',
    acceptPattern: '',
    rejectPrivate: false,
    screenMessage: '',
    blockedMessage: '',
    // Phase 1: default ON — the plugin auto-blocks a caller the AI flags as
    // abusive; unblocking is one click on the chips above.
    autoBlockAbuse: true,
    // Phase 3 manager line: callers from these numbers get the MANAGER
    // persona + name-inclusive lookups; with a PIN set they can also make
    // booking changes by voice (spoken PIN checked in the plugin).
    managerNumbers: '',
    // AOK-304A: the PIN is WRITE-ONLY — the plugin never returns it. `managerPin`
    // is only the NEW PIN being entered (blank = leave the stored one unchanged);
    // `managerPinSet` reflects whether one is stored (from settings.managerPinSet).
    managerPin: '',
    managerPinSet: false,
    whitelistOnly: false,
    defaultCountryCode: '',
  });
  useEffect(() => {
    if (records.loading) return;
    setScreening((prev) => {
      if (prev.recordLoaded) return prev;
      const a = (records.rows[0]?.answers ?? {}) as Record<string, unknown>;
      return {
        ...prev,
        recordLoaded: true,
        whitelistOnly: String(a.whitelist_only ?? '') === 'yes',
        defaultCountryCode: typeof a.default_country_code === 'string' ? a.default_country_code : '',
      };
    });
  }, [records.loading, records.rows]);
  // The block list rendered as removable chips: deleting a number is one
  // click (live report 2026-07-14: editing the raw textarea didn't FEEL like
  // it removed anything — the state was saved but nothing confirmed it).
  const blockedEntries = useMemo(
    () => screening.blockedNumbers.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
    [screening.blockedNumbers]
  );
  const removeBlockedNumber = useCallback((entry: string) => {
    setScreening((sc) => ({
      ...sc,
      blockedNumbers: sc.blockedNumbers
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== entry)
        .join('\n'),
    }));
  }, []);
  const [screeningSaving, setScreeningSaving] = useState(false);
  const handleSaveScreening = useCallback(async () => {
    setScreeningSaving(true);
    setError(null);
    try {
      // AOK-304A: managerPin is write-only. Send it ONLY when the operator typed
      // a new one — a blank field means "leave the stored PIN unchanged", NOT
      // clear it (the old plaintext round-trip is gone, so an always-included
      // blank would silently wipe a set PIN). Removing a PIN has its own button.
      const newPin = screening.managerPin.trim();
      const payload: Record<string, unknown> = {
        blockedNumbers: screening.blockedNumbers.trim(),
        acceptPattern: screening.acceptPattern.trim(),
        rejectPrivate: screening.rejectPrivate,
        screenMessage: screening.screenMessage.trim(),
        blockedMessage: screening.blockedMessage.trim(),
        autoBlockAbuse: screening.autoBlockAbuse,
        managerNumbers: screening.managerNumbers.trim(),
      };
      if (newPin) payload.managerPin = newPin;
      await runCommand('settings.set', payload);
      // Whitelist mode + country code live on the settings RECORD (the flows
      // read them per call). Patch just these two keys — the API merges, so
      // the persona draft in the cards above is never touched.
      if (formId) {
        const answers = {
          whitelist_only: screening.whitelistOnly ? 'yes' : 'no',
          default_country_code: screening.defaultCountryCode.trim(),
        };
        if (recordId) {
          await updateResponse(formId, recordId, { answers });
        } else {
          const created = (await createResponse(formId, answers)) as { id?: string } | undefined;
          if (created && typeof created.id === 'string') setRecordId(created.id);
        }
        records.reload();
      }
      // Read the plugin settings BACK so the card shows the authoritative
      // saved state — a removed number visibly stays gone.
      try {
        const res = await runCommand('settings.get');
        const s = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
        setScreening((prev) => ({
          ...prev,
          blockedNumbers: typeof s.blockedNumbers === 'string' ? s.blockedNumbers : prev.blockedNumbers,
          acceptPattern: typeof s.acceptPattern === 'string' ? s.acceptPattern : prev.acceptPattern,
          rejectPrivate: s.rejectPrivate === true || s.rejectPrivate === 'true',
          screenMessage: typeof s.screenMessage === 'string' ? s.screenMessage : prev.screenMessage,
          blockedMessage: typeof s.blockedMessage === 'string' ? s.blockedMessage : prev.blockedMessage,
          autoBlockAbuse: !(s.autoBlockAbuse === false || s.autoBlockAbuse === 'false'),
          managerNumbers: typeof s.managerNumbers === 'string' ? s.managerNumbers : prev.managerNumbers,
          // AOK-304A: the PIN is never read back — clear the entry field and
          // reflect only whether one is now stored.
          managerPin: '',
          managerPinSet: res.managerPinSet === true,
        }));
      } catch {
        // Read-back is confirmation only — the save above already succeeded.
      }
      toast.success('Call screening saved', 'Applies on the next incoming call.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScreeningSaving(false);
    }
  }, [runCommand, screening, formId, recordId, updateResponse, createResponse, records]);

  // AOK-304A: removing the PIN is a distinct action (blank-on-save now means
  // "keep"). Pushes an empty managerPin, which the plugin treats as a
  // read-only manager line.
  const handleRemoveManagerPin = useCallback(async () => {
    setScreeningSaving(true);
    setError(null);
    try {
      await runCommand('settings.set', { managerPin: '' });
      setScreening((prev) => ({ ...prev, managerPin: '', managerPinSet: false }));
      toast.success('Manager PIN removed', 'The manager line is read-only until a new PIN is set.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScreeningSaving(false);
    }
  }, [runCommand, toast]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    const ok = await persistDraft();
    setSaving(false);
    if (ok) {
      toast.success('Settings saved', 'Applied automatically at the next incoming call.');
    }
  }, [persistDraft]);

  const handleSaveAndApply = useCallback(async () => {
    if (!draft) return;
    setApplying(true);
    setError(null);
    try {
      const ok = await persistDraft();
      if (!ok) return;
      if (draft.active === 'no') {
        toast.info('Saved (marked inactive)', 'This record is inactive, so it was not pushed to the receptionist.');
        return;
      }
      await runCommand('settings.set', buildAgentPayload(draft, sources ?? undefined));
      await refreshRunning();
      toast.success('Applied to the receptionist', 'The very next call uses this configuration.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [draft, sources, persistDraft, runCommand, refreshRunning]);

  if (!formId) {
    return <p className="text-sm text-gray-400 dark:text-slate-500">This screen expects to be attached to the Receptionist Settings form.</p>;
  }
  if (draft === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-gray-400 dark:text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  const mayWrite = recordId ? canEdit(formId) : canSubmit(formId);
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const preview = buildAgentPayload(draft);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* ── Running-now strip: the proof the bot uses these settings ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">What the receptionist is running now</h2>
          <button
            type="button"
            onClick={() => void refreshRunning()}
            title="Re-read the live configuration from the Aokie plugin"
            className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {running ? (
          <div className="space-y-1 text-sm">
            <p className="text-gray-900 dark:text-white">
              <span className="text-gray-400 dark:text-slate-500">Greeting: </span>“{running.greeting || '—'}”
            </p>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Voice {running.voice || 'default'} · model {running.model || 'auto'} ·{' '}
              {running.aiReceptionist ? 'built-in AI agent replies' : 'flow-driven replies'}
              {typeof running.configVersion === 'number' ? ` · config v${running.configVersion}` : ''}
            </p>
            {running.persona && (
              <p className="line-clamp-2 text-[11px] text-gray-400 dark:text-slate-500" title={running.persona}>
                {running.persona}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            {runningError
              ? `Live configuration unavailable — ${runningError}`
              : can('settings.get')
                ? 'Reading the live configuration…'
                : 'Your role cannot read the live configuration.'}
          </p>
        )}
        <p className={hintCls}>
          The Configure Receptionist flow re-applies the saved settings on every incoming call, so saving is enough — “Save
          &amp; apply now” just updates the live line immediately instead of at the next ring.
        </p>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ── Business & greeting ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Business &amp; greeting</h2>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className={labelCls} htmlFor="rs-business">Business name</label>
            <input
              id="rs-business"
              type="text"
              value={draft.business_name}
              onChange={(e) => set({ business_name: e.target.value })}
              placeholder="e.g. Bright Smile Dental"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-greeting">Greeting (spoken first)</label>
            <input
              id="rs-greeting"
              type="text"
              value={draft.greeting}
              onChange={(e) => set({ greeting: e.target.value })}
              placeholder={preview.greeting as string}
              className={inputCls}
            />
            <p className={hintCls}>Blank uses the friendly default shown above. Known callers are greeted by name automatically.</p>
          </div>
        </div>
      </div>

      {/* ── Personality ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">How should it talk &amp; behave?</h2>
        </div>
        <textarea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={6}
          placeholder="e.g. Be warm and concise. Offer to book appointments Mon–Fri 9–5. If asked about prices, give the standard checkup price of $90 and offer to book."
          className={inputCls + ' resize-y'}
        />
        <p className={hintCls}>Blank uses Aokie's built-in receptionist persona. Plain English works — treat it like briefing a new hire.</p>
        <div className="mt-4">
          <h3 className="mb-1.5 text-sm font-medium text-gray-900 dark:text-white">Business info the AI may share</h3>
          <textarea
            value={draft.business_info}
            onChange={(e) => set({ business_info: e.target.value })}
            rows={6}
            placeholder="Menu, services, prices, opening hours, parking, policies, FAQ… The AI answers business questions ONLY from this text and never invents details."
            className={inputCls + ' resize-y'}
          />
          <p className={hintCls}>
            The only facts it will state about the business. Anything not covered here, it offers to have the team confirm — so an empty box means no invented menus or prices.
          </p>
        </div>
      </div>

      {/* ── Voice & replies ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Mic className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Voice &amp; replies</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="rs-voice">Voice</label>
            <select id="rs-voice" value={draft.voice} onChange={(e) => set({ voice: e.target.value })} className={inputCls + ' cursor-pointer'}>
              {VOICES.map((v) => (
                <option key={v || 'default'} value={v}>{v === '' ? 'Default' : v.charAt(0).toUpperCase() + v.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rs-active">Active</label>
            <select id="rs-active" value={draft.active} onChange={(e) => set({ active: e.target.value })} className={inputCls + ' cursor-pointer'}>
              <option value="yes">Yes — use these settings</option>
              <option value="no">No — fall back to defaults</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rs-replymode">Who answers the caller</label>
            <select id="rs-replymode" value={draft.reply_mode} onChange={(e) => set({ reply_mode: e.target.value })} className={inputCls + ' cursor-pointer'}>
              <option value="agent">Built-in AI agent (recommended — fast, on-device)</option>
              <option value="flow">Custom flow (edit the Live Reply flow yourself)</option>
            </select>
            <p className={hintCls}>
              Unlike everything else here, reply mode only takes effect the next time Aokie reconnects — the plugin reads it
              once at startup, not per call.
            </p>
          </div>
        </div>
        {/* ── Speech engine (plugin setting, not part of the persona record) ── */}
        {can('settings.set') && (
          <div className="mt-4 border-t border-gray-100 pt-4 dark:border-slate-800">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">
              Speech engine
            </h3>
            <p className={hintCls}>
              Which on-device engine speaks. Sherpa (Piper voices) synthesises many times faster than
              Pocket-TTS; the Voice picker above applies to Pocket-TTS only — Sherpa voices come from the
              voice-model folder. Saving applies immediately.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="rs-ttsengine">Engine</label>
                <select
                  id="rs-ttsengine"
                  value={engineCfg.engine}
                  onChange={(e) => setEngineCfg((p) => ({ ...p, engine: e.target.value }))}
                  className={inputCls + ' cursor-pointer'}
                >
                  <option value="">Pocket-TTS (default)</option>
                  <option value="sherpa">Sherpa — Piper/VITS voices (fast)</option>
                </select>
              </div>
              {engineCfg.engine === 'sherpa' && (
                <div>
                  <label className={labelCls} htmlFor="rs-ttsmodeldir">Voice model folder (blank = auto)</label>
                  <input
                    id="rs-ttsmodeldir"
                    value={engineCfg.modelDir}
                    onChange={(e) => setEngineCfg((p) => ({ ...p, modelDir: e.target.value }))}
                    className={inputCls}
                    placeholder="blank = first voice under models\tts"
                  />
                  <p className={hintCls}>
                    A sherpa voice bundle folder on the desktop machine (the voice's .onnx + tokens.txt,
                    e.g. vits-piper-en_US-lessac-medium).
                  </p>
                </div>
              )}
            </div>
            <div className="mt-2">
              <button
                type="button"
                onClick={handleSaveEngine}
                disabled={savingEngine || !engineCfg.loaded}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
              >
                {savingEngine ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save speech engine
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Audio understanding (plugin-level; needs an audio-capable model) ── */}
      {can('settings.set') && (
        <div className={`${card} p-4 sm:p-5`}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Audio understanding</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            For audio-capable AI models (like Gemma with audio input). Both apply the next time the
            receptionist reconnects.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={audioCfg.sendAudio}
                onChange={(e) => setAudioCfg((a) => ({ ...a, sendAudio: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              <span>
                Send caller audio to the AI model
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  Each caller turn's audio rides along with the transcript, so the model hears tone and
                  wording directly. Text-only models ignore it — leave off unless your model supports audio.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={audioCfg.audioTranscript}
                disabled={!audioCfg.sendAudio}
                onChange={(e) => setAudioCfg((a) => ({ ...a, audioTranscript: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600"
              />
              <span className={audioCfg.sendAudio ? '' : 'opacity-50'}>
                Audio-corrected transcripts
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  After each caller turn, the audio model quietly corrects the speech-to-text transcript from
                  the actual audio — replies never wait on it, and the raw recognizer text is kept alongside.
                  Needs "Send caller audio" on.
                </span>
              </span>
            </label>
            {audioCfg.audioTranscript && audioCfg.sendAudio && (
              <div className="grid grid-cols-1 gap-3 rounded-xl border border-gray-200 p-3 dark:border-slate-700 sm:grid-cols-2">
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300">
                  Correction endpoint (optional)
                  <input
                    type="text"
                    value={audioCfg.transcriptEndpoint}
                    onChange={(e) => setAudioCfg((a) => ({ ...a, transcriptEndpoint: e.target.value }))}
                    placeholder="blank = same server as replies"
                    spellCheck={false}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800"
                  />
                  <span className="mt-1 block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                    A separate OpenAI-compatible /v1/chat/completions URL just for corrections, so they never
                    compete with live replies.
                  </span>
                </label>
                <label className="block text-xs font-medium text-gray-700 dark:text-slate-300">
                  Correction model (optional)
                  <input
                    type="text"
                    value={audioCfg.transcriptModel}
                    onChange={(e) => setAudioCfg((a) => ({ ...a, transcriptModel: e.target.value }))}
                    placeholder="blank = same model as replies"
                    spellCheck={false}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800"
                  />
                  <span className="mt-1 block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                    A lighter audio-capable model for quicker corrections (must be served by the endpoint
                    above, or the main server if blank).
                  </span>
                </label>
              </div>
            )}
            <div>
              <button
                type="button"
                onClick={() => void handleSaveAudio()}
                disabled={audioSaving || !audioCfg.loaded}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                {audioSaving ? 'Saving…' : 'Save audio settings'}
              </button>
              {!audioCfg.loaded && (
                <span className="ml-2 text-[11px] text-gray-400 dark:text-slate-500">Loading current values…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Phone connection & call waiting (plugin-level) ── */}
      {can('settings.set') && (
        <div className={`${card} p-4 sm:p-5`}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Phone connection &amp; call waiting</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            How the receptionist links to the phone and handles a second caller. All apply the next
            time the receptionist reconnects; call waiting needs a phone plan that supports it.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={waitingCfg.autoConnectPhone}
                onChange={(e) => setWaitingCfg((c) => ({ ...c, autoConnectPhone: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              <span>
                Connect the phone automatically on startup
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  When the receptionist starts, it pages the last connected phone itself, so the
                  line comes up without pressing Reconnect. If the phone is busy reconnecting it
                  retries a few times, then leaves Reconnect for you.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={waitingCfg.holdAndCallWaiting}
                onChange={(e) =>
                  setWaitingCfg((c) => ({
                    ...c,
                    holdAndCallWaiting: e.target.checked,
                    autoHoldQueue: e.target.checked ? c.autoHoldQueue : false,
                  }))
                }
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              <span>
                Detect a second caller (call waiting)
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  A second caller ringing mid-call is noticed and recorded (flows can send them a
                  we-missed-you text) without disturbing the live conversation. On its own it never
                  answers them — they hear normal ringing until they give up.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={waitingCfg.autoHoldQueue}
                disabled={!waitingCfg.holdAndCallWaiting}
                onChange={(e) => setWaitingCfg((c) => ({ ...c, autoHoldQueue: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600"
              />
              <span className={waitingCfg.holdAndCallWaiting ? '' : 'opacity-50'}>
                Automatically hold &amp; queue callers
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  The receptionist tells the current caller another call came in, answers the new
                  caller with "please hold — you're next in the queue", puts them on hold, and
                  returns to the first caller. Held callers are picked up in order as calls end.
                  Needs "Detect a second caller" on. The phone can hold one caller at a time — a
                  third caller keeps ringing until a spot frees up.
                </span>
              </span>
            </label>
            <div>
              <button
                type="button"
                onClick={() => void handleSaveWaiting()}
                disabled={waitingSaving || !waitingCfg.loaded}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                {waitingSaving ? 'Saving…' : 'Save call waiting'}
              </button>
              {!waitingCfg.loaded && (
                <span className="ml-2 text-[11px] text-gray-400 dark:text-slate-500">Loading current values…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Call screening (plugin-level: block list, filters, private numbers) ── */}
      {can('settings.set') && (
        <div className={`${card} p-4 sm:p-5`}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Call screening</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            Who gets through to the receptionist. Screened callers hear a short message (or nothing) and the call
            ends — no greeting, no AI. Changes apply on the next incoming call.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div>
              <label className={labelCls} htmlFor="rs-blocked">Blocked numbers</label>
              <textarea
                id="rs-blocked"
                value={screening.blockedNumbers}
                onChange={(e) => setScreening((sc) => ({ ...sc, blockedNumbers: e.target.value }))}
                placeholder={'One per line (or comma-separated)\n+61 400 111 222\n0491570156'}
                rows={3}
                className={inputCls + ' font-mono text-xs'}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Any format — numbers match on their digits, so +61 and 0-prefixed forms are the same number.
              </p>
              {blockedEntries.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {blockedEntries.map((entry) => (
                    <span
                      key={entry}
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 font-mono text-[11px] text-gray-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {entry}
                      <button
                        type="button"
                        onClick={() => removeBlockedNumber(entry)}
                        aria-label={`Unblock ${entry}`}
                        title="Remove from the block list (then Save screening)"
                        className="cursor-pointer rounded-full px-0.5 text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-blockedmsg">Message for blocked numbers</label>
              <input
                id="rs-blockedmsg"
                type="text"
                value={screening.blockedMessage}
                onChange={(e) => setScreening((sc) => ({ ...sc, blockedMessage: e.target.value }))}
                placeholder="Blank = reject silently (just hang up). Or e.g. This number has been blocked."
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Only for the blocked list above — kept separate from the filtered/private message below.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-accept">Accept filter (regular expression)</label>
              <input
                id="rs-accept"
                type="text"
                value={screening.acceptPattern}
                onChange={(e) => setScreening((sc) => ({ ...sc, acceptPattern: e.target.value }))}
                placeholder={'e.g. ^(\\+?61|0)4  — Australian mobiles only. Blank = accept all.'}
                className={inputCls + ' font-mono text-xs'}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Caller IDs that don't match are screened out. An invalid pattern is ignored (never blocks everyone).
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={screening.rejectPrivate}
                onChange={(e) => setScreening((sc) => ({ ...sc, rejectPrivate: e.target.checked }))}
                className="h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              Screen private / withheld numbers
            </label>
            <div>
              <label className={labelCls} htmlFor="rs-screenmsg">Message for filtered / private callers</label>
              <input
                id="rs-screenmsg"
                type="text"
                value={screening.screenMessage}
                onChange={(e) => setScreening((sc) => ({ ...sc, screenMessage: e.target.value }))}
                placeholder="e.g. Please call back with caller ID enabled. (blank = hang up silently)"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                For callers screened by the accept filter or the private-number setting — not the block list.
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={screening.autoBlockAbuse}
                onChange={(e) => setScreening((sc) => ({ ...sc, autoBlockAbuse: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              <span>
                Auto-block abusive callers
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  When the AI flags genuine abuse (slurs, threats, harassment) it speaks a short notice, ends
                  the call, and adds the number to the blocked list above — remove it there to unblock. The
                  notice and hangup happen even with this off; only the blocking is optional.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={screening.whitelistOnly}
                onChange={(e) => setScreening((sc) => ({ ...sc, whitelistOnly: e.target.checked }))}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-slate-600"
              />
              <span>
                Whitelist mode — known customers only
                <span className="block text-[11px] font-normal text-gray-400 dark:text-slate-500">
                  Callers with no Customer record are rejected once their number is known; customers marked
                  Blocked are always rejected. Withheld numbers aren't covered — use the private-number
                  setting above for those.
                </span>
              </span>
            </label>
            <div>
              <label className={labelCls} htmlFor="rs-mgr">Manager numbers</label>
              <textarea
                id="rs-mgr"
                value={screening.managerNumbers}
                onChange={(e) => setScreening((sc) => ({ ...sc, managerNumbers: e.target.value }))}
                placeholder={'One per line (or comma-separated) — e.g. your own mobile'}
                rows={2}
                className={inputCls + ' font-mono text-xs'}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Calls from these numbers get the manager treatment: a manager greeting, business questions
                answered freely, and lookups include customer names. Manager numbers are never screened out.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <label className={labelCls} htmlFor="rs-mgrpin">Manager PIN (spoken)</label>
                {screening.managerPinSet ? (
                  <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">PIN set</span>
                ) : (
                  <span className="text-[11px] text-gray-400 dark:text-slate-500">no PIN — read-only line</span>
                )}
              </div>
              <input
                id="rs-mgrpin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={screening.managerPin}
                onChange={(e) => setScreening((sc) => ({ ...sc, managerPin: e.target.value }))}
                placeholder={screening.managerPinSet ? 'Enter a new PIN to replace it — blank keeps the current one' : 'Set a 6–8 digit PIN — blank = manager line stays read-only'}
                className={inputCls + ' font-mono text-xs'}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Caller ID can be spoofed, so booking changes by voice (confirm, move, cancel, block a number)
                need this PIN spoken once per call. Aokie asks for it, checks it exactly (digits or words —
                "one two three four"), and the PIN never appears in transcripts. For your security the saved
                PIN is never shown back — leave this blank to keep the current one.
                {screening.managerPinSet && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => void handleRemoveManagerPin()}
                      disabled={screeningSaving}
                      className="font-medium text-rose-600 underline hover:no-underline disabled:opacity-50 dark:text-rose-400"
                    >
                      Remove PIN
                    </button>
                  </>
                )}
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-cc">Default country code for texts</label>
              <input
                id="rs-cc"
                type="text"
                value={screening.defaultCountryCode}
                onChange={(e) => setScreening((sc) => ({ ...sc, defaultCountryCode: e.target.value }))}
                placeholder="e.g. +61 — blank = send numbers exactly as saved"
                className={inputCls + ' font-mono text-xs'}
              />
              <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
                Outbound texts to a 0-prefixed number go out as this code plus the rest (0412… → +61412…).
                Caller recognition doesn't need it.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => void handleSaveScreening()}
                disabled={screeningSaving || !screening.loaded}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                {screeningSaving ? 'Saving…' : 'Save screening'}
              </button>
              {!screening.loaded && (
                <span className="ml-2 text-[11px] text-gray-400 dark:text-slate-500">Loading current values…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Advanced (collapsed by default) ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-2 text-left"
        >
          {showAdvanced ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Advanced — AI model &amp; endpoints</h2>
          <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">blank = auto-detect</span>
        </button>
        {showAdvanced && (
          <div className="mt-3 grid grid-cols-1 gap-3">
            <p className={hintCls}>
              Each lane picks WHERE it runs: Automatic uses the plugin's default (with the custom URL
              below winning when set); a FormLogic Desktop service resolves to that service's live
              address on every call — so a port change heals itself; Custom URL uses your address
              verbatim.
              {sources === null &&
                ' Connect FormLogic Desktop on this machine to pick services by name — saved picks still resolve per call on the desktop.'}
            </p>
            <SourceLane
              label="Answers (LLM)"
              idPrefix="rs-llm"
              source={draft.llm_source}
              endpoint={draft.llm_endpoint}
              services={laneServices('chat')}
              listed={sources !== null}
              placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
              onSource={(v) => set({ llm_source: v })}
              onEndpoint={(v) => set({ llm_endpoint: v })}
            />
            <div>
              <label className={labelCls} htmlFor="rs-model">LLM model</label>
              <input id="rs-model" type="text" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="e.g. llama3.1:8b (blank = auto)" className={inputCls} />
            </div>
            <SourceLane
              label="Speech-to-text"
              idPrefix="rs-stt"
              source={draft.stt_source}
              endpoint={draft.stt_endpoint}
              services={laneServices('speech')}
              listed={sources !== null}
              placeholder="e.g. http://127.0.0.1:17920/v1/audio/transcriptions"
              onSource={(v) => set({ stt_source: v })}
              onEndpoint={(v) => set({ stt_endpoint: v })}
            />
            <SourceLane
              label="Text-to-speech"
              idPrefix="rs-tts"
              source={draft.tts_source}
              endpoint={draft.tts_endpoint}
              services={laneServices('speech')}
              listed={sources !== null}
              placeholder="e.g. http://127.0.0.1:17920/v1/audio/speech"
              onSource={(v) => set({ tts_source: v })}
              onEndpoint={(v) => set({ tts_endpoint: v })}
            />
          </div>
        )}
      </div>

      {/* ── Save bar (sticky on mobile so it's always reachable) ── */}
      <div className="sticky bottom-2 z-10">
        <div className={`${card} flex flex-wrap items-center gap-2 p-3 shadow-lg`}>
          {dirty ? (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Unsaved changes</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={() => { setDraft(saved); }}
                className="cursor-pointer rounded-xl px-3 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                Discard
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!mayWrite || saving || applying || !dirty}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </button>
            {can('settings.set') && (
              <button
                type="button"
                onClick={() => void handleSaveAndApply()}
                disabled={!mayWrite || saving || applying}
                title="Save, then push this configuration to the live receptionist immediately"
                className="app-btn-primary inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
              >
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Save &amp; apply now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
