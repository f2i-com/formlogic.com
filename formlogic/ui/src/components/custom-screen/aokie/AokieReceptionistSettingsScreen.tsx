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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquareText, Mic, Plug, RefreshCw, Save, Settings2, Sparkles } from 'lucide-react';
import { useConnector, useConnectorPermission, useResponses } from '../../../sdk';
import { toast } from '../../../stores/toastStore';
import { api } from '../../../lib/api';
import { useAppRuntimeStore } from '../../../stores/appRuntimeStore';
import { performRelayCommand } from './aokieRelay';
import { useAokiePresence } from './useAokiePresence';
import {
  listAiSources,
  listDesktopServices,
  type AiSourceListing,
} from '../../../client-runtime/flows/desktopService';
// Payload composition lives in receptionistPayload.ts (no React/SDK imports)
// so the pack contract test can pin the console↔flow mirror byte-for-byte.
import {
  buildAgentPayload,
  EMPTY_DRAFT,
  resolveCorrectionEndpoint,
  type Draft,
  type SourceService,
} from './receptionistPayload';
import {
  parseTtsVoiceCatalog,
  VoiceEngineSection,
  type TtsCatalogEngine,
} from './receptionistVoice';

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';
const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-800/60 dark:text-white dark:placeholder:text-slate-500';
const labelCls = 'mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300';
const hintCls = 'mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500';

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
    correction_source: s('correction_source'),
    correction_endpoint: s('correction_endpoint'),
    voice: s('voice'),
    reply_mode: s('reply_mode') || 'agent',
    active: s('active') || 'yes',
  };
}

interface RunningConfig {
  greeting?: string;
  persona?: string;
  voice?: string;
  model?: string;
  aiReceptionist?: boolean;
  configVersion?: number;
}

// ── Connected services: per-lane source options (CON-303 / SRC-203) ──────────
type LaneKind = 'llm' | 'stt' | 'tts';

/** The capability tag each lane needs (matches the desktop's /api/ai/sources tags). */
const LANE_CAPABILITY: Record<LaneKind, string> = {
  llm: 'chat',
  stt: 'transcription',
  tts: 'speech',
};

/** The Aokie speech services that act as each lane's DEFAULT when present. */
const LANE_AOKIE_DEFAULT: Partial<Record<LaneKind, string>> = {
  stt: 'aokie-stt',
  tts: 'aokie-tts',
};

interface LaneOption {
  value: string;
  label: string;
}

/**
 * Option list for one lane's select, ordered: the Aokie default service first
 * (STT/TTS lanes), then capability-matching desktop services (running or
 * stopped — a stopped pick still resolves per call once started), then — LLM
 * lane only — configured AI providers (routed through the desktop AI gateway),
 * then Custom URL…, then the plugin's built-in fallback ('').
 */
function laneOptionsFor(lane: LaneKind, sources: AiSourceListing[] | null): LaneOption[] {
  const cap = LANE_CAPABILITY[lane];
  const defaultId = LANE_AOKIE_DEFAULT[lane];
  const all = sources ?? [];
  const services = all.filter((s) => s.kind === 'service' && s.capabilities.includes(cap));
  const options: LaneOption[] = [];
  const withStatus = (s: AiSourceListing) => (s.status === 'running' ? '' : ` (${s.status})`);
  const def = defaultId ? services.find((s) => s.refId === defaultId) : undefined;
  if (def) options.push({ value: def.id, label: `Aokie default — ${def.name}${withStatus(def)}` });
  for (const s of services) {
    if (def && s.refId === def.refId) continue;
    options.push({ value: s.id, label: `This computer: ${s.name}${withStatus(s)}` });
  }
  if (lane === 'llm') {
    // Providers: capability 'chat' or EMPTY = unrestricted ("all", legacy profiles).
    for (const p of all) {
      if (p.kind !== 'provider' || !p.enabled) continue;
      if (p.capabilities.length > 0 && !p.capabilities.includes('chat')) continue;
      options.push({ value: p.id, label: `Provider: ${p.name}` });
    }
  }
  options.push({ value: 'custom', label: 'Custom URL…' });
  options.push({ value: '', label: 'Built-in (plugin fallback)' });
  return options;
}

