/** @jsxImportSource preact */
// Voice & replies: engine-first voice picker (pocket voice list / sherpa
// bundle list from the settings.get ttsVoiceCatalog) + the record-side
// Active and reply-mode selects. The engine + model folder are LIVE plugin
// settings saved via their own button; the voice pick rides the record.
import { DEFAULT_ENGINES, normalizeEngine, pocketVoices, prettifyBundle } from '../helpers';
import {
  bundleChange,
  d,
  draftInput,
  engineChange,
  engineModelDirInput,
  engineUnsaved,
  saveEngine,
  state,
} from '../store';

export function VoiceCard() {
  const cat = state.catalog;
  const eng = state.engine;
  const isSherpa = eng.engine === 'sherpa';
  const engines = cat && cat.length ? cat : DEFAULT_ENGINES;
  const sherpa = (cat || []).filter((e) => e.id === 'sherpa')[0];
  const bundles = (sherpa && sherpa.bundles) || [];
  const voices = pocketVoices(cat);
  const matched = bundles.filter((b) => b.dir === eng.modelDir)[0];
  const bundleValue = eng.customDir || (eng.modelDir !== '' && !matched) ? '__custom__' : matched ? matched.dir : '';
  const showCustomDir = isSherpa && state.canSet && (bundles.length === 0 || bundleValue === '__custom__');
  const isKokoro = isSherpa && !!matched && matched.kind === 'kokoro';
  const engineValue = eng.engine === 'pocket' ? '' : eng.engine;
  const pending = engineUnsaved();
  const liveEngine = normalizeEngine(eng.savedEngine) === 'sherpa' ? 'Sherpa' : 'Pocket-TTS';
  return (
    <div class="card">
      <h2>{'Voice & replies'}</h2>
      <p class="hint" style="margin-top:0">The voice pick is saved with this record and applies per call. The speech engine and voice model folder are live plugin settings.</p>
      <div class="row2">
        {state.canSet ? (
          <label class="f">
            <span class="lbl">Speech engine</span>
            <select data-eng="engine" value={engineValue} onChange={(e) => engineChange(e.currentTarget.value)}>
              {engines.map((en) => (
                <option value={en.id === 'pocket' ? '' : en.id}>
                  {en.id === 'pocket' ? 'Pocket-TTS (default)' : en.id === 'sherpa' ? 'Sherpa - Piper/VITS voices (fast)' : en.label}
                </option>
              ))}
            </select>
            {pending ? (
              <span class="hint dirty" data-engine-pending>
                {'Not saved yet - the receptionist is still running ' + liveEngine + '. Press "Save speech engine" below, or the voice picked here will not be used.'}
              </span>
            ) : null}
          </label>
        ) : null}
        {!isSherpa ? (
          <label class="f">
            <span class="lbl">Voice</span>
            <select data-d="voice" value={d().voice} onChange={(e) => draftInput('voice', e.currentTarget.value)}>
              {voices.map((v) => (
                <option value={v}>{v === '' ? 'Default' : v.charAt(0).toUpperCase() + v.slice(1)}</option>
              ))}
            </select>
            <span class="hint">Pocket-TTS voice - saved with the record, applied on the next call.</span>
          </label>
        ) : null}
        {isSherpa && state.canSet && bundles.length > 0 ? (
          <label class="f">
            <span class="lbl">Voice</span>
            <select data-eng="bundle" value={bundleValue} onChange={(e) => bundleChange(e.currentTarget.value)}>
              <option value="">Automatic (first installed voice)</option>
              {bundles.map((b) => (
                <option value={b.dir}>{prettifyBundle(b.name)}</option>
              ))}
              <option value="__custom__">Custom folder...</option>
            </select>
            <span class="hint">Installed sherpa voice bundles on the desktop machine. The pick applies per call.</span>
          </label>
        ) : null}
        {showCustomDir ? (
          <label class="f" style={bundles.length > 0 ? 'grid-column:1/-1' : undefined}>
            <span class="lbl">Voice model folder (blank = auto)</span>
            <input
              type="text"
              data-eng="modelDir"
              value={eng.modelDir}
              placeholder="blank = first voice under models/tts"
              onInput={(e) => engineModelDirInput(e.currentTarget.value)}
            />
            <span class="hint">{"A sherpa voice bundle folder on the desktop machine (the voice's .onnx + tokens.txt)."}</span>
          </label>
        ) : null}
        {isKokoro ? (
          <label class="f">
            <span class="lbl">Speaker id</span>
            <input
              type="text"
              class="mono"
              data-d="voice"
              value={d().voice}
              placeholder="e.g. 0"
              onInput={(e) => draftInput('voice', e.currentTarget.value)}
            />
            <span class="hint">Kokoro bundles hold many speakers - the numeric id picks one.</span>
          </label>
        ) : null}
      </div>
      {state.canSet ? (
        <div class="savebtnrow">
          <button type="button" class="btn dark sm" data-act="save-engine" disabled={!!state.busy.engine || !eng.loaded} onClick={saveEngine}>
            {state.busy.engine ? 'Saving...' : 'Save speech engine'}
          </button>
        </div>
      ) : null}
      <div class="row2" style="margin-top:12px;border-top:1px solid var(--fl-border);padding-top:12px">
        <label class="f">
          <span class="lbl">Active</span>
          <select data-d="active" value={d().active} onChange={(e) => draftInput('active', e.currentTarget.value)}>
            <option value="yes">Yes - use these settings</option>
            <option value="no">No - fall back to defaults</option>
          </select>
        </label>
        <label class="f" style="grid-column:1/-1">
          <span class="lbl">Who answers the caller</span>
          <select data-d="reply_mode" value={d().reply_mode} onChange={(e) => draftInput('reply_mode', e.currentTarget.value)}>
            <option value="agent">Built-in AI agent (recommended - fast, on-device)</option>
            <option value="flow">Custom flow (edit the Live Reply flow yourself)</option>
          </select>
          <span class="hint">Reply mode only takes effect the next time Aokie reconnects - the plugin reads it once at startup, not per call.</span>
        </label>
      </div>
    </div>
  );
}
