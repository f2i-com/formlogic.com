import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, ArrowLeft, Menu, X, BookOpen, Rocket, LayoutGrid, ListChecks,
  GitBranch, Palette, Code2, Share2, Inbox, Download, BarChart3, Boxes,
  Package, Server, Shield, Lightbulb, Check, Terminal, Cloud,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';

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
  { id: 'builder', title: 'The form builder', icon: LayoutGrid },
  { id: 'field-types', title: 'Field types', icon: ListChecks },
  { id: 'logic', title: 'Validation & logic', icon: GitBranch },
  { id: 'theming', title: 'Theming', icon: Palette },
  { id: 'scripts', title: 'Backend scripts', icon: Code2 },
  { id: 'publishing', title: 'Publishing & sharing', icon: Share2 },
  { id: 'responses', title: 'Viewing responses', icon: Inbox },
  { id: 'exporting', title: 'Exporting data', icon: Download },
  { id: 'analytics', title: 'Analytics', icon: BarChart3 },
  { id: 'cloud', title: 'Cloud & billing', icon: Cloud },
  { id: 'apps', title: 'Apps & permissions', icon: Boxes },
  { id: 'packs', title: 'Packs & templates', icon: Package },
  { id: 'self-hosting', title: 'Self-hosting', icon: Server },
  { id: 'security', title: 'Security', icon: Shield },
];

function H2({ id, icon: Icon, children }: { id: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <h2 id={id} className="fl-display scroll-mt-24 text-2xl sm:text-3xl text-gray-900 dark:text-white flex items-center gap-3 mb-5 mt-2">
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
    <div className="rounded-xl overflow-hidden border border-slate-700/50 bg-[#0D1017] my-5 shadow-lg shadow-black/20">
      {title && (
        <div className="h-9 bg-[#161B22] flex items-center gap-2 px-4 border-b border-slate-700/40">
          <Terminal className="h-3.5 w-3.5 text-slate-500" />
          <span className="fl-mono text-xs text-slate-500">{title}</span>
        </div>
      )}
      <pre className="fl-mono text-[12.5px] leading-[1.7] text-slate-200 p-4 sm:p-5 overflow-x-auto"><code>{children}</code></pre>
    </div>
  );
}

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="my-6">
      <div className="rounded-xl overflow-hidden border border-gray-200/80 dark:border-slate-800 shadow-xl shadow-gray-900/[0.06] dark:shadow-black/30 bg-gray-50 dark:bg-slate-900">
        <img src={src} alt={alt} loading="lazy" className="w-full block" />
      </div>
      <figcaption className="fl-mono text-xs text-gray-400 dark:text-slate-500 mt-2.5 text-center">{caption}</figcaption>
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
  ['Linked record', 'Reference a response from another form (relationships).'],
  ['Location', 'Capture latitude / longitude.'],
  ['Hidden', 'Stores a default, computed, or script-set value that respondents never see — saved with the response and shown in exports.'],
  ['Statement · Welcome · Thank you', 'Display-only content and intro / completion screens.'],
];

