import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { usePublicConfig } from "../../hooks/usePublicConfig";
import { SectionLabel } from "./shared";

export function PricingSection({ beta }: { beta: boolean }) {
  const { plans } = usePublicConfig();
  const paid = plans.paymentsEnabled && !beta;
  const cards = [
    {
      name: plans.freeName,
      price: "$0",
      period: "no card required",
      description: plans.freeDescription,
      items: [
        "Forms, apps and automations",
        "Your backend logic and databases",
        "Use OAIY, Codex or your own API provider",
        "Visual builders work without AI",
      ],
      to: "/signup",
      action: "Create a free workspace",
    },
    ...(paid
      ? [
          {
            name: plans.paidName,
            price: new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: plans.currency,
            }).format(plans.pricePerMonthCents / 100),
            period: "USD / 30 days",
            description: plans.paidDescription,
            items: [
              "Optional support for development",
              "Free access remains available",
              "Prepaid, with no auto-renewal",
              "AI provider charges are separate",
            ],
            to: "/billing",
            action: "View support options",
          },
        ]
      : []),
    {
      name: "Your AI, your choice",
      price: "BYO AI",
      period: "",
      description: "A guided setup helps connect the AI you already use.",
      items: [
        "OAIY desktop with Codex sign-in",
        "Your own provider API key",
        "Local models on your computer",
        "Change providers in Settings",
      ],
      to: "/connect-ai",
      action: "Explore AI setup",
    },
  ];
  return (
    <section id="pricing" className="lv2-section lv2-band">
      <div className="lv2-container">
        <div className="lv2-heading--center" data-reveal="">
          <SectionLabel both>Free to build</SectionLabel>
          <h2 className="lv2-h2">Bring your ideas. Bring your own AI.</h2>
          <p className="lv2-lead">
            FormLogic is free to use while we keep building it together. Connect
            your own AI when you want help, or start with the visual builders.
          </p>
        </div>
        <div className="lv2-pricing-grid lv2-pricing-dynamic" data-reveal="">
          {cards.map((card, i) => (
            <article
              key={card.name}
              className={`lv2-plan${i === 0 ? " lv2-plan--featured" : ""}`}
            >
              <h3>{card.name}</h3>
              <div className="lv2-plan__price">
                <strong>{card.price}</strong>
                <span>{card.period}</span>
              </div>
              <p>{card.description}</p>
              <ul>
                {card.items.map((item) => (
                  <li key={item}>
                    <Check size={15} />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                to={card.to}
                className={`lv2-plan__cta${i === 0 ? " lv2-plan__cta--primary" : ""}`}
              >
                {card.action}
                <ArrowRight size={15} />
              </Link>
            </article>
          ))}
        </div>
        <p className="lv2-pricing__fineprint">
          {paid
            ? "Supporting FormLogic is optional. Your free workspace does not expire."
            : "No payments are being accepted right now. No card required."}{" "}
          Your AI provider may charge separately. Codex requires an eligible
          account or API billing.
        </p>
      </div>
    </section>
  );
}
