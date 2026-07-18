/** @jsxImportSource preact */
// Business & greeting: business name + greeting with the composed
// default-greeting as a LIVE placeholder (recomputed as the name is typed).
import { AI_GATEWAY_BASE, composeAgentPayload, DEFAULT_PERSONA } from '../agentPayload';
import { str } from '../helpers';
import { d, draftInput, services } from '../store';

export function BusinessCard() {
  const preview = composeAgentPayload(d(), services(), DEFAULT_PERSONA, AI_GATEWAY_BASE);
  return (
    <div class="card">
      <h2>{'Business & greeting'}</h2>
      <label class="f">
        <span class="lbl">Business name</span>
        <input
          type="text"
          data-d="business_name"
          value={d().business_name}
          placeholder="e.g. Bright Smile Dental"
          onInput={(e) => draftInput('business_name', e.currentTarget.value)}
        />
      </label>
      <label class="f">
        <span class="lbl">Greeting (spoken first)</span>
        <input
          type="text"
          data-d="greeting"
          value={d().greeting}
          placeholder={str(preview.greeting)}
          onInput={(e) => draftInput('greeting', e.currentTarget.value)}
        />
        <span class="hint">Blank uses the friendly default shown above. Known callers are greeted by name automatically.</span>
      </label>
    </div>
  );
}
