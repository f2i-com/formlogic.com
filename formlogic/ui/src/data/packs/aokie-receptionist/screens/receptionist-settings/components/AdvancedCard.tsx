/** @jsxImportSource preact */
// Advanced: raw AI model + custom endpoint URLs behind a native <details>
// disclosure. The open state is mirrored into the store (onToggle) so it
// survives re-renders; the disclosure glyph is CSS-driven off [open].
import { d, draftInput, state, toggleAdvanced } from '../store';

export function AdvancedCard() {
  return (
    <details class="card adv" open={state.showAdvanced} onToggle={(e) => toggleAdvanced(e.currentTarget.open)}>
      <summary data-act="toggle-adv">{'Advanced - AI model & endpoints'}</summary>
      <div style="margin-top:10px">
        <p class="hint" style="margin-top:0">The raw AI plumbing. Custom URL fields are used when a lane is set to Custom URL (or left on Built-in with a URL entered).</p>
        <label class="f">
          <span class="lbl">LLM model</span>
          <input
            type="text"
            data-d="model"
            value={d().model}
            placeholder="e.g. llama3.1:8b (blank = auto)"
            onInput={(e) => draftInput('model', e.currentTarget.value)}
          />
        </label>
        <label class="f">
          <span class="lbl">Custom LLM endpoint URL</span>
          <input
            type="text"
            class="mono"
            data-d="llm_endpoint"
            value={d().llm_endpoint}
            placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
            onInput={(e) => draftInput('llm_endpoint', e.currentTarget.value)}
          />
        </label>
        <label class="f">
          <span class="lbl">Custom speech-to-text URL</span>
          <input
            type="text"
            class="mono"
            data-d="stt_endpoint"
            value={d().stt_endpoint}
            placeholder="e.g. http://127.0.0.1:17921/v1/audio/transcriptions"
            onInput={(e) => draftInput('stt_endpoint', e.currentTarget.value)}
          />
        </label>
        <label class="f">
          <span class="lbl">Custom text-to-speech URL</span>
          <input
            type="text"
            class="mono"
            data-d="tts_endpoint"
            value={d().tts_endpoint}
            placeholder="e.g. http://127.0.0.1:17922/v1/audio/speech"
            onInput={(e) => draftInput('tts_endpoint', e.currentTarget.value)}
          />
        </label>
      </div>
    </details>
  );
}
