// State + actions for the sandboxed Receptionist Settings console - the
// behavior-preserving port of the embedded-string screen's IIFE state machine.
// Rendering is preact (index.tsx + components/*): wherever the original
// repainted raw markup this store notifies the subscriber instead; every code
// path, payload shape, validation and gating rule is otherwise unchanged.
//
// SECURITY-CRITICAL invariants preserved from the reviewed original (each was
// a review defect fix - regressing any is a real incident):
//  - MANAGER PIN IS WRITE-ONLY: never seeded from settings.get (only the
//    managerPinSet boolean is read), sent ONLY when the operator typed a new
//    one (blank on save = KEEP), cleared ONLY via the explicit removePin.
//  - PARTIAL SAVES NEVER CLOBBER THE DIRTY BASELINE: each save handler rebases
//    ONLY the keys it actually persisted into state.saved (a first-save create
//    persists the whole draft; later saves their own keys only), so pending
//    edits in other cards are never silently marked saved and lost.
//  - CREATE-IN-FLIGHT GUARD: the settings record is a singleton created on
//    first save; concurrent first-saves share ONE create (createInFlight) and
//    the create sends the FULL draft (create validates required fields and
//    does not merge). Later saves are PARTIAL updateRecord patches (the
//    controller PATCH-merges).
import {
  AI_GATEWAY_BASE,
  composeAgentPayload,
  DEFAULT_PERSONA,
  type Draft,
  type SourceService,
} from './agentPayload';
import { baseName, boolish, parseCatalog, rec, splitList, str, type CatalogEngine } from './helpers';

// -- state shapes --

/** One entry of FormLogic.aiSources() (the host-resolved desktop listing).
 *  Cast, not normalized: the original consumed the raw entries directly. */
export interface AiSource {
  kind: string;
  id: string;
  refId: string;
  name: string;
  category: string;
  status: string;
  url: string;
  capabilities: string[];
  enabled?: boolean;
  model?: string;
}

export interface RunningInfo {
  greeting: string;
  persona: string;
  voice: string;
  model: string;
  aiReceptionist: boolean;
  configVersion: number | undefined;
}

export interface EngineState {
  loaded: boolean;
  engine: string;
  modelDir: string;
  customDir: boolean;
}

export interface AudioState {
  loaded: boolean;
  sendAudio: boolean;
  audioTranscript: boolean;
}

export interface WaitingState {
  loaded: boolean;
  holdAndCallWaiting: boolean;
  autoHoldQueue: boolean;
  autoConnectPhone: boolean;
}

export interface ScreeningState {
  loaded: boolean;
  recordLoaded: boolean;
  blockedNumbers: string;
  acceptPattern: string;
  rejectPrivate: boolean;
  screenMessage: string;
  blockedMessage: string;
  autoBlockAbuse: boolean;
  managerNumbers: string;
  /** WRITE-ONLY staging for a NEWLY TYPED pin - never seeded from the plugin. */
  managerPin: string;
  managerPinSet: boolean;
  whitelistOnly: boolean;
  defaultCountryCode: string;
}

export interface BusyFlags {
  engine?: boolean;
  audio?: boolean;
  waiting?: boolean;
  screening?: boolean;
  save?: boolean;
  apply?: boolean;
}

export interface ScreenState {
  presence: { kind: string };
  demo: boolean;
  canGet: boolean;
  canSet: boolean;
  mayWrite: boolean;
  draft: Draft | null;
  saved: Draft | null;
  recordId: string | null;
  running: RunningInfo | null;
  runningError: string | null;
  err: string | null;
  aiSources: AiSource[] | null;
  catalog: CatalogEngine[] | null;
  engine: EngineState;
  audio: AudioState;
  waiting: WaitingState;
  screening: ScreeningState;
  showAdvanced: boolean;
  busy: BusyFlags;
}

export const EMPTY: Draft = {
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
  correction_source: '',
  correction_endpoint: '',
  voice: '',
  reply_mode: 'agent',
  active: 'yes',
};

