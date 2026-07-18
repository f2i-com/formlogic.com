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
  voice: string;
  reply_mode: string;
  active: string;
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

/** COPY of aokieReceptionistPersona.ts DEFAULT_PERSONA - keep byte-identical
 *  (the backslash-u2014 escape IS the canonical em dash). */
export const DEFAULT_PERSONA =
  'You are Aokie, a warm, efficient phone receptionist for a small business, speaking out loud on a live phone call. If the caller asks who you are or your name, say you are Aokie, the automated receptionist - never invent a different name for yourself. Reply with ONE short, natural spoken sentence \u2014 no lists, markdown, or emoji. Your job: greet the caller, find out their name and how you can help, capture the key details (what they need, and a callback number or time if relevant), and either book them in or take a message. Ask only ONE clear question at a time and keep the conversation moving. IMPORTANT - only promise what actually happens: you take booking REQUESTS and messages for the team to confirm, so say things like I have noted that down and someone will confirm with you - NEVER say you will send a text, SMS, email, or confirmation yourself, and never claim something is booked, sent, or done, because you cannot send messages and bookings are confirmed by a person afterwards.';

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
  //  - 'provider:<id>' composes the fixed AI-gateway base (LLM lane only via
  //    providerOk - the gateway has no audio routes yet, speech lanes get '');
  //  - blank/'custom' falls back to the legacy custom-endpoint field.
  function lane(source: string, custom: string, path: string, providerOk: boolean): string | undefined {
    const src = source.trim();
    const url = custom.trim();
    if (!src || src === 'custom') return url;
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
  let persona = d.instructions.trim() || defaultPersona;
  const business = d.business_name.trim();
  if (business) persona = 'You are the phone receptionist for ' + business + '.\n' + persona;
  // BUSINESS INFO grounding - SAME composition as the pack flows
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
      ? 'Thank you for calling ' + business + '! How can I help you today?'
      : 'Thanks for calling! How can I help you today?';
  }
  const payload: Record<string, unknown> = {
    persona,
    greeting,
    ttsVoice: d.voice.trim(),
    aiModel: d.model.trim(),
    aiEndpoint: lane(d.llm_source, d.llm_endpoint, '/v1/chat/completions', true),
    // provider: picks are GATED off the speech lanes (providerOk=false) - the
    // gateway serves no audio routes yet; they resolve to '' (plugin default).
    sttEndpoint: lane(d.stt_source, d.stt_endpoint, '/v1/audio/transcriptions', false),
    ttsEndpoint: lane(d.tts_source, d.tts_endpoint, '/v1/audio/speech', false),
    // Correction lane (audioTranscript): a CHAT endpoint, so it composes with
    // the LLM lane's path. Blank source resolves to '' (corrections use the
    // main reply model). audioTranscriptModel is deliberately NOT pushed -
    // the chosen service owns its model.
    audioTranscriptEndpoint: lane(d.correction_source, d.correction_endpoint, '/v1/chat/completions', true),
    aiReceptionist: d.reply_mode !== 'flow',
  };
  // An unresolvable service pick (no Desktop list here - remote console)
  // omits its key: the per-call Configure flow resolves it on the desktop.
  for (const k of ['aiEndpoint', 'sttEndpoint', 'ttsEndpoint', 'audioTranscriptEndpoint']) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}
