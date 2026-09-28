// Self-contained payload composition for the SANDBOXED Receptionist Settings
// screen. Screen sources may only import preact and sibling files, so the
// canonical modules (components/custom-screen/aokie/receptionistPayload.ts and
// data/packs/aokieReceptionistPersona.ts) CANNOT be imported here - this file
// carries copies that MUST stay behaviorally identical. The parity tests in
// aokieReceptionistSettingsScreenTsx.test.ts import BOTH sides as modules and
// pin them: DEFAULT_PERSONA / AI_GATEWAY_BASE strict-equal, composeAgentPayload
// deep-equal across the whole case matrix. Change the canonical modules first,
// then mirror the change here.
//
// ASCII-only source: the default persona's single non-ASCII character (an em
// dash) is written as the backslash-u2014 escape so the produced STRING still
// strict-equals the canonical DEFAULT_PERSONA while this source file stays
// ASCII-clean for the pack-screen gate.

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
  /** Independent chat provider used only after/between calls for summaries,
   *  follow-up extraction and SMS drafting. The stored value is the desktop
   *  source id (`provider:<id>`); blank keeps the flow runner's default. */
  background_ai_source: string;
  /** Optional per-flow model override. Blank lets the provider profile choose. */
  background_ai_model: string;
  voice: string;
  reply_mode: string;
  active: string;
  /** Where calls go: 'oaiy' = OAIY on this computer; 'aokie' = Aokie's own
   *  speech lanes; '' = leave the route set in Aokie alone (a record saved
   *  before this field existed). */
  call_route: string;
}

/** COPY of receptionistPayload.ts's OAIY route constants - Aokie's own
 *  receptionist screen writes exactly these for "Send calls to OAIY". */
export const OAIY_PROVIDER_ID = 'oaiy';
export const OAIY_REALTIME_ENDPOINT = 'ws://127.0.0.1:17872/api/ai/providers/oaiy/v1/realtime/stream';
export const OAIY_DESTINATION = 'https://oaiy.localhost';

/** COPY of receptionistPayload.ts LiveRoute: where saved Aokie settings send calls. */
export type LiveRoute = 'oaiy' | 'realtime' | 'local' | 'flows' | 'unknown';

/** COPY of receptionistPayload.ts realtimeProviderId. */
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

/** COPY of receptionistPayload.ts liveRoute. */
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

/** The lane shape composeAgentPayload resolves `service:<id>` picks against -
 *  the flow node's listing (id + loopback url while running). */
export interface SourceService {
  id: string;
  name: string;
  category: string;
  status: string;
  url: string;
}

/** COPY of persona.ts DEFAULT_PERSONA - keep byte-identical (both are locked
 *  to docs/contracts/aokie-persona.v1.json). */
export const DEFAULT_PERSONA =
  'A small business answers this phone. People call to ask a question, to book a time, or to leave a message for the team. Bookings made on a call are requests: someone from the team confirms each one with the caller afterwards. When someone needs a call back, the team needs their name, what it is about, and a good number and time to reach them.';

/** COPY of receptionistPayload.ts AI_GATEWAY_BASE - the desktop AI gateway's
 *  FIXED loopback port; `provider:<id>` picks compose against it. */
export const AI_GATEWAY_BASE = 'http://127.0.0.1:17872/api/ai/providers/';

/**
 * COPY of the canonical SELF-CONTAINED composer in receptionistPayload.ts (the
 * function buildAgentPayload wraps and the per-call Configure Receptionist flow
 * mirrors). NO cross-scope free identifiers: the lane resolver is an inner
 * function and the two constants arrive as PARAMETERS, exactly like the
 * canonical. Keep the body in lock-step - the parity tests deep-equal the
 * output for every source-pick / persona / greeting shape.
 */
export function composeAgentPayload(
  d: Draft,
  services: SourceService[] | undefined,
  defaultPersona: string,
  gatewayBase: string,
): Record<string, unknown> {
  // Inner lane resolver - same rule as the canonical module's laneUrl:
  //  - 'service:<id>' resolves the running service's URL + the lane path ('' while
  //    stopped); undefined services (no Desktop listing) resolves undefined so the
  //    caller OMITS the key and the per-call flow owns it;
  //  - 'provider:<id>' composes the fixed AI-gateway base when providerOk.
  //    Desktop supports chat and transcription providers; it injects the
  //    transcription profile's credential and configured model. TTS remains
  //    gated until a compatible audio/speech gateway route exists;
  //  - blank/'custom' falls back to the legacy custom-endpoint field. On the
  //    LLM lane only, completely blank preserves the plugin's current
  //    Desktop-selected LLM rather than clearing it.
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
  // On the OAIY route the persona is the RECEPTIONIST BRIEF: OAIY's Front
  // desk agent reads it after its own brief and call instructions. The default
  // persona is business context written for that, on every route.
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
    // chosen in OAIY's Engines, the Front desk agent talks. No lane, voice or
    // model is pushed. Aokie refuses Desktop realtime without all four keys.
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
    // A fully blank/default record preserves Desktop's model too. A legacy
    // model-only record and every explicit endpoint/source still apply.
    aiModel: ownsAiModel ? d.model.trim() : undefined,
    // Blank means this pack record does not own the Desktop/plugin LLM choice.
    // Explicit provider/service/custom picks still return a value and apply.
    aiEndpoint: lane(d.llm_source, d.llm_endpoint, '/v1/chat/completions', true, true),
    // A transcription provider is a complete Desktop-owned lane: the plugin
    // sends multipart audio and Desktop injects the provider profile's model
    // and credential. There is intentionally no separate Aokie STT-model key.
    sttEndpoint: lane(d.stt_source, d.stt_endpoint, '/v1/audio/transcriptions', true, false),
    // TTS provider picks are still gated to the plugin fallback.
    ttsEndpoint: lane(d.tts_source, d.tts_endpoint, '/v1/audio/speech', false, false),
    // Correction lane (audioTranscript): a CHAT endpoint, so it composes with
    // the LLM lane's path. Blank source resolves to '' (corrections use the
    // main reply model). audioTranscriptModel is deliberately NOT pushed -
    // the chosen service owns its model.
    audioTranscriptEndpoint: lane(d.correction_source, d.correction_endpoint, '/v1/chat/completions', true, false),
    aiReceptionist: d.reply_mode !== 'flow',
  };
  // An explicit choice of Aokie's own speech lanes takes calls back from a
  // realtime route; a record with no route leaves the realtime keys alone.
  if (route === 'aokie') payload.realtimeVoiceMode = 'legacy';
  // An unresolvable service pick (no Desktop list here - remote console)
  // omits its key: the per-call Configure flow resolves it on the desktop.
  for (const k of ['aiModel', 'aiEndpoint', 'sttEndpoint', 'ttsEndpoint', 'audioTranscriptEndpoint']) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}