export const state: ScreenState = {
  presence: { kind: 'none' },
  demo: false,
  canGet: false,
  canSet: false,
  mayWrite: false,
  draft: null,
  saved: null,
  recordId: null,
  running: null,
  runningError: null,
  err: null,
  aiSources: null,
  catalog: null,
  engine: { loaded: false, engine: '', modelDir: '', customDir: false },
  audio: { loaded: false, sendAudio: false, audioTranscript: false },
  waiting: { loaded: false, holdAndCallWaiting: false, autoHoldQueue: false, autoConnectPhone: true },
  screening: {
    loaded: false,
    recordLoaded: false,
    blockedNumbers: '',
    acceptPattern: '',
    rejectPrivate: false,
    screenMessage: '',
    blockedMessage: '',
    autoBlockAbuse: true,
    managerNumbers: '',
    managerPin: '',
    managerPinSet: false,
    whitelistOnly: false,
    defaultCountryCode: '',
  },
  showAdvanced: false,
  busy: {},
};

// -- re-render notification (replaces the original's whole-tree repaints).
// A notify fired before the component subscribed (load can finish inside the
// mount frame) is replayed on subscribe so the first paint is never lost.
let listeners: Array<() => void> = [];
let missedNotify = false;

export function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  if (missedNotify) {
    missedNotify = false;
    fn();
  }
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function touch(): void {
  if (listeners.length === 0) {
    missedNotify = true;
    return;
  }
  for (const l of listeners) l();
}

// -- selectors --

export function d(): Draft {
  return state.draft || EMPTY;
}

/** The lane list composeAgentPayload resolves service picks against: the
 *  aiSources services, or undefined when there is NO listing (remote console)
 *  so unresolvable picks are omitted for the per-call flow to own. */
export function services(): SourceService[] | undefined {
  if (state.aiSources === null) return undefined;
  const out: SourceService[] = [];
  for (let i = 0; i < state.aiSources.length; i++) {
    const s = state.aiSources[i];
    if (s.kind === 'service') out.push({ id: s.refId, name: s.name, category: s.category, status: s.status, url: s.url });
  }
  return out;
}

export function dirty(): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.saved);
}

function setDraft(patch: Partial<Draft>): void {
  state.draft = { ...d(), ...patch };
}

function messageOf(e: unknown, fallback: string): string {
  const m = e ? (e as { message?: string }).message : undefined;
  return m ? m : fallback;
}

// The runtime shim exposes toast.success/error(msg). The original screen ALSO
// called toast.info and passed a second detail argument; both calls are
// preserved verbatim (the shim ignores the detail today, and a missing info
// method surfaces through the handler's catch exactly as before).
interface ToastLike {
  success(msg: string, detail?: string): Promise<unknown>;
  error(msg: string, detail?: string): Promise<unknown>;
  info(msg: string, detail?: string): Promise<unknown>;
}
function toastApi(): ToastLike {
  return FormLogic.toast as unknown as ToastLike;
}

// -- connector helpers --

function settingsGet(): Promise<Record<string, unknown> | null> {
  return FormLogic.connector('aokie', 'settings.get', {})
    .then((o) => (o.status === 'done' ? rec(o.result) : null))
    .catch(() => null);
}

function settingsSet(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return FormLogic.connector('aokie', 'settings.set', payload).then((o) => {
    if (o.status === 'done') return rec(o.result);
    const errObj = o.error as unknown as { message?: string } | undefined;
    const m = errObj && errObj.message ? errObj.message : o.status;
    throw new Error(m);
  });
}

// -- lane picker option list (port of laneOptionsFor) --

export type Lane = 'llm' | 'stt' | 'tts';

const LANE_CAP: Record<Lane, string> = { llm: 'chat', stt: 'transcription', tts: 'speech' };
const LANE_DEFAULT: Record<string, string | undefined> = { stt: 'aokie-stt', tts: 'aokie-tts' };

export interface LaneOption {
  value: string;
  label: string;
}

export const CODEX_LIVE_CALL_MODEL = 'gpt-5.5';
export const CODEX_LUNA_MODEL = 'gpt-5.6-luna';
const CODEX_LIVE_CALL_SOURCES = [
  'provider:openai-codex-agent-luna-low',
  'provider:openai-codex-agent-luna-low-fast',
  'provider:openai-codex-agent-none',
  'provider:openai-codex-agent-low',
];

/** The Desktop-owned Codex pseudo-providers are text-only live-call adapters.
 *  Keep this exact allow-list narrow so an ordinary provider whose id merely
 *  contains "codex" is never constrained. */
