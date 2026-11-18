import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

/** Visitor-side capture of the fictional pottery studio in scripts/capture-hosted-apps.mjs. */
export function HostedAppPreview() {
  return (
    <figure className="lv2-hosted-example">
      <div className="lv2-hosted-example__image">
        <img src={`${import.meta.env.BASE_URL}images/docs/javascript-app-visitor.jpg`} width="780" height="1440"
          loading="lazy" decoding="async" alt="A hosted pottery studio app showing a class timetable, prices and places available." />
      </div>
      <figcaption>
        <div><span>Hosted app example</span><strong>Pottery class bookings</strong></div>
        <Link to="/docs#javascript-apps">Hosting guide <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </figcaption>
    </figure>
  );
}
