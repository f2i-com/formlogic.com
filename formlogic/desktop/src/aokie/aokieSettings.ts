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
  /** In-process TTS engine: '' / 'pocket' = Pocket-TTS, 'sherpa' = sherpa-onnx
   *  (Piper/VITS/Kokoro voice bundles). Applies live. */
  ttsEngine: string;
  /** Sherpa voice-bundle folder for the in-process fallback engine
   *  ('' = auto-scan models\tts). Applies live. */
  ttsModelDir: string;
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
  ttsEngine: '',
  ttsModelDir: '',
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
    ttsEngine: typeof src.ttsEngine === 'string' ? src.ttsEngine : d.ttsEngine,
    ttsModelDir: typeof src.ttsModelDir === 'string' ? src.ttsModelDir : d.ttsModelDir,
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

// ---------------------------------------------------------------------------
// Endpoint lane composition (CON-301 desktop side).
//
// The Configure-receptionist panel offers SOURCE dropdowns (a local Desktop
// service, an AI provider via the gateway, or a raw custom URL) but the
// plugin's settings bag stores plain endpoint URLs — these helpers compose a
// pick into the URL that gets saved, and reverse-infer the pick from a saved
// URL. They mirror the console's laneUrl semantics
// (formlogic/ui/src/components/custom-screen/aokie/receptionistPayload.ts);
// keep the rules in lock-step.
// ---------------------------------------------------------------------------

/** The three endpoint lanes the receptionist settings expose. */
export type AokieLane = 'llm' | 'stt' | 'tts';

/** Conventional OpenAI-compatible path per lane, appended to a service's
 *  loopback base URL when composing. */
export const LANE_PATHS: Record<AokieLane, string> = {
  llm: '/v1/chat/completions',
  stt: '/v1/audio/transcriptions',
  tts: '/v1/audio/speech',
};

/** The desktop AI gateway's FIXED loopback base — `provider:<id>` picks compose
 *  `http://127.0.0.1:17872/api/ai/providers/<id>/v1/...` against it (the
 *  per-provider OpenAI-protocol routes in the desktop's http.rs). Must be
 *  byte-identical to AI_GATEWAY_BASE in the console's
 *  formlogic/ui/src/components/custom-screen/aokie/receptionistPayload.ts —
 *  keep in lock-step. */
export const AI_GATEWAY_BASE = 'http://127.0.0.1:17872/api/ai/providers/';

/** Structural slice of an /api/ai/sources entry the lane helpers need (kept
 *  local so this module stays importable without api.ts — the cross-repo
 *  conformance suite imports this file directly). */
export interface AokieLaneSource {
  /** 'service:<id>' | 'provider:<id>' */
  id: string;
  kind: 'service' | 'provider';
  /** Live status for services ('running', 'stopped', …); absent for providers. */
  status?: string;
  /** Loopback base URL for services (http://127.0.0.1:<port>). */
  url?: string;
}

/**
 * Compose one lane's saved endpoint URL from a source pick — the SAME rule as
 * the console's laneUrl (receptionistPayload.ts) with providerOk = the LLM
 * lane only:
 *  - blank / 'custom' → the custom URL string as typed (trimmed);
 *  - 'service:<id>'   → the service's loopback URL + the lane's conventional
 *    path while it is RUNNING; a stopped or unknown service composes '' (the
 *    plugin falls back to its built-in default);
 *  - 'provider:<id>'  → the desktop AI gateway's per-provider OpenAI base +
 *    the lane path, LLM lane ONLY (the gateway serves no audio routes yet —
 *    STT/TTS provider picks resolve to '' = plugin default);
 *  - anything else    → the custom URL (defensive parity with laneUrl).
 */
export function composeLaneUrl(
  source: string,
  custom: string,
  lane: AokieLane,
  sources: AokieLaneSource[],
): string {
  const src = source.trim();
  const url = custom.trim();
  if (!src || src === 'custom') return url;
  if (src.startsWith('service:')) {
    const svc = sources.find((x) => x.kind === 'service' && x.id === src);
    if (!svc || svc.status !== 'running' || !svc.url) return '';
    return svc.url + LANE_PATHS[lane];
  }
  if (src.startsWith('provider:')) {
    if (lane !== 'llm') return '';
    return AI_GATEWAY_BASE + encodeURIComponent(src.slice(9)) + LANE_PATHS[lane];
  }
  return url;
}

