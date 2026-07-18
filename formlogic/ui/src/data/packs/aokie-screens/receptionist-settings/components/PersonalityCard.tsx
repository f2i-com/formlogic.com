/** @jsxImportSource preact */
// Personality + the business-info grounding text (the ONLY facts the AI may
// state about the business - empty means no invented menus or prices).
import { d, draftInput } from '../store';

export function PersonalityCard() {
  return (
    <div class="card">
      <h2>{'How should it talk & behave?'}</h2>
      <textarea
        data-d="instructions"
        rows={6}
        placeholder="e.g. Be warm and concise. Offer to book Mon-Fri 9-5. Give the standard checkup price of $90 and offer to book."
        value={d().instructions}
        onInput={(e) => draftInput('instructions', e.currentTarget.value)}
      />
      <p class="hint">{"Blank uses Aokie's built-in receptionist persona. Plain English works - treat it like briefing a new hire."}</p>
      <h3>Business info the AI may share</h3>
      <textarea
        data-d="business_info"
        rows={6}
        placeholder="Menu, services, prices, opening hours, parking, policies, FAQ... The AI answers business questions ONLY from this text and never invents details."
        value={d().business_info}
        onInput={(e) => draftInput('business_info', e.currentTarget.value)}
      />
      <p class="hint">The only facts it will state about the business. Anything not covered here, it offers to have the team confirm - so an empty box means no invented menus or prices.</p>
    </div>
  );
}
