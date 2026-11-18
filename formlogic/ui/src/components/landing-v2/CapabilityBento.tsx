import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, BarChart3, Bot, Database, FileText, Server, Workflow } from 'lucide-react';

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
    <section id="product" className="lv2-guides" aria-labelledby="lv2-guides-title">
      <div className="lv2-container lv2-guides__layout">
        <div><h2 id="lv2-guides-title" className="lv2-guide-title">How-to guides</h2>
          <Link className="lv2-guide-link" to="/docs">All documentation <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className="lv2-guides__links">
          {guides.map(({ icon: Icon, title, to }) => <Link to={to} key={to}>
            <Icon size={18} aria-hidden="true" /><span>{title}</span><ArrowUpRight size={15} aria-hidden="true" />
          </Link>)}
        </div>
      </div>
    </section>
  );
}