/**
 * One lane's source picker (CON-303): the Aokie default / a FormLogic Desktop
 * service (resolved to its live URL per call) / an AI provider via the desktop
 * gateway (LLM lane) / Custom URL / the plugin's built-in fallback. A saved
 * `service:`/`provider:` pick that isn't in the current listing (desktop away,
 * service removed) stays selectable so the record never silently changes just
 * by opening the page.
 */
function SourceLane({
  label,
  hint,
  idPrefix,
  lane,
  source,
  endpoint,
  sources,
  placeholder,
  onSource,
  onEndpoint,
}: {
  label: string;
  hint?: string;
  idPrefix: string;
  lane: LaneKind;
  source: string;
  endpoint: string;
  sources: AiSourceListing[] | null;
  placeholder: string;
  onSource: (v: string) => void;
  onEndpoint: (v: string) => void;
}) {
  const listed = sources !== null;
  const options = laneOptionsFor(lane, sources);
  const savedMissing =
    (source.startsWith('service:') || source.startsWith('provider:')) &&
    !options.some((o) => o.value === source);
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
        {savedMissing && (
          <option value={source}>
            {source.startsWith('provider:') ? 'AI provider' : 'Desktop service'}: {source.replace(/^(service|provider):/, '')}
            {listed ? ' (not found)' : ' (saved)'}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value || 'builtin'} value={o.value}>
            {o.value === '' && endpoint.trim() && source === '' ? `${o.label} — custom URL set below wins` : o.label}
          </option>
        ))}
      </select>
      {savedMissing && listed && (
        <p className={hintCls}>
          This {source.startsWith('provider:') ? 'provider' : 'service'} isn't on the connected desktop — calls fall
          back to the plugin default until it exists again.
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
      {hint && <p className={hintCls}>{hint}</p>}
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
              customDir: false,
            }
      );
      // ttsVoiceCatalog: what's actually installed on the desktop (whole-object
      // gets only; absent on older plugins → the pickers degrade to hardcoded).
      setVoiceCatalog(parseTtsVoiceCatalog(res.ttsVoiceCatalog));
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

  // ── AI sources for the Connected-services pickers ──
  // GET /api/ai/sources: the union of desktop services (capability-tagged) and
  // configured AI providers — the SAME listing the per-call flow's
  // `desktop_services` node resolves service: picks against, so the picker and
  // the flow agree. Older desktops without the route degrade to the plain
  // /api/services list with category-derived capabilities (the desktop's own
  // fallback rule). null = no local Desktop listing here (remote console /
  // demo / unpaired): pickers still save source ids — resolution then happens
  // per call on the desktop runner.
  const [aiSources, setAiSources] = useState<AiSourceListing[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let list = await listAiSources().catch(() => [] as AiSourceListing[]);
      if (list.length === 0) {
        // Pre-SRC-202 desktop: derive capabilities from the service category,
        // mirroring the desktop's service_source_capabilities() defaults.
        const svcs = await listDesktopServices().catch(() => []);
        list = svcs.map((s) => {
          const c = s.category.toLowerCase();
          const capabilities = c.includes('llm')
            ? ['chat']
            : c.includes('speech') || c.includes('voice')
              ? ['transcription', 'speech']
              : c.includes('image')
                ? ['image']
                : [];
          return {
            id: `service:${s.id}`,
            kind: 'service' as const,
            refId: s.id,
            name: s.name,
            category: s.category,
            status: s.status,
            capabilities,
            url: s.url,
            model: '',
            enabled: true,
          };
        });
      }
      if (alive) setAiSources(list.length > 0 ? list : null);
    })().catch(() => {
      /* unavailable — pickers fall back to saved ids */
    });
    return () => {
      alive = false;
    };
  }, []);
  // The service-shaped subset buildAgentPayload resolves `service:` picks
  // against (same shape the flow's desktop_services node yields).
  const sources: SourceService[] | null = useMemo(
    () =>
      aiSources === null
        ? null
        : aiSources
            .filter((s) => s.kind === 'service')
            .map((s) => ({ id: s.refId, name: s.name, category: s.category, status: s.status, url: s.url })),
    [aiSources],
  );

  // ── Aokie speech defaults (SRC-203): a record with NO stt/tts source saved
  // (new records, or blank) defaults its select to the Aokie speech services
  // when this desktop has them — and Saving writes that pick explicitly. A
  // blank source WITH a legacy custom URL keeps its meaning (the URL wins), so
  // it is never overridden. LLM lane keeps '' (the plugin's own aiEndpoint).
  const speechDefaultsApplied = useRef(false);
  useEffect(() => {
    if (speechDefaultsApplied.current || draft === null || aiSources === null) return;
    speechDefaultsApplied.current = true;
    const hasSvc = (sid: string) => aiSources.some((s) => s.kind === 'service' && s.refId === sid);
    setDraft((d) => {
      if (!d) return d;
      const patch: Partial<Draft> = {};
      if (!d.stt_source.trim() && !d.stt_endpoint.trim() && hasSvc('aokie-stt')) patch.stt_source = 'service:aokie-stt';
      if (!d.tts_source.trim() && !d.tts_endpoint.trim() && hasSvc('aokie-tts')) patch.tts_source = 'service:aokie-tts';
      return Object.keys(patch).length > 0 ? { ...d, ...patch } : d;
    });
  }, [draft, aiSources]);

  // ── Speech engine (plugin settings — which in-process TTS speaks) ──
  // ttsEngine: '' / 'pocket' = Pocket-TTS; 'sherpa' = sherpa-onnx running a
  // Piper/VITS (or Kokoro) voice bundle from ttsModelDir. Applies LIVE (the
  // plugin reloads its synth engine on save). voiceCatalog = the plugin's
  // reported on-disk voice inventory (null on older plugins / read failure).
  const [engineCfg, setEngineCfg] = useState({ loaded: false, engine: '', modelDir: '', customDir: false });
  const [voiceCatalog, setVoiceCatalog] = useState<TtsCatalogEngine[] | null>(null);
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

  // ── Audio understanding (plugin settings — the caller-audio MODE) ──
  // sendAudio and audioTranscript are INDEPENDENT: sendAudio ships the
  // caller-turn audio with the reply request (needs an audio-capable reply
  // model); audioTranscript side-runs a small correction request per caller
  // turn against the correction source (works with a text-only reply model —
  // the plugin decouples the lanes). The card exposes them as one 4-way mode
  // select; both keys are pushed explicitly on every save. Read once at radio
  // start, so saves apply at the next reconnect.
  const [audioCfg, setAudioCfg] = useState({
    loaded: false,
    sendAudio: false,
    audioTranscript: false,
  });
  const [audioSaving, setAudioSaving] = useState(false);
  const handleSaveAudio = useCallback(async () => {
    if (!draft) return;
    setAudioSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        sendAudio: audioCfg.sendAudio,
        audioTranscript: audioCfg.audioTranscript,
      };
      // Push the resolved correction endpoint the way "Save & apply now"
      // would (the SAME laneUrl rule as the per-call flow). Unresolvable here
      // (service pick with no local Desktop listing — remote console) → omit:
      // the per-call flow owns it. The model key is never pushed — the chosen
      // service owns its model.
      const correctionUrl = resolveCorrectionEndpoint(
        draft.correction_source,
        draft.correction_endpoint,
        sources ?? undefined,
      );
      if (correctionUrl !== undefined) payload.audioTranscriptEndpoint = correctionUrl;
      await runCommand('settings.set', payload);
      // The correction SOURCE lives on the settings RECORD (the per-call
      // Configure flow re-resolves it every call). Patch just those keys —
      // the API merges, so the persona draft above is never touched.
      if (formId) {
        const answers = {
          correction_source: draft.correction_source.trim(),
          correction_endpoint: draft.correction_endpoint.trim(),
        };
        if (recordId) {
          await updateResponse(formId, recordId, { answers });
        } else {
          const created = (await createResponse(formId, answers)) as { id?: string } | undefined;
          if (created && typeof created.id === 'string') setRecordId(created.id);
        }
        records.reload();
      }
      try {
        const res = await runCommand('settings.get');
        const s = (res.settings && typeof res.settings === 'object' ? res.settings : {}) as Record<string, unknown>;
        setAudioCfg((prev) => ({
          ...prev,
          sendAudio: s.sendAudio === true || s.sendAudio === 'true',
          audioTranscript: s.audioTranscript === true || s.audioTranscript === 'true',
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
  }, [runCommand, audioCfg, draft, sources, formId, recordId, updateResponse, createResponse, records]);

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
        {/* ── Engine-first voice selection: the speech engine (a live plugin
            setting) leads; the voice control below it adapts — pocket voices
            from the catalog, sherpa voice bundles, kokoro speaker id. ── */}
        <VoiceEngineSection
          engineCfg={engineCfg}
          onEngineCfg={(patch) => setEngineCfg((p) => ({ ...p, ...patch }))}
          voice={draft.voice}
          onVoice={(v) => set({ voice: v })}
          catalog={voiceCatalog}
          canManageEngine={can('settings.set')}
          savingEngine={savingEngine}
          onSaveEngine={() => void handleSaveEngine()}
        />
        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-gray-100 pt-4 dark:border-slate-800 sm:grid-cols-2">
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
      </div>

      {/* ── Connected services (SRC-203): WHERE each lane runs ── */}
      <div className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <Plug className="h-4 w-4 text-gray-400 dark:text-slate-500" />
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Connected services</h2>
        </div>
        <p className={hintCls + ' mb-3 mt-0'}>
          Which engine answers, hears and speaks. Picks resolve to the service's live address on
          every call — a port change heals itself; a stopped service falls back to the plugin's
          built-in engine until it runs again. AI providers route through the desktop's AI gateway.
          {aiSources === null &&
            ' Connect FormLogic Desktop on this machine to pick services by name — saved picks still resolve per call on the desktop.'}
        </p>
        <div className="grid grid-cols-1 gap-3">
          <SourceLane
            label="Reply model (LLM)"
            idPrefix="rs-llm"
            lane="llm"
            source={draft.llm_source}
            endpoint={draft.llm_endpoint}
            sources={aiSources}
            placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
            onSource={(v) => set({ llm_source: v })}
            onEndpoint={(v) => set({ llm_endpoint: v })}
            hint="Built-in = the plugin's configured endpoint (auto-detects a local llama.cpp/Ollama)."
          />
          <SourceLane
            label="Speech to text"
            idPrefix="rs-stt"
            lane="stt"
            source={draft.stt_source}
            endpoint={draft.stt_endpoint}
            sources={aiSources}
            placeholder="e.g. http://127.0.0.1:17921/v1/audio/transcriptions"
            onSource={(v) => set({ stt_source: v })}
            onEndpoint={(v) => set({ stt_endpoint: v })}
          />
          <SourceLane
            label="Text to speech"
            idPrefix="rs-tts"
            lane="tts"
            source={draft.tts_source}
            endpoint={draft.tts_endpoint}
            sources={aiSources}
            placeholder="e.g. http://127.0.0.1:17922/v1/audio/speech"
            onSource={(v) => set({ tts_source: v })}
            onEndpoint={(v) => set({ tts_endpoint: v })}
          />
        </div>
      </div>

      {/* ── Audio understanding (plugin-level caller-audio mode) ── */}
      {can('settings.set') && (
        <div className={`${card} p-4 sm:p-5`}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-white">Audio understanding</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            What happens with the caller's actual audio each turn. Applies the next time the
            receptionist reconnects.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div>
              <label className={labelCls} htmlFor="rs-audiomode">Caller audio</label>
              <select
                id="rs-audiomode"
                value={
                  audioCfg.sendAudio && audioCfg.audioTranscript
                    ? 'both'
                    : audioCfg.sendAudio
                      ? 'direct'
                      : audioCfg.audioTranscript
                        ? 'corrections'
                        : 'off'
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setAudioCfg((a) => ({
                    ...a,
                    sendAudio: v === 'direct' || v === 'both',
                    audioTranscript: v === 'corrections' || v === 'both',
                  }));
                }}
                className={inputCls + ' cursor-pointer'}
              >
                <option value="off">Text only</option>
                <option value="direct">Send audio to the reply model (direct)</option>
                <option value="corrections">Side-run transcript corrections</option>
                <option value="both">Both</option>
              </select>
              <p className={hintCls}>
                {audioCfg.sendAudio && audioCfg.audioTranscript
                  ? 'The reply model hears the caller directly AND a small side request per caller turn fixes the stored transcript and the reply history from the audio.'
                  : audioCfg.sendAudio
                    ? "Each caller turn's audio rides along with the reply request — needs an audio-capable reply model (e.g. Gemma with a projector); no extra side run."
                    : audioCfg.audioTranscript
                      ? 'For text-only reply models: a small extra request per caller turn corrects the stored transcript and the reply history from the actual audio — replies never wait on it.'
                      : 'Replies use the on-device speech-to-text transcript only — no audio leaves the plugin.'}
              </p>
            </div>
            {audioCfg.audioTranscript && (
              <div className="grid grid-cols-1 gap-3 rounded-xl border border-gray-200 p-3 dark:border-slate-700">
                <div>
                  <label className={labelCls} htmlFor="rs-correction-source">Correction source</label>
                  <select
                    id="rs-correction-source"
                    value={draft.correction_source}
                    onChange={(e) => set({ correction_source: e.target.value })}
                    className={inputCls + ' cursor-pointer'}
                  >
                    {draft.correction_source.startsWith('service:') &&
                      !(aiSources ?? []).some(
                        (s) =>
                          s.id === draft.correction_source &&
                          s.kind === 'service' &&
                          s.capabilities.includes('chat'),
                      ) && (
                        <option value={draft.correction_source}>
                          Desktop service: {draft.correction_source.slice(8)}
                          {aiSources !== null ? ' (not found)' : ' (saved)'}
                        </option>
                      )}
                    <option value="">Automatic (main reply model)</option>
                    {(aiSources ?? [])
                      .filter((s) => s.kind === 'service' && s.capabilities.includes('chat'))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          This computer: {s.name}
                          {s.model ? ` — ${s.model}` : ''}
                          {s.status === 'running' ? '' : ` (${s.status})`}
                        </option>
                      ))}
                    <option value="custom">Custom URL…</option>
                  </select>
                  {draft.correction_source === 'custom' && (
                    <input
                      id="rs-correction-url"
                      type="text"
                      value={draft.correction_endpoint}
                      onChange={(e) => set({ correction_endpoint: e.target.value })}
                      placeholder="e.g. http://127.0.0.1:8081/v1/chat/completions"
                      spellCheck={false}
                      className={inputCls + ' mt-2 font-mono text-xs'}
                    />
                  )}
                  <p className={hintCls}>
                    Which model runs the corrections — a separate chat service keeps them from competing
                    with live replies. The model comes from the chosen service itself (pick it on the
                    desktop's service card). Resolved per call, like the Connected-services lanes.
                  </p>
                </div>
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
              The raw AI plumbing behind the Connected services card above. The custom URL fields are
              used when a lane is set to Custom URL… (or left on Built-in with a URL entered — the
              legacy behaviour, where the URL wins).
            </p>
            <div>
              <label className={labelCls} htmlFor="rs-model">LLM model</label>
              <input id="rs-model" type="text" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="e.g. llama3.1:8b (blank = auto)" className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-llm-url">Custom LLM endpoint URL</label>
              <input
                id="rs-llm-url"
                type="text"
                value={draft.llm_endpoint}
                onChange={(e) => set({ llm_endpoint: e.target.value })}
                placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
                className={inputCls + ' font-mono text-xs'}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-stt-url">Custom speech-to-text URL</label>
              <input
                id="rs-stt-url"
                type="text"
                value={draft.stt_endpoint}
                onChange={(e) => set({ stt_endpoint: e.target.value })}
                placeholder="e.g. http://127.0.0.1:17921/v1/audio/transcriptions"
                className={inputCls + ' font-mono text-xs'}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="rs-tts-url">Custom text-to-speech URL</label>
              <input
                id="rs-tts-url"
                type="text"
                value={draft.tts_endpoint}
                onChange={(e) => set({ tts_endpoint: e.target.value })}
                placeholder="e.g. http://127.0.0.1:17922/v1/audio/speech"
                className={inputCls + ' font-mono text-xs'}
              />
            </div>
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
