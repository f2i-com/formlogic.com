import { useState } from 'react';
import { FileText, Zap, Shield, BarChart3, ArrowRight, Check } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { AuthModal } from '../components/auth/AuthModal';

export function Landing() {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');

  const openAuth = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setShowAuthModal(true);
  };

  const features = [
    {
      icon: FileText,
      title: 'Drag & Drop Builder',
      description: 'Create beautiful forms with our intuitive drag-and-drop interface. No coding required.',
    },
    {
      icon: Zap,
      title: 'Conditional Logic',
      description: 'Show or hide fields based on user responses with powerful FormLogic expressions.',
    },
    {
      icon: Shield,
      title: 'Validation Rules',
      description: 'Built-in validation with custom rules to ensure data quality.',
    },
    {
      icon: BarChart3,
      title: 'Analytics Dashboard',
      description: 'Track responses, completion rates, and gain insights from your form data.',
    },
  ];

  const pricingPlans = [
    {
      name: 'Free',
      price: '$0',
      period: 'forever',
      features: ['Up to 3 forms', '100 responses/month', 'Basic analytics', 'Local storage'],
      cta: 'Get Started',
      highlighted: false,
    },
    {
      name: 'Pro',
      price: '$12',
      period: '/month',
      features: ['Unlimited forms', 'Unlimited responses', 'Advanced analytics', 'Cloud sync', 'Priority support'],
      cta: 'Start Free Trial',
      highlighted: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      features: ['Everything in Pro', 'Custom integrations', 'SSO/SAML', 'Dedicated support', 'SLA guarantee'],
      cta: 'Contact Sales',
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
          <h1 className="text-5xl sm:text-6xl font-bold text-gray-900 mb-6 leading-tight">
            Build Smart Forms with{' '}
            <span className="text-indigo-600">Powerful Logic</span>
          </h1>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            Create dynamic forms with conditional logic, custom validation, and real-time analytics.
            The modern form builder for teams who need more than basic forms.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Button size="lg" onClick={() => openAuth('register')}>
              Start Building for Free
              <ArrowRight className="h-5 w-5 ml-2" />
            </Button>
            <Button variant="outline" size="lg" onClick={() => openAuth('login')}>
              View Demo
            </Button>
          </div>
          <p className="text-sm text-gray-500 mt-4">
            No credit card required. Start building in seconds.
          </p>
        </div>
      </section>

      {/* Demo Preview */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
            <div className="h-8 bg-gray-100 flex items-center gap-2 px-4 border-b border-gray-200">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <div className="w-3 h-3 rounded-full bg-yellow-400" />
              <div className="w-3 h-3 rounded-full bg-green-400" />
            </div>
            <div className="p-8 bg-gradient-to-br from-indigo-50 to-white">
              <div className="grid md:grid-cols-2 gap-8">
                {/* Form Builder Preview */}
                <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Form</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                      <div className="h-10 bg-gray-100 rounded-lg" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
                      <div className="h-10 bg-gray-100 rounded-lg" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
                      <div className="h-24 bg-gray-100 rounded-lg" />
                    </div>
                    <div className="h-10 bg-indigo-600 rounded-lg" />
                  </div>
                </div>
                {/* Logic Editor Preview */}
                <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Conditional Logic</h3>
                  <div className="bg-gray-900 rounded-lg p-4 font-mono text-sm">
                    <div className="text-green-400">// Show discount field when total {'>'} 100</div>
                    <div className="text-white mt-2">
                      <span className="text-purple-400">if</span> (orderTotal {'>'} <span className="text-yellow-400">100</span>) {'{'}
                    </div>
                    <div className="text-white pl-4">
                      <span className="text-blue-400">show</span>(<span className="text-orange-400">"discountCode"</span>)
                    </div>
                    <div className="text-white">{'}'}</div>
                  </div>
                  <div className="mt-4 p-3 bg-indigo-50 rounded-lg border border-indigo-200">
                    <div className="flex items-center gap-2 text-indigo-700">
                      <Check className="h-4 w-4" />
                      <span className="text-sm font-medium">Expression valid</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Everything You Need to Build Better Forms
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Powerful features designed for developers and non-developers alike.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature) => (
              <div key={feature.title} className="text-center">
                <div className="w-14 h-14 bg-indigo-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <feature.icon className="h-7 w-7 text-indigo-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
                <p className="text-gray-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-xl text-gray-600">
              Start free and scale as you grow.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {pricingPlans.map((plan) => (
              <div
                key={plan.name}
                className={`bg-white rounded-2xl p-8 ${
                  plan.highlighted
                    ? 'ring-2 ring-indigo-600 shadow-xl scale-105'
                    : 'border border-gray-200 shadow-lg'
                }`}
              >
                {plan.highlighted && (
                  <div className="text-center mb-4">
                    <span className="bg-indigo-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                      Most Popular
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
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-indigo-600">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Ready to Build Smarter Forms?
          </h2>
          <p className="text-xl text-indigo-100 mb-8">
            Join thousands of users creating powerful forms with FormLogic.
          </p>
          <Button
            size="lg"
            className="bg-white text-indigo-600 hover:bg-indigo-50"
            onClick={() => openAuth('register')}
          >
            Get Started for Free
            <ArrowRight className="h-5 w-5 ml-2" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-4 sm:px-6 lg:px-8 bg-gray-900">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">FL</span>
              </div>
              <span className="font-semibold text-white text-lg">FormLogic</span>
            </div>
            <p className="text-gray-400 text-sm">
              &copy; {new Date().getFullYear()} FormLogic. All rights reserved.
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
