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
  liveRoute,
  type Draft,
  type LiveRoute,
  type SourceService,
} from './agentPayload';
import {
  baseName,
  boolish,
  normalizeEngine,
  parseCatalog,
  rec,
  splitList,
  str,
  voiceMatchesEngine,
  voiceUsableByEngine,
  type CatalogEngine,
} from './helpers';

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
  /** Where the SAVED Aokie settings send calls (the plugin applies a route
   *  change when it next starts). */
  route: LiveRoute;
  voiceMode: 'flow' | 'standard' | 'desktop_realtime' | 'oaiy';
  voiceModeLabel: string;
  providerLabel: string;
  realtimeVoice: string;
  realtimeTurnDetection: string;
  appointmentToolsLabel: string;
  agentHangup: boolean;
  configVersion: number | undefined;
}

export interface EngineState {
  loaded: boolean;
  engine: string;
  modelDir: string;
  customDir: boolean;
  /** The engine the PLUGIN is actually running, as last read/saved.
   *  `engine` is the operator's pending pick: the two differ until "Save
   *  speech engine" is pressed, and the voice push must be judged against the
   *  engine that will really speak, not the one on screen. */
  savedEngine: string;
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
  /** The outbound-SMS kill switch (record field `sms_enabled`). Held here
   *  rather than on the draft because it is a policy field this card saves,
   *  like whitelistOnly - the agent payload never carries it. */
  smsEnabled: boolean;
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

/** The linked desktop, as the owner's registry last saw it (null = unknown:
 *  a member cannot read the registry, or there is no linked desktop). */
export interface DesktopSeen {
  deviceName: string;
  lastSeenAt: string | null;
}

/** What OAIY reports about itself through its AI gateway's source list
 *  (FormLogic.aiSources): its call voice service and its provider's model.
 *  Empty strings = not reported (an older OAIY, or no listing here). */
export interface OaiyReport {
  voiceStatus: string;
  model: string;
}

/** The outcome of the last push to Aokie that the operator should see:
 *  ok, a step still to take (restart, consent), or not applied at all. */
export interface ApplyNote {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
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
  runningRefreshing: boolean;
  err: string | null;
  aiSources: AiSource[] | null;
  catalog: CatalogEngine[] | null;
  engine: EngineState;
  audio: AudioState;
  waiting: WaitingState;
  screening: ScreeningState;
  showAdvanced: boolean;
  busy: BusyFlags;
  /** The raw live settings bag from the last good settings.get (null = none). */
  live: Record<string, unknown> | null;
  /** The record had no route and Aokie already sends calls to OAIY: the draft
   *  now says so, pending a save that records it for the follow-ups. */
  routeAdopted: boolean;
  /** The other-routes disclosure in the route card. */
  showOtherRoutes: boolean;
  desktop: DesktopSeen | null;
  applyNote: ApplyNote | null;
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
  background_ai_source: '',
  background_ai_model: '',
  voice: '',
  reply_mode: 'agent',
  active: 'yes',
  // A NEW record starts on OAIY, the recommended route. A saved record
  // without the field loads as '' (loadRecord), so no existing route moves.
  call_route: 'oaiy',
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
  runningRefreshing: false,
  err: null,
  aiSources: null,
  catalog: null,
  engine: { loaded: false, engine: '', modelDir: '', customDir: false, savedEngine: '' },
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
    // Absent reads as ON, matching the flows: every install that predates the
    // field is already texting, and a console that showed it off would be
    // describing behaviour the receptionist does not have.
    smsEnabled: true,
    defaultCountryCode: '',
  },
  showAdvanced: false,
  busy: {},
  live: null,
  routeAdopted: false,
  showOtherRoutes: false,
  desktop: null,
  applyNote: null,
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

/** The route the draft names ('oaiy' | 'aokie' | ''). */
export function route(): string {
  return String(d().call_route || '').trim();
}

/** The draft sends calls to OAIY: the lanes, voice and model are OAIY's. */
export function onOaiy(): boolean {
  return route() === 'oaiy';
}

/** Where the saved Aokie settings send calls, as last read ('unknown' before
 *  a read, or when it failed). */
export function liveCallRoute(): LiveRoute {
  return liveRoute(state.live);
}

/** OAIY's own report through its gateway's source list: the OAIY Voice
 *  service's run state and the model its provider answers with. */
export function oaiyReport(): OaiyReport {
  const out: OaiyReport = { voiceStatus: '', model: '' };
  const all = state.aiSources || [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.kind === 'service' && s.refId === 'oaiy-voice') out.voiceStatus = str(s.status);
    if (s.kind === 'provider' && s.refId === 'oaiy' && str(s.model).trim()) out.model = str(s.model).trim();
  }
  return out;
}

