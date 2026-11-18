import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, HardHat, MessagesSquare, Ticket } from 'lucide-react';
import { resolveBackendApiUrl } from '../../lib/apiBase';

/** These are bundled public listings too, so the examples work without a shared Demo account. */
export function StarterExamples() {
  const [showCapture, setShowCapture] = useState(true);
  return (
    <section id="demo" className="lv2-examples" aria-labelledby="starter-examples-title">
      <div className="lv2-container">
        <div className="lv2-guide-head">
          <div>
            <h2 id="starter-examples-title" className="lv2-guide-title">Find a starting point.</h2>
            <p>Explore the forms and screens in a working template before you build your own.</p>
          </div>
          <Link className="lv2-guide-link" to="/packs">Browse the marketplace <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className="lv2-starters">
          <Link className="lv2-starter-feature" to="/packs/event-management">
            <div className="lv2-starter-feature__copy">
              <Ticket size={23} aria-hidden="true" />
              <h3>Event Management</h3>
              <p>Take registrations, coordinate speakers and volunteers, and collect feedback after the event.</p>
              <span className="lv2-starter-action">Preview template <ArrowRight size={15} aria-hidden="true" /></span>
            </div>
            {showCapture && <div className="lv2-starter-capture" aria-hidden="true"><img
              src={resolveBackendApiUrl('/packs/screenshots/event-management.png')} width="2720" height="1700"
              loading="lazy" decoding="async" alt="" onError={() => setShowCapture(false)}
            /></div>}
          </Link>
          <div className="lv2-starter-list">
            <Link to="/packs/customer-service">
              <MessagesSquare size={22} aria-hidden="true" /><div><h3>Customer Service</h3>
                <p>Track support tickets, refund requests and escalations.</p></div>
              <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
            <Link to="/packs/sitepulse-site-diary">
              <HardHat size={22} aria-hidden="true" /><div><h3>Construction Site Diary</h3>
                <p>Log daily site work, deliveries and defects with SitePulse.</p></div>
              <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
