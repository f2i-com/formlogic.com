/**
 * Pure logic behind the Aokie connector settings panel (AokieCard.tsx):
 * defaults, tolerant parsing of a live `settings.get` bag, and the
 * dirty-field patch computation for saves.
 *
 * Kept free of React/Tauri imports so the cross-repo settings-schema
 * conformance suite (formlogic/ui, vitest) can import it directly.
 *
 * Safety invariants (audit AOK-SAFE-001):
 * - `autoAnswer` defaults to OFF everywhere. A missing or malformed key is
 *   treated as false, matching the plugin's own `auto_answer_from_settings`
 *   (explicit `true` / "true" arms it; anything else does not).
 * - Saves send ONLY fields the operator actually changed (the plugin's
 *   `settings.set` merges per key), so an unrelated settings edit can never
 *   rewrite a safety-relevant key, and unknown/newer plugin keys survive.
 */

/**
 * Every key the Aokie connector's settings bag understands (persona,
 * greeting, voice, model, barge-in tuning, …) — see aokie.com
 * `crates/aokie-plugin/src/connector.rs`. Kept flat and fully defaulted so
 * every field in the panel is always a controlled input.
 */
export interface AokieConnectorSettings {
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
  /** PAIR-001: legacy fixed-PIN ("0000") pairing for pre-SSP devices. OFF by
   *  default — it provides no authentication; enable only to bond an old
   *  device, then turn it back off. */
  legacyPairingPin: boolean;
}

export const AOKIE_SETTINGS_DEFAULTS: AokieConnectorSettings = {
  aiReceptionist: false,
  autoAnswer: false,
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
  legacyPairingPin: false,
};

/**
 * Parse a boolean setting the way the plugin does: real booleans pass
 * through, the legacy string forms "true"/"false" (present in shipped
 * settings.json files, accepted by the plugin's validator) coerce, and
 * anything else falls back — so the panel never displays "off" while the
 * plugin would treat the stored value as armed.
 */
function boolSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Merge a raw `settings.get`/`settings.set` payload over the client-side
 * defaults so every field is always defined (never leave a controlled input
 * `undefined`), tolerating missing/mistyped keys from an older plugin build.
 */
export function withAokieDefaults(raw: unknown): AokieConnectorSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = AOKIE_SETTINGS_DEFAULTS;
  const codec = src.hfpCodec;
  return {
    aiReceptionist: boolSetting(src.aiReceptionist, d.aiReceptionist),
    autoAnswer: boolSetting(src.autoAnswer, d.autoAnswer),
    answerTone: boolSetting(src.answerTone, d.answerTone),
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
    bargeIn: boolSetting(src.bargeIn, d.bargeIn),
    bargeSensitivity:
      typeof src.bargeSensitivity === 'number' && Number.isFinite(src.bargeSensitivity)
        ? src.bargeSensitivity
        : d.bargeSensitivity,
    hfpCodec: codec === 'cvsd' || codec === 'wbs' || codec === 'auto' ? codec : d.hfpCodec,
    reenumerateHwid: typeof src.reenumerateHwid === 'string' ? src.reenumerateHwid : d.reenumerateHwid,
    legacyPairingPin: boolSetting(src.legacyPairingPin, d.legacyPairingPin),
  };
}

/**
 * The dirty-field patch for a save: only keys whose value differs from the
 * baseline (the bag as last loaded/saved). The plugin's `settings.set`
 * merges per key, so omitted keys — including anything the panel doesn't
 * know about — keep their live value. Returns an empty object when nothing
 * changed; callers should skip the write entirely in that case.
 */
export function settingsPatch(
  baseline: AokieConnectorSettings,
  current: AokieConnectorSettings
): Partial<AokieConnectorSettings> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(current) as Array<keyof AokieConnectorSettings>) {
    if (current[key] !== baseline[key]) patch[key] = current[key];
  }
  return patch as Partial<AokieConnectorSettings>;
}