/** "12 min ago" for a server timestamp ('' when unknown). Zone-less MySQL
 *  stamps are UTC. */
export function agoText(at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return '';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? at.replace(' ', 'T') + 'Z' : at;
  const ms = Date.parse(iso);
  if (isNaN(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + (h === 1 ? ' hour ago' : ' hours ago');
  return Math.round(h / 24) + ' days ago';
}

/** Is OAIY reachable from this page right now? 'yes' when a desktop answers
 *  (this computer, or a linked one through the relay), 'no' when none does,
 *  'unknown' before the first presence read. */
export function reachable(): 'yes' | 'no' | 'unknown' {
  if (state.presence.kind === 'local' || state.presence.kind === 'remote') return 'yes';
  return state.presence.kind === 'none' ? 'no' : 'unknown';
}

/** One plain sentence for "OAIY can't be reached", with when and where it
 *  was last seen when the owner's registry says. */
export function unreachableText(): string {
  const seen = state.desktop;
  const ago = seen ? agoText(seen.lastSeenAt) : '';
  if (seen && ago) return "OAIY can't be reached. " + seen.deviceName + ' was last seen ' + ago + '.';
  return "OAIY can't be reached from this page.";
}

/** The engine on screen is not the one the plugin is running - the operator
 *  changed it and has not pressed "Save speech engine". Worth saying out loud:
 *  every OTHER control in this card (the voice, the bundle) is judged against
 *  the LIVE engine, so until this is saved the card describes two machines. */
export function engineUnsaved(): boolean {
  return state.engine.loaded && normalizeEngine(state.engine.engine) !== normalizeEngine(state.engine.savedEngine);
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

interface ConnectorFailure extends Error {
  code?: string;
  status?: string;
}

function connectorFailure(out: FlConnectorOutcome): ConnectorFailure {
  const detail = out.error && typeof out.error === 'object' ? out.error : {};
  const rawMessage = typeof detail.message === 'string' ? detail.message.trim() : '';
  const error = new Error(rawMessage || out.status || 'connector request failed') as ConnectorFailure;
  if (typeof detail.code === 'string') error.code = detail.code;
  error.status = out.status;
  return error;
}

/** A settings read is authoritative: a non-done outcome is a typed failure,
 *  never a null value that gets flattened into "the desktop did not respond". */
function settingsGet(): Promise<Record<string, unknown>> {
  return FormLogic.connector('aokie', 'settings.get', {}).then((out) => {
    if (out.status === 'done') return rec(out.result);
    throw connectorFailure(out);
  });
}

function settingsSet(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return FormLogic.connector('aokie', 'settings.set', payload).then((o) => {
    if (o.status === 'done') return rec(o.result);
    throw connectorFailure(o);
  });
}

/** Why a push to Aokie did not land, in words, and never a raw transport
 *  error: OAIY away (with when it was last seen), the relay giving up, a
 *  lost reply, or Aokie's own refusal message. */
function notAppliedReason(e: unknown): string {
  const failure = e as ConnectorFailure | null;
  const code = failure && typeof failure.code === 'string' ? failure.code : '';
  const status = failure && typeof failure.status === 'string' ? failure.status : '';
  if (code === 'connector_unavailable' || code === 'connector_missing') {
    if (state.presence.kind === 'none') return unreachableText();
    return 'Aokie is not running in OAIY.';
  }
  if (status === 'expired') return 'OAIY did not pick it up within a minute (it may be offline or asleep).';
  if (status === 'uncertain') return 'OAIY took it but has not confirmed it: press Refresh to see what Aokie is running.';
  return messageOf(e, 'Aokie refused it.');
}

/** A card's own push to Aokie failed: nothing changed on the phone. */
function notApplied(what: string, e: unknown): string {
  return what + ' not applied: ' + notAppliedReason(e) + ' Nothing changed on the phone; save again once OAIY is back.';
}

const ROUTE_KEYS = ['realtimeVoiceMode', 'realtimeVoiceEndpoint', 'realtimeVoiceDestination'];

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
  // OAIY owns the model, speech and voice: the composed payload is already
  // just the greeting, the brief and the route.
  if (onOaiy()) return payload;
  // Defense in depth for both newly selected and previously saved Codex
  // sources: Save & apply can never carry a stale direct-audio setting into
  // this chat-only provider. The Desktop/provider boundary enforces the same
  // rule, but the settings UI must also represent and persist it honestly.
  if (isCodexLiveCallSource(d().llm_source)) payload.sendAudio = false;
  // Never push a voice the LIVE engine cannot speak. Judged against
  // savedEngine, not the select on screen: "Save & apply" writes the record and
  // the agent payload but NOT ttsEngine (that is its own button), so a pending
  // sherpa pick would otherwise send a Piper bundle to a plugin still running
  // pocket. Blank rather than omitted - the key must actively reset a stale
  // live voice, and the plugin reads blank as "the engine default".
  if (state.engine.loaded && !voiceMatchesEngine(state.engine.savedEngine, str(payload.ttsVoice))) {
    payload.ttsVoice = '';
  }
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
  // Named Desktop providers can currently serve chat and transcription. TTS
  // remains service/custom-only until the gateway exposes an audio/speech
  // route with a compatible response shape.
  if (lane === 'llm' || lane === 'stt') {
    for (let p = 0; p < all.length; p++) {
      const pr = all[p];
      if (pr.kind !== 'provider' || !pr.enabled) continue;
      if (pr.capabilities.length > 0 && pr.capabilities.indexOf(cap) < 0) continue;
      // The generic Codex route is buffered for background work. Only its four
      // call-bounded variants belong in the live receptionist LLM picker.
      if (lane === 'llm' && pr.id === 'provider:openai-codex-agent') continue;
      opts.push({ value: pr.id, label: 'Provider: ' + pr.name });
    }
  }
  opts.push({ value: 'custom', label: 'Custom URL...' });
  opts.push({ value: '', label: 'Built-in (plugin fallback)' });
  return opts;
}

/** Chat providers available to asynchronous work. This is deliberately a
 * separate picker from the live-call LLM lane: a slower delegated ChatGPT /
 * Codex account is useful for drafts and analysis without adding caller delay.
 * API credentials remain in Desktop Services; the pack stores only the
 * provider reference. */
export function backgroundAiOptions(): LaneOption[] {
  const opts: LaneOption[] = [{ value: '', label: 'Automatic (flow default)' }];
  const all = state.aiSources || [];
  for (let i = 0; i < all.length; i++) {
    const provider = all[i];
    if (provider.kind !== 'provider' || !provider.enabled) continue;
    if (provider.capabilities.length > 0 && provider.capabilities.indexOf('chat') < 0) continue;
    // The four live-call adapters carry call-specific prompt and output bounds.
    // Background work uses the generic provider route instead.
    if (isCodexLiveCallSource(provider.id)) continue;
    opts.push({ value: provider.id, label: 'Provider: ' + provider.name });
  }
  return opts;
}

// -- loaders --

const REALTIME_PROVIDER_LABELS: Record<string, { provider: string; model: string }> = {
  'openai-gpt-realtime-2-1-mini': {
    provider: 'OpenAI GPT-Realtime-2.1 mini',
    model: 'gpt-realtime-2.1-mini',
  },
};

/** Extract only the non-secret provider id from an exact Desktop gateway URL.
 *  Custom URLs are deliberately reported as "Custom endpoint" instead of
 *  being echoed into the app (they may contain private hosts or credentials). */
function desktopProviderId(value: unknown, realtime: boolean): string {
  const endpoint = str(value).trim();
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    const ipHost = host.charAt(0) === '[' && host.charAt(host.length - 1) === ']' ? host.slice(1, -1) : host;
    const loopback = host === 'localhost' || ipHost === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
    if (!loopback || parsed.port !== '17872' || parsed.username || parsed.password) return '';
    const suffix = realtime ? '/v1/realtime/stream' : '/v1/chat/completions';
    const prefix = '/api/ai/providers/';
    if (!parsed.pathname.startsWith(prefix) || !parsed.pathname.endsWith(suffix)) return '';
    const encoded = parsed.pathname.slice(prefix.length, -suffix.length);
    if (!encoded || encoded.indexOf('/') >= 0 || /%(?:2f|5c|00)/i.test(encoded)) return '';
    const providerId = decodeURIComponent(encoded);
    return /^[A-Za-z0-9._-]{1,128}$/.test(providerId) ? providerId : '';
  } catch {
    return '';
  }
}

function sourceForProvider(providerId: string): AiSource | undefined {
  if (!providerId || !state.aiSources) return undefined;
  return state.aiSources.find((source) =>
    source.kind === 'provider'
      && (source.refId === providerId || source.id === 'provider:' + providerId),
  );
}

function sourceForServiceEndpoint(endpoint: string): AiSource | undefined {
  if (!endpoint || !state.aiSources) return undefined;
  return state.aiSources.find((source) =>
    source.kind === 'service'
      && !!source.url
      && endpoint.indexOf(source.url.replace(/\/$/, '') + '/') === 0,
  );
}

function runningProvider(s: Record<string, unknown>, realtime: boolean): { provider: string; model: string } {
  const endpoint = str(realtime ? s.realtimeVoiceEndpoint : s.aiEndpoint).trim();
  const providerId = desktopProviderId(endpoint, realtime);
  const known = REALTIME_PROVIDER_LABELS[providerId];
  const source = sourceForProvider(providerId);
  if (source) {
    return {
      provider: source.name || providerId,
      model: str(source.model).trim() || (known ? known.model : ''),
    };
  }
  if (known) return known;
  if (providerId) {
    return {
      provider: providerId.replace(/[._-]+/g, ' '),
      model: '',
    };
  }
  const service = !realtime ? sourceForServiceEndpoint(endpoint) : undefined;
  if (service) return { provider: service.name || 'Local service', model: str(service.model).trim() };
  if (endpoint) return { provider: 'Custom endpoint', model: '' };
  return { provider: realtime ? 'Desktop provider not selected' : 'Automatic / built-in', model: '' };
}

function realtimeVoiceLabel(value: unknown): string {
  const voice = str(value).trim();
  return voice ? voice.charAt(0).toUpperCase() + voice.slice(1) : 'Marin';
}

function realtimeTurnLabel(value: unknown): string {
  if (value === 'semantic_vad') return 'Semantic VAD';
  return 'Server VAD';
}

function friendlyRunningError(error: unknown): string {
  const failure = error as ConnectorFailure | null;
  const code = failure && typeof failure.code === 'string' ? failure.code : '';
  const status = failure && typeof failure.status === 'string' ? failure.status : '';
  const raw = messageOf(error, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const lower = raw.toLowerCase();

  if (code === 'connector_unavailable') {
    if (lower.indexOf('crash') >= 0) {
      return 'Aokie has crashed in OAIY. Restart it in OAIY > Plugins, then press Refresh.';
    }
    if (lower.indexOf('stopped') >= 0 || lower.indexOf('not running') >= 0 || lower.indexOf('start it') >= 0) {
      return 'Aokie is stopped or restarting in OAIY. Start it in OAIY > Plugins, then press Refresh.';
    }
    if (state.presence.kind === 'local') {
      return 'OAIY is connected, but Aokie is not available. Start or restart Aokie in OAIY > Plugins, then press Refresh.';
    }
    if (state.presence.kind === 'none') {
      return unreachableText() + ' The receptionist on that computer keeps answering calls; press Refresh once it is back.';
    }
    return 'The linked OAIY cannot reach Aokie right now. Check OAIY, then press Refresh.';
  }
  if (status === 'expired') {
    return 'OAIY did not answer the relay within a minute. Check that it is online, then press Refresh.';
  }
  if (status === 'uncertain') {
    return 'OAIY took the read but its reply was lost. Press Refresh to try again.';
  }
  if (raw) return 'Aokie refused the live settings read. Check it in OAIY > Plugins > Aokie, then press Refresh.';
  return 'The live settings could not be read. Check OAIY and Aokie, then press Refresh.';
}

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
    state.engine = {
      loaded: true,
      engine: str(s.ttsEngine),
      modelDir: str(s.ttsModelDir),
      customDir: false,
      savedEngine: str(s.ttsEngine),
    };
    // FIRST read only: a record written before this rule existed can hold a
    // voice the live engine cannot speak. The pocket picker has no option for
    // a bundle name, so the select would show "Default" while the record still
    // said Jenny - two different answers to the same question. Normalize the
    // WORKING draft to what the card actually shows, and leave the saved
    // baseline alone so the correction is visibly pending until saved (same
    // treatment enforceCodexTextOnly gives a stale Codex model).
    if (state.draft && !voiceUsableByEngine(state.engine.engine, d().voice, parseCatalog(res.ttsVoiceCatalog))) {
      setDraft({ voice: '' });
    }
  } else {
    // A later read still refreshes what the plugin IS running, without
    // discarding a pending pick the operator has not saved yet.
    state.engine.savedEngine = str(s.ttsEngine);
  }
  state.catalog = parseCatalog(res.ttsVoiceCatalog);
  state.live = s;
  const where = liveRoute(s);
  const realtime = str(s.realtimeVoiceMode) === 'desktop_realtime';
  const toOaiy = where === 'oaiy';
  const aiReceptionist = boolish(s.aiReceptionist);
  const provider = runningProvider(s, realtime);
  const report = oaiyReport();
  state.running = {
    greeting: str(s.greeting),
    persona: str(s.persona),
    voice: toOaiy
      ? (report.voiceStatus ? 'OAIY Voice (' + report.voiceStatus + ') - the voice chosen in OAIY' : 'The voice chosen in OAIY')
      : realtime ? realtimeVoiceLabel(s.realtimeVoice) : str(s.ttsVoice),
    model: toOaiy
      ? (report.model || 'Chosen in OAIY > Engines')
      : realtime ? (provider.model || 'Managed by the desktop provider') : (str(s.aiModel) || provider.model || 'Automatic'),
    aiReceptionist,
    route: where,
    voiceMode: toOaiy ? 'oaiy' : !aiReceptionist ? 'flow' : realtime ? 'desktop_realtime' : 'standard',
    voiceModeLabel: toOaiy
      ? 'OAIY (this computer)'
      : !aiReceptionist
        ? 'Flow-driven replies'
        : realtime
          ? 'Realtime provider via OAIY'
          : "Aokie's own speech (STT -> LLM -> TTS)",
    providerLabel: toOaiy
      ? 'OAIY Front desk agent'
      : !aiReceptionist ? 'Not used for live replies' : provider.provider,
    realtimeVoice: realtimeVoiceLabel(s.realtimeVoice),
    realtimeTurnDetection: realtimeTurnLabel(s.realtimeTurnDetection),
    appointmentToolsLabel: !aiReceptionist
      ? 'Handled by FormLogic flows'
      : toOaiy
        ? 'Booking requests + lookups answered by FormLogic flows'
        : realtime
          ? 'Realtime lookup + booking requests via FormLogic'
          : 'Lookup + booking requests via FormLogic flows',
    agentHangup: boolish(s.agentHangup),
    configVersion: typeof res.configVersion === 'number' ? res.configVersion : undefined,
  };
  // Existing installs: a record saved before routes existed has none. When
  // Aokie already sends calls to OAIY, the console says so and the draft
  // follows (pending, so it is visibly unsaved until the operator saves - the
  // follow-ups read the SAVED route to leave callbacks to OAIY). Any other
  // live route is left alone: the route card offers "Use OAIY" instead.
  if (
    toOaiy && state.draft && state.saved && state.recordId
    && String(state.saved.call_route || '').trim() === '' && route() === ''
  ) {
    setDraft({ call_route: 'oaiy' });
    state.routeAdopted = true;
  }
}