export function isCodexLiveCallSource(source: string): boolean {
  return CODEX_LIVE_CALL_SOURCES.indexOf(source.trim()) >= 0;
}

export function codexLiveCallReasoning(source: string): 'none' | 'low' | null {
  if (source.trim() === 'provider:openai-codex-agent-none') return 'none';
  if (source.trim() === 'provider:openai-codex-agent-low') return 'low';
  if (
    source.trim() === 'provider:openai-codex-agent-luna-low'
    || source.trim() === 'provider:openai-codex-agent-luna-low-fast'
  ) return 'low';
  return null;
}

export function codexLiveCallModel(source: string): string | null {
  if (
    source.trim() === 'provider:openai-codex-agent-luna-low'
    || source.trim() === 'provider:openai-codex-agent-luna-low-fast'
  ) return CODEX_LUNA_MODEL;
  return isCodexLiveCallSource(source) ? CODEX_LIVE_CALL_MODEL : null;
}

export function isCodexLunaSource(source: string): boolean {
  return source.trim() === 'provider:openai-codex-agent-luna-low'
    || source.trim() === 'provider:openai-codex-agent-luna-low-fast';
}

export function isCodexFastSource(source: string): boolean {
  return source.trim() === 'provider:openai-codex-agent-luna-low-fast';
}

function enforceCodexTextOnly(): void {
  const model = codexLiveCallModel(d().llm_source);
  if (!model) return;
  if (d().model !== model) setDraft({ model });
  state.audio.sendAudio = false;
}

function currentAgentPayload(): Record<string, unknown> {
  enforceCodexTextOnly();
  const payload = composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE);
  // Defense in depth for both newly selected and previously saved Codex
  // sources: Save & apply can never carry a stale direct-audio setting into
  // this chat-only provider. The Desktop/provider boundary enforces the same
  // rule, but the settings UI must also represent and persist it honestly.
  if (isCodexLiveCallSource(d().llm_source)) payload.sendAudio = false;
  return payload;
}

export function laneOptions(lane: Lane): LaneOption[] {
  const cap = LANE_CAP[lane];
  const defId = LANE_DEFAULT[lane];
  const all = state.aiSources || [];
  const svcs = all.filter((s) => s.kind === 'service' && s.capabilities.indexOf(cap) >= 0);
  const opts: LaneOption[] = [];
  const withStatus = (s: AiSource) => (s.status === 'running' ? '' : ' (' + s.status + ')');
  const def = defId ? svcs.filter((s) => s.refId === defId)[0] : undefined;
  if (def) opts.push({ value: def.id, label: 'Aokie default - ' + def.name + withStatus(def) });
  for (let i = 0; i < svcs.length; i++) {
    const s = svcs[i];
    if (def && s.refId === def.refId) continue;
    opts.push({ value: s.id, label: 'This computer: ' + s.name + withStatus(s) });
  }
  if (lane === 'llm') {
    for (let p = 0; p < all.length; p++) {
      const pr = all[p];
      if (pr.kind !== 'provider' || !pr.enabled) continue;
      if (pr.capabilities.length > 0 && pr.capabilities.indexOf('chat') < 0) continue;
      opts.push({ value: pr.id, label: 'Provider: ' + pr.name });
    }
  }
  opts.push({ value: 'custom', label: 'Custom URL...' });
  opts.push({ value: '', label: 'Built-in (plugin fallback)' });
  return opts;
}

// -- loaders --

