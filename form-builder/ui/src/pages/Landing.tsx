import { useState } from 'react';
import { Database, Code2, Shield, Download, ArrowRight, Check, Server, Workflow, Lock } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { AuthModal } from '../components/auth/AuthModal';

export function Landing() {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');

  const openAuth = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setShowAuthModal(true);
  };

  const differentiators = [
    {
      icon: Database,
      title: 'SQLite as First-Class Output',
      description: 'Download your entire dataset as a real database. No CSV exports, no data lock-in. Your data, your format.',
      highlight: 'Data ownership',
    },
    {
      icon: Code2,
      title: 'Backend Logic That\'s Actually Logic',
      description: 'Scoring, enrichment, classification, tagging, multi-table writes. Run real application logic on every submission.',
      highlight: 'Server-side power',
    },
    {
      icon: Shield,
      title: 'Scriptable, But Sandboxed',
      description: 'Write logic in a familiar JS-like syntax. Executed server-side with strict limits. No client-side tampering.',
      highlight: 'Safe & controlled',
    },
  ];

  const useCases = [
    { title: 'Lead Scoring', description: 'Automatically score and qualify leads based on responses' },
    { title: 'Application Review', description: 'Route applications based on computed eligibility' },
    { title: 'Survey Analysis', description: 'Enrich and classify responses in real-time' },
    { title: 'Onboarding Flows', description: 'Build multi-step wizards with server-validated logic' },
  ];

  const pricingPlans = [
    {
      name: 'Self-Hosted',
      price: '$0',
      period: 'forever',
      features: [
        'Full source access',
        'Unlimited forms & responses',
        'SQLite per-form databases',
        'Backend scripting engine',
        'Your infrastructure',
      ],
      cta: 'Get Started',
      highlighted: false,
    },
    {
      name: 'Pro Cloud',
      price: '$19',
      period: '/month',
      features: [
        'Managed hosting',
        'Unlimited forms & responses',
        'Automatic backups',
        'API access',
        'Priority support',
      ],
      cta: 'Start Free Trial',
      highlighted: true,
    },
    {
      name: 'Agency License',
      price: '$299',
      period: 'one-time',
      features: [
        'Everything self-hosted',
        'Use in client projects',
        'White-label option',
        'Extended support',
        'Future updates included',
      ],
      cta: 'Buy License',
      highlighted: false,
    },
  ];

  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 bg-white/80 backdrop-blur-md border-b border-gray-100 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">FL</span>
              </div>
              <span className="font-semibold text-gray-900 text-lg">FormLogic</span>
            </div>
            <div className="hidden md:flex items-center gap-8">
              <a href="#features" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">Features</a>
              <a href="#use-cases" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">Use Cases</a>
              <a href="#pricing" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">Pricing</a>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => openAuth('login')}
                className="text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                Sign In
              </button>
              <Button onClick={() => openAuth('register')}>
                Get Started
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-full text-sm font-medium mb-6">
            <Server className="h-4 w-4" />
            Not just another form builder
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold text-gray-900 mb-6 leading-tight">
            A Form Engine for{' '}
            <span className="text-indigo-600">Real Applications</span>
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            Beautiful forms. Real backend logic. Full data ownership.
            <br />
            <span className="text-gray-900 font-medium">Built for developers who ship.</span>
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" onClick={() => openAuth('register')}>
              Start Building
              <ArrowRight className="h-5 w-5 ml-2" />
            </Button>
            <a
              href="https://github.com/f2i-com/formlogic"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 font-medium"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Problem/Solution Banner */}
      <section className="py-8 px-4 sm:px-6 lg:px-8 bg-gray-900">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6 text-center">
            <div className="p-4">
              <p className="text-gray-400 text-sm mb-1">Typeform, Jotform, Tally</p>
              <p className="text-white font-medium">Beautiful UX, weak backend</p>
            </div>
            <div className="p-4">
              <p className="text-gray-400 text-sm mb-1">Custom React forms</p>
              <p className="text-white font-medium">Full control, slow to build</p>
            </div>
            <div className="p-4 bg-indigo-600 rounded-lg">
              <p className="text-indigo-200 text-sm mb-1">FormLogic</p>
              <p className="text-white font-medium">Both. No compromise.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Demo Preview */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
            <div className="h-8 bg-gray-100 flex items-center gap-2 px-4 border-b border-gray-200">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
              <span className="text-xs text-gray-500 ml-2 font-mono">onSubmit.fl</span>
            </div>
            <div className="p-8 bg-gradient-to-br from-gray-900 to-gray-800">
              <div className="font-mono text-sm leading-relaxed">
                <div className="text-gray-500">// Backend script runs on every submission</div>
                <div className="text-purple-400 mt-3">function <span className="text-blue-400">onSubmit</span><span className="text-white">(ctx) {'{'}</span></div>
                <div className="pl-4">
                  <div className="text-gray-500">// Calculate lead score</div>
                  <div className="text-purple-400">let <span className="text-white">score</span> <span className="text-gray-400">=</span> <span className="text-yellow-400">0</span><span className="text-white">;</span></div>
                  <div className="text-purple-400 mt-2">if <span className="text-white">(ctx.answers.company_size</span> <span className="text-gray-400">&gt;</span> <span className="text-yellow-400">50</span><span className="text-white">)</span> <span className="text-white">score</span> <span className="text-gray-400">+=</span> <span className="text-yellow-400">30</span><span className="text-white">;</span></div>
                  <div className="text-purple-400">if <span className="text-white">(ctx.answers.budget</span> <span className="text-gray-400">&gt;=</span> <span className="text-yellow-400">10000</span><span className="text-white">)</span> <span className="text-white">score</span> <span className="text-gray-400">+=</span> <span className="text-yellow-400">40</span><span className="text-white">;</span></div>
                  <div className="mt-3 text-gray-500">// Store computed field & tag</div>
                  <div className="text-white">ctx.db.<span className="text-blue-400">setField</span><span className="text-white">(</span><span className="text-green-400">"lead_score"</span><span className="text-white">, score);</span></div>
                  <div className="text-white">ctx.db.<span className="text-blue-400">setStatus</span><span className="text-white">(score</span> <span className="text-gray-400">&gt;=</span> <span className="text-yellow-400">50</span> <span className="text-gray-400">?</span> <span className="text-green-400">"qualified"</span> <span className="text-gray-400">:</span> <span className="text-green-400">"nurture"</span><span className="text-white">);</span></div>
                  <div className="mt-3 text-gray-500">// Reject spam</div>
                  <div className="text-purple-400">if <span className="text-white">(ctx.answers.email.</span><span className="text-blue-400">includes</span><span className="text-white">(</span><span className="text-green-400">"test@"</span><span className="text-white">))</span></div>
                  <div className="pl-4 text-purple-400">return <span className="text-white">{'{'}</span> <span className="text-white">reject:</span> <span className="text-yellow-400">true</span><span className="text-white">,</span> <span className="text-white">message:</span> <span className="text-green-400">"Invalid email"</span> <span className="text-white">{'}'};</span></div>
                </div>
                <div className="text-white">{'}'}</div>
              </div>
            </div>
            <div className="p-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-green-600">
                  <Check className="h-4 w-4" />
                  <span className="text-sm font-medium">Sandboxed execution</span>
                </div>
                <div className="flex items-center gap-2 text-gray-500">
                  <Lock className="h-4 w-4" />
                  <span className="text-sm">50k instruction limit</span>
                </div>
              </div>
              <span className="text-sm text-gray-500">Server-side only</span>
            </div>
          </div>
        </div>
      </section>

      {/* Key Differentiators */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              What Makes This Different
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Three things that actually matter. No fluff.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {differentiators.map((item) => (
              <div key={item.title} className="bg-white rounded-xl p-8 border border-gray-200 hover:border-indigo-200 hover:shadow-lg transition-all">
                <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center mb-5">
                  <item.icon className="h-6 w-6 text-indigo-600" />
                </div>
                <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wide">{item.highlight}</span>
                <h3 className="text-xl font-semibold text-gray-900 mt-2 mb-3">{item.title}</h3>
                <p className="text-gray-600 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SQLite Feature Highlight */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 bg-indigo-600">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold text-white mb-4">
                Your Data. Actually Yours.
              </h2>
              <p className="text-indigo-100 text-lg mb-6">
                Each form gets its own SQLite database. Responses, computed fields, tags, audit logs &mdash; all in a portable, queryable format.
              </p>
              <ul className="space-y-3">
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200" />
                  Download the entire database anytime
                </li>
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200" />
                  Query with any SQLite tool
                </li>
                <li className="flex items-center gap-3 text-white">
                  <Check className="h-5 w-5 text-indigo-200" />
                  No vendor lock-in. Ever.
                </li>
              </ul>
            </div>
            <div className="bg-white rounded-xl p-6 shadow-xl">
              <div className="flex items-center gap-3 mb-4">
                <Download className="h-5 w-5 text-indigo-600" />
                <span className="font-mono text-sm text-gray-600">contact-form.sqlite</span>
              </div>
              <div className="font-mono text-xs bg-gray-50 rounded-lg p-4 text-gray-700 space-y-1">
                <div><span className="text-indigo-600">responses</span> (id, answers, submitted_at, status)</div>
                <div><span className="text-indigo-600">computed</span> (response_id, field_name, value)</div>
                <div><span className="text-indigo-600">tags</span> (response_id, tag, created_at)</div>
                <div><span className="text-indigo-600">script_logs</span> (response_id, success, ms)</div>
              </div>
              <p className="text-sm text-gray-500 mt-4">Real tables. Real relationships. Real queries.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section id="use-cases" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Built For
            </h2>
            <p className="text-xl text-gray-600">
              Developers, agencies, and technical founders who need more than drag-and-drop.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {useCases.map((useCase) => (
              <div key={useCase.title} className="bg-white rounded-lg p-6 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-2">{useCase.title}</h3>
                <p className="text-sm text-gray-600">{useCase.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 text-center">
            <div className="inline-flex items-center gap-6 text-sm text-gray-500">
              <span className="flex items-center gap-2">
                <Workflow className="h-4 w-4" />
                Indie SaaS builders
              </span>
              <span className="flex items-center gap-2">
                <Code2 className="h-4 w-4" />
                Agencies
              </span>
              <span className="flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Privacy-conscious teams
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Pricing That Makes Sense
            </h2>
            <p className="text-xl text-gray-600">
              Self-host for free. Or let us handle the infrastructure.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {pricingPlans.map((plan) => (
              <div
                key={plan.name}
                className={`bg-white rounded-2xl p-8 ${
                  plan.highlighted
                    ? 'ring-2 ring-indigo-600 shadow-xl'
                    : 'border border-gray-200 shadow-lg'
                }`}
              >
                {plan.highlighted && (
                  <div className="text-center mb-4">
                    <span className="bg-indigo-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                      Recommended
                    </span>
                  </div>
                )}
                <h3 className="text-xl font-semibold text-gray-900 text-center">{plan.name}</h3>
                <div className="text-center mt-4 mb-6">
                  <span className="text-4xl font-bold text-gray-900">{plan.price}</span>
                  <span className="text-gray-600">{plan.period}</span>
                </div>
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="h-5 w-5 text-green-500 flex-shrink-0" />
                      <span className="text-gray-600">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-full"
                  variant={plan.highlighted ? 'primary' : 'outline'}
                  onClick={() => openAuth('register')}
                >
                  {plan.cta}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-900">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Forms That Do More
          </h2>
          <p className="text-xl text-gray-400 mb-8">
            Stop fighting your form builder. Start building real applications.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button
              size="lg"
              className="bg-indigo-600 hover:bg-indigo-700"
              onClick={() => openAuth('register')}
            >
              Get Started
              <ArrowRight className="h-5 w-5 ml-2" />
            </Button>
            <a
              href="https://github.com/f2i-com/formlogic"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-gray-400 hover:text-white font-medium transition-colors"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-4 sm:px-6 lg:px-8 bg-gray-950">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">FL</span>
              </div>
              <span className="font-semibold text-white text-lg">FormLogic</span>
            </div>
            <p className="text-gray-500 text-sm">
              A form engine for real applications.
            </p>
          </div>
        </div>
      </footer>

      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        initialMode={authMode}
      />
    </div>
  );
}
