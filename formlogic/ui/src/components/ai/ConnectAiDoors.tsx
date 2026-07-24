// The three "connect your AI" doors (§11B O2), shared by the /connect-ai wizard
// and the create-app precursor. Each door REUSES the real surface (Settings AI
// card, the Desktop download + pairing, the MCP ConnectAiModal) rather than
// duplicating it. One deliberate distinction (owner direction): MCP connects an
// EXTERNAL assistant to your workspace — it is NOT the model behind FormLogic's
// own site chat.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Cloud, Monitor, Plug } from 'lucide-react';
import { ConnectAiModal } from '../mcp/ConnectAiModal';

export function ConnectAiDoors() {
  const navigate = useNavigate();
  const [showMcp, setShowMcp] = useState(false);

  return (
    <>
      <div className="space-y-4">
        {/* Door 1: web provider */}
        <section className="rounded-2xl border border-gray-200/80 bg-white p-5 dark:border-slate-700/60 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <Cloud className="h-5 w-5 text-primary-600 dark:text-primary-300" />
            Web AI provider
            <span className="rounded bg-primary-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">Fastest setup</span>
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-slate-300">
            Connect an AI provider directly to FormLogic — an OpenAI-compatible endpoint or a
            hosted model. It works anywhere you sign in, without your computer needing to stay online.
          </p>
          <button
            type="button"
            onClick={() => navigate('/settings#ai')}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-700"
          >
            Set up in Settings <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </section>

        {/* Door 2: FormLogic Desktop */}
        <section className="rounded-2xl border border-gray-200/80 bg-white p-5 dark:border-slate-700/60 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <Monitor className="h-5 w-5 text-primary-600 dark:text-primary-300" />
            FormLogic Desktop
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-600 dark:bg-slate-800 dark:text-slate-300">Local &amp; private</span>
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-slate-300">
            Use AI and services running through your own computer — local models, linked
            subscriptions, speech tools, image generators, and other Desktop services.
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
            <li>The Desktop app must be installed, linked to your account, and online.</li>
            <li>You control exactly which services are exposed to the web app.</li>
            <li>Some services can stay entirely local to your machine.</li>
          </ul>
          <button
            type="button"
            onClick={() => navigate('/download')}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-primary-400 hover:text-primary-700 dark:border-slate-600 dark:text-slate-200 dark:hover:text-primary-300"
          >
            Get FormLogic Desktop <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </section>

        {/* Door 3: MCP */}
        <section className="rounded-2xl border border-gray-200/80 bg-white p-5 dark:border-slate-700/60 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-white">
            <Plug className="h-5 w-5 text-primary-600 dark:text-primary-300" />
            External assistant (MCP)
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-gray-600 dark:bg-slate-800 dark:text-slate-300">ChatGPT / Claude</span>
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-600 dark:text-slate-300">
            Connect ChatGPT, Claude, or another MCP client to your workspace so it can create,
            inspect, and update your projects directly from its own chat.
          </p>
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            Worth knowing: MCP is another doorway INTO your workspace — it does not become the
            model behind FormLogic&rsquo;s own site chat. The chat uses the default you pick in Settings.
          </p>
          <button
            type="button"
            onClick={() => setShowMcp(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-primary-400 hover:text-primary-700 dark:border-slate-600 dark:text-slate-200 dark:hover:text-primary-300"
          >
            Connect an external AI <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </section>
      </div>
      <ConnectAiModal isOpen={showMcp} onClose={() => setShowMcp(false)} creator />
    </>
  );
}
