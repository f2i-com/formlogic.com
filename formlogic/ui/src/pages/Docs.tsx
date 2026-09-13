import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Menu, X, BookOpen, Rocket, LayoutGrid, ListChecks,
  GitBranch, Palette, Code2, Share2, Inbox, Download, BarChart3, Boxes,
  Package, Server, Shield, Lightbulb, Check, Terminal, Cloud, Plug, Workflow, Search, Phone, LifeBuoy,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { LandingNav } from '../components/landing-v2/LandingNav';
import { LandingFooter } from '../components/landing-v2/LandingFooter';
import { useLandingFonts } from '../components/landing-v2/hooks';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import '../styles/docs.css';

// Shares the landing page's display/mono/gradient chrome so docs feel part of the brand.
function useDocsChrome() {
  useEffect(() => {
    if (!document.getElementById('fl-landing-fonts')) {
      const link = document.createElement('link');
      link.id = 'fl-landing-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600&display=swap';
      document.head.appendChild(link);
    }
    if (!document.getElementById('fl-landing-styles')) {
      const style = document.createElement('style');
      style.id = 'fl-landing-styles';
      style.textContent = `
        .fl-display{font-family:'Bricolage Grotesque','Plus Jakarta Sans',system-ui,sans-serif;font-weight:800;letter-spacing:-0.035em;line-height:1.04;}
        .fl-mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;}
        .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-700)),rgb(var(--primary-500)) 52%,rgb(var(--primary-700)));-webkit-background-clip:text;background-clip:text;color:transparent;}
        :root.dark .fl-grad{background-image:linear-gradient(102deg,rgb(var(--primary-300)),rgb(var(--primary-400)) 48%,rgb(var(--primary-200)));}
      `;
      document.head.appendChild(style);
    }
  }, []);
}

const SECTIONS = [
  { id: 'introduction', title: 'Introduction', icon: BookOpen },
  { id: 'quick-start', title: 'Quick start', icon: Rocket },
  { id: 'connect-ai', title: 'Connect your AI', icon: Plug },
  { id: 'builder', title: 'The form builder', icon: LayoutGrid },
  { id: 'field-types', title: 'Field types', icon: ListChecks },
  { id: 'logic', title: 'Validation & logic', icon: GitBranch },
  { id: 'theming', title: 'Theming', icon: Palette },
  { id: 'scripts', title: 'Backend scripts', icon: Code2 },
  { id: 'publishing', title: 'Publishing & sharing', icon: Share2 },
  { id: 'responses', title: 'Viewing responses', icon: Inbox },
  { id: 'exporting', title: 'Exporting data', icon: Download },
  { id: 'analytics', title: 'Analytics', icon: BarChart3 },
  { id: 'api', title: 'API access', icon: Terminal },
  { id: 'mcp', title: 'Build with your AI (MCP)', icon: Plug },
  { id: 'cloud', title: 'Free access & support', icon: Cloud },
  { id: 'apps', title: 'Apps & permissions', icon: Boxes },
  { id: 'hosted-apps', title: 'Host an editable app', icon: Code2 },
  { id: 'native-records', title: 'Manage app database records', icon: Inbox },
  { id: 'aokie', title: 'Aokie calls & appointments', icon: Phone },
  { id: 'packs', title: 'Packs & templates', icon: Package },
  { id: 'flows', title: 'Automations & OAIY', icon: Workflow },
  { id: 'self-hosting', title: 'Self-hosting', icon: Server },
  { id: 'security', title: 'Security', icon: Shield },
  { id: 'troubleshooting', title: 'Troubleshooting & guides', icon: LifeBuoy },
];

const START_PATHS = [
  { id: 'quick-start', title: 'Create your first form', description: 'Build, publish and collect a response.', icon: Rocket },
  { id: 'connect-ai', title: 'Bring your own AI', description: 'Use OAIY, a provider API or your AI client.', icon: Plug },
  { id: 'hosted-apps', title: 'Build a connected app', description: 'An editable interface, private logic and data.', icon: Code2 },
  { id: 'native-records', title: 'Manage app database records', icon: Inbox },
  { id: 'aokie', title: 'Set up a front desk', description: 'Connect calls, messages and appointments.', icon: Phone },
];

function GuideLink({ file, children }: { file: string; children: React.ReactNode }) {
  return <a href={`https://github.com/f2i-com/formlogic.com/blob/main/${file}`} className="text-primary-700 dark:text-primary-300 underline decoration-primary-300/50 underline-offset-4 hover:decoration-current">{children}</a>;
}