function seedFromSettings(res: Record<string, unknown>): void {
  const s = rec(res.settings);
  if (!state.audio.loaded) {
    state.audio = {
      loaded: true,
      sendAudio: isCodexLiveCallSource(d().llm_source) ? false : boolish(s.sendAudio),
      audioTranscript: boolish(s.audioTranscript),
    };
  }
  if (!state.waiting.loaded) {
    state.waiting = {
      loaded: true,
      holdAndCallWaiting: boolish(s.holdAndCallWaiting),
      autoHoldQueue: boolish(s.autoHoldQueue),
      autoConnectPhone: !(s.autoConnectPhone === false || s.autoConnectPhone === 'false'),
    };
  }
  if (!state.screening.loaded) {
    state.screening.loaded = true;
    state.screening.blockedNumbers = str(s.blockedNumbers);
    state.screening.acceptPattern = str(s.acceptPattern);
    state.screening.rejectPrivate = boolish(s.rejectPrivate);
    state.screening.screenMessage = str(s.screenMessage);
    state.screening.blockedMessage = str(s.blockedMessage);
    state.screening.autoBlockAbuse = !(s.autoBlockAbuse === false || s.autoBlockAbuse === 'false');
    state.screening.managerNumbers = str(s.managerNumbers);
    // The stored PIN NEVER arrives (the plugin redacts it): the field stays
    // blank and only the set/unset boolean is read.
    state.screening.managerPin = '';
    state.screening.managerPinSet = res.managerPinSet === true;
  }
  if (!state.engine.loaded) {
    state.engine = { loaded: true, engine: str(s.ttsEngine), modelDir: str(s.ttsModelDir), customDir: false };
  }
  state.catalog = parseCatalog(res.ttsVoiceCatalog);
  state.running = {
    greeting: str(s.greeting),
    persona: str(s.persona),
    voice: str(s.ttsVoice),
    model: str(s.aiModel),
    aiReceptionist: s.aiReceptionist === true,
    configVersion: typeof res.configVersion === 'number' ? res.configVersion : undefined,
  };
}

export function refreshRunning(): Promise<void> {
  if (!state.canGet) return Promise.resolve();
  state.runningError = null;
  return settingsGet()
    .then((res) => {
      if (res) {
        seedFromSettings(res);
      } else {
        state.runningError = 'the desktop did not respond';
      }
    })
    .catch((e: unknown) => {
      state.running = null;
      state.runningError = messageOf(e, 'unavailable');
    });
}

function loadRecord(): Promise<void> {
  return FormLogic.records({ limit: 5 })
    .then((rows) => {
      const newest = (rows || [])[0];
      const a = newest ? rec(newest.answers) : {};
      const nd = {} as Draft;
      for (const k of Object.keys(EMPTY) as Array<keyof Draft>) nd[k] = typeof a[k] === 'string' ? (a[k] as string) : EMPTY[k];
      nd.reply_mode = nd.reply_mode || 'agent';
      nd.active = nd.active || 'yes';
      state.draft = nd;
      state.saved = JSON.parse(JSON.stringify(nd)) as Draft;
      // A record may have been written before this UI learned the Codex
      // provider contract. Normalize the working draft (but leave the saved
      // baseline intact so the fixed model is visibly pending until saved).
      enforceCodexTextOnly();
      state.recordId = newest ? newest.id : null;
      // Record-side screening fields (whitelist mode + country code).
      state.screening.whitelistOnly = String(a.whitelist_only || '') === 'yes';
      state.screening.defaultCountryCode = typeof a.default_country_code === 'string' ? a.default_country_code : '';
      state.screening.recordLoaded = true;
    })
    .catch(() => {
      state.draft = JSON.parse(JSON.stringify(EMPTY)) as Draft;
      state.saved = JSON.parse(JSON.stringify(EMPTY)) as Draft;
    });
}

function applySpeechDefaults(): void {
  const sources = state.aiSources;
  if (sources === null || !state.draft) return;
  const has = (id: string) => sources.some((s) => s.kind === 'service' && s.refId === id);
  const patch: Partial<Draft> = {};
  if (!d().stt_source.trim() && !d().stt_endpoint.trim() && has('aokie-stt')) patch.stt_source = 'service:aokie-stt';
  if (!d().tts_source.trim() && !d().tts_endpoint.trim() && has('aokie-tts')) patch.tts_source = 'service:aokie-tts';
  if (Object.keys(patch).length) {
    setDraft(patch);
    state.saved = JSON.parse(JSON.stringify(state.draft)) as Draft;
  }
}

// -- record writes (create-on-first-save, then partial patches) --
// A shared in-flight create guard: concurrent first-saves (e.g. Save audio +
// Save screening) must NOT each submit and duplicate the singleton. Only the
// first no-record caller creates; the rest wait then updateRecord. And the
// create ALWAYS sends the FULL draft (plus this caller's non-draft keys) -
// create validates required fields and does not merge, so a partial first
// write could 400.
let createInFlight: Promise<unknown> | null = null;

