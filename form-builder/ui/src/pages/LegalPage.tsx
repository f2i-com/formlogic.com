import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../components/ui/Logo';

interface LegalSection {
  heading: string;
  body: string;
}

const PRIVACY: LegalSection[] = [
  { heading: 'Overview', body: 'This Privacy Policy explains what information FormLogic collects, how it is used, and the choices you have. It applies to the FormLogic application and the forms and apps created with it.' },
  { heading: 'Information We Collect', body: 'Account information you provide (such as your name and email), the forms, apps and responses you create or submit, and technical data such as IP address and browser type used to operate and secure the service.' },
  { heading: 'How We Use Information', body: 'To provide and improve the service, authenticate you, deliver form submissions to their owners, prevent abuse, and comply with legal obligations. Form responses are processed on behalf of the form owner.' },
  { heading: 'Data Sharing', body: 'We do not sell your personal information. Data may be shared with service providers that help operate the platform, or when required by law. Form responses are accessible to the owner of the relevant form or app.' },
  { heading: 'Data Retention', body: 'We retain account and response data for as long as your account is active or as needed to provide the service. You may request deletion of your account and associated data.' },
  { heading: 'Your Rights', body: 'Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. Contact the operator of this instance to exercise these rights.' },
  { heading: 'Contact', body: 'Questions about this policy can be directed to the operator of this FormLogic instance.' },
];

const TERMS: LegalSection[] = [
  { heading: 'Acceptance of Terms', body: 'By accessing or using FormLogic you agree to these Terms of Service. If you do not agree, do not use the service.' },
  { heading: 'Use of the Service', body: 'You are responsible for the content of the forms, apps and responses you create or collect, and for complying with applicable laws, including obtaining any consents required from respondents.' },
  { heading: 'Accounts', body: 'You are responsible for safeguarding your account credentials and for all activity under your account. Notify the operator promptly of any unauthorized use.' },
  { heading: 'Acceptable Use', body: 'You may not use the service to collect data unlawfully, distribute malware, infringe intellectual property, or attempt to disrupt or gain unauthorized access to the platform.' },
  { heading: 'Content Ownership', body: 'You retain ownership of the forms and data you create. You grant the operator the limited rights needed to host and deliver the service.' },
  { heading: 'Disclaimer & Liability', body: 'The service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, the operator is not liable for indirect or consequential damages arising from use of the service.' },
  { heading: 'Changes', body: 'These terms may be updated from time to time. Continued use after changes constitutes acceptance of the revised terms.' },
];

export function LegalPage({ type }: { type: 'privacy' | 'terms' }) {
  const title = type === 'privacy' ? 'Privacy Policy' : 'Terms of Service';
  const sections = type === 'privacy' ? PRIVACY : TERMS;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <header className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" aria-label="FormLogic home"><Logo /></Link>
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <ArrowLeft className="h-4 w-4" /> Home
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">Last updated {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <div className="mt-8 space-y-8">
          {sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{s.heading}</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-slate-400">{s.body}</p>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
