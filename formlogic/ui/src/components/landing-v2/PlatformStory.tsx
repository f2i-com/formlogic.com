import { Fragment } from 'react';
import { ChevronRight, FileText, LayoutDashboard, Workflow } from 'lucide-react';
import { SectionLabel } from './shared';

const STEPS = [
  {
    num: '01',
    tile: 'lv2-icon-tile--violet',
    icon: FileText,
    title: 'Capture',
    body: 'Collect structured data with forms — or let Aokie turn calls and messages into useful business records.',
    tags: ['Forms', 'Calls', 'Messages'],
  },
  {
    num: '02',
    tile: 'lv2-icon-tile--cyan',
    icon: LayoutDashboard,
    title: 'Operate',
    body: 'Give staff and customers purpose-built apps, portals, dashboards, roles, reports and custom screens.',
    tags: ['Apps', 'Roles', 'Dashboards'],
  },
  {
    num: '03',
    tile: 'lv2-icon-tile--lime',
    icon: Workflow,
    title: 'Automate',
    body: 'Connect triggers, decisions, local AI, records and services in flows that keep working with the browser closed.',
    tags: ['Flows', 'AI', 'Connectors'],
  },
];

/** Capture → Operate → Automate — the three-part platform story. */
export function PlatformStory() {
  return (
    <section id="platform" className="lv2-section lv2-band">
      <div className="lv2-container">
        <div className="lv2-heading--center" data-reveal="">
          <SectionLabel both>One system, end to end</SectionLabel>
          <h2 className="lv2-h2">Capture the work. Run it. Improve it.</h2>
          <p className="lv2-lead">
            FormLogic connects the front door of your business to the software and logic behind it.
          </p>
        </div>

        <div className="lv2-platform__grid" data-reveal="">
          {STEPS.map(({ num, tile, icon: Icon, title, body, tags }, i) => (
            <Fragment key={num}>
              {i > 0 && (
                <span className="lv2-platform__arrow" aria-hidden="true">
                  <ChevronRight size={18} />
                </span>
              )}
              <article className="lv2-platform__card">
                <span className="lv2-platform__num lv2-mono">{num}</span>
                <span className={`lv2-icon-tile ${tile}`}>
                  <Icon size={22} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
                <div className="lv2-tags">
                  {tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              </article>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
