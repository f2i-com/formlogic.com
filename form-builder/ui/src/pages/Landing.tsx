import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Database,
  Code2,
  Shield,
  Download,
  ArrowRight,
  Check,
  Menu,
  X,
  Zap,
  Globe,
  BarChart3,
  Building2,
  Users,
  Clock,
  Lock,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Logo, LogoWhite } from '../components/ui/Logo';

export function Landing() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const stats = [
    { value: '10K+', label: 'Forms Created' },
    { value: '1M+', label: 'Submissions Processed' },
    { value: '99.9%', label: 'Uptime' },
    { value: '<50ms', label: 'Avg Response Time' },
  ];

  const features = [
    {
      icon: Database,
      title: 'Enterprise-Grade Data',
      description: 'Each form gets a dedicated SQLite database. Export anytime, query with any tool. Your data, your format.',
    },
    {
      icon: Code2,
      title: 'Programmable Logic',
      description: 'Execute server-side scripts on every submission. Score leads, validate data, route workflows automatically.',
    },
    {
      icon: Shield,
      title: 'Secure by Design',
      description: 'Sandboxed execution with strict limits. No client-side tampering. Your logic runs safely on our servers.',
    },
    {
      icon: Zap,
      title: 'Lightning Fast',
      description: 'Optimized infrastructure ensures sub-100ms response times globally. Built for scale from day one.',
    },
    {
      icon: Globe,
      title: 'Self-Host Ready',
      description: 'Deploy on your own infrastructure with full source access. No vendor lock-in, complete control.',
    },
    {
      icon: BarChart3,
      title: 'Built-in Analytics',
      description: 'Track submissions, conversion rates, and response patterns. Insights out of the box, no setup required.',
    },
  ];

  const useCases = [
    {
      title: 'Lead Qualification',
      description: 'Automatically score and route leads based on responses, company size, and budget.',
      icon: Users,
    },
    {
      title: 'Application Processing',
      description: 'Build multi-step applications with server-validated eligibility and instant decisions.',
      icon: Building2,
    },
    {
      title: 'Survey Intelligence',
      description: 'Enrich responses with computed scores, classifications, and real-time analysis.',
      icon: BarChart3,
    },
    {
      title: 'Workflow Automation',
      description: 'Trigger actions, update databases, and integrate with your stack on every submission.',
      icon: Zap,
    },
  ];

  const pricingPlans = [
    {
      name: 'Self-Hosted',
      price: '$0',
      period: 'forever',
      description: 'Full control on your infrastructure',
      features: [
        'Complete source access',
        'Unlimited forms & responses',
        'SQLite per-form databases',
        'Backend scripting engine',
        'Community support',
      ],
      cta: 'Get Started',
      highlighted: false,
    },
    {
      name: 'Pro Cloud',
      price: '$19',
      period: '/month',
      description: 'Managed hosting, zero maintenance',
      features: [
        'Everything in Self-Hosted',
        'Managed infrastructure',
        'Automatic backups',
        'API access',
        'Priority email support',
      ],
      cta: 'Start Free Trial',
      highlighted: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      description: 'For teams with advanced needs',
      features: [
        'Everything in Pro Cloud',
        'Custom deployment options',
        'SLA guarantee',
        'Dedicated support',
        'Security review & compliance',
      ],
      cta: 'Contact Sales',
      highlighted: false,
    },
  ];

  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Logo size="md" />
            <div className="hidden md:flex items-center gap-8">
              <a href="#features" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Features
              </a>
              <a href="#solutions" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Solutions
              </a>
              <a href="#pricing" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Pricing
              </a>
              <a
                href="https://github.com/formlogic"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                Docs
              </a>
            </div>
            <div className="hidden sm:flex items-center gap-4">
              <Link to="/login" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Sign In
              </Link>
              <Link to="/signup">
                <Button>Get Started Free</Button>
              </Link>
            </div>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white border-t border-gray-100 py-4 px-4 space-y-3">
            <a
              href="#features"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 hover:text-gray-900 font-medium"
            >
              Features
            </a>
            <a
              href="#solutions"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 hover:text-gray-900 font-medium"
            >
              Solutions
            </a>
            <a
              href="#pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 hover:text-gray-900 font-medium"
            >
              Pricing
            </a>
            <div className="pt-3 border-t border-gray-100 flex flex-col gap-2">
              <Link
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="py-2 text-gray-600 hover:text-gray-900 font-medium"
              >
                Sign In
              </Link>
              <Link to="/signup" onClick={() => setMobileMenuOpen(false)}>
                <Button className="w-full">Get Started Free</Button>
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* Hero Section */}
      <section className="pt-28 sm:pt-36 pb-16 sm:pb-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-gray-50 to-white">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-full text-sm font-medium mb-6">
            <Building2 className="h-4 w-4" />
            Built for enterprise teams
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 mb-6 leading-tight">
            The Form Platform for
            <br />
            <span className="text-indigo-600">Serious Applications</span>
          </h1>
          <p className="text-lg sm:text-xl text-gray-600 mb-8 max-w-3xl mx-auto leading-relaxed">
            Move beyond basic form builders. FormLogic combines beautiful UX with real backend logic,
            giving you complete control over your data and submission workflows.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link to="/signup">
              <Button size="lg" className="w-full sm:w-auto">
                Start Free Trial
                <ArrowRight className="h-5 w-5 ml-2" />
              </Button>
            </Link>
            <Link
              to="/login"
              className="text-gray-600 hover:text-gray-900 font-medium flex items-center gap-2 py-2"
            >
              Sign in to your account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 max-w-4xl mx-auto pt-8 border-t border-gray-200">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl sm:text-4xl font-bold text-gray-900">{stat.value}</div>
                <div className="text-sm text-gray-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust Banner */}
      <section className="py-8 px-4 sm:px-6 lg:px-8 bg-gray-900">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-12 text-gray-400 text-sm">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              <span>SOC 2 Compliant</span>
            </div>
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              <span>GDPR Ready</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              <span>99.9% Uptime SLA</span>
            </div>
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              <span>Global CDN</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 sm:py-28 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Enterprise Features, Developer Experience
            </h2>
            <p className="text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto">
              Everything you need to build sophisticated form-driven applications.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="bg-white rounded-xl p-8 border border-gray-200 hover:border-indigo-200 hover:shadow-lg transition-all duration-200"
              >
                <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center mb-5">
                  <feature.icon className="h-6 w-6 text-indigo-600" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">{feature.title}</h3>
                <p className="text-gray-600 leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Code Demo Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-6">
                Real Backend Logic,
                <br />
                Not Just Webhooks
              </h2>
              <p className="text-lg text-gray-600 mb-8 leading-relaxed">
                Write server-side scripts that run on every submission. Score leads, validate data,
                route workflows, and store computed fields &mdash; all in a familiar JavaScript-like syntax.
              </p>
              <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <Check className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span className="text-gray-700">Sandboxed execution with 50k instruction limit</span>
                </li>
                <li className="flex items-start gap-3">
                  <Check className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span className="text-gray-700">Access to all form data and submission context</span>
                </li>
                <li className="flex items-start gap-3">
                  <Check className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                  <span className="text-gray-700">Store computed fields directly to the database</span>
                </li>
              </ul>
            </div>
            <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
              <div className="h-8 bg-gray-100 flex items-center gap-2 px-4 border-b border-gray-200">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-yellow-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
                <span className="text-xs text-gray-500 ml-2 font-mono">onSubmit.fl</span>
              </div>
              <div className="p-6 bg-gradient-to-br from-gray-900 to-gray-800 overflow-x-auto">
                <div className="font-mono text-sm leading-relaxed">
                  <div className="text-gray-500">// Runs on every submission</div>
                  <div className="text-purple-400 mt-3">
                    function <span className="text-blue-400">onSubmit</span>
                    <span className="text-white">(ctx) {'{'}</span>
                  </div>
                  <div className="pl-4">
                    <div className="text-purple-400">
                      let <span className="text-white">score</span> <span className="text-gray-400">=</span>{' '}
                      <span className="text-yellow-400">0</span>
                      <span className="text-white">;</span>
                    </div>
                    <div className="text-purple-400 mt-2">
                      if <span className="text-white">(ctx.answers.budget</span>{' '}
                      <span className="text-gray-400">&gt;=</span> <span className="text-yellow-400">10000</span>
                      <span className="text-white">)</span>
                    </div>
                    <div className="pl-4 text-white">
                      score <span className="text-gray-400">+=</span> <span className="text-yellow-400">40</span>;
                    </div>
                    <div className="mt-3 text-white">
                      ctx.db.<span className="text-blue-400">setField</span>
                      <span className="text-white">(</span>
                      <span className="text-green-400">"lead_score"</span>
                      <span className="text-white">, score);</span>
                    </div>
                    <div className="text-white">
                      ctx.db.<span className="text-blue-400">setStatus</span>
                      <span className="text-white">(</span>
                      <span className="text-green-400">"qualified"</span>
                      <span className="text-white">);</span>
                    </div>
                  </div>
                  <div className="text-white">{'}'}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SQLite Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-indigo-600">
        <div className="max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6">
                Your Data. Actually Yours.
              </h2>
              <p className="text-indigo-100 text-lg mb-8 leading-relaxed">
                Each form gets its own SQLite database. Responses, computed fields, tags, audit logs &mdash;
                all in a portable, queryable format you can download anytime.
              </p>
              <ul className="space-y-4">
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200 flex-shrink-0" />
                  Download the entire database anytime
                </li>
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200 flex-shrink-0" />
                  Query with any SQLite-compatible tool
                </li>
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200 flex-shrink-0" />
                  No vendor lock-in, ever
                </li>
              </ul>
            </div>
            <div className="bg-white rounded-xl p-6 shadow-xl">
              <div className="flex items-center gap-3 mb-4">
                <Download className="h-5 w-5 text-indigo-600" />
                <span className="font-mono text-sm text-gray-600">contact-form.sqlite</span>
              </div>
              <div className="font-mono text-sm bg-gray-50 rounded-lg p-4 text-gray-700 space-y-2">
                <div>
                  <span className="text-indigo-600">responses</span> (id, answers, submitted_at, status)
                </div>
                <div>
                  <span className="text-indigo-600">computed</span> (response_id, field_name, value)
                </div>
                <div>
                  <span className="text-indigo-600">tags</span> (response_id, tag, created_at)
                </div>
                <div>
                  <span className="text-indigo-600">script_logs</span> (response_id, success, duration_ms)
                </div>
              </div>
              <p className="text-sm text-gray-500 mt-4">Real tables. Real relationships. Real queries.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Solutions Section */}
      <section id="solutions" className="py-20 sm:py-28 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">Built For Your Use Case</h2>
            <p className="text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto">
              From lead generation to complex application processing, FormLogic handles it all.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-8">
            {useCases.map((useCase) => (
              <div
                key={useCase.title}
                className="bg-white rounded-xl p-8 border border-gray-200 hover:border-indigo-200 hover:shadow-lg transition-all duration-200"
              >
                <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mb-5">
                  <useCase.icon className="h-6 w-6 text-gray-700" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">{useCase.title}</h3>
                <p className="text-gray-600 leading-relaxed">{useCase.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20 sm:py-28 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-lg sm:text-xl text-gray-600 max-w-2xl mx-auto">
              Start free, scale as you grow. No hidden fees, no surprises.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {pricingPlans.map((plan) => (
              <div
                key={plan.name}
                className={`bg-white rounded-2xl p-8 ${
                  plan.highlighted
                    ? 'ring-2 ring-indigo-600 shadow-xl relative'
                    : 'border border-gray-200 shadow-lg'
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <span className="bg-indigo-600 text-white text-sm font-medium px-4 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                <div className="text-center mb-6">
                  <h3 className="text-xl font-semibold text-gray-900">{plan.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
                </div>
                <div className="text-center mb-6">
                  <span className="text-4xl font-bold text-gray-900">{plan.price}</span>
                  <span className="text-gray-600">{plan.period}</span>
                </div>
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                      <span className="text-gray-600">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/signup" className="block">
                  <Button className="w-full" variant={plan.highlighted ? 'primary' : 'outline'}>
                    {plan.cta}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-indigo-600">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Ready to build smarter forms?
          </h2>
          <p className="text-xl text-indigo-100 mb-8">
            Start your free trial today. No credit card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/signup">
              <Button size="lg" className="bg-white text-indigo-600 hover:bg-gray-100">
                Get Started Free
                <ArrowRight className="h-5 w-5 ml-2" />
              </Button>
            </Link>
            <Link
              to="/login"
              className="text-indigo-100 hover:text-white font-medium flex items-center gap-2 py-2"
            >
              Sign in to existing account
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-16 px-4 sm:px-6 lg:px-8 bg-gray-900">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8 mb-12">
            <div className="md:col-span-1">
              <LogoWhite size="md" />
              <p className="text-gray-400 mt-4 text-sm leading-relaxed">
                The form platform for serious applications. Built for developers and enterprises.
              </p>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Product</h4>
              <ul className="space-y-3 text-gray-400 text-sm">
                <li>
                  <a href="#features" className="hover:text-white transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="hover:text-white transition-colors">
                    Pricing
                  </a>
                </li>
                <li>
                  <a href="#solutions" className="hover:text-white transition-colors">
                    Solutions
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Documentation
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Company</h4>
              <ul className="space-y-3 text-gray-400 text-sm">
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    About
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Blog
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Careers
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Contact
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Legal</h4>
              <ul className="space-y-3 text-gray-400 text-sm">
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Privacy Policy
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Terms of Service
                  </a>
                </li>
                <li>
                  <a href="#" className="hover:text-white transition-colors">
                    Security
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-gray-500 text-sm">&copy; 2025 FormLogic. All rights reserved.</p>
            <div className="flex items-center gap-6">
              <a
                href="https://github.com/formlogic"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
              <a
                href="https://twitter.com/formlogic"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
