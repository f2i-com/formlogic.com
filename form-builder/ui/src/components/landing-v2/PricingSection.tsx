import { Link } from 'react-router-dom';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { SectionLabel } from './shared';

const SALES_EMAIL = `mailto:sales@${import.meta.env.VITE_PUBLIC_DOMAIN || 'formlogic.com'}?subject=FormLogic%20Enterprise`;

type Plan = {
  name: string;
  price: string;
  period: string;
  description: string;
  items: string[];
  action: string;
  featured?: boolean;
  /** internal router path, or an href (mailto / hash) */
  to?: string;
  href?: string;
};

const PLANS: Plan[] = [
  {
    name: 'Self-hosted',
    price: '$0',
    period: 'forever',
    description: 'Run FormLogic on your own infrastructure.',
    items: [
      'Complete source access',
      'Unlimited forms and responses',
      'Apps, flows, API and packs',
      'Your own storage and AI',
    ],
    action: 'Read the docs',
    to: '/docs',
  },
  {
    name: 'Personal',
    price: '$5',
    period: '/ 30 days',
    description: 'Managed FormLogic without a subscription.',
    items: [
      'First 30 days free',
      '100 forms and 1 GB storage',
      'Unlimited responses (fair use)',
      'Prepaid with no auto-renewal',
    ],
    action: 'Start free',
    to: '/signup',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'Deployment and support for larger teams.',
    items: [
      'Everything in Personal',
      'Unlimited forms',
      'Configurable storage',
      'Deployment and security review',
    ],
    action: 'Talk to us',
    href: SALES_EMAIL,
  },
];

/** Dynamic pricing: three plans, with the beta banner while betaMode is on. */
export function PricingSection({ beta }: { beta: boolean }) {
  return (
    <section id="pricing" className="lv2-section lv2-band">
      <div className="lv2-container">
        <div className="lv2-heading--center" data-reveal="">
          <SectionLabel both>Simple pricing</SectionLabel>
          <h2 className="lv2-h2">Start free. Pay without another subscription.</h2>
          <p className="lv2-lead">
            {beta
              ? 'The hosted service is free during public beta. After beta, use prepaid Personal access or self-host for free.'
              : 'Use prepaid Personal access without a subscription, or self-host for free.'}
          </p>
          {beta && (
            <span className="lv2-beta-pill">
              <Sparkles size={14} /> Free during public beta — no card required
            </span>
          )}
        </div>
        <div className="lv2-pricing-grid" data-reveal="">
          {PLANS.map((plan) => {
            const body = (
              <>
                {plan.featured && <span className="lv2-plan__popular">Most popular</span>}
                <h3>{plan.name}</h3>
                <div className="lv2-plan__price">
                  <strong>{plan.price}</strong>
                  {plan.period && <span>{plan.period}</span>}
                </div>
                <p>{plan.description}</p>
                <ul>
                  {plan.items.map((item) => (
                    <li key={item}>
                      <Check size={15} /> {item}
                    </li>
                  ))}
                </ul>
                {plan.to ? (
                  <Link
                    to={plan.to}
                    className={`lv2-plan__cta${plan.featured ? ' lv2-plan__cta--primary' : ''}`}
                  >
                    {plan.action} <ArrowRight size={15} />
                  </Link>
                ) : (
                  <a href={plan.href} className="lv2-plan__cta">
                    {plan.action} <ArrowRight size={15} />
                  </a>
                )}
              </>
            );
            return (
              <article
                key={plan.name}
                className={`lv2-plan${plan.featured ? ' lv2-plan--featured' : ''}`}
              >
                {body}
              </article>
            );
          })}
        </div>
        <p className="lv2-pricing__fineprint">
          Personal is prepaid — no auto-renewal, cancel anytime, export everything.
        </p>
      </div>
    </section>
  );
}
