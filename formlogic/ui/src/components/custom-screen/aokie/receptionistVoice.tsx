// Engine-first voice selection for the Receptionist Settings console.
//
// The plugin's whole-object settings.get MAY carry a `ttsVoiceCatalog` side
// key (docs/AOKIE_PLUGIN_CONTRACT.md §2 — sibling of settings/managerPinSet/
// configVersion) describing what is actually installed on the desktop:
//   { engines: [ { id: 'pocket', label, voices: [...] },
//                { id: 'sherpa', label, bundles: [{dir, name, kind}], scanRoot } ] }
// Older plugins never return the key — everything here degrades to the
// hardcoded pocket voice list and a free-text sherpa folder input.
//
// Split out of AokieReceptionistSettingsScreen.tsx so the picker logic and
// markup are unit-testable without the screen's SDK/store dependency graph.
import { Loader2, Save } from 'lucide-react';

const inputCls =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-700 dark:bg-slate-800/60 dark:text-white dark:placeholder:text-slate-500';
const labelCls = 'mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300';
const hintCls = 'mt-1 text-[11px] leading-snug text-gray-400 dark:text-slate-500';

/** The legacy fallback voice list (pocket-tts voices shipped with Aokie Voice)
 *  — used only when the plugin doesn't report a ttsVoiceCatalog. */
export const FALLBACK_POCKET_VOICES = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];

