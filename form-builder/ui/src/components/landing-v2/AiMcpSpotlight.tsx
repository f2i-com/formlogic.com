import { Link } from 'react-router-dom';
import { ArrowRight, Bot, CheckCircle2 } from 'lucide-react';

/** "Build it with your AI" — the MCP builder card with the chat terminal. */
export function AiMcpSpotlight() {
  return (
    <section className="lv2-section lv2-band--tint">
      <div className="lv2-container lv2-ai__card" data-reveal="">
        <div className="lv2-ai__copy">
          <span className="lv2-ai__icon">
            <Bot size={24} />
          </span>
          <div>
            <span className="lv2-ai__label">Build it with your AI</span>
          </div>
          <h2>Describe the software you need. Let your AI work inside FormLogic.</h2>
          <p>
            Connect Claude, ChatGPT, Cursor or another MCP client with scoped OAuth. Your AI can
            create and edit the structure while you stay in control of permissions and data access.
          </p>
          <Link to="/docs" className="lv2-btn lv2-btn--light">
            See how AI building works <ArrowRight size={17} />
          </Link>
        </div>
        <div className="lv2-ai__terminal">
          <div className="lv2-ai__terminal-bar">
            <span />
            <span />
            <span />
            <small>Connected AI · FormLogic MCP</small>
          </div>
          <p>
            <strong>you</strong> Build a dental front-desk app with customers, appointments and
            follow-ups.
          </p>
          <p className="lv2-ai__reply">
            <strong>AI</strong> I&rsquo;ve created 4 forms, linked the customer records, added a
            staff dashboard and drafted 2 flows.
          </p>
          <span className="lv2-ai__success">
            <CheckCircle2 size={15} /> Changes ready to review in FormLogic
          </span>
        </div>
      </div>
    </section>
  );
}
