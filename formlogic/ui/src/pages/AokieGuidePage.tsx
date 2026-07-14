// Public Aokie setup guide (marketing tutorial): everything needed to run the
// AI phone receptionist on your own machine — hardware requirements, the local
// model stack (with sizes), and the full install walkthrough from the desktop
// app to the first live call. Linked from the landing "Explore Aokie" CTA and
// the footer; public route /aokie (all three route tables + PUBLIC_PATHS).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bluetooth,
  Cpu,
  Download,
  HardDrive,
  Mic,
  Monitor,
  Phone,
  PhoneCall,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Usb,
  Wrench,
} from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { Logo } from '../components/ui/Logo';

const DESKTOP_RELEASES = 'https://github.com/f2i-com/formlogic.com/releases/latest';
const AOKIE_RELEASES = 'https://github.com/f2i-com/aokie.com/releases';

/* ---------- small local doc components (Docs.tsx conventions) ---------- */

function H2({ icon, children, id }: { icon: ReactNode; children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mt-14 flex items-center gap-3 text-2xl font-bold tracking-tight text-gray-900 dark:text-white scroll-mt-24">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
        {icon}
      </span>
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">{children}</p>;
}

function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] font-medium text-gray-800 dark:bg-slate-800 dark:text-slate-200">
      {children}
    </code>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-primary-200 bg-primary-50/60 px-4 py-3 text-sm leading-relaxed text-gray-700 dark:border-primary-500/25 dark:bg-primary-500/10 dark:text-slate-200">
      {children}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative pl-14">
      <span className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-primary-600 text-sm font-bold text-primary-foreground">
        {n}
      </span>
      <h3 className="pt-1 text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">{children}</div>
    </li>
  );
}

function SpecTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-700/70">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 dark:border-slate-700/70 dark:bg-slate-900">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 font-semibold text-gray-700 dark:text-slate-200">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {rows.map((cells, i) => (
            <tr key={i} className="align-top">
              {cells.map((c, j) => (
                <td key={j} className="px-4 py-2.5 text-gray-600 dark:text-slate-300">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'beta'; children: ReactNode }) {
  return (
    <span
      className={
        tone === 'ok'
          ? 'inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
          : 'inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      }
    >
      {children}
    </span>
  );
}

/* ---------- the page ---------- */

export function AokieGuidePage() {
  useDocumentTitle('Aokie — run your own AI receptionist');

  return (
    <div className="min-h-[100dvh] w-full overflow-x-clip bg-white dark:bg-slate-950">
      {/* Slim header */}
      <header className="sticky top-0 z-20 border-b border-gray-200/70 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-5">
          <Link to="/" aria-label="FormLogic home">
            <Logo size="sm" />
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium text-gray-600 dark:text-slate-300">
            <Link to="/packs/aokie-receptionist" className="hover:text-gray-900 dark:hover:text-white">Marketplace</Link>
            <Link
              to="/download"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-primary-foreground hover:bg-primary-700"
            >
              <Download className="h-3.5 w-3.5" /> Get Desktop
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-gray-200/70 bg-gradient-to-b from-primary-50/60 to-white dark:border-slate-800 dark:from-slate-900 dark:to-slate-950">
        <div className="mx-auto max-w-3xl px-5 py-14">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-400">
            Aokie · AI Receptionist
            <span className="ml-2 inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold tracking-normal text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
              Hardware beta
            </span>
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
            Run your own AI phone receptionist — on your own machine.
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">
            Aokie turns a Windows PC, a USB Bluetooth dongle and the phone you already own into a
            local AI receptionist: it answers calls, talks to callers, captures appointment
            requests and files every call, transcript and request into your FormLogic app.
            Speech recognition, the language model and the voice run{' '}
            <strong>locally on your hardware by default</strong> — no per-minute fees, and with
            the standard local models your call audio stays on your machine. (If you point Aokie
            at a remote AI or speech endpoint, that provider receives the audio or transcripts it
            needs.)
          </p>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-gray-500 dark:text-slate-400">
            Aokie is in <strong>hardware beta</strong>: it needs Windows 10/11, a supported USB
            Bluetooth dongle and a GPU for comfortable local AI — see{' '}
            <a href="#requirements" className="underline hover:no-underline">what you need</a> below.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/download"
              className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5"
            >
              <Monitor className="h-4 w-4" /> Download FormLogic Desktop
            </Link>
            <Link
              to="/packs/aokie-receptionist"
              className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-5 py-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-900"
            >
              <Sparkles className="h-4 w-4" /> See the Receptionist app
            </Link>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-5 pb-24">
        {/* How it works */}
        <H2 icon={<PhoneCall size={18} />} id="how-it-works">How it works</H2>
        <P>
          Your mobile phone pairs to the PC over Bluetooth, exactly like it would to a car&apos;s
          hands-free kit. When a call comes in, Aokie answers it through the dongle and runs the
          whole conversation locally:
        </P>
        <ol className="mt-4 space-y-2 text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">
          <li className="flex gap-3"><Phone className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" /> The caller&apos;s voice arrives over the Bluetooth hands-free link (HFP).</li>
          <li className="flex gap-3"><Mic className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" /> A local speech-recognition model (Parakeet) turns it into text in real time.</li>
          <li className="flex gap-3"><Cpu className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" /> A local language model decides what to say — using the business name, services and instructions from the Receptionist Settings you control.</li>
          <li className="flex gap-3"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" /> A local text-to-speech voice (pocket-tts) speaks the reply to the caller — who can interrupt it naturally (barge-in).</li>
          <li className="flex gap-3"><HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" /> FormLogic flows file the call: caller, transcript, summary, appointment requests and follow-up tasks land as records in your app — your team confirms bookings from there.</li>
        </ol>

        {/* Requirements */}
        <H2 icon={<Cpu size={18} />} id="requirements">What you need</H2>
        <SpecTable
          head={['Component', 'Requirement']}
          rows={[
            [<strong key="pc">PC</strong>, <>Windows 10 or 11, 64-bit. 16&nbsp;GB RAM recommended.</>],
            [
              <strong key="gpu">GPU</strong>,
              <>
                Around <strong>8&nbsp;GB of VRAM</strong> comfortably runs the default model (Gemma&nbsp;4 E4B).
                6&nbsp;GB cards can use the lighter E2B variant, and smaller quantised models (Qwen&nbsp;3.5&nbsp;4B,
                MiniCPM5&nbsp;1B) run through the bundled <C>llama-server</C> on modest hardware.
              </>,
            ],
            [<strong key="disk">Disk</strong>, <>Roughly 4–8&nbsp;GB free for the models (see the table below).</>],
            [
              <strong key="dongle">Bluetooth dongle</strong>,
              <>A supported USB Bluetooth adapter — Aokie drives the radio directly, so the chipset matters (list below).</>,
            ],
            [
              <strong key="phone">Phone</strong>,
              <>Any mainstream Android or iOS handset with your business SIM. Calls use HFP, SMS uses MAP, contacts use PBAP.</>,
            ],
            [<strong key="fl">FormLogic</strong>, <>A FormLogic account (cloud or self-hosted) for the Receptionist app, records and dashboards.</>],
          ]}
        />

        <h3 className="mt-8 text-lg font-semibold text-gray-900 dark:text-white">Supported Bluetooth dongles</h3>
        <P>
          Aokie takes the dongle over with the WinUSB driver and speaks to the radio directly —
          that&apos;s what makes reliable call audio possible, but it means only known-good chipsets
          are supported:
        </P>
        <SpecTable
          head={['Chipset', 'USB id', 'Support']}
          rows={[
            ['Broadcom BCM20702', <C key="a">0a5c:21e8</C>, <Badge key="b" tone="ok">Certified</Badge>],
            ['Broadcom BCM20702 (variant)', <C key="a">0a5c:21ec</C>, <Badge key="b" tone="ok">Certified</Badge>],
            ['Realtek RTL8761', <C key="a">0bda:8771</C>, <Badge key="b" tone="beta">Beta</Badge>],
            ['Realtek RTL8821CE', <C key="a">0bda:c822</C>, <Badge key="b" tone="beta">Beta</Badge>],
            ['CSR CSR8510 A10', <C key="a">0a12:0001</C>, <Badge key="b" tone="beta">Beta</Badge>],
          ]}
        />
        <P>
          <em>Certified</em> means the full answer / hear / speak / SMS path is verified.
          <em> Beta</em> chipsets enumerate and pair, but call audio can vary by revision.
        </P>

        <h3 className="mt-8 text-lg font-semibold text-gray-900 dark:text-white">The models (and their sizes)</h3>
        <P>
          Everything is downloaded once from Hugging Face and cached locally. FormLogic Desktop
          fetches them for you on first run (or from its <strong>Models</strong> page) — you never
          need to download files by hand, but here is what lands on disk:
        </P>
        <SpecTable
          head={['Role', 'Model', 'Approx. size', 'Notes']}
          rows={[
            [
              'Language model (default)',
              <>Gemma 4 E4B <span className="text-gray-400 dark:text-slate-500">(onnx-community/gemma-4-E4B-it-ONNX)</span></>,
              '≈ 4 GB',
              'Fits comfortably in 8 GB VRAM with room for context.',
            ],
            [
              'Language model (small)',
              <>Gemma 4 E2B / Qwen 3.5 4B <span className="text-gray-400 dark:text-slate-500">(unsloth/Qwen3.5-4B-GGUF)</span> / MiniCPM5 1B</>,
              '≈ 1–2.5 GB',
              'For 6 GB cards or CPU-heavy setups, via the bundled llama-server.',
            ],
            [
              'Speech-to-text',
              <>Parakeet-Unified-EN 0.6B <span className="text-gray-400 dark:text-slate-500">(eschmidbauer/parakeet-unified-en-0.6b-onnx)</span></>,
              '≈ 700 MB',
              'Real-time transcription with streaming partials.',
            ],
            [
              'Text-to-speech',
              <>pocket-tts <span className="text-gray-400 dark:text-slate-500">(KevinAHM/pocket-tts-onnx)</span></>,
              '≈ a few hundred MB',
              'Multiple voices (Alba, Cosette, Jean, …) — pick one in settings.',
            ],
          ]}
        />

        {/* Setup steps */}
        <H2 icon={<Wrench size={18} />} id="setup">Set it up, step by step</H2>
        <ol className="mt-6 space-y-10">
          <Step n={1} title="Install FormLogic Desktop">
            <p>
              Grab the Windows installer from the <Link className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-400" to="/download">download page</Link>{' '}
              (or the <a className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-400" href={DESKTOP_RELEASES} target="_blank" rel="noreferrer">latest GitHub release</a>, with SHA-256 checksums) and run it.
              Desktop lives in your system tray and supervises everything local: models, services,
              plugins and the flow runtime.
            </p>
            <p className="text-[13px] text-gray-500 dark:text-slate-400">
              During the beta the release downloads require beta access — if a release link asks you
              to sign in to GitHub, email{' '}
              <a className="underline hover:no-underline" href="mailto:hello@formlogic.com">hello@formlogic.com</a>{' '}
              for an invite.
            </p>
          </Step>

          <Step n={2} title="Install the Aokie plugin">
            <p>
              In Desktop open <strong>Plugins</strong> and click <strong>Install Aokie plugin</strong> —
              Aokie is bundled as a built-in plugin template, and like any plugin it can be stopped or
              removed again at any time. If the plugin card reports its binary isn&apos;t installed
              yet, download the plugin bundle from the{' '}
              <a className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-400" href={AOKIE_RELEASES} target="_blank" rel="noreferrer">Aokie releases page</a>{' '}
              and drop its files (<C>aokie-plugin.exe</C>, <C>aokie-driver-helper.exe</C>, the ONNX runtime DLL)
              into the plugin folder — the Plugins page has an <em>open</em> button that takes you straight there.
            </p>
          </Step>

          <Step n={3} title="Let it download the models">
            <p>
              On first start Aokie fetches its speech and voice models from Hugging Face into your
              local models folder, and Desktop&apos;s <strong>Models</strong> page shows download
              progress and disk usage. Two local services run alongside the plugin and start
              automatically from <strong>Services</strong>:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li><C>aokie-voice</C> — the speech service (Parakeet STT + pocket-tts TTS).</li>
              <li><C>llama-cpp</C> — the language model server (when using a GGUF model). It answers <C>503</C> while the model loads and is ready about 30 seconds later.</li>
            </ul>
          </Step>

          <Step n={4} title="Plug in the dongle and install the WinUSB driver">
            <p>
              Plug the USB Bluetooth dongle in, then open the Aokie plugin&apos;s{' '}
              <strong>Dongle setup</strong> wizard (Plugins → Aokie, or the AI Receptionist
              workspace). It walks you through three steps:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li><strong>Choose the dongle</strong> — it scans your USB devices and shows which ones are supported.</li>
              <li><strong>Install the driver</strong> — Windows shows one elevation (UAC) prompt; answer <em>Yes</em>. Only that exact device is rebound to WinUSB.</li>
              <li><strong>Verify</strong> — the wizard confirms the dongle re-appeared, bound and ready.</li>
            </ul>
            <p>
              You can hand the dongle back to Windows at any time with the wizard&apos;s{' '}
              <em>Restore Windows driver</em> option.
            </p>
          </Step>

          <Step n={5} title="Pair your phone">
            <p>
              In the Aokie card&apos;s <strong>Bluetooth pairing</strong> section press{' '}
              <strong>Pair a phone</strong> — this makes the PC discoverable as{' '}
              <em>&quot;Aokie AI Assistant&quot;</em> for five minutes. On your phone open
              Bluetooth → pair new device → tap <em>Aokie AI Assistant</em>. Once bonded, the phone
              reconnects automatically whenever both are on.
            </p>
            <Tip>
              For security the PC is <strong>only discoverable while a pairing window is open</strong>.
              If your phone can&apos;t see it, start (or restart) the pairing window — and if the
              phone paired to an older Aokie setup before, <em>forget</em> that entry on the phone
              first, then pair fresh.
            </Tip>
          </Step>

          <Step n={6} title="Import the Receptionist app and link Desktop">
            <p>
              In FormLogic, install <Link className="font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-400" to="/packs/aokie-receptionist">Aokie Receptionist</Link>{' '}
              from the marketplace — it ships the whole business side ready-made: Calls, Customers,
              Appointments, Transcript Turns, SMS, a front-desk console and the flows that connect
              them to the phone. Then link Desktop to your account:{' '}
              <strong>Connections → Link FormLogic Cloud</strong> (a one-click OAuth approval).
              From now on the desktop runs the app&apos;s flows headlessly — calls create records
              even with the browser closed.
            </p>
          </Step>

          <Step n={7} title="Make a test call, then make it yours">
            <p>
              Call your own number. Aokie answers, greets, and handles the conversation — try
              interrupting it mid-sentence; barge-in is on by default. Afterwards, check the app:
              the call, transcript and summary are already filed.
            </p>
            <p>
              To customise the receptionist, add a record to <strong>Receptionist Settings</strong>{' '}
              inside the app: your business name, what you offer, booking instructions
              (e.g. <em>&quot;Ask the caller&apos;s name and what service they need, then offer Mon–Fri 9–5&quot;</em>),
              the greeting and the voice. The next call uses it — no restarts.
            </p>
          </Step>
        </ol>

        {/* Troubleshooting */}
        <H2 icon={<Wrench size={18} />} id="troubleshooting">If something doesn&apos;t work</H2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-gray-600 dark:text-slate-300">
          <li>
            <strong>The phone can&apos;t find &quot;Aokie AI Assistant&quot;.</strong> The pairing
            window has expired (it&apos;s discoverable only while open) — press <em>Pair a phone</em>{' '}
            again. Re-pairing an old handset? Forget the previous entry on the phone first.
          </li>
          <li>
            <strong>The first reply takes a while after startup.</strong> The language model loads
            for ~30 seconds after Desktop starts (<C>llama-cpp</C> answers 503 meanwhile). Give it a
            moment, then call again.
          </li>
          <li>
            <strong>Call connects but there&apos;s no audio.</strong> Check the Hardware Events feed
            in the app&apos;s Device Setup screen — an <C>sco_unarmed</C> event means the audio
            channel didn&apos;t arm; replugging the dongle or switching the codec setting
            (<C>hfpCodec</C>: auto / CVSD / mSBC) usually resolves it.
          </li>
          <li>
            <strong>Want your normal Bluetooth back?</strong> The Dongle setup wizard&apos;s{' '}
            <em>Restore Windows driver</em> returns the dongle to the standard Windows stack.
          </li>
        </ul>

        {/* Privacy */}
        <H2 icon={<ShieldCheck size={18} />} id="privacy">Private by construction</H2>
        <P>
          Transcription, the language model and speech synthesis all run on your machine — call
          audio is processed locally and records live in your FormLogic app under your retention
          settings. One thing that stays your responsibility: rules about call recording and
          AI-disclosure vary by country and state, so set the greeting and behaviour to match your
          local requirements.
        </P>

        {/* Final CTA */}
        <div className="mt-14 rounded-2xl bg-primary-600 px-6 py-8 text-primary-foreground sm:px-8">
          <h2 className="text-2xl font-bold tracking-tight">Ready to give your phone a front desk?</h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed opacity-90">
            Install FormLogic Desktop, add the Aokie plugin, pair your phone — and your calls start
            answering themselves.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              to="/download"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-primary-700 hover:bg-primary-50"
            >
              <Download className="h-4 w-4" /> Get FormLogic Desktop
            </Link>
            <Link
              to="/packs/aokie-receptionist"
              className="inline-flex items-center gap-2 rounded-xl border border-white/40 px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-white/10"
            >
              Explore the Receptionist app <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        {/* Hardware footnote */}
        <p className="mt-8 flex items-start gap-2 text-xs leading-relaxed text-gray-400 dark:text-slate-500">
          <Usb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Aokie needs FormLogic Desktop on Windows and a supported Bluetooth dongle.{' '}
            <Bluetooth className="inline h-3 w-3" /> Your phone keeps working normally — Aokie is
            just another hands-free device to it. <Smartphone className="inline h-3 w-3" />
          </span>
        </p>
      </main>
    </div>
  );
}
