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
import { Logo } from '../components/ui/Logo';

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
    <div className="min-h-screen bg-white dark:bg-slate-950 text-gray-900 dark:text-slate-50 selection:bg-indigo-500/20 dark:selection:bg-indigo-400/20">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 bg-white/90 dark:bg-slate-950/80 backdrop-blur-xl border-b border-gray-100 dark:border-indigo-500/10 z-50 transition-all duration-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Logo size="md" />
            <div className="hidden md:flex items-center gap-8">
              <a href="#features" className="text-sm font-medium text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Features
              </a>
              <a href="#solutions" className="text-sm font-medium text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Solutions
              </a>
              <a href="#pricing" className="text-sm font-medium text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                Pricing
              </a>
            </div>
            <div className="hidden md:flex items-center gap-4">
              <Link to="/login" className="text-sm font-medium text-gray-500 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors">
                Sign In
              </Link>
              <Link to="/signup">
                <Button className="bg-indigo-600 hover:bg-indigo-500 text-white border-0 shadow-md shadow-indigo-600/20">
                  Get Started Free
                </Button>
              </Link>
            </div>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              className="md:hidden p-2 text-gray-400 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-900 rounded-lg transition-colors"
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
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white font-medium"
            >
              Features
            </a>
            <a
              href="#solutions"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white font-medium"
            >
              Solutions
            </a>
            <a
              href="#pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2 text-gray-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white font-medium"
            >
              Pricing
            </a>
            <div className="pt-3 border-t border-gray-100 dark:border-slate-900 flex flex-col gap-2">
              <Link
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="py-2 text-gray-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-white font-medium"
              >
                Sign In
              </Link>
              <Link to="/signup" onClick={() => setMobileMenuOpen(false)}>
                <Button className="w-full bg-indigo-600">Get Started Free</Button>
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 sm:pt-40 pb-20 sm:pb-32 px-4 sm:px-6 lg:px-8 overflow-hidden">
        {/* Background Gradients */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-indigo-600/15 blur-[100px] rounded-full opacity-40 pointer-events-none" />
        <div className="absolute top-20 right-0 w-[500px] h-[500px] bg-purple-600/10 blur-[100px] rounded-full opacity-20 pointer-events-none" />

        <div className="relative max-w-5xl mx-auto text-center z-10">
          <div className="inline-flex items-center gap-2 bg-white/60 dark:bg-slate-900/50 backdrop-blur-sm border border-indigo-200/60 dark:border-indigo-500/20 text-indigo-600 dark:text-indigo-300 px-4 py-1.5 rounded-full text-sm font-medium mb-8">
            <Building2 className="h-4 w-4" />
            <span>Built for enterprise teams</span>
          </div>

          <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight text-gray-900 dark:text-white mb-8 leading-[1.1]">
            The Form Platform for
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 via-purple-500 to-indigo-600 dark:from-indigo-400 dark:via-purple-400 dark:to-indigo-400">
              Serious Applications
            </span>
          </h1>

          <p className="text-lg sm:text-xl text-gray-500 dark:text-slate-400 mb-12 max-w-2xl mx-auto leading-relaxed">
            Move beyond basic form builders. FormLogic combines beautiful UX with real backend logic,
            giving you complete control over your data and submission workflows.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-5 mb-20">
            <Link to="/signup" className="w-full sm:w-auto">
              <Button size="lg" className="w-full sm:w-auto text-base h-12 bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/25 border-0">
                Start Free Trial
                <ArrowRight className="h-5 w-5 ml-2" />
              </Button>
            </Link>
            <Link
              to="/login"
              className="group text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white font-medium flex items-center gap-2 py-2 transition-colors"
            >
              Sign in to your account
              <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 max-w-4xl mx-auto pt-10 border-t border-gray-200 dark:border-slate-800">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center group hover:-translate-y-1 transition-transform duration-300">
                <div className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors tracking-tight">{stat.value}</div>
                <div className="text-sm text-gray-500 dark:text-slate-500 mt-2">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust Banner */}
      <section className="py-10 px-4 sm:px-6 lg:px-8 bg-gray-50/80 dark:bg-slate-900/30 border-y border-gray-100 dark:border-slate-800/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-16 text-gray-400 dark:text-slate-500 text-sm font-medium">
            <div className="flex items-center gap-3 hover:text-gray-700 dark:hover:text-slate-300 transition-colors">
              <Shield className="h-5 w-5" />
              <span>SOC 2 Compliant</span>
            </div>
            <div className="flex items-center gap-3 hover:text-gray-700 dark:hover:text-slate-300 transition-colors">
              <Lock className="h-5 w-5" />
              <span>GDPR Ready</span>
            </div>
            <div className="flex items-center gap-3 hover:text-gray-700 dark:hover:text-slate-300 transition-colors">
              <Clock className="h-5 w-5" />
              <span>99.9% Uptime SLA</span>
            </div>
            <div className="flex items-center gap-3 hover:text-gray-700 dark:hover:text-slate-300 transition-colors">
              <Globe className="h-5 w-5" />
              <span>Global CDN</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8 relative">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-6 tracking-tight">
              Enterprise Features, <span className="text-indigo-600 dark:text-indigo-400">Developer Experience</span>
            </h2>
            <p className="text-lg sm:text-xl text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              Everything you need to build sophisticated form-driven applications.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="group bg-white dark:bg-slate-900/40 backdrop-blur-md rounded-2xl p-8 border border-gray-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-500/30 hover:bg-white dark:hover:bg-slate-800/60 transition-all duration-300 hover:shadow-xl hover:shadow-indigo-500/[0.04]"
              >
                <div className="w-12 h-12 bg-indigo-50 dark:bg-slate-800 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300 border border-indigo-100 dark:border-slate-700 group-hover:border-indigo-300 dark:group-hover:border-indigo-500/30">
                  <feature.icon className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3 tracking-tight">{feature.title}</h3>
                <p className="text-gray-500 dark:text-slate-400 leading-relaxed text-[15px]">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Code Demo Section */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-gray-50/80 dark:bg-slate-900/20 overflow-hidden relative border-y border-gray-100 dark:border-slate-800/50">
        <div className="absolute inset-0 bg-white/50 dark:bg-slate-950/80" />
        <div className="absolute top-1/2 left-0 w-[600px] h-[600px] bg-indigo-600/5 dark:bg-indigo-600/10 blur-[120px] rounded-full -translate-y-1/2 -translate-x-1/2" />

        <div className="max-w-6xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl sm:text-5xl font-bold text-gray-900 dark:text-white mb-8 leading-tight tracking-tight">
                Real Backend Logic,
                <br />
                <span className="text-indigo-600 dark:text-indigo-400">Not Just Webhooks</span>
              </h2>
              <p className="text-lg text-gray-500 dark:text-slate-400 mb-10 leading-relaxed">
                Write server-side scripts that run on every submission. Score leads, validate data,
                route workflows, and store computed fields &mdash; all in a familiar JavaScript-like syntax.
              </p>
              <ul className="space-y-5">
                <li className="flex items-start gap-4">
                  <div className="mt-1 p-1 bg-emerald-500/10 rounded-full">
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  </div>
                  <span className="text-gray-600 dark:text-slate-300 text-lg">Sandboxed execution with 50k instruction limit</span>
                </li>
                <li className="flex items-start gap-4">
                  <div className="mt-1 p-1 bg-emerald-500/10 rounded-full">
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  </div>
                  <span className="text-gray-600 dark:text-slate-300 text-lg">Access to all form data and submission context</span>
                </li>
                <li className="flex items-start gap-4">
                  <div className="mt-1 p-1 bg-emerald-500/10 rounded-full">
                    <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  </div>
                  <span className="text-gray-600 dark:text-slate-300 text-lg">Store computed fields directly to the database</span>
                </li>
              </ul>
            </div>

            {/* Terminal Window */}
            <div className="relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500/50 to-purple-600/50 rounded-2xl opacity-15 group-hover:opacity-30 blur-lg transition duration-500" />
              <div className="relative bg-[#0F1117] rounded-2xl shadow-2xl border border-slate-800/80 overflow-hidden">
                <div className="h-10 bg-slate-900/80 flex items-center gap-2 px-4 border-b border-slate-800/80">
                  <div className="w-3 h-3 rounded-full bg-red-500/70" />
                  <div className="w-3 h-3 rounded-full bg-amber-500/70" />
                  <div className="w-3 h-3 rounded-full bg-green-500/70" />
                  <span className="text-xs text-slate-500 ml-2 font-mono">onSubmit.ts</span>
                </div>
                <div className="p-6 overflow-x-auto">
                  <div className="font-mono text-sm leading-relaxed">
                    <div className="text-slate-500 italic">// Runs on every submission</div>
                    <div className="text-purple-400 mt-3">
                      function <span className="text-blue-400">onSubmit</span>
                      <span className="text-slate-300">(ctx) {'{'}</span>
                    </div>
                    <div className="pl-6 border-l border-slate-800/50 ml-1">
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
      <section className="py-24 px-4 sm:px-6 lg:px-8 bg-indigo-50/60 dark:bg-indigo-950/20 relative overflow-hidden">
        <div className="max-w-6xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div className="order-2 lg:order-1">
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-8 shadow-xl shadow-gray-900/[0.03] dark:shadow-none border border-gray-200/80 dark:border-indigo-500/20 relative group">
                <div className="absolute -inset-px bg-gradient-to-br from-indigo-500/30 to-transparent rounded-2xl opacity-0 group-hover:opacity-100 transition duration-500 pointer-events-none" />
                <div className="flex items-center gap-4 mb-6 relative">
                  <div className="p-3 bg-indigo-100 dark:bg-indigo-500/10 rounded-xl">
                    <Download className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <span className="font-mono text-sm text-gray-500 dark:text-slate-400">contact-form.sqlite</span>
                </div>
                <div className="font-mono text-sm bg-gray-950 dark:bg-slate-950 rounded-xl p-6 text-slate-300 space-y-4 shadow-inner border border-gray-800 dark:border-slate-800 relative">
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-indigo-400">responses</span>
                    <span className="text-slate-600">(id, answers, submitted_at, status)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-indigo-400">computed</span>
                    <span className="text-slate-600">(response_id, field_name, value)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-indigo-400">tags</span>
                    <span className="text-slate-600">(response_id, tag, created_at)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Database className="h-4 w-4 text-slate-600" />
                    <span className="text-indigo-400">script_logs</span>
                    <span className="text-slate-600">(response_id, success, duration_ms)</span>
                  </div>
                </div>
                <p className="text-sm text-gray-400 dark:text-slate-500 mt-6 text-center relative">Real tables. Real relationships. Real queries.</p>
              </div>
            </div>

            <div className="order-1 lg:order-2">
              <h2 className="text-3xl sm:text-5xl font-bold text-gray-900 dark:text-white mb-8 tracking-tight">
                Your Data.
                <br />
                <span className="text-indigo-600 dark:text-indigo-400">Actually Yours.</span>
              </h2>
              <p className="text-gray-500 dark:text-slate-400 text-lg mb-10 leading-relaxed">
                Each form gets its own SQLite database. Responses, computed fields, tags, audit logs &mdash;
                all in a portable, queryable format you can download anytime.
              </p>
              <ul className="space-y-5">
                <li className="flex items-center gap-4 text-gray-600 dark:text-slate-300">
                  <div className="p-1 bg-indigo-100 dark:bg-indigo-500/10 rounded-full">
                    <Check className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  </div>
                  Download the entire database anytime
                </li>
                <li className="flex items-center gap-4 text-gray-600 dark:text-slate-300">
                  <div className="p-1 bg-indigo-100 dark:bg-indigo-500/10 rounded-full">
                    <Check className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  </div>
                  Query with any SQLite-compatible tool
                </li>
                <li className="flex items-center gap-4 text-gray-600 dark:text-slate-300">
                  <div className="p-1 bg-indigo-100 dark:bg-indigo-500/10 rounded-full">
                    <Check className="h-4 w-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  </div>
                  No vendor lock-in, ever
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Solutions Section */}
      <section id="solutions" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8 bg-gray-50/80 dark:bg-slate-900/30">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-6 tracking-tight">Built For Your Use Case</h2>
            <p className="text-lg sm:text-xl text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              From lead generation to complex application processing, FormLogic handles it all.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-6">
            {useCases.map((useCase) => (
              <div
                key={useCase.title}
                className="bg-white dark:bg-slate-950/80 rounded-2xl p-10 border border-gray-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-500/30 hover:shadow-xl hover:shadow-gray-900/[0.04] transition-all duration-300 group"
              >
                <div className="w-12 h-12 bg-indigo-50 dark:bg-slate-900 rounded-xl flex items-center justify-center mb-6 border border-indigo-100/80 dark:border-slate-800 group-hover:border-indigo-300 dark:group-hover:border-indigo-500/30 group-hover:bg-indigo-50 dark:group-hover:bg-indigo-500/5 transition-all duration-300">
                  <useCase.icon className="h-6 w-6 text-indigo-600 dark:text-slate-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3 tracking-tight">{useCase.title}</h3>
                <p className="text-gray-500 dark:text-slate-400 leading-relaxed group-hover:text-gray-600 dark:group-hover:text-slate-300 transition-colors">{useCase.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-24 sm:py-32 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-6 tracking-tight">
              Simple, Transparent Pricing
            </h2>
            <p className="text-lg sm:text-xl text-gray-500 dark:text-slate-400 max-w-2xl mx-auto">
              Start free, scale as you grow. No hidden fees, no surprises.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {pricingPlans.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-2xl p-8 transition-all duration-300 ${plan.highlighted
                  ? 'bg-white dark:bg-slate-900/80 ring-2 ring-indigo-500 shadow-2xl shadow-indigo-500/10 scale-[1.03] z-10'
                  : 'bg-white dark:bg-slate-950/80 border border-gray-200/80 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'
                  }`}
              >
                {plan.highlighted && (
                  <div className="flex justify-center -mt-12 mb-6">
                    <span className="bg-indigo-600 text-white text-sm font-semibold px-4 py-1.5 rounded-full shadow-lg shadow-indigo-600/30">
                      Most Popular
                    </span>
                  </div>
                )}
                <div className="text-center mb-8">
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-white tracking-tight">{plan.name}</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-500 mt-2">{plan.description}</p>
                </div>
                <div className="text-center mb-8">
                  <span className="text-5xl font-bold text-gray-900 dark:text-white tracking-tight">{plan.price}</span>
                  <span className="text-gray-400 dark:text-slate-400 ml-2">{plan.period}</span>
                </div>
                <ul className="space-y-4 mb-10">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-indigo-600 dark:text-indigo-500 flex-shrink-0 mt-0.5" />
                      <span className="text-gray-600 dark:text-slate-300 text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/signup" className="block">
                  <Button className={`w-full ${plan.highlighted ? 'bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/20 border-0' : 'bg-gray-100 hover:bg-gray-200 text-gray-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-white border-0'}`} size="lg">
                    {plan.cta}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-600 via-indigo-700 to-purple-800" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:40px_40px]" />

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6 tracking-tight">
            Ready to build smarter forms?
          </h2>
          <p className="text-xl text-indigo-100/80 mb-10 max-w-2xl mx-auto">
            Start your free trial today. No credit card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
            <Link to="/signup">
              <Button size="lg" className="bg-white text-indigo-600 hover:bg-indigo-50 h-14 px-8 text-lg font-semibold shadow-2xl shadow-black/20">
                Get Started Free
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
                The form platform for serious applications. Built for developers and enterprises.
              </p>
            </div>
            <div>
              <h4 className="text-gray-900 dark:text-white font-semibold mb-6 text-sm tracking-wide uppercase">Product</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <a href="#features" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Pricing
                  </a>
                </li>
                <li>
                  <a href="#solutions" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Solutions
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-gray-900 dark:text-white font-semibold mb-6 text-sm tracking-wide uppercase">Get Started</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <Link to="/signup" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Sign Up
                  </Link>
                </li>
                <li>
                  <Link to="/login" className="hover:text-gray-900 dark:hover:text-white transition-colors">
                    Sign In
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-gray-900 dark:text-white font-semibold mb-6 text-sm tracking-wide uppercase">Legal</h4>
              <ul className="space-y-4 text-gray-500 dark:text-slate-500 text-sm">
                <li>
                  <span className="cursor-default">Privacy Policy</span>
                </li>
                <li>
                  <span className="cursor-default">Terms of Service</span>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-200/80 dark:border-slate-900 pt-10 flex flex-col sm:flex-row items-center justify-between gap-6">
            <p className="text-gray-400 dark:text-slate-500 text-sm">&copy; {new Date().getFullYear()} FormLogic. All rights reserved.</p>
            <div className="flex items-center gap-6">
              <a
                href="https://twitter.com/formlogic"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-gray-600 dark:hover:text-white transition-colors"
                aria-label="Twitter"
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
