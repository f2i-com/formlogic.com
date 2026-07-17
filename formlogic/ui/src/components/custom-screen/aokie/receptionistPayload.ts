// Receptionist Settings → plugin payload composition (console side).
//
// buildAgentPayload is the console MIRROR of the pack's FLOW_AGENT_CONFIG
// (aokieReceptionistPack.ts): "Save & apply now" pushes EXACTLY what the
// per-call Configure Receptionist flow would push, so the two can never
// disagree about what the bot should run. Kept in its own module (no React,
// no SDK imports) so the pack contract test can pin the parity byte-for-byte.
import { DEFAULT_PERSONA } from '../../../data/packs/aokieReceptionistPack';

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
  voice: string;
  reply_mode: string;
  active: string;
}

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
  voice: '',
  reply_mode: 'agent',
  active: 'yes',
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
 *  the same literal inside the pack's FLOW_AGENT_CONFIG. */
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
 *    the per-call flow. LLM lane only (`providerOk`): the gateway has no
 *    audio routes yet, so STT/TTS provider picks resolve to '' (plugin
 *    default) until those exist.
 *  - blank/'custom' → the legacy custom-endpoint field.
 */
function laneUrl(
  source: string,
  custom: string,
  path: string,
  services: SourceService[] | undefined,
  providerOk: boolean,
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
  if (src.startsWith('provider:')) {
    if (!providerOk) return '';
    return AI_GATEWAY_BASE + encodeURIComponent(src.slice(9)) + path;
  }
  return url;
}

/**
 * The settings.set payload for a draft — the SAME composition rule as the
 * pack's Configure Receptionist flow (FLOW_AGENT_CONFIG), so "apply now" and
 * the per-call flow can never disagree about what the bot should run.
 */
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
    aiEndpoint: laneUrl(d.llm_source, d.llm_endpoint, '/v1/chat/completions', services, true),
    // provider: picks are GATED off the speech lanes (providerOk=false) — the
    // gateway serves no audio routes yet; they resolve to '' (plugin default).
    sttEndpoint: laneUrl(d.stt_source, d.stt_endpoint, '/v1/audio/transcriptions', services, false),
    ttsEndpoint: laneUrl(d.tts_source, d.tts_endpoint, '/v1/audio/speech', services, false),
    aiReceptionist: d.reply_mode !== 'flow',
  };
  // An unresolvable service pick (no Desktop list here — remote console)
  // omits its key: the per-call Configure flow resolves it on the desktop.
  for (const k of ['aiEndpoint', 'sttEndpoint', 'ttsEndpoint']) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}