/**
 * Reverse of composeLaneUrl for seeding the select from a saved endpoint URL:
 *  - ''                                → '' (automatic / built-in);
 *  - a service's url + the lane path   → that 'service:<id>' (status ignored —
 *    the pick should survive the service being momentarily stopped);
 *  - an AI_GATEWAY_BASE-prefixed URL   → 'provider:<id>';
 *  - anything else                     → 'custom'.
 */
export function inferLaneSource(
  savedUrl: string,
  lane: AokieLane,
  sources: AokieLaneSource[],
): string {
  const url = savedUrl.trim();
  if (!url) return '';
  const path = LANE_PATHS[lane];
  const svc = sources.find((x) => x.kind === 'service' && x.url && x.url + path === url);
  if (svc) return svc.id;
  if (url.startsWith(AI_GATEWAY_BASE)) {
    const id = url.slice(AI_GATEWAY_BASE.length).split('/')[0];
    if (id) {
      try {
        return 'provider:' + decodeURIComponent(id);
      } catch {
        return 'provider:' + id;
      }
    }
  }
  return 'custom';
}

// ---------------------------------------------------------------------------
// TTS voice catalog (engine-first voice picker).
//
// The plugin's whole-object settings.get MAY carry a `ttsVoiceCatalog` side
// key (docs/AOKIE_PLUGIN_CONTRACT.md §2) describing what is actually
// installed on this machine:
//   { engines: [ { id: 'pocket', label, voices: [...] },
//                { id: 'sherpa', label, bundles: [{dir, name, kind}], scanRoot } ] }
// Older plugins never return the key — everything degrades to the hardcoded
// pocket voice list and a free-text sherpa folder input.
//
// These helpers MIRROR the console's
// formlogic/ui/src/components/custom-screen/aokie/receptionistVoice.tsx —
// keep the rules in lock-step (that file's vitest suite imports this module
// and asserts behavioral parity).
// ---------------------------------------------------------------------------

/** The legacy fallback voice list (pocket-tts voices shipped with Aokie Voice)
 *  — used only when the plugin doesn't report a ttsVoiceCatalog. */
export const FALLBACK_POCKET_VOICES = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];

export interface TtsCatalogBundle {
  /** Absolute folder on this machine (the value ttsModelDir stores). */
  dir: string;
  /** Folder basename, e.g. 'vits-piper-en_GB-jenny_dioco-medium'. */
  name: string;
  /** 'kokoro' (voices.bin present — multi-speaker) or 'vits'. */
  kind: string;
}

export interface TtsCatalogEngine {
  id: string;
  label: string;
  voices?: string[];
  bundles?: TtsCatalogBundle[];
  scanRoot?: string;
}

/**
 * Defensive parse of the settings.get `ttsVoiceCatalog` side key. Absent /
 * malformed / empty → null (consumers fall back to the legacy hardcoded UI —
 * older plugins never return the key at all).
 */