export function Docs() {
  useDocsChrome();
  const [mobileNav, setMobileNav] = useState(false);

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-gray-900 dark:text-slate-50 selection:bg-primary-500/20">
      {/* Top nav */}
      <nav className="fixed top-0 inset-x-0 h-16 bg-white/85 dark:bg-slate-950/80 backdrop-blur-xl border-b border-gray-100 dark:border-primary-500/10 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileNav((v) => !v)} aria-label="Toggle docs menu" className="lg:hidden p-2 -ml-2 text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer">
              {mobileNav ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <Logo size="md" />
            <span className="fl-mono hidden sm:inline text-[11px] uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 border border-primary-200/70 dark:border-primary-500/25 rounded-full px-2.5 py-0.5">Docs</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/" className="hidden sm:flex items-center gap-1.5 text-sm font-medium text-gray-500 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors">
              <ArrowLeft className="h-4 w-4" /> Home
            </Link>
            <Link to="/signup"><Button className="bg-primary-600 hover:bg-primary-500 text-primary-foreground border-0">Get started</Button></Link>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16">
        <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10">
          {/* Sidebar TOC */}
          <aside className={`${mobileNav ? 'block' : 'hidden'} lg:block lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:overflow-y-auto py-6 lg:py-8`}>
            <p className="fl-mono text-[11px] uppercase tracking-[0.2em] text-gray-400 dark:text-slate-500 mb-3 px-3">On this page</p>
            <nav className="space-y-0.5">
              {SECTIONS.map((s) => (
                <a key={s.id} href={`#${s.id}`} onClick={() => setMobileNav(false)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:text-primary-700 dark:hover:text-primary-300 hover:bg-primary-50/70 dark:hover:bg-primary-500/[0.08] transition-colors">
                  <s.icon className="h-4 w-4 shrink-0 opacity-70" />
                  {s.title}
                </a>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <main className="min-w-0 py-8 lg:py-12 max-w-3xl">
            <div className="mb-12">
              <p className="fl-mono text-xs uppercase tracking-[0.2em] text-primary-600 dark:text-primary-400 mb-4">Documentation</p>
              <h1 className="fl-display text-4xl sm:text-5xl text-gray-900 dark:text-white mb-5">How to use <span className="fl-grad">FormLogic</span></h1>
              <p className="text-lg text-gray-500 dark:text-slate-400 leading-relaxed">
                A complete, step-by-step guide — from building your first form to running server-side logic,
                viewing responses, and shipping multi-form apps. Follow it top to bottom, or jump to a section.
              </p>
            </div>

            {/* Introduction */}
            <section className="mb-14">
              <H2 id="introduction" icon={BookOpen}>Introduction</H2>
              <P>FormLogic is a form platform with a real backend. Unlike basic form builders, every submission can run a sandboxed server-side script, and each form stores its responses in its own portable database you can download anytime. The flow is simple:</P>
              <div className="flex flex-wrap items-center gap-2 my-5 fl-mono text-xs">
                <span className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">a visitor submits</span>
                <ArrowRight className="h-3.5 w-3.5 text-primary-500" />
                <span className="px-3 py-1.5 rounded-full bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-800">onSubmit(ctx) runs</span>
                <ArrowRight className="h-3.5 w-3.5 text-primary-500" />
                <span className="px-3 py-1.5 rounded-full bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/25 text-primary-700 dark:text-primary-300">data is stored</span>
              </div>
              <P>This guide assumes you're using the hosted app. If you want to run it yourself, jump to <a href="#self-hosting" className="text-primary-600 dark:text-primary-400 hover:underline">Self-hosting</a>.</P>
            </section>

            {/* Quick start */}
            <section className="mb-14">
              <H2 id="quick-start" icon={Rocket}>Quick start</H2>
              <P>Go from zero to a live form in about two minutes:</P>
              <Steps items={[
                <><strong className="text-gray-900 dark:text-white">Create an account</strong> on the <Link to="/signup" className="text-primary-600 dark:text-primary-400 hover:underline">sign-up page</Link>, then sign in. You land on your dashboard.</>,
                <><strong className="text-gray-900 dark:text-white">Click “New form”</strong> and pick a starting point — a blank form, a built-in template, or generate one from a prompt or a photo with AI.</>,
                <><strong className="text-gray-900 dark:text-white">Add fields</strong> from the palette and arrange them in the builder.</>,
                <><strong className="text-gray-900 dark:text-white">Click Publish</strong> to make it live, then share the link or embed it.</>,
                <><strong className="text-gray-900 dark:text-white">Watch responses</strong> arrive under <C>Responses</C>, and download your data anytime.</>,
              ]} />
              <Figure src="/screenshots/dashboard.png" alt="FormLogic dashboard" caption="Your dashboard — every form, its responses, and quick actions in one place." />
            </section>

            {/* Builder */}
            <section className="mb-14">
              <H2 id="builder" icon={LayoutGrid}>The form builder</H2>
              <P>The builder has three areas: the <strong className="text-gray-900 dark:text-white">field palette</strong> on the left, the <strong className="text-gray-900 dark:text-white">canvas</strong> in the middle, and a contextual <strong className="text-gray-900 dark:text-white">settings panel</strong> on the right.</P>
              <Bullets items={[
                <>Click <C>Add Field</C> (or a palette item) to add a field; drag the handle to reorder.</>,
                <>Select any field to edit it in the settings panel — its <strong className="text-gray-900 dark:text-white">Basic</strong> info (label, description, placeholder, required), <strong className="text-gray-900 dark:text-white">Validation</strong> rules, and conditional <strong className="text-gray-900 dark:text-white">Logic</strong>.</>,
                <>Use the header to open <C>Theme</C>, <C>Script</C>, <C>Preview</C>, <C>Share</C>, and <C>Publish</C>. Undo / redo is always one click away.</>,
              ]} />
              <Figure src="/screenshots/builder.png" alt="The FormLogic form builder" caption="The builder: field palette (left), canvas (centre), and the field settings panel (right)." />
            </section>

            {/* Field types */}
            <section className="mb-14">
              <H2 id="field-types" icon={ListChecks}>Field types</H2>
              <P>FormLogic ships with a field for almost any question. Every field can be marked required and most support validation.</P>
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
              <P>The <strong className="text-gray-900 dark:text-white">Logic</strong> tab lets a field appear only when earlier answers meet a condition — for example, show a “Which competitor?” field only when someone answers “Yes, I switched”. A field that's conditionally hidden is skipped during validation and submission.</P>
              <Tip>For anything beyond simple show/hide — scoring, cross-field checks, or calling another service — use a <a href="#scripts" className="text-primary-600 dark:text-primary-400 hover:underline">backend script</a>.</Tip>
            </section>

            {/* Theming */}
            <section className="mb-14">
              <H2 id="theming" icon={Palette}>Theming</H2>
              <P>Click <C>Theme</C> in the builder to match your brand. You can set:</P>
              <Bullets items={[
                <>Primary, background, and text <strong className="text-gray-900 dark:text-white">colours</strong>, plus the <strong className="text-gray-900 dark:text-white">font</strong>.</>,
                <>A <strong className="text-gray-900 dark:text-white">logo</strong> shown above the form and a full-page <strong className="text-gray-900 dark:text-white">background image</strong>.</>,
                <>Choose between <strong className="text-gray-900 dark:text-white">Focused</strong> mode (one question at a time, Typeform-style) and <strong className="text-gray-900 dark:text-white">Classic</strong> mode (all questions on one page) — or let the respondent switch.</>,
              ]} />
              <Figure src="/screenshots/form-fill.png" alt="A published form in focused mode" caption="A published form in focused mode — one question at a time, fully themed." />
            </section>

            {/* Scripts */}
            <section className="mb-14">
              <H2 id="scripts" icon={Code2}>Backend scripts (onSubmit)</H2>
              <P>This is what makes FormLogic different. Click <C>Script</C> in the builder to write an <C>onSubmit(ctx)</C> function that runs <strong className="text-gray-900 dark:text-white">on the server</strong> every time the form is submitted — to validate, score, tag, compute fields, set a status, or call an external API.</P>
              <CodeBlock title="onSubmit — lead scoring">{`function onSubmit(ctx) {
  // Read answers by field id
  let score = 0;
  if ((Number(ctx.answers.budget) || 0) >= 10000) score += 40;
  if (ctx.answers.role === "decision_maker") score += 30;

  // Store a computed field, a status, and a tag on the response
  ctx.db.setField("lead_score", score);
  ctx.db.setStatus(score >= 50 ? "qualified" : "review");
  if (score >= 50) ctx.db.addTag("hot-lead");

  // Reject a submission outright
  if (ctx.answers.email.endsWith("@spam.com")) {
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
                <><strong className="text-gray-900 dark:text-white">AI Generate</strong> — describe what you want in plain English and it writes the script, grounded in your fields.</>,
                <><strong className="text-gray-900 dark:text-white">Run Test</strong> — execute the script against sample answers without saving anything, and see the computed result.</>,
                <>An <strong className="text-gray-900 dark:text-white">API Reference</strong> tab with every function, and a <strong className="text-gray-900 dark:text-white">Form Fields</strong> tab listing your field IDs.</>,
              ]} />
              <Figure src="/screenshots/script-editor.png" alt="The backend script editor's AI Generate tab" caption="The script editor — describe the logic and AI writes it using your form's fields." />
              <Tip>Scripts run in a secure sandbox with strict limits (instruction count, wall-clock time, memory, no filesystem). <C>ctx.http</C> and <C>ctx.db</C> are <strong className="text-gray-900 dark:text-white">synchronous</strong> — call them directly, don't use <C>async</C>/<C>await</C>. A script error never blocks a submission — it's recorded and the response is still saved.</Tip>
            </section>

            {/* Publishing */}
            <section className="mb-14">
              <H2 id="publishing" icon={Share2}>Publishing &amp; sharing</H2>
              <Steps items={[
                <>Click <C>Publish</C> in the builder. Your form goes live and gets a public link.</>,
                <>Open <C>Share</C> to copy the link or grab an <strong className="text-gray-900 dark:text-white">embed</strong> snippet for your website.</>,
                <>Re-publish anytime — changes go live instantly. Set the form to “closed” or add a response quota in <C>Settings</C> when you're done collecting.</>,
              ]} />
              <Tip>Files uploaded to a <strong className="text-gray-900 dark:text-white">public standalone form</strong> can be opened by anyone with the file link. For member-only file access, collect uploads through an <strong className="text-gray-900 dark:text-white">app form</strong>, where access is gated by app membership + permissions.</Tip>
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
              <Figure src="/screenshots/responses.png" alt="The responses table" caption="The responses view — responsive columns, statuses, and one-click detail." />
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
              <Tip>Each form is backed by its own SQLite database (responses, computed fields, tags, logs). No vendor lock-in — download it and take it anywhere.</Tip>
            </section>

            {/* Analytics */}
            <section className="mb-14">
              <H2 id="analytics" icon={BarChart3}>Analytics</H2>
              <P>The analytics page shows the funnel for each form — <strong className="text-gray-900 dark:text-white">views → starts → responses</strong> — plus completion rate, average completion time, responses over time, and a per-field breakdown.</P>
              <Figure src="/screenshots/analytics.png" alt="Form analytics" caption="Built-in analytics — views, completion rate, trends, and field-level breakdowns." />
            </section>

            {/* Cloud & billing */}
            <section className="mb-14">
              <H2 id="cloud" icon={Cloud}>Cloud &amp; billing</H2>
              <P>FormLogic is free to use — self-host it or run it locally and everything works. <strong className="text-gray-900 dark:text-white">Cloud</strong> is optional managed hosting (we run it for you, with backups) billed <strong className="text-gray-900 dark:text-white">pay-as-you-go</strong>: every new account gets the <strong className="text-gray-900 dark:text-white">first 30 days of Cloud free</strong>, then $5 buys another 30 days — that's it, <strong className="text-gray-900 dark:text-white">no subscription and nothing auto-renews</strong>.</P>
              <Steps items={[
                <>Open <strong className="text-gray-900 dark:text-white">Cloud &amp; billing</strong> from the account menu (top-right).</>,
                <>Choose how many 30-day periods you want — buying several at once just stacks them onto your expiry date.</>,
                <>Pay with <strong className="text-gray-900 dark:text-white">PayPal</strong>. Your cloud access extends from the later of today or your current expiry, so time never overlaps or gets lost.</>,
                <>When it lapses, nothing is deleted — you simply drop back to the free plan until you top up again.</>,
              ]} />
              <Bullets items={[
                <>One-time PayPal payments — no card stored, no recurring charge.</>,
                <>Each payment is verified on the server before any time is credited.</>,
                <>Self-hosting? Set <C>PAYPAL_CLIENT_ID</C> / <C>PAYPAL_SECRET</C> (and optionally <C>CLOUD_PRICE_CENTS</C>) in the backend <C>.env</C> to enable purchases — leave them blank to hide billing entirely.</>,
              ]} />
            </section>

            {/* Apps */}
            <section className="mb-14">
              <H2 id="apps" icon={Boxes}>Apps &amp; permissions</H2>
              <P>An <strong className="text-gray-900 dark:text-white">App</strong> bundles several forms into a private, role-based workspace — perfect for internal tools like an HR hub or a project tracker.</P>
              <Steps items={[
                <>Go to <C>Apps → New app</C> and add the forms it should contain.</>,
                <>Define <strong className="text-gray-900 dark:text-white">roles</strong> and set per-form <strong className="text-gray-900 dark:text-white">permissions</strong> (submit, view own, view all, edit, delete, export).</>,
                <>Invite <strong className="text-gray-900 dark:text-white">members</strong> by email and assign roles. They sign in to the app's runtime — a clean data-table interface scoped to what they're allowed to see.</>,
                <>Use <strong className="text-gray-900 dark:text-white">linked records</strong> to relate responses across forms (e.g. an interview linked to a candidate).</>,
              ]} />
            </section>

            {/* Packs */}
            <section className="mb-14">
              <H2 id="packs" icon={Package}>Packs &amp; templates</H2>
              <P>Packs are ready-made bundles of forms (and apps) you can install in one click from the <Link to="/packs" className="text-primary-600 dark:text-primary-400 hover:underline">marketplace</Link> — covering HR, customer service, finance, and more.</P>
              <Bullets items={[
                <>Browse the marketplace, open a pack to preview its forms, and install it into your account.</>,
                <>Built something useful? In the builder, choose <C>Publish as pack</C> to share your form with the marketplace.</>,
              ]} />
              <Figure src="/screenshots/marketplace.png" alt="The pack marketplace" caption="The pack marketplace — install ready-made bundles or publish your own." />
            </section>

            {/* Self-hosting */}
            <section className="mb-14">
              <H2 id="self-hosting" icon={Server}>Self-hosting</H2>
              <P>FormLogic runs entirely on your own infrastructure — PHP backend, static frontend, MySQL for global data, and SQLite per form. There's no Node runtime requirement on the server (scripts run in a vendored sandbox).</P>
              <P>Two assisted installers live in <C>form-builder/</C>:</P>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Web wizard</strong> — serve the repo and open <C>.../form-builder/install.php</C>. It checks requirements, tests the database, and writes config.</>,
                <><strong className="text-gray-900 dark:text-white">CLI</strong> — run <C>./install.sh</C> from <C>form-builder/</C>.</>,
              ]} />
              <CodeBlock title="manual setup (summary)">{`# 1. Create the database
mysql -u root -p -e "CREATE DATABASE formlogic CHARACTER SET utf8mb4;"

# 2. Backend
cd form-builder/backend && composer install
cp .env.example .env        # set DB creds + a 32+ char JWT_SECRET

# 3. Frontend
cd ../ui && npm install && npm run build`}</CodeBlock>
              <P>See the project README for full details and production hardening (set <C>APP_ENV=production</C>, strong secrets, HTTPS).</P>
            </section>

            {/* Security */}
            <section className="mb-10">
              <H2 id="security" icon={Shield}>Security &amp; data ownership</H2>
              <Bullets items={[
                <><strong className="text-gray-900 dark:text-white">Sandboxed scripts</strong> — user code runs with instruction, time, memory, and call-depth limits, and no filesystem or DOM access. Optional <C>ctx.http</C> calls are brokered by the server with SSRF and DNS-pinning protection plus timeout, redirect, and response-size limits.</>,
                <><strong className="text-gray-900 dark:text-white">Server-enforced rules</strong> — validation and submission limits can't be tampered with from the browser.</>,
                <><strong className="text-gray-900 dark:text-white">Sessions</strong> — HttpOnly + Secure cookies with CSRF protection; rate limiting on sensitive endpoints.</>,
                <><strong className="text-gray-900 dark:text-white">Hash-chained audit log</strong> and a portable per-form database — your data stays yours.</>,
              ]} />
              <div className="mt-10 rounded-2xl border border-primary-200/70 dark:border-primary-500/25 bg-primary-50/60 dark:bg-primary-500/[0.07] p-7 text-center">
                <h3 className="fl-display text-2xl text-gray-900 dark:text-white mb-2">Ready to build?</h3>
                <p className="text-gray-600 dark:text-slate-300 mb-5">Create your first form in minutes — no credit card required.</p>
                <Link to="/signup"><Button size="lg" className="bg-primary-600 hover:bg-primary-500 text-primary-foreground border-0">Get started free <ArrowRight className="h-4 w-4 ml-2" /></Button></Link>
              </div>
            </section>

            <div className="border-t border-gray-200/80 dark:border-slate-900 pt-8 flex items-center justify-between fl-mono text-xs text-gray-400 dark:text-slate-500">
              <span>&copy; {new Date().getFullYear()} FormLogic</span>
              <div className="flex gap-5">
                <Link to="/" className="hover:text-gray-700 dark:hover:text-slate-300">Home</Link>
                <Link to="/privacy" className="hover:text-gray-700 dark:hover:text-slate-300">Privacy</Link>
                <Link to="/terms" className="hover:text-gray-700 dark:hover:text-slate-300">Terms</Link>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
