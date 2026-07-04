import { useState, useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Database,
  Code2,
  Shield,
  Download,
  ArrowRight,
  Check,
  Menu,
  Minus,
  X,
  Zap,
  Globe,
  BarChart3,
  Building2,
  Users,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { LiveDemoSection } from '../components/landing/LiveDemoSection';

// Landing-only chrome: a characterful display face (Bricolage Grotesque) + a
// monospace signature (JetBrains Mono) for the technical/data accents, plus the
// scoped style primitives the page leans on. Injected on mount instead of in
// index.html so the rest of the app never pays for marketing-only fonts.
function useLandingChrome() {
  useEffect(() => {
    if (!document.getElementById('fl-landing-fonts')) {
      const link = document.createElement('link');
      link.id = 'fl-landing-fonts';
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600&display=swap';
      document.head.appendChild(link);
    }
    if (!document.getElementById('fl-landing-styles')) {
      const style = document.createElement('style');
      style.id = 'fl-landing-styles';
      style.textContent = `
        .fl-display{font-family:'Bricolage Grotesque','Plus Jakarta Sans',system-ui,sans-serif;font-weight:800;letter-spacing:-0.035em;line-height:1.02;}
        .fl-mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;}
        .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-700)),rgb(var(--primary-500)) 52%,rgb(var(--primary-700)));-webkit-background-clip:text;background-clip:text;color:transparent;}
        :root.dark .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-300)),rgb(var(--primary-400)) 48%,rgb(var(--primary-200)));}
        .fl-grid{background-image:linear-gradient(rgb(var(--primary-500)/0.09) 1px,transparent 1px),linear-gradient(90deg,rgb(var(--primary-500)/0.09) 1px,transparent 1px);background-size:54px 54px;}
        .fl-reveal{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.16,1,.3,1),transform .8s cubic-bezier(.16,1,.3,1);}
        .fl-reveal.fl-in{opacity:1;transform:none;}
        .fl-dot{animation:flPulse 2.4s ease-in-out infinite;}
        @keyframes flPulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgb(var(--primary-500)/0.55)}50%{opacity:.65;box-shadow:0 0 0 7px rgb(var(--primary-500)/0)}}
        @media (prefers-reduced-motion:reduce){.fl-reveal{opacity:1!important;transform:none!important;transition:none!important}.fl-dot{animation:none}}
      `;
      document.head.appendChild(style);
    }
  }, []);
}

// Reveal-on-scroll: add `.fl-in` to every [data-reveal] element when it enters
// the viewport. Elements already on screen at mount (the hero) reveal instantly.
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (els.length === 0) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('fl-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('fl-in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -48px 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

// Minimal browser chrome around a real product screenshot — same traffic-light
// treatment as the terminal window further down, so the page reads as one set.
function BrowserFrame({
  url,
  className = '',
  children,
}: {
  url: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-gray-200/90 dark:border-slate-700/60 bg-white dark:bg-slate-900 overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.05),0_16px_40px_-12px_rgba(15,23,42,0.18)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.5),0_24px_56px_-16px_rgba(0,0,0,0.55)] ${className}`}
    >
      <div className="h-10 flex items-center gap-2 px-4 bg-gray-50 dark:bg-slate-900 border-b border-gray-200/80 dark:border-slate-800">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
        </div>
        <span className="fl-mono text-[11px] text-gray-400 dark:text-slate-500 ml-3 min-w-0 truncate">{url}</span>
      </div>
      {children}
    </div>
  );
}

// Small mono eyebrow used to give each section an "engineered catalog" rhythm.
function SectionTag({ index, label }: { index: string; label: string }) {
  return (
    <div className="fl-mono inline-flex items-center gap-2.5 text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 mb-5">
      <span className="opacity-60">{index}</span>
      <span className="h-px w-8 bg-primary-500/40" />
      <span>{label}</span>
    </div>
  );
}

export function Landing() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useLandingChrome();
  useReveal();

  // Quiet capability proof — no fake numerals, just what the product actually is.
  const proofPoints = [
    { icon: Globe, label: 'Self-hosted or cloud' },
    { icon: Shield, label: 'Sandboxed JS runtime' },
    { icon: Database, label: 'SQLite per form' },
    { icon: Download, label: 'Your data, exportable' },
  ];

  // Marketplace apps shown as the real, running product — both themes represented.
  const showcaseApps = [
    {
      src: '/landing/app-salon-light.png',
      url: 'formlogic.app/apps/salon',
      name: 'Salon',
      caption: 'live dashboard',
      packSlug: 'salon-beauty-studio',
      alt: 'Salon app from the FormLogic marketplace — a configurable dashboard with booking, revenue and stylist KPIs and charts',
    },
    {
      src: '/landing/app-safety-dark.png',
      url: 'formlogic.app/apps/safety',
      name: 'Safety',
      caption: 'incident dashboard',
      packSlug: 'ohs-qms',
      alt: 'Safety app from the FormLogic marketplace — incident KPIs, a severity breakdown and recent incidents, in dark mode',
    },
  ];

  const features = [
    {
      icon: Database,
      title: 'Enterprise-grade data',
      description: 'Each form gets a dedicated SQLite database. Export anytime, query with any tool. Your data, your format.',
    },
    {
      icon: Code2,
      title: 'Programmable logic',
      description: 'Execute server-side scripts on every submission. Score leads, validate data, route workflows automatically.',
    },
    {
      icon: Shield,
      title: 'Secure by design',
      description: 'Sandboxed execution with strict limits. No client-side tampering. Your logic runs safely on our servers.',
    },
    {
      icon: Zap,
      title: 'Lightweight stack',
      description: 'A lean PHP + SQLite backend with no heavy runtime to manage — quick to deploy and responsive by design.',
    },
    {
      icon: Globe,
      title: 'Self-host ready',
      description: 'Deploy on your own infrastructure with full source access. No vendor lock-in, complete control.',
    },
    {
      icon: BarChart3,
      title: 'Built-in analytics',
      description: 'Track submissions, conversion rates, and response patterns. Insights out of the box, no setup required.',
    },
  ];

  const useCases = [
    {
      title: 'Lead qualification',
      description: 'Automatically score and route leads based on responses, company size, and budget.',
      icon: Users,
    },
    {
      title: 'Application processing',
      description: 'Build multi-step applications with server-validated eligibility and instant decisions.',
      icon: Building2,
    },
    {
      title: 'Survey intelligence',
      description: 'Enrich responses with computed scores, classifications, and real-time analysis.',
      icon: BarChart3,
    },
    {
      title: 'Workflow automation',
      description: 'Trigger actions, update databases, and integrate with your stack on every submission.',
      icon: Zap,
    },
  ];

  const pricingPlans = [
    {
      name: 'Self-hosted',
      price: '$0',
      period: 'forever',
      description: 'Run it on your own infrastructure',
      features: [
        'Complete source access',
        'Unlimited forms & responses',
        'SQLite per-form databases',
        'Backend scripts, API, AI & packs',
        'Community support',
      ],
      cta: 'Read the docs',
      ctaHref: '/docs#self-hosting',
      highlighted: false,
    },
    {
      name: 'Personal',
      price: '$5',
      period: '/ 30 days',
      description: 'Managed cloud, prepaid',
      features: [
        'First 30 days free',
        '100 forms · 1 GB storage',
        'Unlimited responses (fair use)',
        'Business apps, scripts & API',
        'Prepaid — pay with PayPal, no subscription',
      ],
      cta: 'Get started',
      ctaHref: '/signup',
      highlighted: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      description: 'For teams & scale',
      features: [
        'Everything in Personal',
        'Unlimited forms',
        'Configurable storage',
        'Free self-hosting or commercial support',
        'Custom deployment & security review',
      ],
      cta: 'Contact sales',
      ctaHref: 'mailto:sales@formlogic.app?subject=FormLogic%20Enterprise',
      ctaExternal: true,
      highlighted: false,
    },
  ];

  // Detailed feature comparison shown under the plan cards. Boolean cells
  // render as Check/Minus icons instead of text.
  const comparison: Array<{ feature: string; personal: string | boolean; enterprise: string | boolean }> = [
    { feature: 'Forms', personal: '100', enterprise: 'Unlimited' },
    { feature: 'Responses', personal: 'Unlimited (fair use)', enterprise: 'Unlimited' },
    { feature: 'Storage', personal: '1 GB', enterprise: 'Configurable' },
    { feature: 'Business apps', personal: 'Included', enterprise: 'Included' },
    { feature: 'Backend scripts', personal: true, enterprise: true },
    { feature: 'API', personal: true, enterprise: true },
    { feature: 'AI (local)', personal: 'Unlimited', enterprise: 'Unlimited' },
    { feature: 'Packs', personal: true, enterprise: true },
    { feature: 'Self-hosting', personal: 'Free', enterprise: 'Free / Commercial support' },
  ];

  const renderPlanCell = (value: string | boolean) =>
    typeof value === 'boolean' ? (
      <span className="inline-flex items-center justify-end">
        {value ? (
          <Check className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
        ) : (
          <Minus className="h-4 w-4 text-gray-400 dark:text-slate-600" aria-hidden="true" />
        )}
        <span className="sr-only">{value ? 'Included' : 'Not included'}</span>
      </span>
    ) : (
      value
    );

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-gray-900 dark:text-slate-50 selection:bg-primary-500/20 overflow-x-hidden">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 bg-white/85 dark:bg-slate-950/75 backdrop-blur-xl border-b border-gray-100 dark:border-primary-500/10 z-50 transition-all duration-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link
              to="/"
              aria-label="FormLogic home"
              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
            >
              <Logo size="md" />
            </Link>
            <div className="hidden md:flex items-center gap-8">
              <a href="#features" className="fl-mono text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Features
              </a>
              <a href="#solutions" className="fl-mono text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Solutions
              </a>
              <Link to="/packs" className="fl-mono text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Marketplace
              </Link>
              <a href="#pricing" className="fl-mono text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Pricing
              </a>
              <Link to="/docs" className="fl-mono text-xs uppercase tracking-wider text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Docs
              </Link>
            </div>
            <div className="hidden md:flex items-center gap-4">
              <ThemeToggle />
              <Link to="/login" className="text-sm font-medium text-gray-500 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors">
                Sign in
              </Link>
              <Link to="/signup">
                <Button className="bg-primary-600 hover:bg-primary-500 text-primary-foreground border-0 shadow-md shadow-primary-600/20">
                  Get started free
                </Button>
              </Link>
            </div>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              className="md:hidden p-2 text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-900 rounded-lg transition-colors cursor-pointer"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white dark:bg-slate-950 border-t border-gray-100 dark:border-slate-900 py-4 px-4 space-y-3 shadow-2xl">
            <a
              href="#features"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
            >
              Features
            </a>
            <a
              href="#solutions"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
            >
              Solutions
            </a>
            <Link
              to="/packs"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
            >
              Marketplace
            </Link>
            <a
              href="#pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
            >
              Pricing
            </a>
            <Link
              to="/docs"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
            >
              Docs
            </Link>
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600 dark:text-slate-300 font-medium">Theme</span>
              <ThemeToggle />
            </div>
            <div className="pt-3 border-t border-gray-100 dark:border-slate-900 flex flex-col gap-2">
              <Link
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="py-2 text-gray-600 dark:text-slate-300 hover:text-primary-600 dark:hover:text-white font-medium"
              >
                Sign in
              </Link>
              <Link to="/signup" onClick={() => setMobileMenuOpen(false)}>
                <Button className="w-full bg-primary-600 text-primary-foreground">Get started free</Button>
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* Hero Section */}
      <section className="relative pt-36 sm:pt-44 pb-20 sm:pb-28 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/* Blueprint grid, masked to fade out toward the edges */}
        <div
          className="fl-grid absolute inset-0 pointer-events-none"
          style={{
            maskImage: 'radial-gradient(ellipse 75% 65% at 50% 30%, #000 0%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(ellipse 75% 65% at 50% 30%, #000 0%, transparent 78%)',
          }}
        />
        {/* Atmospheric glows */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1100px] h-[560px] bg-primary-600/12 blur-[130px] rounded-full opacity-60 pointer-events-none" />
        <div className="absolute top-24 right-[8%] w-[440px] h-[440px] bg-primary-500/10 blur-[110px] rounded-full opacity-40 pointer-events-none" />
        <div className="absolute -bottom-10 left-[6%] w-[380px] h-[380px] bg-primary-400/8 blur-[110px] rounded-full opacity-30 pointer-events-none" />

        <div className="relative max-w-6xl mx-auto text-center z-10">
          <div
            data-reveal
            className="fl-reveal inline-flex items-center gap-2.5 bg-white/70 dark:bg-slate-900/60 backdrop-blur-sm border border-primary-200/60 dark:border-primary-500/20 text-primary-700 dark:text-primary-300 pl-3 pr-4 py-1.5 rounded-full text-xs font-medium mb-8 shadow-sm shadow-primary-500/5"
          >
            <span className="fl-dot relative inline-flex h-2 w-2 rounded-full bg-primary-500" />
            <span className="fl-mono uppercase tracking-[0.18em]">Forms → business apps</span>
          </div>

          <h1
            data-reveal
            className="fl-display fl-reveal text-[2.85rem] leading-[1.04] sm:text-7xl text-gray-900 dark:text-white mb-7"
            style={{ transitionDelay: '80ms' }}
          >
            Build business apps
            <br />
            <span className="fl-grad">from forms</span>
          </h1>

          <p
            data-reveal
            className="fl-reveal text-lg sm:text-xl text-gray-500 dark:text-slate-400 mb-11 max-w-2xl mx-auto leading-relaxed"
            style={{ transitionDelay: '160ms' }}
          >
            Manually or with your AI. FormLogic turns forms into real business apps — backend
            logic, custom screens, linked records, roles, and a database per form. Build it
            yourself, or hand a link to your AI and let it build.
          </p>

          <div
            data-reveal
            className="fl-reveal flex flex-col sm:flex-row items-center justify-center gap-5 mb-16"
            style={{ transitionDelay: '240ms' }}
          >
            <Link to="/signup" className="w-full sm:w-auto group">
              <Button size="lg" className="w-full sm:w-auto text-base px-8 bg-primary-600 hover:bg-primary-500 text-primary-foreground shadow-lg shadow-primary-600/25 border-0 font-semibold">
                Get started free
                <ArrowRight className="h-5 w-5 ml-2 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
            <Link
              to="/login"
              className="group text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white font-medium flex items-center gap-2 py-2.5 px-1 transition-colors"
            >
              Sign in to your account
              <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>

          {/* Pipeline glimpse — the product's actual shape: submit → run logic → store */}
          <div
            data-reveal
            className="fl-reveal flex flex-wrap items-center justify-center gap-x-3 gap-y-2 fl-mono text-xs text-gray-400 dark:text-slate-500 mb-14"
            style={{ transitionDelay: '320ms' }}
          >
            <span className="px-3 py-1.5 rounded-full bg-gray-100/80 dark:bg-slate-900/70 border border-gray-200/70 dark:border-slate-800">submit()</span>
            <ArrowRight className="h-3.5 w-3.5 text-primary-500/70" />
            <span className="px-3 py-1.5 rounded-full bg-gray-100/80 dark:bg-slate-900/70 border border-gray-200/70 dark:border-slate-800">onSubmit(ctx)</span>
            <ArrowRight className="h-3.5 w-3.5 text-primary-500/70" />
            <span className="px-3 py-1.5 rounded-full bg-primary-50 dark:bg-primary-500/10 border border-primary-200/70 dark:border-primary-500/25 text-primary-700 dark:text-primary-300">db.write()</span>
          </div>

          {/* Product visual — the actual app runtime, in a browser frame. Loaded
              eagerly: it's the hero. Light/dark variants swap via CSS. */}
          <div
            data-reveal
            className="fl-reveal relative max-w-5xl mx-auto"
            style={{ transitionDelay: '400ms' }}
          >
            <div
              aria-hidden="true"
              className="absolute -inset-x-8 -top-10 h-72 bg-primary-500/15 dark:bg-primary-500/10 blur-[90px] rounded-full pointer-events-none"
            />
            <BrowserFrame url="formlogic.app/apps/inventory" className="relative">
              <img
                src="/landing/app-inventory-light.png"
                width={1360}
                height={900}
                fetchPriority="high"
                alt="FormLogic inventory app — sidebar navigation and a configurable stock dashboard with KPIs, charts and recent activity"
                className="block w-full h-auto dark:hidden"
              />
              <img
                src="/landing/app-inventory-dark.png"
                width={1360}
                height={900}
                alt="FormLogic inventory app in dark mode — sidebar navigation and a configurable stock dashboard with KPIs and charts"
                className="hidden w-full h-auto dark:block"
              />
            </BrowserFrame>
          </div>

          {/* Quiet proof strip — capabilities, not fake traction numerals */}
          <div
            data-reveal
            className="fl-reveal mt-12 flex flex-wrap items-center justify-center gap-x-9 gap-y-3 fl-mono text-[11px] uppercase tracking-wider text-gray-400 dark:text-slate-500"
          >
            {proofPoints.map((point) => (
              <div key={point.label} className="flex items-center gap-2.5">
                <point.icon className="h-4 w-4 text-primary-500/80 dark:text-primary-400/80" aria-hidden="true" />
                <span>{point.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Live demo band — try a real app with no signup */}
      <LiveDemoSection />

      {/* Features Section */}
      <section id="features" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8 relative">
        <div className="max-w-6xl mx-auto">
          <div data-reveal className="fl-reveal text-center mb-16 flex flex-col items-center">
            <SectionTag index="01" label="Features" />
            <h2 className="fl-display text-3xl sm:text-5xl text-gray-900 dark:text-white mb-5">
              Enterprise features,{' '}
              <span className="fl-grad">developer experience</span>
            </h2>
            <p className="text-lg text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              Everything you need to build sophisticated form-driven applications.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
            {features.map((feature, i) => (
              <div
                key={feature.title}
                data-reveal
                className="fl-reveal group relative bg-white dark:bg-slate-900/40 backdrop-blur-md rounded-2xl p-7 sm:p-8 border border-gray-200/80 dark:border-slate-800 hover:border-primary-300 dark:hover:border-primary-500/30 hover:bg-white dark:hover:bg-slate-800/60 transition-all duration-300 hover:shadow-xl hover:shadow-primary-500/[0.05] hover:-translate-y-1 overflow-hidden"
                style={{ transitionDelay: `${(i % 3) * 80}ms` }}
              >
                {/* accent line that draws in on hover */}
                <span className="absolute top-0 left-0 h-0.5 w-0 bg-gradient-to-r from-primary-500 to-primary-400 group-hover:w-full transition-all duration-500 ease-out" />
                <div className="flex items-start justify-between mb-5">
                  <div className="w-11 h-11 bg-primary-50 dark:bg-primary-500/10 rounded-xl flex items-center justify-center group-hover:scale-105 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/15 transition-all duration-300">
                    <feature.icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                  </div>
                  <span className="fl-mono text-xs text-gray-300 dark:text-slate-600 group-hover:text-primary-400 dark:group-hover:text-primary-400 transition-colors">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className="text-[17px] font-semibold text-gray-900 dark:text-white mb-2.5 tracking-tight">{feature.title}</h3>
                <p className="text-gray-500 dark:text-slate-400 leading-relaxed text-[15px]">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Code Demo Section */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-gray-50/80 dark:bg-slate-900/20 overflow-hidden relative border-y border-gray-100 dark:border-slate-800/50">
        <div className="absolute inset-0 bg-white/50 dark:bg-slate-950/80" />
        <div className="absolute top-1/2 left-0 w-[600px] h-[600px] bg-primary-600/5 dark:bg-primary-600/10 blur-[120px] rounded-full -translate-y-1/2 -translate-x-1/2" />

        <div className="max-w-6xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div data-reveal className="fl-reveal">
              <SectionTag index="02" label="Logic Engine" />
              <h2 className="fl-display text-3xl sm:text-5xl text-gray-900 dark:text-white mb-7 leading-tight">
                Real backend logic,
                <br />
                <span className="fl-grad">not just webhooks</span>
              </h2>
              <p className="text-lg text-gray-500 dark:text-slate-400 mb-10 leading-relaxed">
                Write server-side scripts that run on every submission. Score leads, validate data,
                route workflows, and store computed fields &mdash; all in a familiar JavaScript-like syntax.
              </p>
              <ul className="space-y-5">
                {[
                  'Sandboxed execution with 50k instruction limit',
                  'Access to all form data and submission context',
                  'Store computed fields directly to the database',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-4">
                    <div className="mt-0.5 p-1 bg-emerald-500/10 rounded-full">
                      <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                    </div>
                    <span className="text-gray-600 dark:text-slate-300 text-[17px]">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Terminal Window */}
            <div data-reveal className="fl-reveal relative group" style={{ transitionDelay: '120ms' }}>
              <div className="absolute -inset-1.5 bg-gradient-to-r from-primary-500/40 to-primary-600/40 rounded-2xl opacity-20 group-hover:opacity-35 blur-xl transition duration-500" />
              <div className="relative bg-[#0D1017] rounded-2xl shadow-2xl shadow-black/40 border border-slate-700/50 overflow-hidden">
                <div className="h-11 bg-[#161B22] flex items-center gap-2 px-4 border-b border-slate-700/40">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-[#FF5F57]" />
                    <div className="w-3 h-3 rounded-full bg-[#FEBC2E]" />
                    <div className="w-3 h-3 rounded-full bg-[#28C840]" />
                  </div>
                  <span className="fl-mono text-xs text-slate-500 ml-3 tracking-wide">onSubmit.ts</span>
                </div>
                <div className="p-5 sm:p-6 overflow-x-auto">
                  <div className="fl-mono text-[13px] leading-[1.75]">
                    <div className="text-slate-500 italic">// Runs on every submission</div>
                    <div className="text-purple-400 mt-3">
                      function <span className="text-blue-400">onSubmit</span>
                      <span className="text-slate-300">(ctx) {'{'}</span>
                    </div>
                    <div className="pl-6 border-l-2 border-slate-800/60 ml-1">
                      <div className="text-purple-400">
                        let <span className="text-slate-300">score</span> <span className="text-slate-500">=</span>{' '}
                        <span className="text-amber-400">0</span>
                        <span className="text-slate-500">;</span>
                      </div>
                      <div className="text-purple-400 mt-2">
                        if <span className="text-slate-300">(ctx.answers.budget</span>{' '}
                        <span className="text-slate-500">&gt;=</span> <span className="text-amber-400">10000</span>
                        <span className="text-slate-300">)</span>
                      </div>
                      <div className="pl-6 text-slate-300">
                        score <span className="text-slate-500">+=</span> <span className="text-amber-400">40</span>;
                      </div>
                      <div className="mt-3 text-slate-300">
                        ctx.db.<span className="text-blue-400">setField</span>
                        <span className="text-slate-300">(</span>
                        <span className="text-green-400">"lead_score"</span>
                        <span className="text-slate-300">, score);</span>
                      </div>
                      <div className="text-slate-300">
                        ctx.db.<span className="text-blue-400">setStatus</span>
                        <span className="text-slate-300">(</span>
                        <span className="text-green-400">"qualified"</span>
                        <span className="text-slate-300">);</span>
                      </div>
                    </div>
                    <div className="text-slate-300">{'}'}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SQLite Section */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-primary-50/60 dark:bg-primary-950/20 relative overflow-hidden">
        <div className="max-w-6xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div data-reveal className="fl-reveal order-2 lg:order-1">
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-8 shadow-xl shadow-gray-900/[0.03] dark:shadow-none border border-gray-200/80 dark:border-primary-500/20 relative group">
                <div className="absolute -inset-px bg-gradient-to-br from-primary-500/30 to-transparent rounded-2xl opacity-0 group-hover:opacity-100 transition duration-500 pointer-events-none" />
                <div className="flex items-center gap-4 mb-6 relative">
                  <div className="p-3 bg-primary-100 dark:bg-primary-500/10 rounded-xl">
                    <Download className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                  </div>
                  <span className="fl-mono text-sm text-gray-500 dark:text-slate-400">contact-form.sqlite</span>
                </div>
                <div className="fl-mono text-sm bg-gray-950 dark:bg-slate-950 rounded-xl p-6 text-slate-300 space-y-4 shadow-inner border border-gray-800 dark:border-slate-800 relative">
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-primary-400">responses</span>
                    <span className="text-slate-600">(id, answers, submitted_at, status)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-primary-400">computed</span>
                    <span className="text-slate-600">(response_id, field_name, value)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-primary-400">tags</span>
                    <span className="text-slate-600">(response_id, tag, created_at)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-primary-400">script_logs</span>
                    <span className="text-slate-600">(response_id, success, duration_ms)</span>
                  </div>
                </div>
                <p className="fl-mono text-xs text-gray-400 dark:text-slate-500 mt-6 text-center relative">Real tables. Real relationships. Real queries.</p>
              </div>
            </div>

            <div data-reveal className="fl-reveal order-1 lg:order-2" style={{ transitionDelay: '120ms' }}>
              <SectionTag index="03" label="Data Ownership" />
              <h2 className="fl-display text-3xl sm:text-5xl text-gray-900 dark:text-white mb-7">
                Your data.
                <br />
                <span className="fl-grad">Actually yours.</span>
              </h2>
              <p className="text-gray-500 dark:text-slate-400 text-lg mb-10 leading-relaxed">
                Each form gets its own SQLite database. Responses, computed fields, tags, audit logs &mdash;
                all in a portable, queryable format you can download anytime.
              </p>
              <ul className="space-y-5">
                {[
                  'Download the entire database anytime',
                  'Query with any SQLite-compatible tool',
                  'No vendor lock-in, ever',
                ].map((item) => (
                  <li key={item} className="flex items-center gap-4 text-gray-600 dark:text-slate-300">
                    <div className="p-1 bg-primary-100 dark:bg-primary-500/10 rounded-full">
                      <Check className="h-4 w-4 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                    </div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Solutions Section */}
      <section id="solutions" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8 bg-gray-50/80 dark:bg-slate-900/30">
        <div className="max-w-6xl mx-auto">
          <div data-reveal className="fl-reveal text-center mb-16 flex flex-col items-center">
            <SectionTag index="04" label="Solutions" />
            <h2 className="fl-display text-3xl sm:text-5xl text-gray-900 dark:text-white mb-5">Built for your use case</h2>
            <p className="text-lg text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              From lead generation to complex application processing, FormLogic handles it all.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-6">
            {useCases.map((useCase, i) => (
              <div
                key={useCase.title}
                data-reveal
                className="fl-reveal bg-white dark:bg-slate-950/80 rounded-2xl p-10 border border-gray-200/80 dark:border-slate-800 hover:border-primary-300 dark:hover:border-primary-500/30 hover:shadow-xl hover:shadow-gray-900/[0.04] transition-all duration-300 group"
                style={{ transitionDelay: `${(i % 2) * 80}ms` }}
              >
                <div className="w-12 h-12 bg-primary-50 dark:bg-slate-900 rounded-xl flex items-center justify-center mb-6 border border-primary-100/80 dark:border-slate-800 group-hover:border-primary-300 dark:group-hover:border-primary-500/30 group-hover:bg-primary-50 dark:group-hover:bg-primary-500/5 transition-all duration-300">
                  <useCase.icon className="h-6 w-6 text-primary-600 dark:text-slate-400 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3 tracking-tight">{useCase.title}</h3>
                <p className="text-gray-500 dark:text-slate-400 leading-relaxed group-hover:text-gray-600 dark:group-hover:text-slate-300 transition-colors">{useCase.description}</p>
              </div>
            ))}
          </div>

          {/* Marketplace showcase — real installable apps, not mockups */}
          <div data-reveal className="fl-reveal mt-24 text-center flex flex-col items-center">
            <h3 className="fl-display text-2xl sm:text-4xl text-gray-900 dark:text-white mb-4">
              Real apps on <span className="fl-grad">day one</span>
            </h3>
            <p className="text-lg text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              Install a ready-made app from the marketplace — forms, screens, and backend logic
              included — then make it yours.
            </p>
          </div>
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-8 mt-12">
            {showcaseApps.map((app, i) => (
              <Link
                key={app.name}
                to={`/packs/${app.packSlug}`}
                data-reveal
                className="fl-reveal group block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-4 focus-visible:ring-offset-gray-50 dark:focus-visible:ring-offset-slate-950"
                style={{ transitionDelay: `${i * 100}ms` }}
              >
                <figure>
                  <BrowserFrame
                    url={app.url}
                    className="transition-all duration-300 group-hover:border-primary-300 dark:group-hover:border-primary-500/40 group-hover:-translate-y-1 group-hover:shadow-xl group-hover:shadow-primary-500/[0.07]"
                  >
                    <img
                      src={app.src}
                      width={1360}
                      height={900}
                      loading="lazy"
                      alt={app.alt}
                      className="block w-full h-auto"
                    />
                  </BrowserFrame>
                  <figcaption className="fl-mono mt-4 flex items-center justify-center gap-2 text-xs uppercase tracking-wider text-gray-400 dark:text-slate-500">
                    <span className="text-gray-700 dark:text-slate-200">{app.name}</span>
                    <span aria-hidden="true" className="opacity-50">·</span>
                    <span>{app.caption}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-primary-500/80 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" aria-hidden="true" />
                  </figcaption>
                </figure>
              </Link>
            ))}
          </div>
          <div data-reveal className="fl-reveal text-center mt-10">
            <Link
              to="/packs"
              className="group inline-flex items-center gap-2 text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium transition-colors"
            >
              Browse the marketplace
              <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div data-reveal className="fl-reveal text-center mb-16 flex flex-col items-center">
            <SectionTag index="05" label="Pricing" />
            <h2 className="fl-display text-3xl sm:text-5xl text-gray-900 dark:text-white mb-5">
              Simple, transparent pricing
            </h2>
            <p className="text-lg text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              Start free, scale as you grow. No hidden fees, no surprises.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-5 lg:gap-6 items-start">
            {pricingPlans.map((plan, i) => (
              <div
                key={plan.name}
                data-reveal
                className={`fl-reveal rounded-2xl p-8 transition-all duration-300 relative ${plan.highlighted
                  ? 'bg-white dark:bg-slate-900/80 ring-2 ring-primary-500 shadow-2xl shadow-primary-500/10 z-10 md:-translate-y-3'
                  : 'bg-white dark:bg-slate-950/80 border border-gray-200/80 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700 hover:shadow-lg hover:shadow-gray-900/[0.04]'
                  }`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="fl-mono bg-primary-600 text-primary-foreground text-[11px] uppercase tracking-wider font-semibold px-4 py-1.5 rounded-full shadow-lg shadow-primary-600/30 whitespace-nowrap">
                      Most popular
                    </span>
                  </div>
                )}
                <div className="text-center mb-8">
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">{plan.name}</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-500 mt-2">{plan.description}</p>
                </div>
                <div className="text-center mb-8">
                  <span className="fl-display text-5xl text-gray-900 dark:text-white">{plan.price}</span>
                  <span className="fl-mono text-gray-400 dark:text-slate-400 ml-1.5 text-sm">{plan.period}</span>
                </div>
                <ul className="space-y-3.5 mb-10">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <div className="p-0.5 rounded-full bg-primary-50 dark:bg-primary-500/10 mt-0.5">
                        <Check className="h-3.5 w-3.5 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                      </div>
                      <span className="text-gray-600 dark:text-slate-300 text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
                {('ctaExternal' in plan && plan.ctaExternal) ? (
                  <a href={plan.ctaHref} className="block">
                    <Button className={`w-full ${plan.highlighted ? 'bg-primary-600 hover:bg-primary-500 text-primary-foreground shadow-lg shadow-primary-600/20 border-0' : 'bg-gray-100 hover:bg-gray-200 text-gray-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-white border-0'}`} size="lg">
                      {plan.cta}
                    </Button>
                  </a>
                ) : (
                  <Link to={plan.ctaHref ?? '/signup'} className="block">
                    <Button className={`w-full ${plan.highlighted ? 'bg-primary-600 hover:bg-primary-500 text-primary-foreground shadow-lg shadow-primary-600/20 border-0' : 'bg-gray-100 hover:bg-gray-200 text-gray-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-white border-0'}`} size="lg">
                      {plan.cta}
                    </Button>
                  </Link>
                )}
              </div>
            ))}
          </div>

          {/* Feature comparison */}
          <div data-reveal className="fl-reveal mt-16 max-w-3xl mx-auto">
            <h3 className="fl-display text-center text-2xl text-gray-900 dark:text-white mb-7">Compare plans</h3>
            <div className="rounded-2xl border border-gray-200/80 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-950/40">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/80 dark:bg-slate-900/60 border-b border-gray-200/80 dark:border-slate-800">
                    <th className="text-left font-medium text-gray-500 dark:text-slate-400 px-4 sm:px-6 py-3.5">Feature</th>
                    <th className="text-right font-semibold text-gray-900 dark:text-white px-3 sm:px-6 py-3.5">
                      Personal
                      <span className="block fl-mono text-[11px] font-normal text-gray-400 dark:text-slate-500">$5 / 30 days</span>
                    </th>
                    <th className="text-right font-semibold text-gray-900 dark:text-white px-4 sm:px-6 py-3.5">Enterprise</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row, i) => (
                    <tr key={row.feature} className={i > 0 ? 'border-t border-gray-100 dark:border-slate-800/60' : ''}>
                      <td className="px-4 sm:px-6 py-3 text-gray-600 dark:text-slate-300">{row.feature}</td>
                      <td className="px-3 sm:px-6 py-3 text-right text-gray-700 dark:text-slate-200">{renderPlanCell(row.personal)}</td>
                      <td className="px-4 sm:px-6 py-3 text-right text-gray-700 dark:text-slate-200">{renderPlanCell(row.enterprise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
            <p className="fl-mono text-center text-xs text-gray-400 dark:text-slate-500 mt-4">
              Self-hosting is always free. Personal is prepaid via PayPal — no subscription, no auto-renew.
            </p>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 sm:py-28 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-700 via-primary-800 to-slate-900" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary-400/20 blur-[120px] rounded-full pointer-events-none" />

        <div data-reveal className="fl-reveal max-w-4xl mx-auto text-center relative z-10">
          <h2 className="fl-display text-4xl sm:text-6xl text-white mb-6">
            Ready to build your first app?
          </h2>
          <p className="text-lg sm:text-xl text-primary-100/80 mb-10 max-w-2xl mx-auto leading-relaxed">
            Create a free account — your first 30 days of Cloud are on us. No credit card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
            <Link to="/signup">
              <Button size="lg" className="bg-white text-primary-700 hover:bg-primary-50 h-14 px-8 text-lg font-semibold shadow-2xl shadow-black/20 border-0">
                Get started free
                <ArrowRight className="h-5 w-5 ml-2" />
              </Button>
            </Link>
            <Link
              to="/login"
              className="text-white/90 hover:text-white font-medium flex items-center gap-2 py-3 px-4 rounded-lg hover:bg-white/10 transition-colors"
            >
              Sign in to existing account
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-slate-950 border-t border-gray-200/80 dark:border-slate-900">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-12 mb-16">
            <div className="md:col-span-1">
              <Logo size="md" />
              <p className="text-gray-400 dark:text-slate-500 mt-6 text-sm leading-relaxed">
                Build business apps from forms. Self-hosted or cloud, with your data in portable SQLite.
              </p>
            </div>
            <div>
              <h4 className="fl-mono text-gray-900 dark:text-white font-semibold mb-6 text-xs tracking-[0.2em] uppercase">Product</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <a href="#features" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#solutions" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Solutions
                  </a>
                </li>
                <li>
                  <Link to="/packs" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Marketplace
                  </Link>
                </li>
                <li>
                  <a href="#demo" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Live demo
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Pricing
                  </a>
                </li>
                <li>
                  <Link to="/docs" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Docs
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="fl-mono text-gray-900 dark:text-white font-semibold mb-6 text-xs tracking-[0.2em] uppercase">Get started</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <Link to="/signup" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Sign up
                  </Link>
                </li>
                <li>
                  <Link to="/login" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Sign in
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="fl-mono text-gray-900 dark:text-white font-semibold mb-6 text-xs tracking-[0.2em] uppercase">Legal</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <Link to="/privacy" className="hover:text-gray-900 dark:hover:text-white transition-colors">Privacy Policy</Link>
                </li>
                <li>
                  <Link to="/terms" className="hover:text-gray-900 dark:hover:text-white transition-colors">Terms of Service</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-200/80 dark:border-slate-900 pt-10 flex flex-col sm:flex-row items-center justify-between gap-6">
            <p className="fl-mono text-gray-400 dark:text-slate-500 text-xs">&copy; {new Date().getFullYear()} FormLogic. All rights reserved.</p>
            <div className="flex items-center gap-6 fl-mono text-xs">
              <Link to="/docs" className="text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-white transition-colors">Docs</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
