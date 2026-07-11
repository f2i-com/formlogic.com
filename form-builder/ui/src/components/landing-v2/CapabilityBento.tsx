import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Boxes,
  HardDrive,
  LayoutDashboard,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { SectionLabel } from './shared';

const CARDS: Array<{
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  wide?: boolean;
  to: string;
}> = [
  {
    icon: Boxes,
    eyebrow: 'Apps',
    title: 'Real software, built around your work',
    body: 'Turn connected forms into branded staff apps, client portals and admin consoles — with roles, linked records and custom screens.',
    wide: true,
    to: '/docs',
  },
  {
    icon: Workflow,
    eyebrow: 'Flows',
    title: 'Automate the hand-offs',
    body: 'React to forms, calls and messages with visual workflows, tracked runs and reusable logic.',
    to: '/docs',
  },
  {
    icon: Bot,
    eyebrow: 'AI + MCP',
    title: 'Build with the AI you already use',
    body: 'Connect an AI through scoped OAuth and let it create forms, apps, dashboards, reports and flows with you.',
    to: '/docs',
  },
  {
    icon: LayoutDashboard,
    eyebrow: 'Insight',
    title: 'Dashboards that stay attached to the work',
    body: 'Move from live records to charts, printable reports and operational views without exporting.',
    to: '/docs',
  },
  {
    icon: HardDrive,
    eyebrow: 'Ownership',
    title: 'Your data stays portable',
    body: 'Cloud or self-hosted. Export in familiar formats, with a dedicated SQLite database per form — no one-way door.',
    to: '/docs',
  },
];

/** Capability bento: Apps, Flows, AI/MCP, dashboards, data ownership. */
export function CapabilityBento() {
  return (
    <section className="lv2-section lv2-band--alt">
      <div className="lv2-container">
        <div style={{ maxWidth: 700, marginBottom: 52 }} data-reveal="">
          <SectionLabel>More than a form builder</SectionLabel>
          <h2 className="lv2-h2">Everything stays connected to the same source of truth.</h2>
          <p className="lv2-lead">
            Start small, then add the interface, automation and local capability your workflow
            actually needs.
          </p>
        </div>
        <div className="lv2-bento" data-reveal="">
          {CARDS.map(({ icon: Icon, eyebrow, title, body, wide, to }) => (
            <Link
              key={title}
              to={to}
              className={`lv2-bento__card${wide ? ' lv2-bento__card--wide' : ''}`}
            >
              <span className="lv2-bento__icon">
                <Icon size={21} />
              </span>
              <small>{eyebrow}</small>
              <h3>{title}</h3>
              <p>{body}</p>
              <span className="lv2-bento__more">
                Learn more <ArrowRight size={14} />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
