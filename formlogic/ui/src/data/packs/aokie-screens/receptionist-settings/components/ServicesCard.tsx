/** @jsxImportSource preact */
// Connected services: per-lane source pickers (Aokie default first, then
// desktop services, providers on the LLM lane, Custom URL, Built-in) fed by
// FormLogic.aiSources(); null listing = no local desktop (saved picks still
// resolve per call on the desktop).
import { d, laneChange, laneOptions, laneUrlInput, state, type Lane } from '../store';

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
  return (
    <div class="card">
      <h2>Connected services</h2>
      <p class="hint" style="margin-top:0">
        {"Which engine answers, hears and speaks. Picks resolve to the service's live address on every call. AI providers route through the desktop's AI gateway."
          + (state.aiSources === null ? ' Connect FormLogic Desktop on this machine to pick services by name - saved picks still resolve per call on the desktop.' : '')}
      </p>
      <LaneField
        lane="llm"
        label="Reply model (LLM)"
        source={d().llm_source}
        endpoint={d().llm_endpoint}
        placeholder="e.g. http://127.0.0.1:8080/v1/chat/completions"
        hint="Built-in = the plugin's configured endpoint (auto-detects a local llama.cpp/Ollama)."
      />
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
