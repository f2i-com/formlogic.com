import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, FileText, Layers3, Database, Download, ShieldCheck } from 'lucide-react';
import { SectionLabel } from './shared';

const steps = [
  { Icon: FileText, title: 'Start with what you need', body: 'Create a form, choose a template, or bring an existing app project into App Studio.' },
  { Icon: Layers3, title: 'Design your app', body: 'Combine forms into an editable project. Shape the screens and interactions with our Softn app engine.' },
  { Icon: Database, title: 'Connect and host', body: "Add private .logic backend actions and store records in your app's own SQLite database. Preview, publish and invite your members." },
  { Icon: Download, title: 'Keep building, anywhere', body: 'Download your client source, save the full editable project, or export a snapshot of your database.' },
];

export function PortableAppsSpotlight() {
  return <section className="lv2-section lv2-band--alt" id="portable-apps" aria-labelledby="portable-title">
    <div className="lv2-container">
      <div className="fl-portable">
        <div>
          <SectionLabel both>From an idea to a working app</SectionLabel>
          <h2 className="lv2-h2" id="portable-title">Your screens.<br />Your logic. Your app.</h2>
          <p className="lv2-lead">Build an app your team can use, with an interface you can change and a backend that keeps the work moving. FormLogic brings the project, hosting and data together.</p>
          <div className="fl-hosting-path" aria-label="How a hosted app works">
            <div><Layers3 size={20} aria-hidden="true" /><strong>App interface</strong><span>Built with Softn</span></div>
            <ArrowRight size={18} aria-hidden="true" />
            <div><ShieldCheck size={20} aria-hidden="true" /><strong>Private actions</strong><span>FormLogic API</span></div>
            <ArrowRight size={18} aria-hidden="true" />
            <div><Database size={20} aria-hidden="true" /><strong>Your records</strong><span>App SQLite database</span></div>
          </div>
          <p className="fl-portable__credit">Powered by <a href="https://softn.com" target="_blank" rel="noopener noreferrer">Softn <ArrowUpRight size={14} aria-hidden="true" /></a>, our app-building engine. Keep the editable source and make the experience your own.</p>
          <Link to="/signup" className="fl-hosting-cta">Start building <ArrowRight size={17} aria-hidden="true" /></Link>
        </div>
        <ol className="fl-portable__steps" aria-label="From form to hosted app">
          {steps.map(({ Icon, title, body }, index) => <li key={title}>
            <span className="fl-portable__icon"><Icon size={22} aria-hidden="true" /></span>
            <div><span className="fl-portable__number">0{index + 1}</span><h3>{title}</h3><p>{body}</p></div>
          </li>)}
        </ol>
      </div>
      <p className="fl-hosting-note">Already have forms? Portable exports start with local records. Connect their submissions to backend actions when you want shared data; existing form responses are not automatically moved. Hosted apps are available to their owner and active members.</p>
    </div>
  </section>;
}
