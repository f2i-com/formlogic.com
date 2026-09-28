// Receptionist Settings → plugin payload composition (console side).
//
// buildAgentPayload is the console MIRROR of the pack's FLOW_AGENT_CONFIG
// (aokieReceptionistPack.ts): "Save & apply now" pushes EXACTLY what the
// per-call Configure Receptionist flow would push, so the two can never
// disagree about what the bot should run. Kept in its own module (no React,
// no SDK imports) so the pack contract test can pin the parity byte-for-byte.
// DEFAULT_PERSONA comes from the LEAF module (not the pack) so this file never
// imports the pack — keeping `pack → settingsScreen → receptionistPayload` acyclic.
import { DEFAULT_PERSONA } from './persona';

/** The Receptionist Settings record fields the console edits. */
export interface Draft {
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
  /** Correction lane (audioTranscript side runs): '' = the main reply model,
   *  'service:<id>' = a chat-capable Desktop service, 'custom' = the
   *  correction_endpoint URL. Composed into `audioTranscriptEndpoint`. */
  correction_source: string;
  correction_endpoint: string;
  background_ai_source: string;
  background_ai_model: string;
  voice: string;
  reply_mode: string;
  active: string;
  /** Where calls go (see CALL_ROUTES): 'oaiy' = OAIY on this computer (its
   *  Front desk agent talks, OAIY hears and speaks); 'aokie' = Aokie's own
   *  speech lanes picked below; '' = leave the route set in Aokie alone (a
   *  record saved before this field existed). */
  call_route: string;
}

/** The call routes a record can name. */
export const CALL_ROUTES = ['oaiy', 'aokie', ''] as const;

/** OAIY's realtime route, exactly as Aokie's own receptionist screen writes
 *  it: Desktop realtime mode, the provider "oaiy" on the voice gateway's
 *  fixed port, and OAIY on this computer as the processor the consent grant
 *  names. OAIY ignores the provider segment but Aokie requires the shape. */
export const OAIY_PROVIDER_ID = 'oaiy';
export const OAIY_REALTIME_ENDPOINT = 'ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream';
export const OAIY_DESTINATION = 'https://oaiy.localhost';

export const EMPTY_DRAFT: Draft = {
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
  // '' = what a record saved before the field existed composes to: the
  // payload leaves Aokie's route alone. The console starts a NEW record on
  // 'oaiy' (its own EMPTY), never an existing one.
  call_route: '',
};

/** The lane shape buildAgentPayload resolves `service:<id>` picks against —
 *  the flow node's listing (id + loopback url while running). */
export interface SourceService {
  id: string;
  name: string;
  category: string;
  status: string;
  url: string;
}

/** The desktop AI gateway's FIXED loopback port — `provider:<id>` picks compose
 *  `http://127.0.0.1:17872/api/ai/providers/<id>/v1/...` against it (the
 *  per-provider OpenAI-protocol routes in the desktop's http.rs). Must match
 *  the same literal inside the pack's FLOW_AGENT_CONFIG AND the desktop
 *  panel's AI_GATEWAY_BASE (formlogic/desktop/src/aokie/aokieSettings.ts) —
 *  keep all three in lock-step. */
export const AI_GATEWAY_BASE = 'http://127.0.0.1:17872/api/ai/providers/';

/**
 * Resolve one lane's endpoint — the SAME rule as the pack flow's laneUrl
 * (FLOW_AGENT_CONFIG):
 *  - 'service:<id>' → the running service's URL + the lane's conventional path
 *    ('' while stopped — the plugin falls back to its default); `undefined`
 *    services (no Desktop list available, e.g. a remote console) → undefined:
 *    the caller OMITS the key and lets the per-call flow (which can resolve)
 *    own it.
 *  - 'provider:<id>' → the desktop AI gateway's per-provider OpenAI base +
 *    the lane path. The gateway port is FIXED (:17872), so this composes
 *    deterministically with NO listing — identical on remote consoles and in
 *    the per-call flow. Chat and transcription lanes opt in with
 *    `providerOk`; Desktop injects the selected transcription provider's
 *    configured model and credential. TTS remains gated to '' (plugin
 *    default) until a compatible audio/speech route exists.
 *  - blank/'custom' → the legacy custom-endpoint field. For the LLM lane
 *    only, a completely blank source + endpoint means "leave the plugin's
 *    current LLM choice alone"; an explicit `custom` selection (including an
 *    intentionally blank URL) still applies.
 */
function laneUrl(
  source: string,
  custom: string,
  path: string,
  services: SourceService[] | undefined,
  providerOk: boolean,
  preserveBlank = false,
): string | undefined {
  const src = source.trim();
  const url = custom.trim();
  if (!src) return preserveBlank && !url ? undefined : url;
  if (src === 'custom') return url;
  if (src.startsWith('service:')) {
    if (!services) return undefined;
    const sid = src.slice(8);
    const svc = services.find((x) => x.id === sid && x.url);
    return svc ? svc.url + path : '';
  }
  if (src.startsWith('provider:')) {
    if (!providerOk) return '';
    return AI_GATEWAY_BASE + encodeURIComponent(src.slice(9)) + path;
  }
  return url;
}

