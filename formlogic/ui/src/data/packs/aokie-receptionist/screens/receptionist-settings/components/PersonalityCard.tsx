/** @jsxImportSource preact */
// How the receptionist talks + the business-info grounding text (the ONLY
// facts the AI may state about the business - empty means no invented menus
// or prices). On the OAIY route this is the RECEPTIONIST BRIEF: OAIY hands it
// to its Front desk agent, whose own brief and call instructions come first.
import { d, draftInput, onOaiy } from '../store';

export function PersonalityCard() {
  const toOaiy = onOaiy();
  return (
    <section class="card" data-brief-card>
      <h2>{toOaiy ? 'Receptionist brief' : 'How should it talk & behave?'}</h2>
      <textarea
        data-d="instructions"
        rows={6}
        placeholder={toOaiy
          ? 'e.g. We are a small dental clinic. Checkups take 30 minutes. Offer bookings Mon-Fri 9-5 as requests the team confirms.'
          : 'e.g. Be warm and concise. Offer to book Mon-Fri 9-5. Give the standard checkup price of $90 and offer to book.'}
        value={d().instructions}
        onInput={(e) => draftInput('instructions', e.currentTarget.value)}
      />
      {toOaiy ? (
        <p class="hint" data-brief-hint>
          {"Sent with every call. OAIY gives it to its Front desk agent as the receptionist brief, and the Front desk's own brief (OAIY > Agent > Front desk: /brief.md) and call instructions (OAIY > Agent > Phone) take precedence. Blank = no brief: the Front desk's own is enough."}
        </p>
      ) : (
        <p class="hint">{"Blank uses Aokie's built-in receptionist persona. Plain English works - treat it like briefing a new hire."}</p>
      )}
      <h3>Business info the AI may share</h3>
      <textarea
        data-d="business_info"
        rows={6}
        placeholder="Menu, services, prices, opening hours, parking, policies, FAQ... The AI answers business questions ONLY from this text and never invents details."
        value={d().business_info}
        onInput={(e) => draftInput('business_info', e.currentTarget.value)}
      />
      <p class="hint">
        {toOaiy
          ? 'Sent inside the brief. Hours, services and bookings the agent looks up during the call come from your FormLogic records through the business lookup.'
          : 'The only facts it will state about the business. Anything not covered here, it offers to have the team confirm - so an empty box means no invented menus or prices.'}
      </p>
    </section>
  );
}
