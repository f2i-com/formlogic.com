import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  Database,
  FileText,
  KeyRound,
  Link2,
  Server,
  ShieldCheck,
  Workflow,
} from 'lucide-react';

const capabilities = [
  {
    icon: Link2,
    tag: 'Shared SQLite',
    title: 'Share one app database across apps, forms & charts',
    description:
      'Host a SoftN, PHP, Rust, JS, or Python app and link its live SQLite database to sibling apps or 1-click FormLogic Management Forms with live KPIs and charts.',
    points: ['Real-time WAL-mode SQLite sharing', '1-click Management CRUD & chart builder', 'Role-based team access controls'],
  },
  {
    icon: KeyRound,
    tag: 'External APIs',
    title: 'Spin up shared-DB API backends & invoke via API key',
    description:
      'Attach a dedicated SoftN API backend to any app database and call backend routes or trigger flows securely from external services using scoped flk_ API keys.',
    points: ['POST /api/v1/apps/{id}/invoke', 'Scoped apps:invoke & flows:run keys', 'Built-in route tester & live call logs'],
  },
  {
    icon: Workflow,
    tag: 'Cross-App Flows',
    title: 'Database triggers & programmatic cross-app automation',
    description:
      'React to database inserts, updates, deletes, or form submissions automatically — and let visual flows call other apps, query app tables, or run AI steps.',
    points: ['DB record-change event triggers', 'Call another app & App database nodes', 'Trigger flows from app code or REST API'],
  },
  {
    icon: ShieldCheck,
    tag: 'Forms & Privacy',
    title: 'Smart forms, ZIPP logic & optional E2EE vaults',
    description:
      'Build multi-step forms with sandboxed JavaScript or Python logic, linked records, webhooks, and end-to-end encrypted response vaults when privacy matters.',
    points: ['Sandboxed ZIPP expressions & validation', 'End-to-end encrypted Private forms', 'Self-hostable PHP + SQLite stack'],
  },
];

const guides = [
  { icon: FileText, title: 'Publish and share a form', to: '/docs#publishing' },
  { icon: Workflow, title: 'Automate a workflow', to: '/docs#flows' },
  { icon: Database, title: 'Manage records in an app', to: '/docs#native-records' },
  { icon: BarChart3, title: 'Explore response analytics', to: '/docs#analytics' },
  { icon: Bot, title: 'Build with an MCP client', to: '/docs#mcp' },
  { icon: Server, title: 'Host your own FormLogic', to: '/docs#self-hosting' },
];

export function CapabilityBento() {
  return (
    <section id="product" className="lv2-guides" aria-labelledby="lv2-platform-title">
      <div className="lv2-container">
        <div className="lv2-guide-head">
          <div>
            <span className="lv2-pill-eyebrow">Platform capabilities</span>
            <h2 id="lv2-platform-title" className="lv2-guide-title">Everything you need to run connected apps.</h2>
            <p className="lv2-guide-intro">
              Start simple with a form or a single app, then connect shared databases, external APIs, charts, and cross-app flows whenever you need them.
            </p>
          </div>
          <Link className="lv2-guide-link" to="/docs">All documentation <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>

        <div className="lv2-bento-grid">
          {capabilities.map(({ icon: Icon, tag, title, description, points }) => (
            <article key={title} className="lv2-bento-card">
              <div className="lv2-bento-card__top">
                <span className="lv2-bento-card__icon"><Icon size={20} aria-hidden="true" /></span>
                <span className="lv2-bento-card__tag">{tag}</span>
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
              <ul>
                {points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="lv2-guides__strip">
          <div className="lv2-guides__layout">
            <div>
              <h3 className="lv2-guides__subhead">Quick-start guides</h3>
              <Link className="lv2-guide-link" to="/docs">Browse all docs <ArrowRight size={15} aria-hidden="true" /></Link>
            </div>
            <div className="lv2-guides__links">
              {guides.map(({ icon: Icon, title, to }) => (
                <Link to={to} key={to}>
                  <Icon size={17} aria-hidden="true" />
                  <span>{title}</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