/**
 * The correction lane (audioTranscript side runs) resolved to the plugin's
 * `audioTranscriptEndpoint` setting — the plugin's correction client is the
 * SAME LlmClient as the reply lane, so it wants a full `/v1/chat/completions`
 * URL (agent.rs `LlmClient::new`). '' = blank = the main reply model; the
 * console never pushes `audioTranscriptModel` (the chosen service owns its
 * model — desktop service cards pick it). Exported so the console's audio
 * card can push the exact value the per-call flow would compose.
 */
export function resolveCorrectionEndpoint(
  source: string,
  custom: string,
  services?: SourceService[],
): string | undefined {
  return laneUrl(source, custom, '/v1/chat/completions', services, true);
}

/**
 * SELF-CONTAINED payload composer — the ONE source of truth for
 * buildAgentPayload AND the pack-owned Receptionist Settings screen's embedded
 * copy. It has NO cross-scope free identifiers: `laneUrl` is an inner function,
 * and the two constants it needs (the default persona and the AI-gateway base)
 * arrive as PARAMETERS. That makes `composeAgentPayload.toString()` safe to
 * embed into a sandboxed code screen even against a production-MINIFIED bundle
 * (a minifier renaming a module-scope helper can't desync the embed, because
 * there are no module-scope references to rename) — the same structural
 * guarantee the transcript screen's self-contained `compareTurns` embed relies
 * on. The composition rule mirrors the pack's Configure Receptionist flow
 * (FLOW_AGENT_CONFIG in aokieReceptionistPack.ts): keep all three in lock-step;
 * the parity tests pin flow ≡ buildAgentPayload ≡ embedded copy.
 */
export function composeAgentPayload(
  d: Draft,
  services: SourceService[] | undefined,
  defaultPersona: string,
  gatewayBase: string,
): Record<string, unknown> {
  // Inner lane resolver - same rule as the module laneUrl, but services and
  // gatewayBase are closed-over params (no free identifiers). ASCII-only: this
  // function is embedded verbatim into the sandbox screen via toString(), and
  // the check-pack-screens gate rejects non-ASCII arrows/dashes in screen code.
  function lane(source: string, custom: string, path: string, providerOk: boolean, preserveBlank: boolean): string | undefined {
    const src = source.trim();
    const url = custom.trim();
    if (!src) return preserveBlank && !url ? undefined : url;
    if (src === 'custom') return url;
    if (src.indexOf('service:') === 0) {
      if (!services) return undefined;
      const sid = src.slice(8);
      const svc = services.find((x) => x.id === sid && x.url);
      return svc ? svc.url + path : '';
    }
    if (src.indexOf('provider:') === 0) {
      if (!providerOk) return '';
      return gatewayBase + encodeURIComponent(src.slice(9)) + path;
    }
    return url;
  }
  const route = String(d.call_route || '').trim();
  const toOaiy = route === 'oaiy';
  // On the OAIY route the persona is the RECEPTIONIST BRIEF: OAIY gives it to
  // its Front desk agent, whose own brief and call instructions come first.
  // The default persona is business context written for exactly that (no
  // name, no sentence rules), so it is the blank-brief fallback on every route.
  let persona = d.instructions.trim() || defaultPersona;
  const business = d.business_name.trim();
  if (business) persona = 'You are the phone receptionist for ' + business + '.' + (persona ? '\n' + persona : '');
  // BUSINESS INFO grounding - SAME composition as the pack flows
  // (BUSINESS_INFO_BLOCK_JS in aokieReceptionistPack.ts); keep in lock-step.
  const info = d.business_info.trim().slice(0, 4000);
  if (info) {
    persona +=
      (persona ? '\n\n' : '') + 'BUSINESS INFO - the ONLY facts about the business you may share:\n' + info +
      '\nAnswer questions about services, menu, prices, opening hours or policies ONLY from this info, quoting details exactly. If something is not covered here, say you will have the team confirm it - NEVER invent business details.';
  }
  let greeting = d.greeting.trim();
  if (!greeting) {
    greeting = business
      ? 'Thank you for calling ' + business + '! How can I help you today?'
      : 'Thanks for calling! How can I help you today?';
  }
  if (toOaiy) {
    // OAIY answers: its voice gateway hears and speaks, the model is the one
    // chosen in OAIY's Engines and the Front desk agent does the talking. The
    // lanes, the voice and the model are OAIY's, so none of them is pushed
    // (Aokie ignores them on this route, and a pushed lane would only fight
    // what OAIY chose). Aokie refuses Desktop realtime without the AI
    // receptionist on, the endpoint and the destination, so all four go
    // together. The route keys apply when the receptionist next starts.
    return {
      persona,
      greeting,
      aiReceptionist: true,
      realtimeVoiceMode: 'desktop_realtime',
      realtimeVoiceEndpoint: gatewayBase.replace(/^http/, 'ws') + 'oaiy/v1/realtime/stream',
      realtimeVoiceDestination: 'https://oaiy.localhost',
    };
  }
  const ownsAiEndpoint = d.llm_source.trim() !== '' || d.llm_endpoint.trim() !== '';
  const ownsAiModel = ownsAiEndpoint || d.model.trim() !== '';
  const payload: Record<string, unknown> = {
    persona,
    greeting,
    ttsVoice: d.voice.trim(),
    // Model ownership follows the LLM lane. A fully blank/default record must
    // not clear a model selected directly in Desktop; a legacy model-only
    // record and every explicit endpoint/source still apply.
    aiModel: ownsAiModel ? d.model.trim() : undefined,
    // A blank pack record does not own the Desktop/plugin LLM choice. Omit
    // aiEndpoint so a connector selected directly in Desktop survives both
    // Save & apply and the per-call Configure Receptionist flow. Any explicit
    // provider/service/custom selection still returns a value and applies.
    aiEndpoint: lane(d.llm_source, d.llm_endpoint, '/v1/chat/completions', true, true),
    // Desktop owns the selected transcription provider's model + credential;
    // Aokie only stores and applies the named provider endpoint.
    sttEndpoint: lane(d.stt_source, d.stt_endpoint, '/v1/audio/transcriptions', true, false),
    // TTS remains gated until the provider gateway serves audio/speech.
    ttsEndpoint: lane(d.tts_source, d.tts_endpoint, '/v1/audio/speech', false, false),
    // Correction lane (audioTranscript): a CHAT endpoint, so it composes with
    // the LLM lane's path. Blank source resolves to '' (corrections use the
    // main reply model). audioTranscriptModel is deliberately NOT pushed -
    // the chosen service owns its model.
    audioTranscriptEndpoint: lane(d.correction_source, d.correction_endpoint, '/v1/chat/completions', true, false),
    aiReceptionist: d.reply_mode !== 'flow',
  };
  // An explicit choice of Aokie's own speech lanes takes calls back from a
  // realtime route (OAIY's or another provider's). A record with no route
  // ('' - saved before routes existed) leaves the realtime keys alone.
  if (route === 'aokie') payload.realtimeVoiceMode = 'legacy';
  // An unresolvable service pick (no Desktop list here - remote console)
  // omits its key: the per-call Configure flow resolves it on the desktop.
  for (const k of ['aiModel', 'aiEndpoint', 'sttEndpoint', 'ttsEndpoint', 'audioTranscriptEndpoint']) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}