let runningReadGeneration = 0;

export function refreshRunning(): Promise<void> {
  if (!state.canGet) return Promise.resolve();
  const generation = ++runningReadGeneration;
  state.runningRefreshing = true;
  state.runningError = null;
  touch();
  return FormLogic.presence()
    .then((presence) => {
      if (generation === runningReadGeneration && presence) state.presence = presence;
    })
    .catch(() => undefined)
    .then(settingsGet)
    .then((res) => {
      if (generation !== runningReadGeneration) return;
      seedFromSettings(res);
      state.runningError = null;
    })
    .catch((e: unknown) => {
      if (generation !== runningReadGeneration) return;
      state.running = null;
      state.live = null;
      state.runningError = friendlyRunningError(e);
    })
    .then(() => {
      if (generation !== runningReadGeneration) return;
      state.runningRefreshing = false;
      touch();
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
      // Only a NEW record starts on OAIY. A saved record without a route (it
      // predates the field) keeps '' = the route set in Aokie, never moved.
      if (newest && typeof a.call_route !== 'string') nd.call_route = '';
      state.draft = nd;
      state.saved = JSON.parse(JSON.stringify(nd)) as Draft;
      // A record may have been written before this UI learned the Codex
      // provider contract. Normalize the working draft (but leave the saved
      // baseline intact so the fixed model is visibly pending until saved).
      enforceCodexTextOnly();
      state.recordId = newest ? newest.id : null;
      // Record-side screening fields (whitelist mode + country code).
      state.screening.whitelistOnly = String(a.whitelist_only || '') === 'yes';
      // Only an explicit 'no' switches it off - same rule the flows apply, so
      // the console and the receptionist can never disagree about it.
      state.screening.smsEnabled = String(a.sms_enabled || 'yes') !== 'no';
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
      // The pick is now what the plugin runs, so the voice push is judged
      // against it from here on.
      state.engine.savedEngine = state.engine.engine;
      void toastApi().success('Speech engine updated');
    })
    .catch((e: unknown) => {
      void toastApi().error(notApplied('Speech engine', e));
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
  let pushed = false;
  settingsSet(payload)
    .then(() => {
      pushed = true;
      return writeRecord({ correction_source: d().correction_source.trim(), correction_endpoint: d().correction_endpoint.trim() });
    })
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
      state.err = pushed ? messageOf(e, 'save failed') : notApplied('Audio settings', e);
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
      state.err = notApplied('Call waiting', e);
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
  let pushed = false;
  settingsSet(payload)
    .then(() => (pushed = true))
    .then(() => writeRecord({
      whitelist_only: sc.whitelistOnly ? 'yes' : 'no',
      default_country_code: sc.defaultCountryCode.trim(),
      sms_enabled: sc.smsEnabled ? 'yes' : 'no',
    }))
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
      state.err = pushed ? messageOf(e, 'save failed') : notApplied('Call screening', e);
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
      state.err = notApplied('Removing the PIN', e);
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

/** What an applied payload means for the line: a route change waits for
 *  Aokie's next start, and a destination the consent grant does not cover
 *  pauses the receptionist until Consent is reviewed. */
function applyOutcome(payload: Record<string, unknown>, result: Record<string, unknown>, before: LiveRoute): ApplyNote {
  const blocked = typeof result.blocked === 'string' ? result.blocked.trim() : '';
  const toOaiy = payload.realtimeVoiceMode === 'desktop_realtime';
  if (blocked) {
    return {
      tone: 'bad',
      text: toOaiy
        ? "Saved, but Aokie paused the receptionist: its consent does not cover OAIY on this computer yet. In OAIY open Plugins > Aokie > Consent and accept OAIY as the destination; calls resume after that."
        : 'Saved, but Aokie paused the receptionist until its consent covers the new destination. Review it in OAIY > Plugins > Aokie > Consent.',
    };
  }
  const pending = Array.isArray(result.appliesAtReconnect) ? (result.appliesAtReconnect as unknown[]).map(String) : [];
  const routeMoves = pending.some((k) => ROUTE_KEYS.indexOf(k) >= 0)
    && (toOaiy ? before !== 'oaiy' : payload.realtimeVoiceMode === 'legacy' && (before === 'oaiy' || before === 'realtime'));
  if (routeMoves) {
    return {
      tone: 'warn',
      text: (toOaiy ? 'Saved. Calls move to OAIY' : "Saved. Calls move back to Aokie's own speech")
        + ' when the receptionist restarts: restart it in OAIY > Plugins > Aokie (between calls).',
    };
  }
  return { tone: 'ok', text: 'Applied. The very next call uses this configuration.' };
}

export function doSaveApply(): void {
  state.busy.apply = true;
  state.err = null;
  state.applyNote = null;
  touch();
  let saved = false;
  const before = liveCallRoute();
  persistDraft()
    .then(() => {
      saved = true;
      if (d().active === 'no') {
        void toastApi().info('Saved (marked inactive)', 'This record is inactive, so it was not pushed to the receptionist.');
        return;
      }
      // The composed payload NEVER carries a PIN: composeAgentPayload reads
      // only the draft fields (persona/greeting/voice/model/endpoints/route).
      const payload = currentAgentPayload();
      return settingsSet(payload)
        .then((result) => {
          state.applyNote = applyOutcome(payload, result, before);
          state.routeAdopted = false;
          return refreshRunning();
        })
        .then(() => {
          if (state.applyNote && state.applyNote.tone === 'ok') {
            void toastApi().success('Applied to the receptionist', 'The very next call uses this configuration.');
          }
        });
    })
    .catch((e: unknown) => {
      if (saved) {
        // The record is saved; only the push missed. The Configure
        // Receptionist flow re-applies the saved record on every incoming
        // call, so it lands on its own once OAIY is back.
        state.applyNote = {
          tone: 'warn',
          text: 'Saved in FormLogic, not applied yet: ' + notAppliedReason(e)
            + ' It applies on the next incoming call once OAIY is back (the Configure Receptionist flow re-applies it).',
        };
      } else {
        state.err = messageOf(e, 'apply failed');
      }
    })
    .then(() => {
      state.busy.apply = false;
      touch();
    });
}

/** "Use OAIY": the explicit, one-click move of this receptionist to OAIY.
 *  Sets the route and saves + applies it (a saved non-OAIY route is never
 *  moved any other way). Without the settings.set grant it only saves: the
 *  Configure Receptionist flow applies it on the next call. */
export function useOaiy(): void {
  setDraft({ call_route: 'oaiy' });
  state.showOtherRoutes = false;
  if (state.canSet) doSaveApply();
  else doSave();
}

export function routeChange(value: string): void {
  setDraft({ call_route: value === 'oaiy' || value === 'aokie' ? value : '' });
  state.routeAdopted = false;
  touch();
}

export function toggleOtherRoutes(open: boolean): void {
  state.showOtherRoutes = open;
  touch();
}

/** The owner's linked desktops, for "last seen" when OAIY is away. Owner-only
 *  (a member's refusal, or an older host without the service lane, leaves
 *  it unknown). Never throws. */
function loadDesktop(): Promise<void> {
  const sdk = FormLogic as unknown as { service?: (op: string, input?: Record<string, unknown>) => Promise<FlServiceOutcome> };
  if (typeof sdk.service !== 'function') return Promise.resolve();
  return sdk.service('desktop.connections.list', {})
    .then((out) => {
      if (!out || out.status !== 'done') return;
      const list = rec(out.result).connections;
      let best: DesktopSeen | null = null;
      let bestAt = -1;
      for (const row of Array.isArray(list) ? list : []) {
        const r = rec(row);
        const at = str(r.lastSeenAt);
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? at.replace(' ', 'T') + 'Z' : at;
        const ms = at ? Date.parse(iso) : NaN;
        const t = isNaN(ms) ? 0 : ms;
        if (best === null || t > bestAt) {
          best = { deviceName: str(r.deviceName).trim() || 'OAIY', lastSeenAt: at || null };
          bestAt = t;
        }
      }
      state.desktop = best;
    })
    .catch(() => undefined);
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

export type ScreeningBoolKey = 'rejectPrivate' | 'autoBlockAbuse' | 'whitelistOnly' | 'smsEnabled';

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

export function backgroundAiChange(value: string): void {
  const patch: Partial<Draft> = { background_ai_source: value };
  // Desktop-owned Codex routes pin their own supported model. Never carry a
  // stale generic override into one of those routes.
  if (isCodexLiveCallSource(value)) patch.background_ai_model = '';
  setDraft(patch);
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
  // The engine is a LIVE plugin setting and the voice rides the RECORD, saved
  // by a different button - so the two drift apart the moment one is saved
  // without the other. Downstream that drift is silent: the plugin now refuses
  // a voice belonging to the other engine and speaks the engine default, so a
  // stale pick here would show a voice on screen that no caller ever hears.
  // Clear it and let the new engine's default stand, which is what the picker
  // below now offers anyway.
  if (!voiceUsableByEngine(v, d().voice, state.catalog)) setDraft({ voice: '' });
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
  state.routeAdopted = false;
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
  void refreshRunning();
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
        loadDesktop(),
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
