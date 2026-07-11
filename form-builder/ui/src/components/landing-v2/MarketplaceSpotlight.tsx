import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck,
  ChevronRight,
  LayoutGrid,
  PhoneCall,
  ShieldCheck,
  ShoppingBag,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { SectionLabel } from './shared';

const PACKS: Array<{ icon: LucideIcon; label: string; tone: string; to: string }> = [
  { icon: PhoneCall, label: 'AI Receptionist', tone: 'violet', to: '/packs/aokie-receptionist' },
  { icon: CalendarCheck, label: 'Bookings', tone: 'cyan', to: '/packs' },
  { icon: ShoppingBag, label: 'Orders', tone: 'amber', to: '/packs' },
  { icon: Users, label: 'Client portals', tone: 'rose', to: '/packs' },
  { icon: ShieldCheck, label: 'Safety & quality', tone: 'green', to: '/packs' },
  { icon: LayoutGrid, label: 'Custom operations', tone: 'blue', to: '/packs' },
];

/** Marketplace proof: solution pack tiles + the catalogue link. */
export function MarketplaceSpotlight({ packCount }: { packCount: number }) {
  return (
    <section id="marketplace" className="lv2-section lv2-band--alt">
      <div className="lv2-container">
        <div className="lv2-heading--center" data-reveal="">
          <SectionLabel both>Start with a working system</SectionLabel>
          <h2 className="lv2-h2">Pick a pack. Make it yours.</h2>
          <p className="lv2-lead">
            Use a ready-made structure, then change the forms, screens, roles and flows to fit your
            business.
          </p>
        </div>
        <div className="lv2-pack-grid" data-reveal="">
          {PACKS.map(({ icon: Icon, label, tone, to }) => (
            <Link key={label} to={to}>
              <span
                style={{
                  background: `var(--lv2-tile-${tone}-bg)`,
                  color: `var(--lv2-tile-${tone}-fg)`,
                }}
              >
                <Icon size={20} />
              </span>
              <strong>{label}</strong>
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
        <Link to="/packs" className="lv2-market__all">
          Explore all {packCount} packs <ArrowRight size={15} />
        </Link>
      </div>
    </section>
  );
}