/** Where saved Aokie settings send calls, the same reading Aokie's own
 *  receptionist screen makes (tabs/settings.js callRoute):
 *  'oaiy'     - Desktop realtime to the provider "oaiy" (OAIY answers);
 *  'realtime' - Desktop realtime to another provider;
 *  'local'    - Aokie's own speech lanes with its AI receptionist;
 *  'flows'    - no AI receptionist: flows or the operator speak;
 *  'unknown'  - nothing to read. */
export type LiveRoute = 'oaiy' | 'realtime' | 'local' | 'flows' | 'unknown';

/** The provider id in a Desktop realtime route URL, '' for anything else. */
export function realtimeProviderId(endpoint: unknown): string {
  try {
    const seg = new URL(String(endpoint || '').trim()).pathname.split('/');
    if (
      seg.length === 8 && seg[1] === 'api' && seg[2] === 'ai' && seg[3] === 'providers'
      && seg[5] === 'v1' && seg[6] === 'realtime' && seg[7] === 'stream'
    ) return decodeURIComponent(seg[4]);
  } catch {
    /* not a URL */
  }
  return '';
}

export function liveRoute(settings: Record<string, unknown> | null | undefined): LiveRoute {
  if (!settings || typeof settings !== 'object') return 'unknown';
  if (settings.realtimeVoiceMode === 'desktop_realtime') {
    return realtimeProviderId(settings.realtimeVoiceEndpoint) === OAIY_PROVIDER_ID ? 'oaiy' : 'realtime';
  }
  const on = settings.aiReceptionist;
  if (on === true || on === 'true') return 'local';
  if (on === false || on === 'false') return 'flows';
  return 'unknown';
}

/**
 * The settings.set payload for a draft — a thin wrapper over the self-contained
 * composeAgentPayload with the first-party constants bound. The console screen
 * and the existing parity test call THIS; the sandbox embeds composeAgentPayload.
 */
export function buildAgentPayload(d: Draft, services?: SourceService[]): Record<string, unknown> {
  return composeAgentPayload(d, services, DEFAULT_PERSONA, AI_GATEWAY_BASE);
}
