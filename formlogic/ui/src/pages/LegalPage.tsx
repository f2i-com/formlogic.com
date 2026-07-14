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
// v3 (2026-07-12): full data-flow coverage (Aokie telephony/transcription, remote
// endpoints, model downloads, MCP/API, subprocessors, roles, security) + beta/
// prepaid/support/availability terms. PENDING QUALIFIED LEGAL REVIEW for launch
// jurisdictions — flagged in-page until counsel signs off.
const LEGAL_VERSION = '3';
const LEGAL_EFFECTIVE_DATE = 'July 12, 2026';
const PENDING_COUNSEL_REVIEW = true;

const PRIVACY: LegalSection[] = [
  { heading: 'Overview', body: 'This Privacy Policy explains what information FormLogic collects, how it is used, and the choices you have. It applies to the FormLogic application, the forms and apps created with it, the optional FormLogic Desktop companion, and the optional Aokie phone receptionist. FormLogic is currently in public beta.' },
  { heading: 'Who Operates This Service', body: 'The hosted service at formlogic.com is operated by the FormLogic team (privacy and support contact: hello@formlogic.com; security reports: see the project security policy). FormLogic is source-available software — a self-hosted instance is operated by whoever deployed it, and that operator (not the FormLogic team) is responsible for this policy on their instance.' },
  { heading: 'Controller & Processor Roles', body: 'For your account data (name, email, login records) the service operator is the controller. For the content of forms and apps — the responses, records, files, call transcripts and SMS threads collected through them — the form or app OWNER is the controller and the service operator processes that data on the owner’s instructions. If you submitted data through someone’s form and want it corrected or deleted, the form owner is the right first contact.' },
  { heading: 'Information We Collect', body: 'Account information you provide (name, email, password hash, optional TOTP enrolment), the forms, apps, flows and responses you create or submit, uploaded files, and technical data used to operate and secure the service: IP address, browser/user-agent, referrer, preferred language and signed-in identity are recorded with each form submission so owners can verify provenance; authentication events and administrative actions are kept in an audit log.' },
  { heading: 'How We Use Information', body: 'To provide and improve the service, authenticate you, deliver form submissions to their owners, prevent abuse and fraud, and comply with legal obligations. We do not use your form content to train AI models, and we do not sell personal information.' },
  { heading: 'Desktop & Local Processing', body: 'FormLogic Desktop runs on your own computer. Local AI models, downloaded model files, plugin data, operational journals and flow execution state are stored and processed on that machine, not on FormLogic servers. Operational journals that contain call or message content are encrypted at rest with a per-install key, and completed entries have their content dropped on completion. Records that your flows file into a FormLogic app are stored with your FormLogic account (cloud or self-hosted). Model files are downloaded from the sources shown in the Desktop app (for example Hugging Face) and verified against pinned checksums; those downloads disclose your IP address to the hosting provider, as any download does.' },
  { heading: 'Aokie Calls & Messages', body: 'When you operate the Aokie receptionist, call audio is processed on your machine by local speech and language models by default — audio does not leave your computer unless you configure it to. Before the receptionist can operate, the device operator must accept a versioned, scoped consent covering the Bluetooth phone link, contacts, SMS and live transcription; denied scopes are refused at the point of capture. Call records, transcripts, summaries and SMS threads that your flows create are stored in your FormLogic app, under retention settings you control (90 days by default for call and SMS records). If you configure a remote AI, speech or transcription endpoint, the audio or transcript data needed for that feature is sent to that provider, and that endpoint becomes part of your consent record — you are responsible for choosing providers and for any disclosure to callers that your jurisdiction requires, including call-recording, transcription and AI-disclosure consent. Many jurisdictions require callers to be told they are speaking with an AI and/or being transcribed.' },
  { heading: 'Programmatic Access (API & MCP)', body: 'If you create External API keys or MCP tokens, systems holding those credentials can read or write your workspace within the scopes you granted. Requests made with them are attributed to your account and logged. Treat these credentials as secrets; you can revoke them at any time in Settings.' },
  { heading: 'Subprocessors & Data Sharing', body: 'The hosted service runs on the operator’s own infrastructure. Payment processing for prepaid cloud access is handled by PayPal (we never see your card details). Remote AI endpoints you explicitly configure receive only the data needed for that feature and only after you consent to them. Data may otherwise be disclosed only to comply with law or to protect the service and its users. Self-hosted instances have whatever subprocessors their operator chooses.' },
  { heading: 'International Transfers', body: 'The hosted service stores data in the operator’s hosting region. If you configure remote AI endpoints or webhooks in other countries, you are transferring that data there yourself — check your obligations before doing so. Self-hosted instances control their own data location entirely.' },
  { heading: 'Security', body: 'Passwords are stored hashed, optional two-factor authentication (TOTP) is available, uploads are private by default with owner-scoped access, desktop journals are encrypted at rest, plugin packages and model downloads are signature/checksum verified, and administrative actions are audit-logged. No system is perfectly secure — report suspected vulnerabilities to the security contact rather than opening a public issue.' },
  { heading: 'Data Retention & Deletion', body: 'We retain account and response data for as long as your account is active or as needed to provide the service. Call and SMS records default to 90-day retention, configurable per form. Deleted forms, apps and flows are recoverable from your recycle bin for 30 days, then purged. Nightly backups are retained for 7 days. You can export your full workspace at any time and request deletion of your account and associated data, which removes your forms, responses, uploaded files and backups — deletion is verified before the account record itself is removed.' },
  { heading: 'Your Rights', body: 'Depending on your jurisdiction (for example under the GDPR or the Australian Privacy Act), you may have rights to access, correct, export, restrict or delete your personal data, and to complain to a supervisory authority. Exercise them by contacting the operator of your instance; for the hosted service, hello@formlogic.com. If your data was collected through someone else’s form, we will refer your request to that form’s owner where the owner is the controller.' },
  { heading: 'Contact', body: 'Questions about this policy can be directed to the operator of this FormLogic instance — for the hosted service, hello@formlogic.com.' },
];

