/** @jsxImportSource preact */
// Audio understanding: the 4-way caller-audio mode select (sendAudio /
// audioTranscript live plugin settings) + the correction-source picker
// (correction_source / correction_endpoint record fields).
import { audioModeChange, d, draftInput, isCodexLiveCallSource, saveAudio, state } from '../store';

export function AudioCard() {
  if (!state.canSet) return null;
  const a = state.audio;
  const codexTextOnly = isCodexLiveCallSource(d().llm_source);
  const sendAudio = !codexTextOnly && a.sendAudio;
  const mode = sendAudio && a.audioTranscript ? 'both' : sendAudio ? 'direct' : a.audioTranscript ? 'corrections' : 'off';
  const modeHint = sendAudio && a.audioTranscript
    ? 'The reply model hears the caller directly AND a small side request per turn fixes the stored transcript from the audio.'
    : sendAudio
      ? "Each caller turn's audio rides along with the reply request - needs an audio-capable reply model; no extra side run."
      : a.audioTranscript
        ? 'For text-only reply models: a small extra request per caller turn corrects the stored transcript from the audio - replies never wait on it.'
        : 'Replies use the on-device speech-to-text transcript only - no audio leaves the plugin.';
  const cs = d().correction_source;
  const chatSvcs = (state.aiSources || []).filter((s) => s.kind === 'service' && s.capabilities.indexOf('chat') >= 0);
  const missing = cs.indexOf('service:') === 0 && !chatSvcs.some((s) => s.id === cs);
  return (
    <div class="card">
      <h2>Audio understanding</h2>
      <p class="muted">{"What happens with the caller's actual audio each turn. Applies the next time the receptionist reconnects."}</p>
      <label class="f">
        <span class="lbl">Caller audio</span>
        <select data-audio="mode" value={mode} onChange={(e) => audioModeChange(e.currentTarget.value)}>
          <option value="off">Text only</option>
          <option value="direct" disabled={codexTextOnly}>Send audio to the reply model (direct)</option>
          <option value="corrections">Side-run transcript corrections</option>
          <option value="both" disabled={codexTextOnly}>Both</option>
        </select>
        <span class="hint">{modeHint}</span>
        {codexTextOnly ? (
          <span class="hint" data-codex-live-call-note="audio">
            Codex live-call replies are text-only. Direct caller audio is blocked; Aokie's existing speech-to-text and text-to-speech services continue to hear and speak.
          </span>
        ) : null}
      </label>
      {a.audioTranscript ? (
        <div style="border:1px solid var(--fl-border);border-radius:12px;padding:10px;margin-top:10px">
          <label class="f">
            <span class="lbl">Correction source</span>
            <select data-d="correction_source" value={cs} onChange={(e) => draftInput('correction_source', e.currentTarget.value)}>
              {missing ? (
                <option value={cs}>{'Desktop service: ' + cs.slice(8) + (state.aiSources !== null ? ' (not found)' : ' (saved)')}</option>
              ) : null}
              <option value="">Automatic (main reply model)</option>
              {chatSvcs.map((s) => (
                <option value={s.id}>
                  {'This computer: ' + s.name + (s.model ? ' - ' + s.model : '') + (s.status === 'running' ? '' : ' (' + s.status + ')')}
                </option>
              ))}
              <option value="custom">Custom URL...</option>
            </select>
            {cs === 'custom' ? (
              <input
                type="text"
                class="mono"
                data-d="correction_endpoint"
                value={d().correction_endpoint}
                placeholder="e.g. http://127.0.0.1:8081/v1/chat/completions"
                style="margin-top:6px;font-size:11.5px"
                onInput={(e) => draftInput('correction_endpoint', e.currentTarget.value)}
              />
            ) : null}
            <span class="hint">Which model runs the corrections - a separate chat service keeps them from competing with live replies. Resolved per call.</span>
          </label>
        </div>
      ) : null}
      <div class="savebtnrow">
        <button type="button" class="btn dark sm" data-act="save-audio" disabled={!!state.busy.audio || !a.loaded} onClick={saveAudio}>
          {state.busy.audio ? 'Saving...' : 'Save audio settings'}
        </button>
        {a.loaded ? null : <span class="faint">Loading current values...</span>}
      </div>
    </div>
  );
}
