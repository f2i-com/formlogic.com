import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';

/**
 * Real captures of an app's own page, with a web app that was built elsewhere running in it.
 * The app and its classes are fictional. See scripts/capture-hosted-apps.mjs.
 */
export function HostedAppPreview() {
  const theme = useUIStore((state) => state.theme);
  const base = `${import.meta.env.BASE_URL}images/hosted-app`;

  return (
    <figure className="fl-workspace fl-hosted-app" aria-label="A hosted web app on its page">
      <div className="fl-workspace__bar">
        <span>A web app you built, on its page</span>
        <span className="fl-example-label">Demo preview</span>
      </div>
      <picture className="fl-workspace__capture fl-workspace__capture--app">
        <source media="(max-width: 640px)" srcSet={`${base}/mobile-${theme}.jpg`} width={780} height={1800} />
        <img
          src={`${base}/desktop-${theme}.jpg`}
          width={1776}
          height={1350}
          loading="lazy"
          decoding="async"
          alt="An app's own page in FormLogic, with sections for Overview, Data, Members, Edit, Automations, Domains and Settings. A pottery studio's class timetable, built as a web app elsewhere, runs in the preview with places left read from its own database; beside it are Upload a new build, Edit the backend code and how the app is hosted. All data is fictional."
        />
      </picture>
      <figcaption className="fl-workspace__foot">
        <span>Actual screenshot: a built web app, uploaded as a zip, with its own backend and database.</span>
        <Link to="/docs#javascript-apps">How a built app is hosted <ArrowRight size={14} aria-hidden="true" /></Link>
      </figcaption>
    </figure>
  );
}