function writeRecord(answers: Record<string, unknown>): Promise<unknown> {
  if (state.recordId) return FormLogic.updateRecord(state.recordId, answers);
  if (createInFlight) return createInFlight.then(() => FormLogic.updateRecord(state.recordId, answers));
  const full: Record<string, unknown> = { ...d() };
  for (const j in answers) full[j] = answers[j];
  createInFlight = FormLogic.submit(full).then(
    (r) => {
      const id = r ? (r as { id?: string }).id : undefined;
      if (id) state.recordId = id;
      createInFlight = null;
      return r;
    },
    (e: unknown) => {
      createInFlight = null;
      throw e;
    },
  );
  return createInFlight;
}

function persistDraft(): Promise<boolean> {
  enforceCodexTextOnly();
  const full: Record<string, unknown> = { ...d() };
  return writeRecord(full).then(() => {
    state.saved = JSON.parse(JSON.stringify(state.draft)) as Draft;
    return true;
  });
}

// -- save handlers --

export function saveEngine(): void {
  state.busy.engine = true;
  touch();
  settingsSet({ ttsEngine: state.engine.engine, ttsModelDir: state.engine.modelDir.trim() })
    .then(() => {
      void toastApi().success('Speech engine updated');
    })
    .catch((e: unknown) => {
      void toastApi().error(messageOf(e, 'Could not save the speech engine'));
    })
    .then(() => {
      state.busy.engine = false;
      touch();
    });
}

export function saveAudio(): void {
  enforceCodexTextOnly();
  state.busy.audio = true;
  state.err = null;
  // Capture BEFORE the write: a first-save creates the FULL draft (whole
  // record persisted), a later save persists only the two correction keys.
  const wasCreate = !state.recordId;
  touch();
  const payload: Record<string, unknown> = {
    sendAudio: isCodexLiveCallSource(d().llm_source) ? false : state.audio.sendAudio,
    audioTranscript: state.audio.audioTranscript,
  };
  const p = composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE);
  if ('audioTranscriptEndpoint' in p) payload.audioTranscriptEndpoint = p.audioTranscriptEndpoint;
  settingsSet(payload)
    .then(() => writeRecord({ correction_source: d().correction_source.trim(), correction_endpoint: d().correction_endpoint.trim() }))
    .then(() => {
      // Reflect ONLY what this save persisted into the dirty baseline: on a
      // create the whole draft went in; on an update only the two correction
      // keys - clobbering the whole baseline would silently mark unrelated
      // pending edits (business name, persona, ...) as saved and lose them.
      if (wasCreate) {
        state.saved = JSON.parse(JSON.stringify(state.draft)) as Draft;
      } else {
        (state.saved as Draft).correction_source = (state.draft as Draft).correction_source;
        (state.saved as Draft).correction_endpoint = (state.draft as Draft).correction_endpoint;
      }
      return settingsGet();
    })
    .then((res) => {
      if (res) {
        const s = rec(res.settings);
        state.audio.sendAudio = isCodexLiveCallSource(d().llm_source) ? false : boolish(s.sendAudio);
        state.audio.audioTranscript = boolish(s.audioTranscript);
      }
      void toastApi().success('Audio settings saved', 'Applies when the receptionist next reconnects.');
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'save failed');
    })
    .then(() => {
      state.busy.audio = false;
      touch();
    });
}

export function saveWaiting(): void {
  state.busy.waiting = true;
  state.err = null;
  touch();
  const w = state.waiting;
  settingsSet({ holdAndCallWaiting: w.holdAndCallWaiting, autoHoldQueue: w.autoHoldQueue, autoConnectPhone: w.autoConnectPhone })
    .then(() => settingsGet())
    .then((res) => {
      if (res) {
        const s = rec(res.settings);
        w.holdAndCallWaiting = boolish(s.holdAndCallWaiting);
        w.autoHoldQueue = boolish(s.autoHoldQueue);
        w.autoConnectPhone = !(s.autoConnectPhone === false || s.autoConnectPhone === 'false');
      }
      void toastApi().success('Call waiting saved', 'Applies when the receptionist next reconnects.');
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'save failed');
    })
    .then(() => {
      state.busy.waiting = false;
      touch();
    });
}