function H2({ id, icon: Icon, children }: { id: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <h2 id={id} tabIndex={-1} className="fl-display scroll-mt-24 text-2xl sm:text-3xl text-gray-900 dark:text-white flex items-center gap-3 mb-5 mt-2 outline-none">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 shrink-0">
        <Icon className="h-5 w-5" />
      </span>
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-gray-600 dark:text-slate-300 mb-4">{children}</p>;
}

function C({ children }: { children: React.ReactNode }) {
  return <code className="fl-mono text-[0.85em] bg-gray-100 dark:bg-slate-800 text-primary-700 dark:text-primary-300 px-1.5 py-0.5 rounded">{children}</code>;
}

function CodeBlock({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden border border-slate-800 dark:border-slate-700/60 bg-slate-950 dark:bg-slate-900/60 my-5 shadow-lg shadow-black/20">
      {title && (
        <div className="h-9 bg-slate-900 dark:bg-slate-800/60 flex items-center gap-2 px-4 border-b border-slate-800 dark:border-slate-700/50 min-w-0">
          <Terminal className="h-3.5 w-3.5 text-slate-500 shrink-0" />
          <span className="fl-mono text-xs text-slate-400 truncate">{title}</span>
        </div>
      )}
      <pre tabIndex={0} role="region" aria-label={title ?? 'Code example'} className="fl-mono text-[12.5px] leading-[1.7] text-slate-200 p-4 sm:p-5 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400"><code>{children}</code></pre>
    </div>
  );
}

// Bump when the /screenshots images are replaced: Apache serves them without Cache-Control,
// so browsers heuristically cache by Last-Modified and would keep showing the old captures.
const SCREENSHOT_VERSION = '2026-09-13';
const SCREENSHOT_SIZES: Record<string, [number, number]> = {
  '/images/dashboard-demo/desktop-dark.jpg': [2880, 2000],
  '/images/docs/connect-ai.jpg': [2880, 2000],
  '/images/docs/aokie-front-desk.png': [1440, 1000],
  '/images/docs/starter-apps.jpg': [2160, 1560],
  '/images/docs/native-backend.jpg': [896, 990],
  '/images/docs/native-screens.jpg': [896, 990],
  '/images/docs/native-records.jpg': [1024, 970],
  '/images/docs/native-record-editor-mobile.jpg': [358, 629],
};

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="my-6">
      <div className="rounded-xl overflow-hidden border border-gray-200/80 dark:border-slate-800 shadow-xl shadow-gray-900/[0.06] dark:shadow-black/30 bg-gray-50 dark:bg-slate-900">
        <a href={`${src}?v=${SCREENSHOT_VERSION}`} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size screenshot: ${alt}`} className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"><img src={`${src}?v=${SCREENSHOT_VERSION}`} alt={alt} width={SCREENSHOT_SIZES[src]?.[0]} height={SCREENSHOT_SIZES[src]?.[1]} loading="lazy" decoding="async" className="w-full h-auto block" /></a>
      </div>
      <figcaption className="fl-mono text-xs text-gray-500 dark:text-slate-400 mt-2.5 text-center">{caption}</figcaption>
    </figure>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-3 my-5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3.5">
          <span className="fl-mono shrink-0 h-6 w-6 rounded-full bg-primary-600 text-primary-foreground text-xs font-semibold flex items-center justify-center mt-0.5">{i + 1}</span>
          <div className="text-[15px] leading-relaxed text-gray-600 dark:text-slate-300 pt-0.5">{item}</div>
        </li>
      ))}
    </ol>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-5 flex gap-3 rounded-xl border border-primary-200/70 dark:border-primary-500/25 bg-primary-50/60 dark:bg-primary-500/[0.07] p-4">
      <Lightbulb className="h-5 w-5 text-primary-600 dark:text-primary-400 shrink-0 mt-0.5" />
      <div className="text-[14px] leading-relaxed text-gray-700 dark:text-slate-300">{children}</div>
    </div>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2.5 my-4">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3 text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">
          <Check className="h-4 w-4 text-primary-600 dark:text-primary-400 shrink-0 mt-1" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const FIELD_TYPES: Array<[string, string]> = [
  ['Short / Long text', 'Single-line and multi-line free text, with optional length limits.'],
  ['Email · Phone · URL', 'Text inputs with format validation built in.'],
  ['Number', 'Numeric input with optional min / max / step.'],
  ['Date · Time · Date & Time', 'Native pickers for scheduling and deadlines.'],
  ['Dropdown · Multiple choice · Checkboxes', 'Single- and multi-select from your options.'],
  ['Rating · Scale', 'Star ratings and linear scales (e.g. 1–10) for satisfaction.'],
  ['File upload', 'Accept documents and images, with type and size limits.'],
  ['Signature', 'Draw-or-type signature capture.'],
  ['Calculated', 'A read-only value computed from an expression over other fields.'],
  ['Linked record', 'Reference a response from another form in an authenticated app or owner context. The picker is unavailable to anonymous standalone visitors.'],
  ['Location', 'Capture latitude / longitude.'],
  ['Hidden', 'Stores a default, computed, or script-set value that respondents never see — saved with the response and shown in exports.'],
  ['Statement · Welcome · Thank you', 'Display-only content and intro / completion screens.'],
];

export function Docs() {
  useDocsChrome();
  useLandingFonts();
  useDocumentTitle('Documentation');
  const [mobileNav, setMobileNav] = useState(false);
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const [sectionQuery, setSectionQuery] = useState('');
  const visibleSections = SECTIONS.filter((section) => section.title.toLowerCase().includes(sectionQuery.trim().toLowerCase()));

  useEffect(() => {
    if (!mobileNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileNav(false);
        document.getElementById('docs-menu-toggle')?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileNav]);

  // Keep the preceding section active through long content and gaps between headings.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const current = [...SECTIONS].reverse().find((section) => {
        const heading = document.getElementById(section.id);
        return heading && heading.getBoundingClientRect().top <= 180;
      });
      setActiveId(current?.id ?? SECTIONS[0].id);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return (
    <div className="lv2 fl-docs min-h-screen selection:bg-primary-500/20">
      <a href="#docs-content" onClick={() => setMobileNav(false)} className="fl-skip">Skip to documentation</a>
      <LandingNav onMenuOpen={() => setMobileNav(false)} />
      <div className="fl-docs__toolbar lg:hidden">
        <span className="text-sm font-semibold">Documentation</span>
        <button id="docs-menu-toggle" onClick={() => setMobileNav((v) => !v)} aria-label={mobileNav ? 'Close docs sections' : 'Browse docs sections'} aria-controls="docs-sections" aria-expanded={mobileNav} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 cursor-pointer">
          {mobileNav ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          <span>{mobileNav ? 'Close sections' : 'On this page'}</span>
        </button>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10">
          {/* Sidebar TOC — inline column on desktop, full-height overlay panel under the nav on mobile */}
          <aside id="docs-sections" className={`fl-docs__sections ${mobileNav ? 'fl-docs__sections--open' : ''} py-6 lg:py-8`}>
            <p className="fl-mono text-[11px] uppercase tracking-[0.2em] text-gray-500 dark:text-slate-400 mb-3 px-3">On this page</p>
            <label className="mb-4 mx-1 flex items-center gap-2 rounded-xl border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 px-3 focus-within:ring-2 focus-within:ring-primary-500/50">
              <Search className="h-4 w-4 shrink-0 text-gray-500" />
              <input type="search" value={sectionQuery} onChange={(event) => setSectionQuery(event.target.value)} aria-label="Find a docs section" placeholder="Find a section…" className="min-w-0 w-full bg-transparent py-3 text-sm text-gray-900 dark:text-slate-100 outline-none" />
            </label>
            <nav className="space-y-0.5" aria-label="Docs sections">
              {visibleSections.map((s) => {
                const isActive = activeId === s.id;
                return (
                  <a key={s.id} href={`#${s.id}`} onClick={() => { setActiveId(s.id); setMobileNav(false); setSectionQuery(''); requestAnimationFrame(() => document.getElementById(s.id)?.focus({ preventScroll: true })); }}
                    aria-current={isActive ? 'true' : undefined}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 motion-safe:transition-colors ${
                      isActive
                        ? 'bg-primary-50/80 dark:bg-primary-500/[0.12] text-primary-700 dark:text-primary-300 font-medium'
                        : 'text-gray-600 dark:text-slate-400 hover:text-primary-700 dark:hover:text-primary-300 hover:bg-primary-50/70 dark:hover:bg-primary-500/[0.08]'
                    }`}>
                    <s.icon className={`h-4 w-4 shrink-0 ${isActive ? 'opacity-100' : 'opacity-70'}`} />
                    <span className="min-w-0 truncate">{s.title}</span>
                  </a>
                );
              })}
              {visibleSections.length === 0 && <p role="status" className="px-3 py-4 text-sm text-gray-500 dark:text-slate-400">No matching section. Try “AI”, “app” or “form”.</p>}
            </nav>
          </aside>

          {/* Content */}
          <main id="docs-content" tabIndex={-1} className="min-w-0 py-8 lg:py-12 max-w-3xl scroll-mt-24 outline-none [overflow-wrap:anywhere]">
            <div className="mb-12">
              <p className="fl-mono text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 mb-4">Documentation</p>
              <h1 className="fl-display text-4xl sm:text-5xl text-gray-900 dark:text-white mb-5">Build something<br /><span className="fl-grad">that works for you.</span></h1>
              <p className="text-lg text-gray-500 dark:text-slate-400 leading-relaxed">
                Start with a form. Turn it into an app. Connect your AI, automate the next step,
                and keep your team’s work in one place. Choose a guide to get started.
              </p>
              <div className="grid sm:grid-cols-2 gap-3 mt-7">
                {START_PATHS.map((path) => <a key={path.id} href={`#${path.id}`} className="group rounded-2xl border border-gray-200 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-900/50 p-5 hover:border-primary-400 dark:hover:border-primary-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 motion-safe:transition-colors">
                  <path.icon className="h-5 w-5 text-primary-600 dark:text-primary-400 mb-3" />
                  <span className="flex items-center justify-between gap-2 font-semibold text-gray-900 dark:text-white">{path.title}<ArrowRight className="h-4 w-4 shrink-0 text-gray-400 group-hover:text-primary-500" /></span>
                  <span className="block mt-2 text-sm leading-relaxed text-gray-600 dark:text-slate-400">{path.description}</span>
                </a>)}
              </div>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-5">New here? <Link to="/packs" className="text-primary-700 dark:text-primary-300 underline underline-offset-4">Explore starter apps</Link> or <Link to="/ai-setup" className="text-primary-700 dark:text-primary-300 underline underline-offset-4">follow the guided setup</Link>. Free access, with your own AI when you need it.</p>
            </div>

            {/* Introduction */}
            <section className="mb-14">
              <H2 id="introduction" icon={BookOpen}>Introduction</H2>
              <P>FormLogic brings forms, dashboards, records, roles and automations into one workspace. Forms define the data. Apps give that data a home for a team or customer. A form can appear in several apps while keeping the same records and server-enforced permissions.</P>
              <div className="flex flex-wrap items-center gap-2 my-5 fl-mono text-xs">
                <span className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">a visitor submits</span>
                <ArrowRight className="h-3.5 w-3.5 text-primary-500" />
                <span className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">onSubmit(ctx) runs</span>
                <ArrowRight className="h-3.5 w-3.5 text-primary-500" />
                <span className="px-3 py-1.5 rounded-full bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/25 text-primary-700 dark:text-primary-300">data is stored</span>
              </div>
              <P>Editable app interfaces use Softn. FormLogic hosts their private backend logic and SQLite databases. OAIY connects local AI, services and devices; Aokie adds calls, messages and appointment workflows. You can start with the visual builders and connect these when you need them.</P>
              <P>This guide covers the current workspace. For deployment or API details, use the linked developer guides or jump to <a href="#self-hosting" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">Self-hosting</a>.</P>
            </section>

            {/* Quick start */}
            <section className="mb-14">
              <H2 id="quick-start" icon={Rocket}>Quick start</H2>
              <P>Start with one form and a test response. No AI connection is needed for the visual builder.</P>
              <Steps items={[
                <><strong className="text-gray-900 dark:text-white">Create an account</strong> on the <Link to="/signup" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">sign-up page</Link>, then sign in. You land on your dashboard.</>,
                <><strong className="text-gray-900 dark:text-white">Choose “New form”</strong> and start blank or from a template. To generate one with AI, <a href="#connect-ai" className="underline">connect your AI</a> first; available generation tools depend on that connection.</>,
                <><strong className="text-gray-900 dark:text-white">Add fields</strong> from the palette and arrange them in the builder.</>,
                <><strong className="text-gray-900 dark:text-white">Save the form to your account and Publish</strong>, then share its public link or embed it. Browser-local forms stay on this device.</>,
                <><strong className="text-gray-900 dark:text-white">Submit a test response</strong>, check it under <C>Responses</C>, then add the form to an app when you want a dashboard or member access.</>,
              ]} />
              <Figure src="/images/dashboard-demo/desktop-dark.jpg" alt="Current FormLogic dashboard showing fictional studio apps and activity" caption="The current dashboard, shown with fictional studio data." />
            </section>

            <section className="mb-14">
              <H2 id="connect-ai" icon={Plug}>Connect your AI</H2>
              <P>Open <Link to="/connect-ai" className="text-primary-700 dark:text-primary-300 underline">Connect your AI</Link>. The wizard walks through choosing a connection, testing it and making it your default. You can explore the <Link to="/ai-setup" className="underline">public setup guide</Link> before signing in; the connection wizard requires sign-in.</P>
              <Steps items={[
                <><strong className="text-gray-900 dark:text-white">Choose OAIY or a direct API.</strong> OAIY can connect a Codex account, a provider key or a local model. A direct API connection is configured in this browser and needs a provider that permits browser requests.</>,
                <><strong className="text-gray-900 dark:text-white">Connect and test.</strong> In OAIY, complete Getting started, select an AI provider and approve the FormLogic pairing code. For a direct API, enter the endpoint, model and key in the provider editor and test the connection.</>,
                <><strong className="text-gray-900 dark:text-white">Choose your default.</strong> Finish the wizard and try a small request in the workspace. The selected provider supplies the AI; its own usage limits and charges apply.</>,
              ]} />
              <Figure src="/images/docs/connect-ai.jpg" alt="FormLogic connection wizard offering OAIY Desktop and a direct API provider" caption="Actual connection wizard with a fictional account and no provider connected." />
              <Tip>Browser pairing lets this browser use approved OAIY capabilities. To deliver device events and run account workflows, also link your FormLogic account in OAIY. Those are separate connections. For an external AI client, follow <a href="#mcp" className="underline">Build with your AI (MCP)</a>.</Tip>
              <P>Operator-funded Site AI is off by default. Some specialised generation tools still require it and are unavailable when it is off. <GuideLink file="docs/FREE_PLANS_AND_AI_SETUP.md">Connection options, feature coverage and administrator setup</GuideLink>.</P>
            </section>

            {/* Builder */}
            <section className="mb-14">
              <H2 id="builder" icon={LayoutGrid}>The form builder</H2>
              <P><C>Create new form</C> offers a blank form or a starter from the site’s template folder. Form names are optional; rename an untitled form later in the builder or forms list. The catalogue refreshes each time the picker opens.</P>
              <Tip>Self-hosting operators can add JSON files to <C>backend/storage/form-templates/</C> to extend or override the bundled starters without rebuilding the website. Categories come from the files. Existing forms stay unchanged. <GuideLink file="docs/FORM_TEMPLATES.md">Template format and setup</GuideLink>.</Tip>
              <P>The builder has three areas: the <strong className="text-gray-900 dark:text-white">field palette</strong> on the left, the <strong className="text-gray-900 dark:text-white">canvas</strong> in the middle, and a contextual <strong className="text-gray-900 dark:text-white">settings panel</strong> on the right.</P>
              <Bullets items={[
                <>Click <C>Add Field</C> (or a palette item) to add a field; drag the handle to reorder.</>,
                <>Select any field to edit it in the settings panel — its <strong className="text-gray-900 dark:text-white">Basic</strong> info (label, description, placeholder, required), <strong className="text-gray-900 dark:text-white">Validation</strong> rules, and conditional <strong className="text-gray-900 dark:text-white">Logic</strong>.</>,
                <>Use the header to open <C>Theme</C>, <C>Script</C>, <C>Preview</C>, <C>Share</C>, and <C>Publish</C>. Undo / redo is always one click away.</>,
              ]} />

            </section>

            {/* Field types */}
            <section className="mb-14">
              <H2 id="field-types" icon={ListChecks}>Field types</H2>
              <P>Choose the field that matches the answer you need. Input fields support requiredness and type-specific validation. Display-only, hidden and calculated fields do not have a required toggle.</P>
              <div className="grid sm:grid-cols-2 gap-3 my-5">
                {FIELD_TYPES.map(([name, desc]) => (
                  <div key={name} className="rounded-xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4">
                    <div className="text-[14px] font-semibold text-gray-900 dark:text-white mb-1">{name}</div>
                    <div className="text-[13px] text-gray-500 dark:text-slate-400 leading-relaxed">{desc}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* Logic & validation */}
            <section className="mb-14">
              <H2 id="logic" icon={GitBranch}>Validation &amp; conditional logic</H2>
              <P>Open a field's settings and switch to the <strong className="text-gray-900 dark:text-white">Validation</strong> tab to add rules — minimum / maximum length, a numeric range, or a regular-expression pattern. Rules run both in the browser and on the server, so they can't be bypassed.</P>
              <P>The <strong className="text-gray-900 dark:text-white">Logic</strong> tab lets a field appear only when earlier answers meet a condition. For example, show “Which competitor?” when someone answers “Yes, I switched”. A conditionally hidden input is no longer required, but hiding it does not erase its answer. Supplied values still go through server validation.</P>
              <Tip>For anything beyond simple show/hide — scoring, cross-field checks, or calling another service — use a <a href="#scripts" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">backend script</a>.</Tip>
            </section>

            {/* Theming */}
            <section className="mb-14">
              <H2 id="theming" icon={Palette}>Theming</H2>
              <P>Click <C>Theme</C> in the builder to match your brand. You can set:</P>
              <Bullets items={[
                <>Primary, background, and text <strong className="text-gray-900 dark:text-white">colours</strong>, plus the <strong className="text-gray-900 dark:text-white">font</strong>.</>,
                <>A <strong className="text-gray-900 dark:text-white">logo</strong> shown above the form and a full-page <strong className="text-gray-900 dark:text-white">background image</strong>.</>,
              ]} />
              <P>To change the layout, open <C>Settings → Presentation → Presentation mode</C>. Choose <strong>Focused</strong> for one question at a time, <strong>Classic</strong> for all questions on one page, or <strong>Both</strong> to let the respondent switch.</P>

            </section>

            {/* Scripts */}
            <section className="mb-14">
              <H2 id="scripts" icon={Code2}>Backend scripts (onSubmit)</H2>
              <P>This is what makes FormLogic different. Click <C>Script</C> in the builder to write an <C>onSubmit(ctx)</C> function that runs <strong className="text-gray-900 dark:text-white">on the server</strong> every time the form is submitted — to validate, score, tag, compute fields, set a status, or call an external API.</P>
              <CodeBlock title="onSubmit — lead scoring">{`function onSubmit(ctx) {
  // Replace these field IDs with those shown in Form Fields.
  // Add a hidden lead_score field to keep the computed result.
  let score = 0;
  if ((Number(ctx.answers.budget) || 0) >= 10000) score += 40;
  if (ctx.answers.role === "decision_maker") score += 30;

  // Store a computed field, a status, and a tag on the response
  ctx.db.setField("lead_score", score);
  ctx.db.setStatus(score >= 50 ? "approved" : "reviewed");
  if (score >= 50) ctx.db.addTag("hot-lead");

  // Reject a submission outright
  if (String(ctx.answers.email || "").toLowerCase().endsWith("@spam.com")) {
    return { reject: true, message: "Please use a work email." };
  }
}`}</CodeBlock>
              <h3 id="ctx-api" className="scroll-mt-24 text-[15px] text-gray-700 dark:text-slate-200 font-semibold mt-6 mb-3">What's available on <C>ctx</C></h3>
              <Bullets items={[
                <><C>ctx.answers.fieldId</C> — every submitted answer.</>,
                <><C>ctx.db.getField(name)</C> — read a field from the record (a submitted answer, or one this script set).</>,
                <><C>ctx.db.setField(name, value)</C>, <C>ctx.db.setStatus(status)</C>, <C>ctx.db.addTag(tag)</C> — write computed data back to the response.</>,
                <><C>ctx.utils.now()</C>, <C>ctx.utils.uuid()</C>, <C>ctx.utils.hash(str)</C>, <C>ctx.utils.formatDate(...)</C> — helpers.</>,
                <><C>ctx.http.post(url, data, opts)</C> / <C>get</C> / <C>put</C> … — call external APIs (e.g. a webhook or CRM).</>,
                <><C>ctx.meta.ip</C>, <C>ctx.meta.formId</C>, <C>ctx.meta.responseId</C> — submission metadata.</>,
              ]} />
              <P>You don't have to write it from scratch. The Script editor includes:</P>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Starter script</strong> — generates a working example using your form's real field IDs.</>,
                <><strong className="text-gray-900 dark:text-white">AI assistance</strong> — use the connected chat to help write the script. A separate AI Generate tab is available only when that generation route is enabled and chat AI is unavailable.</>,
                <><strong className="text-gray-900 dark:text-white">Run Test</strong> — use sample answers without saving a FormLogic response and inspect the computed result. HTTP calls still execute, so use test endpoints.</>,
                <>An <strong className="text-gray-900 dark:text-white">API Reference</strong> tab with every function, and a <strong className="text-gray-900 dark:text-white">Form Fields</strong> tab listing your field IDs.</>,
              ]} />

              <Tip>Scripts run in a sandbox with instruction, time and memory limits and no filesystem access. <C>ctx.http</C> and <C>ctx.db</C> are synchronous: call them directly, without <C>async</C>/<C>await</C>. If the script fails or times out, the submission is not saved. Fix the script or runtime problem, test it and retry the submission. An intentional rejection also prevents saving and returns your rejection message.</Tip>
            </section>

            {/* Publishing */}
            <section className="mb-14">
              <H2 id="publishing" icon={Share2}>Publishing &amp; sharing</H2>
              <Steps items={[
                <>Save your form to the account backend, then click <C>Publish</C>. A hosted form gets a public link; a browser-local form only publishes locally and has no public URL.</>,
                <>Open <C>Share</C> to copy the link or grab an <strong className="text-gray-900 dark:text-white">embed</strong> snippet for your website.</>,
                <>Edits to an already-published hosted form autosave and become live; they are not held for a separate republish. Close the form or change its response limit in <C>Settings</C> when you are done collecting.</>,
              ]} />
              <Tip>Uploads are private by default. Access requires the owner, an app member with the relevant response permission, or a short-lived per-file receipt token for a standalone submission. Publishing a form does not make its uploads public. Explicitly configured public-record screens can expose selected file fields, so review those settings before sharing.</Tip>
            </section>

            {/* Responses */}
            <section className="mb-14">
              <H2 id="responses" icon={Inbox}>Collecting &amp; viewing responses</H2>
              <P>Open <C>Responses</C> on any form to see submissions in a table that adapts to your screen — it shows as many columns as fit and stacks into cards on narrow screens. Click a row to see the full response, including computed fields, tags, and status.</P>
              <Bullets items={[
                <>Edit or delete individual responses; calculated fields recompute on save.</>,
                <>Filter by status (submitted, reviewed, approved, rejected…) and search across answers.</>,
                <>File uploads appear as download links; choice answers show their human labels.</>,
              ]} />

            </section>

            {/* Exporting */}
            <section className="mb-14">
              <H2 id="exporting" icon={Download}>Exporting your data</H2>
              <P>Your data is always yours. From the form's analytics / responses you can export to:</P>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">CSV</strong> — for spreadsheets (choice labels resolved, formula-injection safe).</>,
                <><strong className="text-gray-900 dark:text-white">JSON</strong> — for programmatic use.</>,
                <><strong className="text-gray-900 dark:text-white">SQLite</strong> — the form's entire database file, queryable with any SQLite tool.</>,
              ]} />
              <Tip>Each form has its own SQLite database. For an encrypted private form, that database contains encrypted envelopes, not readable answers. Plaintext CSV/JSON downloads in Analytics are unavailable; use the decrypted spreadsheet export in Responses after unlocking the form.</Tip>
            </section>

            {/* Analytics */}
            <section className="mb-14">
              <H2 id="analytics" icon={BarChart3}>Analytics</H2>
              <P>For a hosted form, Analytics shows <strong className="text-gray-900 dark:text-white">views → starts → responses</strong>, completion rate, average completion time and response trends. Field breakdowns may use a sample of recent responses; check the sample-size label. Encrypted answer contents are unavailable to server-side field analytics.</P>

            </section>

            {/* API access */}
            <section className="mb-14">
              <H2 id="api" icon={Terminal}>API access</H2>
              <P>Every form has a REST API, so you can use it programmatically — submit responses from your own app, script, or device, and read or manage the data. A submission made through the API runs the <strong className="text-gray-900 dark:text-white">same pipeline as filling out the form</strong>: server-side validation, calculated fields, and your <a href="#scripts" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">backend <C>onSubmit</C> script</a> (including reject, set status, and add tags). Full scripting, over HTTP.</P>
              <P>Create a key, then send it as a Bearer token on every request:</P>
              <Steps items={[
                <>Open <C>Settings → API keys</C> and choose <strong className="text-gray-900 dark:text-white">Create API Key</strong>.</>,
                <>Choose its <strong className="text-gray-900 dark:text-white">scopes</strong> (grant only what's needed), and optionally restrict it to specific forms or set an expiry.</>,
                <>Copy the key (<C>flk_…</C>) — it's shown <strong className="text-gray-900 dark:text-white">once</strong> and stored hashed. Keep it secret.</>,
              ]} />
              <CodeBlock title="submit a response — runs validation + the onSubmit script">{`curl -X POST https://<your-api-host>/api/v1/forms/FORM_ID/responses \\
  -H "Authorization: Bearer flk_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{ "answers": { "full_name": "Ada", "score": 80 } }'

# 201 → { "response": { "status": "approved", "tags": ["high-score"],
#          "answers": { "full_name": "Ada", "score": 80, "grade": 160 } } }
# rejected by the script → 422 { "rejected": true, "message": "..." }`}</CodeBlock>
              <P>What you can do — each route needs a matching scope:</P>
              <ul className="space-y-1.5 text-gray-600 dark:text-slate-300 list-disc pl-5 my-4">
                <li><strong className="text-gray-900 dark:text-white">Forms</strong> — list forms, read a form and its fields (<C>forms:read</C>)</li>
                <li><strong className="text-gray-900 dark:text-white">Responses</strong> — submit single or in batches (<C>responses:write</C>), list/read (<C>responses:read</C>), update/delete (<C>responses:manage</C>)</li>
                <li><strong className="text-gray-900 dark:text-white">Analytics</strong> — the per-form funnel and field breakdowns (<C>responses:read</C>)</li>
                <li><strong className="text-gray-900 dark:text-white">Webhooks</strong> — list (<C>webhooks:read</C>), create/update/delete (<C>webhooks:write</C>)</li>
              </ul>
              <Tip>A key only reaches permitted resources and uses the base URL <C>https://&lt;your-api-host&gt;/api/v1</C>. Keep long-lived keys on a trusted server. Hosted clients use an authenticated bridge instead of embedding keys. <GuideLink file="docs/API.md">REST endpoint reference and examples</GuideLink>.</Tip>
            </section>

            {/* MCP */}
            <section className="mb-14">
              <H2 id="mcp" icon={Plug}>Build with your AI (MCP)</H2>
              <P>Connect an AI client that supports remote HTTP <strong className="text-gray-900 dark:text-white">MCP</strong> (Model Context Protocol) to create and edit forms, screens, dashboards, reports, flows and hosted app projects. Every connection is scoped and revocable. The client can only use tools granted by your token and account permissions.</P>
              <h3 className="scroll-mt-24 text-[15px] text-gray-700 dark:text-slate-200 font-semibold mt-6 mb-3">Connect with OAuth</h3>
              <Steps items={[
                <>Open <C>Settings → External AI access → Manage AI connections</C> and copy your MCP URL: <C>https://&lt;your-host&gt;/api/mcp</C>.</>,
                <>Add that URL as a remote MCP server in your AI client and choose OAuth if the client supports it.</>,
                <>Your browser opens FormLogic&apos;s consent page: check who&apos;s asking, optionally <strong className="text-gray-900 dark:text-white">limit the connection to one app</strong>, and approve.</>,
              ]} />
              <h3 className="scroll-mt-24 text-[15px] text-gray-700 dark:text-slate-200 font-semibold mt-6 mb-3">Or generate a manual token (other clients)</h3>
              <P>Open <C>Manage AI connections</C> in Settings, or <C>Connect an AI</C> on the Apps page. For a connection limited to an existing app, use that app&apos;s <C>Manage → Connect an AI</C> action. Choose <strong className="text-gray-900 dark:text-white">Generate connection</strong> and use the supplied settings in your client. Its exact configuration format may differ; a URL and bearer-header configuration looks like:</P>
              <CodeBlock title="client config — add as a remote/HTTP MCP server">{`{
  "mcpServers": {
    "formlogic": {
      "url": "https://<your-api-host>/api/mcp",
      "headers": { "Authorization": "Bearer flm_xxx" }
    }
  }
}`}</CodeBlock>
              <P>Connections are deliberately short-lived — a <strong className="text-gray-900 dark:text-white">1-hour</strong> expiry (OAuth clients refresh silently), a <strong className="text-gray-900 dark:text-white">15-minute</strong> idle timeout for manual tokens, and one-click revoke. Tokens are stored hashed and shown only once.</P>
              <P>Tokens carry <strong className="text-gray-900 dark:text-white">scopes</strong>. The default &quot;builder&quot; token can manage apps, forms, and screens — but <strong className="text-gray-900 dark:text-white">cannot read submission data</strong> (<C>responses:read</C> is opt-in). Tools the AI can call:</P>
              <ul className="space-y-1.5 text-gray-600 dark:text-slate-300 list-disc pl-5 my-4">
                <li><strong className="text-gray-900 dark:text-white">Forms</strong> — <C>list_forms</C>, <C>get_form</C>, <C>create_form</C>, <C>update_form</C> (fields, onSubmit script, custom screen)</li>
                <li><strong className="text-gray-900 dark:text-white">Apps</strong> — <C>list_apps</C>, <C>create_app</C>, <C>update_app</C> (name, slug, publish), <C>add_form_to_app</C>, <C>set_app_home</C> (a no-code widget dashboard, or a custom code screen)</li>
                <li><strong className="text-gray-900 dark:text-white">Reports</strong> — <C>create_report</C> (charts, KPIs, tables) and <C>create_document</C> (exportable PDF pages)</li>
                <li><strong className="text-gray-900 dark:text-white">Responses</strong> — <C>list_responses</C> (only with the <C>responses:read</C> scope)</li>
                <li><strong className="text-gray-900 dark:text-white">Hosted apps</strong> — <C>get_workspace_template</C>, <C>get_app_project</C>, <C>publish_app_project</C> and <C>compose_apps</C>. Native apps use <C>get_native_app_template</C>, <C>get_native_app_project</C>, <C>publish_native_app_project</C>, <C>update_native_app_files</C> and <C>list_native_app_records</C></li>
                <li><strong className="text-gray-900 dark:text-white">Aokie and roles</strong> — install a starter, create app roles and set form permissions and reviewed connector grants</li>
                <li><strong className="text-gray-900 dark:text-white">OAIY</strong> — <C>desktop_status</C> and <C>connector_command</C> operate approved connectors, including the Aokie phone bridge; command access is off by default</li>
              </ul>
              <Tip>Start with app-scoped access and grant only the capabilities needed. Read the current project and version before replacing it. Signup, email verification, OAuth consent and native device pairing still require the person using the account; MCP does not bypass them.</Tip>
              <P><GuideLink file="docs/MCP.md">MCP setup, scopes and tool reference</GuideLink> · <Link to="/ai-setup" className="text-primary-700 dark:text-primary-300 underline">Guided setup</Link> · <a href="/llms.txt" className="text-primary-700 dark:text-primary-300 underline">Machine-readable starting point</a></P>
            </section>

            {/* Plans and AI setup */}
            <section className="mb-14">
              <H2 id="cloud" icon={Cloud}>Free access &amp; optional support</H2>
              <P>FormLogic is free. Create forms, apps and automations with the visual builders, and bring your own AI when you want an assistant. Your AI provider may charge separately.</P>
              <Steps items={[
                <>Open <Link to="/connect-ai" className="underline">Connect your AI</Link> and choose OAIY desktop or your own API provider.</>,
                <>For OAIY, use its Getting started guide to sign in with Codex, add a provider key, or start a local model. Approve FormLogic's pairing code in OAIY.</>,
                <>For a direct API, save and test your provider in this browser. Select it as your default in the final wizard step.</>,
                <>After signing in, open your account menu and choose <C>Cloud &amp; billing</C> to reach <strong>Your plan</strong>. Payments are disabled by default; if enabled, support is optional and prepaid, with no auto-renewal.</>,
                <>Administrators can edit plan names, descriptions and prices in Admin &gt; Platform &gt; Plans. PayPal credentials alone never enable checkout. Free access continues regardless of support expiry.</>,
              ]} />
            </section>

            {/* Apps */}
            <section className="mb-14">
              <H2 id="apps" icon={Boxes}>Apps &amp; permissions</H2>
              <P>An app brings forms, screens, dashboards and members together. Open its <strong className="text-gray-900 dark:text-white">App Studio</strong> to shape the experience: manage forms and records, choose screens, configure automations, then review people and roles before sharing.</P>
              <Steps items={[
                <>Go to <C>Apps → Create app</C> and add the forms it should contain.</>,
                <>Define <strong className="text-gray-900 dark:text-white">roles</strong> and set per-form <strong className="text-gray-900 dark:text-white">permissions</strong> (submit, view own, view all, edit, delete, export).</>,
                <>Invite <strong className="text-gray-900 dark:text-white">members</strong> by email and assign roles. They sign in to the app's runtime — a clean data-table interface scoped to what they're allowed to see.</>,
                <>Use <strong className="text-gray-900 dark:text-white">linked records</strong> to relate responses across forms (e.g. an interview linked to a candidate).</>,
              ]} />

              <h3 className="scroll-mt-24 text-[15px] text-gray-700 dark:text-slate-200 font-semibold mt-8 mb-3">No-code dashboards</h3>
              <P>Use a widget dashboard as an app home or form section. Add KPIs, charts, tables and recent-record lists backed by your forms. Click <C>Edit dashboard</C> to rearrange, resize or configure widgets. For an editable app interface that opens the same tools, use <a href="#hosted-apps" className="underline">Create connected dashboard</a>.</P>

              <P>Two more ways to shape an app:</P>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Reports</strong> — build cross-form queries (bar, pie, KPI, table) and export them to PDF, with no SQL to write.</>,
                <><strong className="text-gray-900 dark:text-white">Custom screens</strong> — for total control, drop in a sandboxed HTML/CSS/JS screen (hand-written or AI-generated) as an app home or a form section — the same SDK powers public form links and embeds.</>,
              ]} />
              <Tip>Adding the same form to another app shares its records; it does not copy them. Review roles in each app. <GuideLink file="docs/ONE_BACKEND_MANY_PORTALS.md">One backend, many portals</GuideLink>.</Tip>
            </section>

            <section className="mb-14">
              <H2 id="hosted-apps" icon={Code2}>Host an editable app</H2>
              <P>Softn powers portable interfaces made from <C>.ui</C> screens and <C>.logic</C> code. FormLogic can host the interface alongside private backend actions and a separate SQLite database. The interface stays editable and downloadable.</P>
              <h3 className="text-lg font-semibold mt-6 mb-3">Use your existing forms and records</h3>
              <Steps items={[
                <>Open your app&apos;s <C>App Studio → Screens</C> and choose <C>Create connected dashboard</C>.</>,
                <>Preview the starter. It lists the app&apos;s forms and tools, reads permitted recent records and opens existing form screens.</>,
                <>Choose <C>Use as app home</C> when ready. The original home is retained so you can restore it.</>,
                <>Use <C>Download starter</C> to edit the portable client further. Existing chart widgets are not automatically converted into this starter.</>,
              ]} />
              <h3 className="text-lg font-semibold mt-6 mb-3">Build custom screens and private actions</h3>
              <Steps items={[
                <>In <C>Screens → App hosting</C>, start from the working notes project or import a client <C>.softn</C> bundle. Review the imported interface and its backend requirements.</>,
                <>Define named private actions with <C>onRequest(ctx)</C>. Set each action&apos;s access to owner or member and its database mode to read or write.</>,
                <>Call actions from the client with <C>softn.backend.call</C>. The host handles the signed-in session; the client receives no account token.</>,
                <>Publish the project and preview it. Publish the parent app and give members access separately before sharing it with them.</>,
              ]} />
              <CodeBlock title="client .logic — call a private backend action">{`let notes = [];
let message = "";

function _init() {
  softn.backend.call("listNotes", {}, function(response) {
    if (response.error) { message = response.error; return; }
    notes = response.result;
  });
}`}</CodeBlock>
              <P>Private actions use bounded <C>ctx.db.get</C>, <C>list</C>, <C>put</C> and <C>remove</C> operations inside a transaction. They do not expose arbitrary SQL or network access. A member action must check <C>ctx.user.id</C> itself when records need finer ownership rules.</P>
              <Tip><strong>Choose the right export.</strong> Download client contains public interface files. Save project copy includes private action source. Download database includes the deployment and records. Downloaded clients need a compatible authenticated FormLogic host for live records; they contain neither credentials nor an offline database.</Tip>
              <h3 className="text-lg font-semibold mt-6 mb-3">Host an existing app with its own backend</h3>
              <P>Open <C>Data &amp; forms → Records</C> for direct access to <C>Backend code</C> and <C>Database records</C>. Backend edits publish a new source version while preserving the app’s SQLite records.</P>
              <P>Use <C>Screens → Hosting &amp; app tools → Native app hosting</C> for a complete app with private <C>.logic</C> handlers and SQLite migrations. Its backend runs in ZIPP, and the Records tab shows the same database used by the app.</P>
              <Steps items={[
                <>Import the <C>.softn</C> project and review its interface, backend and migrations before installing.</>,
                <>Keep the app&apos;s own sign-in, or require FormLogic membership and configure registration in <C>Users &amp; roles</C>. Project administration remains separate from visitor accounts.</>,
                <>Choose <C>Use this app as the website home</C> to open it at the normal app address. Connected domains in direct-app mode use this entry point after publication.</>,
                <>Edit source in Screens and Backend, and browse its SQLite tables in Records. Open Visual Builder for layout changes, or AI Studio for source and AI editing, including on mobile. Studio uses your FormLogic AI settings. Review changes returns a draft; publish it when ready. Download editable project keeps a portable copy.</>,
              ]} />
              <h3 className="text-lg font-semibold mt-6 mb-3">Edit the interface and its backend</h3>
              <P><C>Screens</C> highlights interface tags, embedded client logic and styles. <C>Backend</C> highlights private <C>.logic</C> files and read-only SQL migrations. Both include line numbers, wrapping, light/dark themes and <C>Ctrl/Cmd+F</C> search. Switch files without losing your draft, then choose <C>Publish changes</C>. Existing records are preserved.</P>
              <Figure src="/images/docs/native-backend.jpg" alt="Native app hosting Backend tab with syntax-highlighted private logic and Publish changes" caption="Private backend source in the running app. Fictional Service desk project; select any screenshot to open it full size." />
              <P><C>Open Visual Builder</C> edits layouts and components. <C>Open AI Studio</C> provides source and AI tools using your FormLogic AI settings. Choose <C>Review changes</C> to bring edits back into a draft, then publish. Builder is best on a larger screen; use Studio or the source tabs on mobile. Publish and open the hosted app to test its backend; an editor preview does not run the hosted database.</P>
              <Figure src="/images/docs/native-screens.jpg" alt="Screens tab with highlighted interface markup and client logic in the same editor" caption="Interface and client logic stay together in the editable project." />
              <h3 className="text-lg font-semibold mt-6 mb-3">Run a flow when a record changes</h3>
              <P>In <C>Automations → Connect database event</C>, choose a table, a created/updated/deleted change, and a flow. For a signup flow, choose the table where the app creates verified users. The flow receives <C>record</C>, <C>table</C> and <C>operation</C> inputs. Use the trigger editor for conditions, such as checking that an account is verified.</P>
              <P>Only future committed changes on enabled flows and triggers are captured. Failed or rolled-back writes do not trigger a flow. Record previews omit common secret fields and shorten long values. Keep OAIY connected for unattended execution, or open the app’s authenticated FormLogic member runtime. Run history shows whether work is queued or completed.</P>
              <Tip>The native host is a local preview requiring a compatible server runtime and the native record recovery dispatcher for interrupted deliveries. Importing does not configure SMS delivery, photo uploads, public DNS or HTTPS, and does not publish the parent app. Downloaded projects exclude database records and server credentials.</Tip>
              <P>Local app storage, hosted app databases and existing form response databases are separate. Importing a client does not migrate its records or automatically wire local forms to backend actions. <GuideLink file="docs/HOSTED_APPS.md">Hosting API, examples, limits and backups</GuideLink> · <GuideLink file="docs/CONNECTED_APPS.md">Connected dashboard guide</GuideLink>.</P>
            </section>

            <section className="mb-14">
              <H2 id="native-records" icon={Inbox}>Manage app database records</H2>
              <P>In <C>App Studio → Data &amp; forms</C>, open a native table, or choose <C>Records → Database records</C>. The owner can manage the same SQLite database used by the hosted app. This is separate from FormLogic form responses.</P>
              <Steps items={[
                <>Choose a table. Browse 50 records per page, filter the current page, and open <C>View</C> (or <C>View details</C> on mobile).</>,
                <>Select <C>Add record</C> to create an entry. Enter required fields and leave automatic IDs and defaults to the database. <C>No value (NULL)</C> is different from empty text.</>,
                <>Choose <C>View → Edit record</C> to load full field values and save changes. Primary keys remain unchanged. If the record changed while you were editing, close the editor and refresh before trying again.</>,
                <>Inside the editor, choose <C>Delete record</C> and review the confirmation. Database relationships may also delete dependent records.</>,
              ]} />
              <Figure src="/images/docs/native-records.jpg" alt="Database Records with a table selector, Add record, page filtering and three fictional service requests" caption="Browse and maintain the app’s real SQLite records from FormLogic." />
              <Tip>Owner edits save directly to SQLite and queue connected record automations. Database constraints apply, but these controls do not call the app’s backend validation functions. Use the app itself when those business rules are required.</Tip>
              <P>List cells preview up to 400 characters. Editing loads full text up to 100 KB per field. Secret columns stay hidden; binary and generated fields remain read-only. Existing records need a complete visible primary key for editing or deletion. If creation requires private or binary fields, create the record through the app.</P>
              <div className="mx-auto max-w-sm"><Figure src="/images/docs/native-record-editor-mobile.jpg" alt="Mobile record editor with a read-only ID, editable request title, Save record and Delete record controls" caption="The same record editor at phone width. All pictured requests are fictional." /></div>
              <P><GuideLink file="docs/HOSTED_APPS.md#owner-record-api">Owner record API and database maintenance reference</GuideLink>.</P>
            </section>

            <section className="mb-14">
              <H2 id="aokie" icon={Phone}>Aokie calls &amp; appointments</H2>
              <P>The Aokie starter gives your team a front desk for calls, appointments, messages, transcript turns, follow-ups and device logs. Its portable interface uses the same permission-checked FormLogic records as the rest of your app.</P>
              <Figure src="/images/docs/aokie-front-desk.png" alt="Current Aokie front desk with Calls, Appointments, Messages, Transcripts, Follow-ups and Device logs" caption="The running Aokie app, shown with fictional call records." />
              <Steps items={[
                <>Find <strong>Aokie Receptionist</strong> in <Link to="/packs" className="underline">Starter apps</Link>, review its forms and capabilities, then install it in your account.</>,
                <>Install Aokie in OAIY, connect a supported Bluetooth dongle and pair your phone. Follow <Link to="/aokie" className="underline">the Aokie setup guide</Link> for the hardware steps.</>,
                <>Configure and test speech recognition, your language model and text-to-speech in OAIY. Link FormLogic and select the destination app in Device Setup.</>,
                <>Make a controlled test call. Check the call record and transcript in the app, then verify an appointment request reaches the Appointments view. Review it before treating it as confirmed.</>,
              ]} />
              <P>Use <strong>Open call controls</strong>, <strong>Manage appointments</strong> and <strong>Manage messages</strong> to reach the relevant tools. Outbound calls, interruption handling, SMS and missed-call callbacks depend on the configured phone, runtime and flows. Auto-answer is off by default.</P>
              <h3 className="text-lg font-semibold mt-6 mb-3">Add Aokie to an app you already use</h3>
              <Steps items={[
                <>Open the destination app&apos;s <C>App Studio → Screens → Add from another app</C> and select Aokie.</>,
                <>Share Calls and Appointments to add a <strong>Front desk</strong> view alongside your existing home. Include the other receptionist forms for transcripts, logs, messages and follow-ups.</>,
                <>Review destination roles. The forms and records are shared; automation stays in the source unless you explicitly select <C>Move automation here too</C> and approve the connector capabilities.</>,
                <>If you move automation, review Device Setup and reload open source tabs before testing the new destination.</>,
              ]} />
              <P><GuideLink file="docs/CONNECTED_APPS.md">App composition and portable front desk</GuideLink> · <GuideLink file="docs/AOKIE_OPERATIONS.md">Aokie operations</GuideLink> · <GuideLink file="docs/AOKIE_TROUBLESHOOTING.md">Call and audio troubleshooting</GuideLink>.</P>
            </section>

            {/* Packs */}
            <section className="mb-14">
              <H2 id="packs" icon={Package}>Packs &amp; templates</H2>
              <P>Packs provide starter forms, screens and workflows for a business use case. Browse <Link to="/packs" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">Starter apps</Link> without signing in, including Aokie, trades, hospitality, customer service and team operations.</P>
              <Figure src="/images/docs/starter-apps.jpg" alt="The public FormLogic starter-app catalogue" caption="The current starter-app catalogue, available before sign-in." />
              <Bullets items={[
                <>Open a pack to inspect its forms and capabilities. Use the live demo link where a seeded demo is available.</>,
                <>Sign in, complete the capability review and install it into your account. Configure roles, connections and workflows for your own use.</>,
                <>If the live marketplace is unavailable, the gallery labels its bundled preview. You can browse that catalogue, but installation requires a working server connection.</>,
                <>Built something useful? In the builder, choose <C>Publish as pack</C> to share your work with the marketplace.</>,
              ]} />

            </section>

            {/* Flows & Desktop */}
            <section className="mb-14">
              <H2 id="flows" icon={Workflow}>Automations &amp; OAIY</H2>
              <P>Open <strong>Automations</strong> to build a flow: an event starts it, nodes read or transform data, and actions write records or use an approved connector. Begin with a manual test, inspect the run history and then enable the trigger you need. Workspace flows support <C>form.submitted</C>; connector events such as Aokie calls need a flow within an app.</P>

              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Browser runs</strong> execute while the workspace is open. Check the selected execution target when testing.</>,
                <><strong className="text-gray-900 dark:text-white">OAIY background runs</strong> need OAIY running with a linked account, the relevant flow configured for that runtime and the required connector grants. Pairing the browser alone does not enable background execution.</>,
                <><strong className="text-gray-900 dark:text-white">AI and speech</strong> use the provider and services configured for the runtime. Test each service before debugging a whole conversation flow.</>,
                <><strong className="text-gray-900 dark:text-white">Aokie events</strong> feed caller lookup, appointment requests, summaries and follow-up work into FormLogic. Check the event destination and run history if calls work locally but records do not appear.</>,
              ]} />
              <P><GuideLink file="docs/FORMLOGIC_FLOWS.md">Flow nodes, bindings, execution and run history</GuideLink>.</P>
            </section>

            {/* Self-hosting */}
            <section className="mb-14">
              <H2 id="self-hosting" icon={Server}>Self-hosting</H2>
              <P>FormLogic can run on your infrastructure: PHP 8.2+, MySQL 8+, SQLite for form responses and hosted apps, and a static frontend. Use the Node version pinned in the repository to build the frontend. Native app hosting also needs a compatible Node runtime on the server, with node:sqlite, to run its ZIPP backend host. Standard form scripts and named hosted actions use their packaged sandbox launcher. Include the generated browser runtime, editors and native host modules.</P>
              <P><strong>Prepare a source checkout before running an installer.</strong> Keep <C>softn.com</C> beside <C>formlogic.com</C>, install dependencies in the Softn repository and in <C>formlogic/ui</C>, then run this from <C>formlogic/ui</C>:</P>
              <CodeBlock title="required before the frontend build or CLI installer">{`npm run build:hosted-runtime
npm run build:app-editors
node ../../scripts/prepare-native-runtime.mjs`}</CodeBlock>
              <P>Every frontend build checks for these generated assets. A fresh clone without them cannot complete <C>npm run build</C> or the CLI installer. A deployment using prepared build artifacts must include the matching hosted-runtime and app-editors directories, plus the prepared native backend modules.</P>
              <P><strong>Updates after installation:</strong> open <C>Admin → Updates</C>, choose <C>Check for updates</C>, then <C>Download and verify</C>. Review the release before selecting <C>Install</C>. FormLogic verifies the official GitHub release digest and backs up your database and code before applying it. No signing-key setup is needed for official downloads; signed ZIP uploads remain available for offline or custom releases. See the <GuideLink file="docs/UPGRADING.md">upgrade guide</GuideLink>.</P>
              <P>Then choose an assisted installer in <C>formlogic/</C>:</P>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Web wizard</strong> — serve the repo and open <C>.../formlogic/install.php</C>. It checks requirements, tests the database, writes config, and (optionally) seeds the marketplace with the ready-made app packs plus a no-signup demo.</>,
                <><strong className="text-gray-900 dark:text-white">CLI</strong> — run <C>./install.sh</C> from <C>formlogic/</C>. Same seeding; skip it with <C>SEED_DEMO=0 ./install.sh</C>.</>,
              ]} />
              <P>Use the <GuideLink file="formlogic/README.md">developer setup guide</GuideLink> for database initialization, environment variables and local servers. The CLI builds the web client. For a manual setup, run <C>npm run build</C> from <C>formlogic/ui</C> after preparing the runtime.</P>
              <P>Include the generated <C>public/hosted-runtime/</C> and <C>public/app-editors/</C> assets in deployment and follow their static-file header requirements. Back up hosted app databases separately from form exports. <GuideLink file="docs/HOSTED_APPS.md">Hosted app deployment and backups</GuideLink> · <GuideLink file="DEPLOYMENT.md">Production deployment guide</GuideLink>.</P>
              <Tip><strong className="text-gray-900 dark:text-white">One domain is all you need.</strong> The frontend calls the API at <C>/api</C> on the <strong className="text-gray-900 dark:text-white">same origin</strong> by default, so you can serve the app and its API from a single domain with no CORS setup — point your web server's <C>/api</C> at the PHP backend and serve the built UI for everything else. Only set <C>VITE_API_URL</C> (at build time) and <C>CORS_ORIGIN</C> if you deliberately put the API on a <em>separate</em> host.</Tip>
              <P>FormLogic is source-available — the full source, README, and deployment guide live on <a href="https://github.com/f2i-com/formlogic.com" target="_blank" rel="noreferrer" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">GitHub</a> (production hardening: set <C>APP_ENV=production</C>, strong secrets, HTTPS). You can self-host and modify it freely under the project's <a href="https://github.com/f2i-com/formlogic.com/blob/main/LICENSE" target="_blank" rel="noreferrer" className="text-primary-600 dark:text-primary-400 underline underline-offset-4">license</a>. If it's useful to you, a <strong className="text-gray-900 dark:text-white">star</strong> is hugely appreciated.</P>
            </section>

            {/* Security */}
            <section className="mb-10">
              <H2 id="security" icon={Shield}>Security &amp; data ownership</H2>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Sandboxed scripts</strong> — user code runs with instruction, time, memory, and call-depth limits, and no filesystem or DOM access. Optional <C>ctx.http</C> calls are brokered by the server with SSRF and DNS-pinning protection plus timeout, redirect, and response-size limits.</>,
                <><strong className="text-gray-900 dark:text-white">Server-enforced rules</strong> — validation and submission limits can't be tampered with from the browser.</>,
                <><strong className="text-gray-900 dark:text-white">Sessions</strong> — HttpOnly cookies, CSRF protection and rate limits on sensitive endpoints. Production deployments should use HTTPS and Secure cookies; local HTTP development has different cookie settings.</>,
                <><strong className="text-gray-900 dark:text-white">Hash-chained audit log</strong> and a portable per-form database — your data stays yours.</>,
              ]} />
              <div className="mt-10 rounded-2xl border border-primary-200/70 dark:border-primary-500/25 bg-primary-50/60 dark:bg-primary-500/[0.07] p-7 text-center">
                <h3 className="fl-display text-2xl text-gray-900 dark:text-white mb-2">Ready to build?</h3>
                <p className="text-gray-600 dark:text-slate-300 mb-5">Create your first form in minutes — no credit card required.</p>
                <Link to="/signup"><Button size="lg" className="bg-primary-600 hover:bg-primary-500 text-primary-foreground border-0">Get started free <ArrowRight className="h-4 w-4 ml-2" /></Button></Link>
              </div>
            </section>

            <section className="mb-14">
              <H2 id="troubleshooting" icon={LifeBuoy}>Troubleshooting &amp; deeper guides</H2>
              <div className="space-y-3">
                {[
                  { title: 'AI is connected, but generation is unavailable', body: 'Reopen Connect your AI, test the selected provider and check the default. Some specialised tools need operator-funded Site AI. An OAIY pairing and an account link serve different purposes.', file: 'docs/FREE_PLANS_AND_AI_SETUP.md', label: 'AI setup and feature coverage' },
                  { title: 'An app preview is blank or cannot load records', body: 'Confirm the app host assets were built and served correctly. Preview as the owner, then check the parent app publication status and member access. Downloaded clients need the authenticated host bridge for live data.', file: 'docs/HOSTED_APPS.md', label: 'Hosting diagnostics and deployment' },
                  { title: 'Calls work, but appointments or transcripts are missing', body: 'Check the linked FormLogic account and destination in OAIY, the app’s shared forms and the event or flow run history. Appointment requests remain requests until staff or an explicit flow confirms them.', file: 'docs/AOKIE_TROUBLESHOOTING.md', label: 'Aokie troubleshooting' },
                  { title: 'An AI client cannot see an app or use a tool', body: 'Review token expiry, app confinement and the required scopes. Publishing projects and assigning connector grants require additional scopes. Reconnect with only the extra permissions you need.', file: 'docs/MCP.md', label: 'MCP tools and permissions' },
                ].map((item) => <details key={item.title} className="group rounded-xl border border-gray-200 dark:border-slate-800 bg-gray-50/60 dark:bg-slate-900/40 p-4 sm:p-5">
                  <summary className="cursor-pointer font-semibold text-gray-900 dark:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded">{item.title}</summary>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-slate-300">{item.body}</p>
                  <p className="mt-3 text-sm"><GuideLink file={item.file}>{item.label}</GuideLink></p>
                </details>)}
              </div>
              <P><span className="block mt-6">For implementation details, examples and operator references, start with the <GuideLink file="docs/README.md">documentation index</GuideLink>. It separates current guides from historical design notes.</span></P>
            </section>

          </main>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
