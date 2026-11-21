import { Link } from 'react-router-dom';
import { AppWindow, ArrowRight, BarChart3, Braces, KeyRound, Link2 } from 'lucide-react';
import { HostedAppPreview } from './HostedAppPreview';
import { useAuthStore } from '../../stores/authStore';

export function PortableAppsSpotlight() {
  const signedIn = useAuthStore((s) => !!s.user && !s.user.isDemo);
  const paths = [
    {
      icon: BarChart3,
      title: 'Forms, CRUD & live dashboards',
      text: 'Build forms with conditional logic, or auto-generate live CRUD forms and charts directly over any hosted app SQLite table.',
      to: signedIn ? '/apps/new?type=forms' : '/signup',
    },
    {
      icon: Braces,
      title: 'Host SoftN apps (PHP, Rust, JS, Python)',
      text: 'Upload a .softn or .zip project with a built-in SQLite database and private backend — no servers or DevOps to manage.',
      to: signedIn ? '/apps/new?type=upload' : '/signup',
    },
    {
      icon: Link2,
      title: 'Share databases & spin up API backends',
      text: 'Link multiple apps to the same SQLite database and expose dedicated API backends callable externally with scoped API keys.',
      to: signedIn ? '/apps' : '/signup',
    },
    {
      icon: AppWindow,
      title: 'Visual Builder & AI Studio',
      text: 'Start from a working web app template and refine pages, logic, and data visually or with your preferred AI model.',
      to: signedIn ? '/apps/new?type=web' : '/signup',
    },
  ];

  return (
    <section className="lv2-hosting" id="portable-apps" aria-labelledby="portable-title">
      <div className="lv2-container lv2-hosting__layout">
        <div>
          <span className="lv2-pill-eyebrow"><KeyRound size={13} aria-hidden="true" />Connected App Architecture</span>
          <h2 id="portable-title" className="lv2-guide-title">One workspace. Separate apps, shared data.</h2>
          <p className="lv2-guide-intro">
            Host customer-facing apps, private admin dashboards with charts, and external API backends — all backed by the same SQLite database and linked by visual flows.
          </p>
          <div className="lv2-hosting__paths">
            {paths.map(({ icon: Icon, title, text, to }) => (
              <Link key={title} to={to}>
                <Icon size={20} aria-hidden="true" />
                <div><h3>{title}</h3><p>{text}</p></div>
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
        <HostedAppPreview />
      </div>
    </section>
  );
}
