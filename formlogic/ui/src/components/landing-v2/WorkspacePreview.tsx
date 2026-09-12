import { ArrowRight } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';

/** Real dashboard captures, generated with isolated sample data. See scripts/capture-dashboard-preview.mjs. */
export function WorkspacePreview() {
  const theme = useUIStore((state) => state.theme);
  const base = `${import.meta.env.BASE_URL}images/dashboard-demo`;

  return (
    <figure className="fl-workspace" aria-label="Studio workspace demo">
      <div className="fl-workspace__bar">
        <span>Studio workspace</span>
        <span className="fl-example-label">Demo preview</span>
      </div>
      <picture className="fl-workspace__capture">
        <source media="(max-width: 640px)" srcSet={`${base}/mobile-${theme}.jpg`} width={780} height={2000} />
        <img
          src={`${base}/desktop-${theme}.jpg`}
          width={2880}
          height={2000}
          loading="lazy"
          decoding="async"
          alt="FormLogic dashboard with workspace navigation, a Client portal and Studio bookings app, form creation tools, response counts and recent activity. All data is fictional."
        />
      </picture>
      <figcaption className="fl-workspace__foot">
        <span>Actual dashboard screenshot with sample data.</span>
        <a href="#live-demo">Try a working app <ArrowRight size={14} aria-hidden="true" /></a>
      </figcaption>
    </figure>
  );
}
