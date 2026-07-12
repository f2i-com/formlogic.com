import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Headphones,
  MessageSquareText,
  PhoneCall,
  Puzzle,
  Radio,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { SectionLabel } from './shared';

const CHECKS = [
  ['Custom AI receptionist', 'with your greeting, voice and instructions.'],
  ['Live call console', 'for answer, reject, hang-up and monitoring.'],
  ['Calls become work', '— transcripts, summaries, appointment requests and follow-ups.'],
  ['Remote visibility', 'through the FormLogic app while Desktop handles the local connection.'],
] as const;

const READINESS = [
  [Puzzle, 'Plugin', 'Running'],
  [Radio, 'Dongle', 'Ready'],
  [Smartphone, 'Phone', 'Connected'],
  [Headphones, 'Voice', 'Ready'],
] as const;

/** The Aokie AI Receptionist spotlight: claims copy + the console mockup. */
export function AokieSpotlight() {
  return (
    <section id="aokie" className="lv2-section lv2-aokie">
      <div className="lv2-container lv2-split">
        <div className="lv2-split__copy" data-reveal="">
          <SectionLabel>Meet Aokie</SectionLabel>
          <span className="lv2-new-badge">Hardware beta · Desktop-powered</span>
          <h2 className="lv2-h2">Turn the phone you already use into a smarter front desk.</h2>
          <p className="lv2-lead">
            Aokie can answer business calls, recognise returning callers and capture what happens as
            structured FormLogic records — so flows and your team can take the next step.
          </p>
          <ul className="lv2-checks">
            {CHECKS.map(([lead, rest]) => (
              <li key={lead}>
                <CheckCircle2 size={18} />
                <span>
                  <strong>{lead}</strong> {rest}
                </span>
              </li>
            ))}
          </ul>
          <div className="lv2-inline-actions">
            <Link to="/aokie" className="lv2-btn lv2-btn--primary">
              Explore Aokie <ArrowRight size={17} />
            </Link>
            <span>Requires FormLogic Desktop on Windows and compatible Bluetooth hardware — the guide covers it all.</span>
          </div>
        </div>

        <div className="lv2-console" data-reveal="">
          <div className="lv2-console__accent" aria-hidden="true" />
          <div className="lv2-console__header">
            <span className="lv2-console__orb">
              <PhoneCall size={21} />
            </span>
            <div>
              <strong>Aokie Receptionist</strong>
              <small>Brightside Dental</small>
            </div>
            <span className="lv2-ready-badge">
              <i /> Ready
            </span>
          </div>
          <div className="lv2-console__readiness">
            {READINESS.map(([Icon, label, state]) => (
              <span key={label}>
                <Icon size={17} />
                <small>{label}</small>
                <strong>{state}</strong>
              </span>
            ))}
          </div>
          <div className="lv2-console__call">
            <div className="lv2-console__caller">
              <span>JW</span>
              <div>
                <small>Recent call · 4m ago</small>
                <strong>Jordan Wells</strong>
                <p>Appointment request captured</p>
              </div>
              <span className="lv2-console__duration">02:18</span>
            </div>
            <div className="lv2-console__summary">
              <Sparkles size={16} />
              <p>
                Returning customer requested a Tuesday afternoon check-up. Preferred time:
                2:30&nbsp;pm.
              </p>
            </div>
            <div className="lv2-console__results">
              <span>
                <CalendarCheck size={16} /> Appointment request
              </span>
              <span>
                <MessageSquareText size={16} /> Reply draft
              </span>
              <span>
                <CheckCircle2 size={16} /> Call record
              </span>
            </div>
          </div>
          <div className="lv2-console__footer">
            <span>
              <ShieldCheck size={15} /> Auto-answer is always opt-in
            </span>
            <Link to="/packs/aokie-receptionist">Open live console</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