export function parseTtsVoiceCatalog(raw: unknown): TtsCatalogEngine[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const engines = (raw as { engines?: unknown }).engines;
  if (!Array.isArray(engines)) return null;
  const out: TtsCatalogEngine[] = [];
  for (const e of engines) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id) continue;
    const voices = Array.isArray(rec.voices)
      ? rec.voices.filter((v): v is string => typeof v === 'string' && v !== '')
      : undefined;
    const bundles = Array.isArray(rec.bundles)
      ? rec.bundles
          .map((b): TtsCatalogBundle | null => {
            if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
            const br = b as Record<string, unknown>;
            if (typeof br.dir !== 'string' || !br.dir) return null;
            return {
              dir: br.dir,
              name: typeof br.name === 'string' && br.name ? br.name : br.dir,
              kind: typeof br.kind === 'string' && br.kind ? br.kind : 'vits',
            };
          })
          .filter((b): b is TtsCatalogBundle => b !== null)
      : undefined;
    out.push({
      id: rec.id,
      label: typeof rec.label === 'string' && rec.label ? rec.label : rec.id,
      ...(voices !== undefined ? { voices } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
      ...(typeof rec.scanRoot === 'string' && rec.scanRoot ? { scanRoot: rec.scanRoot } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * The pocket voice <select> options: '' (Default) + the catalog's installed
 * voices sorted/deduped; the legacy hardcoded list when no catalog.
 */
export function pocketVoiceOptions(catalog: TtsCatalogEngine[] | null): string[] {
  const pocket = catalog?.find((e) => e.id === 'pocket');
  const voices = pocket?.voices ?? [];
  if (voices.length === 0) return FALLBACK_POCKET_VOICES;
  return ['', ...Array.from(new Set(voices)).sort((a, b) => a.localeCompare(b))];
}

/** Tokens that name the engine/format, not the voice, in bundle folder names. */
const BUNDLE_ENGINE_TOKENS = new Set(['vits', 'piper', 'kokoro', 'matcha', 'mms', 'coqui', 'icefall']);
const BUNDLE_QUALITY_TOKENS = new Set(['low', 'medium', 'high', 'x_low', 'x_high']);

/**
 * Human label for a sherpa voice-bundle folder name:
 * 'vits-piper-en_GB-jenny_dioco-medium' → 'Jenny Dioco (en_GB, medium)'.
 * Names that don't follow the piper convention come back unchanged.
 */
export function prettifyBundleName(name: string): string {
  const parts = name.split('-').filter(Boolean);
  let i = 0;
  while (i < parts.length && BUNDLE_ENGINE_TOKENS.has(parts[i].toLowerCase())) i += 1;
  const rest = parts.slice(i);
  if (rest.length === 0) return name;
  const locale = /^[a-z]{2,3}(_[A-Z]{2})?$/.test(rest[0]) ? rest[0] : null;
  const last = rest[rest.length - 1];
  const quality = rest.length > 1 && BUNDLE_QUALITY_TOKENS.has(last.toLowerCase()) ? last.toLowerCase() : null;
  const voiceTokens = rest.slice(locale ? 1 : 0, quality ? rest.length - 1 : rest.length);
  if (voiceTokens.length === 0) return name;
  const voice = voiceTokens
    .join(' ')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const meta = [locale, quality].filter(Boolean).join(', ');
  return meta ? `${voice} (${meta})` : voice;
}

/** Engine choices when the plugin doesn't report a catalog (older builds).
 *  Ids must stay inside the plugin's ttsEngine enum (schema-conformance
 *  test-locked: the select writes '' for pocket, the raw id otherwise). */
export const DEFAULT_ENGINES: TtsCatalogEngine[] = [
  { id: 'pocket', label: 'Pocket-TTS' },
  { id: 'sherpa', label: 'Sherpa (Piper/VITS/Kokoro)' },
];

/** Display label for an engine option (parity-locked with the console). */
export function engineOptionLabel(engine: TtsCatalogEngine): string {
  if (engine.id === 'pocket') return 'Pocket-TTS (default)';
  if (engine.id === 'sherpa') return 'Sherpa — Piper/VITS voices (fast)';
  return engine.label;
}

/** Sentinel <option> value for "Custom folder…" in the bundle picker. */
export const CUSTOM_BUNDLE_DIR = '__custom__';

/**
 * State update for a bundle-picker selection. Two write targets, because the
 * AUDIBLE voice comes from the aokie-tts SERVICE per request (the plugin's
 * `ttsVoice` setting — the service accepts a bundle folder NAME,
 * 'bundle:speaker' or a bare speaker id), while `ttsModelDir` remains the
 * in-process FALLBACK engine's bundle:
 *  - a bundle pick writes modelDir (→ ttsModelDir) AND voice (→ ttsVoice =
 *    the bundle's folder NAME);
 *  - '' (Automatic) clears both;
 *  - the Custom sentinel only reveals the free-text folder input — the folder
 *    typed there sets ttsModelDir only (voice untouched: `voice` stays
 *    undefined here so callers leave ttsVoice alone).
 */
export function bundleSelectionUpdate(
  value: string,
  bundles: TtsCatalogBundle[],
): { engine: { modelDir?: string; customDir?: boolean }; voice?: string } {
  if (value === CUSTOM_BUNDLE_DIR) return { engine: { customDir: true } };
  if (value === '') return { engine: { modelDir: '', customDir: false }, voice: '' };
  const matched = bundles.find((b) => b.dir === value);
  const name = matched?.name ?? value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  return { engine: { modelDir: value, customDir: false }, voice: name };
}
