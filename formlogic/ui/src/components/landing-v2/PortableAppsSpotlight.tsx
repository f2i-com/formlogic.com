import { Link } from 'react-router-dom';
import { AppWindow, ArrowRight, Braces, ClipboardList } from 'lucide-react';
import { HostedAppPreview } from './HostedAppPreview';

const paths = [
  { icon: ClipboardList, title: 'Build with forms', text: 'Connect submissions to records, dashboards and staff screens.', to: '/apps/new?type=forms' },
  { icon: AppWindow, title: 'Design a web app', text: 'Edit your app in Studio or Builder and preview the changes.', to: '/apps/new?type=web' },
  { icon: Braces, title: 'Upload a web app', text: 'Bring a ZIP of your JavaScript files or your React or Vue build.', to: '/apps/new?type=upload' },
];

export function PortableAppsSpotlight() {
  return (
    <section className="lv2-hosting" id="portable-apps" aria-labelledby="portable-title">
      <div className="lv2-container lv2-hosting__layout">
        <div>
          <h2 id="portable-title" className="lv2-guide-title">Build an app for your team.</h2>
          <p className="lv2-guide-intro">Choose how to start. Add a private API and SQLite database when your app needs shared records.</p>
          <div className="lv2-hosting__paths">
            {paths.map(({icon: Icon, title, text, to}) => <Link key={to} to={to}>
              <Icon size={20} aria-hidden="true" /><div><h3>{title}</h3><p>{text}</p></div>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>)}
          </div>
        </div>
        <HostedAppPreview />
      </div>
    </section>
  );
}