export function saveScreening(): void {
  state.busy.screening = true;
  state.err = null;
  const wasCreate = !state.recordId;
  touch();
  const sc = state.screening;
  const newPin = sc.managerPin.trim();
  // managerPin: send ONLY when the operator typed a new one - a blank field
  // means "keep the current PIN", never wipe it (Remove PIN is explicit).
  const payload: Record<string, unknown> = {
    blockedNumbers: sc.blockedNumbers.trim(),
    acceptPattern: sc.acceptPattern.trim(),
    rejectPrivate: sc.rejectPrivate,
    screenMessage: sc.screenMessage.trim(),
    blockedMessage: sc.blockedMessage.trim(),
    autoBlockAbuse: sc.autoBlockAbuse,
    managerNumbers: sc.managerNumbers.trim(),
  };
  if (newPin) payload.managerPin = newPin;
  settingsSet(payload)
    .then(() => writeRecord({ whitelist_only: sc.whitelistOnly ? 'yes' : 'no', default_country_code: sc.defaultCountryCode.trim() }))
    .then(() => {
      // whitelist_only / default_country_code live on state.screening, NOT the
      // draft - so a normal screening save persists NO draft keys and must not
      // touch the dirty baseline. Only a first-save (which creates the whole
      // draft) makes the draft persisted.
      if (wasCreate) state.saved = JSON.parse(JSON.stringify(state.draft)) as Draft;
      return settingsGet();
    })
    .then((res) => {
      if (res) {
        const s = rec(res.settings);
        sc.blockedNumbers = typeof s.blockedNumbers === 'string' ? s.blockedNumbers : sc.blockedNumbers;
        sc.acceptPattern = typeof s.acceptPattern === 'string' ? s.acceptPattern : sc.acceptPattern;
        sc.rejectPrivate = boolish(s.rejectPrivate);
        sc.screenMessage = typeof s.screenMessage === 'string' ? s.screenMessage : sc.screenMessage;
        sc.blockedMessage = typeof s.blockedMessage === 'string' ? s.blockedMessage : sc.blockedMessage;
        sc.autoBlockAbuse = !(s.autoBlockAbuse === false || s.autoBlockAbuse === 'false');
        sc.managerNumbers = typeof s.managerNumbers === 'string' ? s.managerNumbers : sc.managerNumbers;
        sc.managerPin = '';
        sc.managerPinSet = res.managerPinSet === true;
      }
      void toastApi().success('Call screening saved', 'Applies on the next incoming call.');
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'save failed');
    })
    .then(() => {
      state.busy.screening = false;
      touch();
    });
}

export function removePin(): void {
  state.busy.screening = true;
  state.err = null;
  touch();
  settingsSet({ managerPin: '' })
    .then(() => {
      state.screening.managerPin = '';
      state.screening.managerPinSet = false;
      void toastApi().success('Manager PIN removed', 'The manager line is read-only until a new PIN is set.');
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'save failed');
    })
    .then(() => {
      state.busy.screening = false;
      touch();
    });
}

export function doSave(): void {
  state.busy.save = true;
  state.err = null;
  touch();
  persistDraft()
    .then(() => {
      void toastApi().success('Settings saved', 'Applied automatically at the next incoming call.');
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'save failed');
    })
    .then(() => {
      state.busy.save = false;
      touch();
    });
}

export function doSaveApply(): void {
  state.busy.apply = true;
  state.err = null;
  touch();
  persistDraft()
    .then(() => {
      if (d().active === 'no') {
        void toastApi().info('Saved (marked inactive)', 'This record is inactive, so it was not pushed to the receptionist.');
        return;
      }
      // The composed payload NEVER carries a PIN: composeAgentPayload reads
      // only the draft fields (persona/greeting/voice/model/endpoints).
      return settingsSet(currentAgentPayload())
        .then(refreshRunning)
        .then(() => {
          void toastApi().success('Applied to the receptionist', 'The very next call uses this configuration.');
        });
    })
    .catch((e: unknown) => {
      state.err = messageOf(e, 'apply failed');
    })
    .then(() => {
      state.busy.apply = false;
      touch();
    });
}

// -- edit actions (the original's delegated input/change/click handlers) --

export function draftInput(key: keyof Draft, value: string): void {
  const codexModel = codexLiveCallModel(d().llm_source);
  if (key === 'model' && codexModel) {
    setDraft({ model: codexModel });
    touch();
    return;
  }
  setDraft({ [key]: value } as Partial<Draft>);
  touch();
}

export type ScreeningTextKey =
  | 'blockedNumbers'
  | 'acceptPattern'
  | 'screenMessage'
  | 'blockedMessage'
  | 'managerNumbers'
  | 'managerPin'
  | 'defaultCountryCode';