export interface TtsCatalogBundle {
  /** Absolute folder on the DESKTOP machine (the value ttsModelDir stores). */
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

/** Sentinel <option> value for "Custom folder…" in the bundle picker. */
export const CUSTOM_BUNDLE_DIR = '__custom__';

export interface EngineCfg {
  loaded: boolean;
  /** ttsEngine as stored: '' / 'pocket' = Pocket-TTS, 'sherpa' = sherpa-onnx. */
  engine: string;
  /** ttsModelDir as stored (sherpa voice-bundle folder; '' = auto-scan). */
  modelDir: string;
  /** UI-only: the operator explicitly chose "Custom folder…". */
  customDir: boolean;
}

/**
 * State update for a bundle-picker selection. Two write targets, because the
 * AUDIBLE voice now comes from the aokie-tts SERVICE per call (the record's
 * `voice` → the ttsVoice push — the service accepts a bundle folder NAME,
 * 'bundle:speaker' or a bare speaker id), while `ttsModelDir` remains the
 * in-process FALLBACK engine's bundle:
 *  - a bundle pick writes ttsModelDir (fallback) AND voice = the bundle's
 *    folder NAME (per-call service voice);
 *  - '' (Automatic) clears both;
 *  - the Custom sentinel only reveals the free-text folder input — the folder
 *    typed there sets ttsModelDir only (voice untouched: `voice` stays
 *    undefined here so callers leave the record field alone).
 */
export function bundleSelectionUpdate(
  value: string,
  bundles: TtsCatalogBundle[],
): { engine: Partial<EngineCfg>; voice?: string } {
  if (value === CUSTOM_BUNDLE_DIR) return { engine: { customDir: true } };
  if (value === '') return { engine: { modelDir: '', customDir: false }, voice: '' };
  const matched = bundles.find((b) => b.dir === value);
  const name = matched?.name ?? value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  return { engine: { modelDir: value, customDir: false }, voice: name };
}

const DEFAULT_ENGINES: TtsCatalogEngine[] = [
  { id: 'pocket', label: 'Pocket-TTS' },
  { id: 'sherpa', label: 'Sherpa (Piper/VITS/Kokoro)' },
];

function engineOptionLabel(engine: TtsCatalogEngine): string {
  if (engine.id === 'pocket') return 'Pocket-TTS (default)';
  if (engine.id === 'sherpa') return 'Sherpa — Piper/VITS voices (fast)';
  return engine.label;
}

export interface VoiceEngineSectionProps {
  engineCfg: EngineCfg;
  onEngineCfg: (patch: Partial<EngineCfg>) => void;
  /** The persona RECORD's voice field (pocket voice name / kokoro speaker id). */
  voice: string;
  onVoice: (v: string) => void;
  catalog: TtsCatalogEngine[] | null;
  /** can('settings.set') — engine/folder are plugin settings, not record fields. */
  canManageEngine: boolean;
  savingEngine: boolean;
  onSaveEngine: () => void;
}

/**
 * Engine-first voice picker for the Voice & replies card. The engine (and,
 * under sherpa, the voice-bundle folder) are PLUGIN settings applied live via
 * settings.set; the pocket voice / kokoro speaker id live on the persona
 * record and are pushed per call as ttsVoice.
 */
export function VoiceEngineSection({
  engineCfg,
  onEngineCfg,
  voice,
  onVoice,
  catalog,
  canManageEngine,
  savingEngine,
  onSaveEngine,
}: VoiceEngineSectionProps) {
  const isSherpa = engineCfg.engine === 'sherpa';
  const engines = catalog && catalog.length > 0 ? catalog : DEFAULT_ENGINES;
  const bundles = catalog?.find((e) => e.id === 'sherpa')?.bundles ?? [];
  const voices = pocketVoiceOptions(catalog);
  const matched = bundles.find((b) => b.dir === engineCfg.modelDir);
  // A stored folder outside the catalog (e.g. E:\models\piper\…) renders as
  // the Custom choice with the input pre-filled — never silently discarded.
  const bundleValue =
    engineCfg.customDir || (engineCfg.modelDir !== '' && !matched)
      ? CUSTOM_BUNDLE_DIR
      : matched
        ? matched.dir
        : '';
  const showCustomDir = isSherpa && canManageEngine && (bundles.length === 0 || bundleValue === CUSTOM_BUNDLE_DIR);
  const isKokoro = isSherpa && matched?.kind === 'kokoro';
  // The stored engine may read 'pocket' explicitly; the select's pocket option
  // keeps the legacy '' value so save semantics never change.
  const engineValue = engineCfg.engine === 'pocket' ? '' : engineCfg.engine;

  return (
    <div>
      <p className={hintCls + ' mt-0'}>
        The voice pick is saved with this record and applies per call (it rides the ttsVoice push to
        the speech service). The speech engine and voice model folder are live plugin settings — the
        folder sets the in-process fallback engine's voice for when the speech service isn't running.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {canManageEngine && (
          <div>
            <label className={labelCls} htmlFor="rs-ttsengine">Speech engine</label>
            <select
              id="rs-ttsengine"
              value={engineValue}
              onChange={(e) => onEngineCfg({ engine: e.target.value })}
              className={inputCls + ' cursor-pointer'}
            >
              {engines.map((e) => (
                <option key={e.id} value={e.id === 'pocket' ? '' : e.id}>
                  {engineOptionLabel(e)}
                </option>
              ))}
            </select>
          </div>
        )}
        {!isSherpa && (
          <div>
            <label className={labelCls} htmlFor="rs-voice">Voice</label>
            <select
              id="rs-voice"
              value={voice}
              onChange={(e) => onVoice(e.target.value)}
              className={inputCls + ' cursor-pointer'}
            >
              {voices.map((v) => (
                <option key={v || 'default'} value={v}>
                  {v === '' ? 'Default' : v.charAt(0).toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
            <p className={hintCls}>Pocket-TTS voice — saved with the record, applied on the next call.</p>
          </div>
        )}
        {isSherpa && canManageEngine && bundles.length > 0 && (
          <div>
            <label className={labelCls} htmlFor="rs-ttsbundle">Voice</label>
            <select
              id="rs-ttsbundle"
              value={bundleValue}
              onChange={(e) => {
                const u = bundleSelectionUpdate(e.target.value, bundles);
                onEngineCfg(u.engine);
                if (u.voice !== undefined) onVoice(u.voice);
              }}
              className={inputCls + ' cursor-pointer'}
            >
              <option value="">Automatic (first installed voice)</option>
              {bundles.map((b) => (
                <option key={b.dir} value={b.dir}>
                  {prettifyBundleName(b.name)}
                </option>
              ))}
              <option value={CUSTOM_BUNDLE_DIR}>Custom folder…</option>
            </select>
            <p className={hintCls}>
              Installed sherpa voice bundles on the desktop machine. The pick applies per call (it's
              saved as this record's voice); the same folder becomes the fallback engine's voice.
            </p>
          </div>
        )}
        {showCustomDir && (
          <div className={bundles.length > 0 ? 'sm:col-span-2' : ''}>
            <label className={labelCls} htmlFor="rs-ttsmodeldir">Voice model folder (blank = auto)</label>
            <input
              id="rs-ttsmodeldir"
              value={engineCfg.modelDir}
              onChange={(e) => onEngineCfg({ modelDir: e.target.value, customDir: true })}
              className={inputCls}
              placeholder={'blank = first voice under models\\tts'}
            />
            <p className={hintCls}>
              A sherpa voice bundle folder on the desktop machine (the voice's .onnx + tokens.txt,
              e.g. vits-piper-en_US-lessac-medium). Sets the in-process FALLBACK engine's voice — the
              per-call voice is the record's voice field (the bundle picks above write both).
            </p>
          </div>
        )}
        {isKokoro && (
          <div>
            <label className={labelCls} htmlFor="rs-kokoro-speaker">Speaker id</label>
            <input
              id="rs-kokoro-speaker"
              type="text"
              inputMode="numeric"
              value={voice}
              onChange={(e) => onVoice(e.target.value)}
              placeholder="e.g. 0"
              className={inputCls + ' font-mono'}
            />
            <p className={hintCls}>
              Kokoro bundles hold many speakers — the numeric id picks one. Saved with the record and
              applied per call (non-numeric values are ignored by the plugin).
            </p>
          </div>
        )}
      </div>
      {canManageEngine && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onSaveEngine}
            disabled={savingEngine || !engineCfg.loaded}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
          >
            {savingEngine ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save speech engine
          </button>
        </div>
      )}
    </div>
  );
}