const TERMS: LegalSection[] = [
  { heading: 'Acceptance of Terms', body: 'By accessing or using FormLogic you agree to these Terms of Service. If you do not agree, do not use the service.' },
  { heading: 'Beta Status', body: 'FormLogic is provided as a public beta: features may change, break or be withdrawn, and no availability level is guaranteed. The Aokie receptionist additionally requires supported Windows hardware and is offered as a hardware beta with an explicit supported-device list. Do not rely on a beta service as your only copy of important data — use the built-in workspace export.' },
  { heading: 'Pricing & Prepaid Access', body: 'During the beta, signup is free for the stated period. Prepaid cloud access, where offered, is a one-time, non-recurring purchase for the stated period — there is no subscription and nothing renews automatically. Prices and included periods are shown before purchase. Where required by consumer law, refunds are provided for paid periods the service materially failed to deliver; otherwise prepaid periods are non-refundable once consumed.' },
  { heading: 'Use of the Service', body: 'You are responsible for the content of the forms, apps and responses you create or collect, and for complying with applicable laws, including obtaining any consents required from respondents. If you operate the Aokie receptionist, you are responsible for caller disclosure and for lawful recording and transcription in your jurisdiction — the Desktop consent wizard records YOUR authorisation of the system; it does not obtain your callers’ consent for you.' },
  { heading: 'Accounts', body: 'You are responsible for safeguarding your account credentials and for all activity under your account, including activity via API keys and MCP tokens you issue. Notify the operator promptly of any unauthorized use.' },
  { heading: 'Acceptable Use', body: 'You may not use the service to collect data unlawfully, send unsolicited communications, distribute malware, infringe intellectual property, or attempt to disrupt or gain unauthorized access to the platform or other users’ data. Rate limits and quotas protect the shared service and must not be circumvented.' },
  { heading: 'Content Ownership', body: 'You retain ownership of the forms and data you create. You grant the operator the limited rights needed to host and deliver the service. The FormLogic software itself is source-available under its published licence.' },
  { heading: 'Support & Availability', body: 'Support is provided on a best-effort basis via hello@formlogic.com. The beta service targets no specific uptime; maintenance may occur without notice. Self-hosted instances are supported by their own operators.' },
  { heading: 'Disclaimer & Liability', body: 'The service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, the operator is not liable for indirect or consequential damages arising from use of the service, and total liability is capped at the amount you paid for the service in the preceding 12 months. Nothing in these terms excludes liability that cannot lawfully be excluded, including non-excludable consumer guarantees.' },
  { heading: 'Changes', body: 'These terms may be updated from time to time; the version and effective date above change when the text changes. Material changes will be flagged in the application. Continued use after changes constitutes acceptance of the revised terms.' },
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
        {PENDING_COUNSEL_REVIEW && (
          <p className="mt-3 text-xs rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2">
            Beta notice: this document describes our actual data flows but has not yet completed
            review by qualified counsel for every launch jurisdiction.
          </p>
        )}

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
