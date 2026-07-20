/** @jsxImportSource preact */
// Connected services: per-lane source pickers (Aokie default first, then
// desktop services, providers on the LLM lane, Custom URL, Built-in) fed by
// FormLogic.aiSources(); null listing = no local desktop (saved picks still
// resolve per call on the desktop).
import {
  codexLiveCallModel,
  codexLiveCallReasoning,
  d,
  draftInput,
  isCodexFastSource,
  isCodexLunaSource,
  laneChange,
  laneOptions,
  laneUrlInput,
  state,
  type Lane,
} from '../store';

function LaneField(props: { lane: Lane; label: string; source: string; endpoint: string; placeholder: string; hint: string }) {
  const { lane, label, source, endpoint, placeholder, hint } = props;
  const listed = state.aiSources !== null;
  const opts = laneOptions(lane);
  const isPick = source.indexOf('service:') === 0 || source.indexOf('provider:') === 0;
  const missing = isPick && !opts.some((o) => o.value === source);
  const showUrl = source === 'custom' || (source === '' && endpoint.trim() !== '');
  return (
    <label class="f">
      <span class="lbl">{label}</span>
      <select data-lane={lane} value={source} onChange={(e) => laneChange(lane, e.currentTarget.value)}>
        {missing ? (
          <option value={source}>
            {(source.indexOf('provider:') === 0 ? 'AI provider' : 'Desktop service') + ': '
              + source.slice(source.indexOf(':') + 1)
              + (listed ? ' (not found)' : ' (saved)')}
          </option>
        ) : null}
        {opts.map((o) => (
          <option value={o.value}>
            {o.value === '' && endpoint.trim() && source === '' ? o.label + ' - custom URL below wins' : o.label}
          </option>
        ))}
      </select>
      {showUrl ? (
        <input
          type="text"
          class="mono"
          data-laneurl={lane}
          value={endpoint}
          placeholder={placeholder}
          style="margin-top:6px;font-size:11.5px"
          onInput={(e) => laneUrlInput(lane, e.currentTarget.value)}
        />
      ) : null}
      {hint ? <span class="hint">{hint}</span> : null}
    </label>
  );
}

export function ServicesCard() {
  const codexReasoning = codexLiveCallReasoning(d().llm_source);
  const codexModel = codexLiveCallModel(d().llm_source);
  const luna = isCodexLunaSource(d().llm_source);
  const fast = isCodexFastSource(d().llm_source);
  return (
    <div class="card">
      <h2>Connected services</h2>
      <p class="hint" style="margin-top:0">
        {"Which engine answers, hears and speaks. Picks resolve to the service's live address on every call. AI providers route through the desktop's AI gateway."
          + (state.aiSources === null ? ' Connect FormLogic Desktop on this machine to pick services by name - saved picks still resolve per call on the desktop.' : '')}
      </p>
      <LaneField
        lane="llm"
        label="LLM source"
        source={d().llm_source}
        endpoint={d().llm_endpoint}
        placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
        hint="Built-in = the plugin's configured endpoint (auto-detects a local llama.cpp/Ollama)."
      />
      {codexModel === null ? (
        <label class="f">
          <span class="lbl">LLM model</span>
          <input
            type="text"
            data-d="model"
            value={d().model}
            placeholder="e.g. llama3.1:8b (blank = auto)"
            onInput={(e) => draftInput('model', e.currentTarget.value)}
          />
          <span class="hint">Leave blank to use the model currently loaded by the selected service.</span>
        </label>
      ) : null}
      {codexReasoning ? (
        <p class="hint" data-codex-live-call-note="services">
          {luna
            ? 'GPT-5.6 Luna is selected with low reasoning, its fastest supported reasoning setting. '
              + (fast
                ? 'Fast mode requests Codex priority service; actual latency can still vary by load. '
                : 'Default service mode avoids spending Fast-mode priority quota. ')
              + 'The model is fixed automatically and its response streams into Aokie sentence by sentence.'
            : codexReasoning === 'none'
            ? 'Experimental ChatGPT/Codex live-call mode. Off is the fastest setting and is intended for the shortest reply delay.'
            : 'Experimental ChatGPT/Codex live-call mode. Low can improve difficult replies, but may add noticeable delay on a phone call.'}
          {' Live reply requests use transcript text and the fixed ' + codexModel + ' model. Aokie keeps using the selected speech-to-text and text-to-speech services.'}
        </p>
      ) : null}
      <LaneField
        lane="stt"
        label="Speech to text"
        source={d().stt_source}
        endpoint={d().stt_endpoint}
        placeholder="e.g. http://127.0.0.1:17921/v1/audio/transcriptions"
        hint=""
      />
      <LaneField
        lane="tts"
        label="Text to speech"
        source={d().tts_source}
        endpoint={d().tts_endpoint}
        placeholder="e.g. http://127.0.0.1:17922/v1/audio/speech"
        hint=""
      />
    </div>
  );
}