export function screeningInput(key: ScreeningTextKey, value: string): void {
  state.screening[key] = value;
  touch();
}

export type ScreeningBoolKey = 'rejectPrivate' | 'autoBlockAbuse' | 'whitelistOnly';

export function screeningToggle(key: ScreeningBoolKey, checked: boolean): void {
  state.screening[key] = checked;
  touch();
}

export function engineModelDirInput(value: string): void {
  state.engine.modelDir = value;
  state.engine.customDir = true;
  touch();
}

export function laneUrlInput(lane: Lane, value: string): void {
  setDraft({ [lane + '_endpoint']: value } as Partial<Draft>);
  touch();
}

export function laneChange(lane: Lane, value: string): void {
  const patch = { [lane + '_source']: value } as Partial<Draft>;
  const codexModel = lane === 'llm' ? codexLiveCallModel(value) : null;
  if (codexModel) patch.model = codexModel;
  setDraft(patch);
  enforceCodexTextOnly();
  touch();
}

export type WaitKey = 'autoConnectPhone' | 'holdAndCallWaiting' | 'autoHoldQueue';

export function waitChange(key: WaitKey, checked: boolean): void {
  state.waiting[key] = checked;
  if (key === 'holdAndCallWaiting' && !checked) state.waiting.autoHoldQueue = false;
  touch();
}

export function audioModeChange(v: string): void {
  state.audio.sendAudio = !isCodexLiveCallSource(d().llm_source) && (v === 'direct' || v === 'both');
  state.audio.audioTranscript = v === 'corrections' || v === 'both';
  touch();
}

export function engineChange(v: string): void {
  state.engine.engine = v;
  touch();
}

export function bundleChange(val: string): void {
  const sherpa = (state.catalog || []).filter((x) => x.id === 'sherpa')[0];
  const bundles = (sherpa && sherpa.bundles) || [];
  if (val === '__custom__') {
    state.engine.customDir = true;
  } else if (val === '') {
    state.engine.modelDir = '';
    state.engine.customDir = false;
    setDraft({ voice: '' });
  } else {
    const m = bundles.filter((b) => b.dir === val)[0];
    state.engine.modelDir = val;
    state.engine.customDir = false;
    setDraft({ voice: m ? m.name : baseName(val) });
  }
  touch();
}

export function unblock(num: string): void {
  const keep = splitList(state.screening.blockedNumbers).filter((x) => x !== num);
  state.screening.blockedNumbers = keep.join('\n');
  touch();
}

export function discard(): void {
  state.draft = JSON.parse(JSON.stringify(state.saved)) as Draft | null;
  enforceCodexTextOnly();
  touch();
}

export function toggleAdvanced(open: boolean): void {
  // Persists the native <details> open state across re-renders; the disclosure
  // glyph itself is CSS-driven off [open].
  state.showAdvanced = open;
  touch();
}

export function refreshRunningClick(): void {
  void refreshRunning().then(touch);
}

// -- boot --

export function loadAll(): Promise<void> {
  return FormLogic.presence()
    .then((p) => {
      state.presence = p || { kind: 'none' };
    })
    .catch(() => {
      /* keep the default presence */
    })
    .then(() => Promise.all([FormLogic.can('connector.aokie.settings.get'), FormLogic.can('connector.aokie.settings.set')]))
    .then((g) => {
      state.canGet = g[0] === true;
      state.canSet = g[1] === true;
    })
    .then(() =>
      Promise.all([
        loadRecord(),
        FormLogic.aiSources()
          .then((a) => {
            state.aiSources = a as unknown as AiSource[] | null;
          })
          .catch(() => {
            state.aiSources = null;
          }),
      ]),
    )
    .then(() => FormLogic.currentUser())
    .then((u) => {
      state.demo = !!(u && u.email === 'demo@formlogic.local');
    })
    .catch(() => {
      /* demo detection is best-effort */
    })
    .then(() => {
      // mayWrite mirrors canEdit/canSubmit: the server is the real gate; the
      // sandbox has no per-form record-perm read, so allow the attempt and let
      // the API refuse. Records() succeeding implies at least view.
      state.mayWrite = true;
      applySpeechDefaults();
    })
    .then(refreshRunning)
    .then(touch);
}
