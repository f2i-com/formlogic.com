import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../components/ui/Logo';

interface LegalSection {
  heading: string;
  body: string;
}

// Versioned legal documents (audit LEGAL-001): the effective date is part of the
// document and changes ONLY when the document text changes — never render the
// current date here, or an unchanged policy looks freshly updated on every visit.
const LEGAL_VERSION = '2';
const LEGAL_EFFECTIVE_DATE = 'July 12, 2026';

const PRIVACY: LegalSection[] = [
  { heading: 'Overview', body: 'This Privacy Policy explains what information FormLogic collects, how it is used, and the choices you have. It applies to the FormLogic application, the forms and apps created with it, the optional FormLogic Desktop companion, and the optional Aokie phone receptionist. FormLogic is currently in public beta.' },
  { heading: 'Information We Collect', body: 'Account information you provide (such as your name and email), the forms, apps, flows and responses you create or submit, and technical data such as IP address and browser type used to operate and secure the service.' },
  { heading: 'How We Use Information', body: 'To provide and improve the service, authenticate you, deliver form submissions to their owners, prevent abuse, and comply with legal obligations. Form responses are processed on behalf of the form owner, who acts as the controller of that data.' },
  { heading: 'Desktop & Local Processing', body: 'FormLogic Desktop runs on your own computer. Local AI models, downloaded model files, plugin data and flow execution state are stored and processed on that machine, not on FormLogic servers. Records that your flows file into a FormLogic app are stored with your FormLogic account (cloud or self-hosted).' },
  { heading: 'Aokie Calls & Messages', body: 'When you operate the Aokie receptionist, call audio is processed on your machine by local speech and language models by default. Call records, transcripts, summaries and SMS threads that your flows create are stored in your FormLogic app, under retention settings you control (90 days by default for call and SMS records). If you configure a remote AI, speech or transcription endpoint, the audio or transcript data needed for that feature is sent to that provider — you are responsible for choosing providers and for any disclosure to callers that your jurisdiction requires, including call-recording and transcription consent.' },
  { heading: 'Data Sharing', body: 'We do not sell your personal information. Data may be shared with service providers that help operate the platform, or when required by law. Form responses are accessible to the owner of the relevant form or app. Remote AI endpoints you explicitly configure receive only the data needed for that feature.' },
  { heading: 'Data Retention & Deletion', body: 'We retain account and response data for as long as your account is active or as needed to provide the service. Deleted forms, apps and flows are recoverable from your recycle bin for 30 days, then purged. You can export your full workspace at any time and request deletion of your account and associated data, which removes your forms, responses, uploaded files and backups.' },
  { heading: 'Your Rights', body: 'Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. Contact the operator of this instance to exercise these rights.' },
  { heading: 'Contact', body: 'Questions about this policy can be directed to the operator of this FormLogic instance — for the hosted service, hello@formlogic.com.' },
];

const TERMS: LegalSection[] = [
  { heading: 'Acceptance of Terms', body: 'By accessing or using FormLogic you agree to these Terms of Service. If you do not agree, do not use the service.' },
  { heading: 'Beta Status', body: 'FormLogic is provided as a public beta. Features may change, and the Aokie receptionist additionally requires supported Windows hardware and is offered as a hardware beta. During the beta, signup is free for a limited period; prepaid cloud access, where offered, is a one-time, non-recurring purchase for the stated period.' },
  { heading: 'Use of the Service', body: 'You are responsible for the content of the forms, apps and responses you create or collect, and for complying with applicable laws, including obtaining any consents required from respondents. If you operate the Aokie receptionist, you are responsible for caller disclosure and for lawful recording and transcription in your jurisdiction.' },
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
        <p className="mt-2 text-sm text-gray-500 dark:text-slate-400">Version {LEGAL_VERSION} · Effective {LEGAL_EFFECTIVE_DATE}</p>

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
