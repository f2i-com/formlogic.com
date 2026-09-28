/** @jsxImportSource preact */
// Background AI: the provider FormLogic's own flows use after or between
// calls (summaries, follow-up decisions, booking extraction, SMS drafts). It
// never answers the caller, so it applies on every route, OAIY's included.
import {
  backgroundAiChange,
  backgroundAiOptions,
  d,
  draftInput,
  isCodexLiveCallSource,
  state,
} from '../store';

export function BackgroundAiCard() {
  const backgroundOptions = backgroundAiOptions();
  const backgroundMissing = d().background_ai_source !== ''
    && !backgroundOptions.some((o) => o.value === d().background_ai_source);
  const backgroundCodex = isCodexLiveCallSource(d().background_ai_source);
  return (
    <section class="card" data-background-ai>
      <h2>Background AI</h2>
      <p class="muted">
        Used by FormLogic's flows after or between calls: call summaries, follow-up decisions, booking extraction and SMS drafts. It never answers a caller, so a slower account such as ChatGPT via Codex adds no delay to a call.
      </p>
      <label class="f">
        <span class="lbl">Background AI provider</span>
        <select
          data-d="background_ai_source"
          value={d().background_ai_source}
          onChange={(e) => backgroundAiChange(e.currentTarget.value)}
        >
          {backgroundMissing ? (
            <option value={d().background_ai_source}>
              {'AI provider: ' + d().background_ai_source.replace('provider:', '')
                + (state.aiSources === null ? ' (saved)' : ' (not found)')}
            </option>
          ) : null}
          {backgroundOptions.map((o) => <option value={o.value}>{o.label}</option>)}
        </select>
        <span class="hint">{'Keys stay in OAIY (Services and providers): this record saves only the provider reference. Automatic uses the default model in OAIY > Providers.'}</span>
      </label>
      {!backgroundCodex ? (
        <label class="f">
          <span class="lbl">Model override</span>
          <input
            type="text"
            data-d="background_ai_model"
            value={d().background_ai_model}
            placeholder="blank = the provider's default model"
            onInput={(e) => draftInput('background_ai_model', e.currentTarget.value)}
          />
          <span class="hint">Optional. Leave blank to use the model configured on the selected provider.</span>
        </label>
      ) : (
        <p class="hint" data-background-codex-note>
          This delegated ChatGPT/Codex route chooses its supported model and reasoning mode automatically. It is used only for background text work here.
        </p>
      )}
    </section>
  );
}
