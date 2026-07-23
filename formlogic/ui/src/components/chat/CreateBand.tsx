// §11B O1 — the availability-routed creation band on the Dashboard.
//
// "Start with an idea. Build it by hand, with AI, or together." Routed by AI
// AVAILABILITY, not plan: a resolvable default AI source lands on the "What do you
// want to create?" composer (submits into the site chat, pre-seeded); no usable
// source lands on the "Build your way" trio (Connect AI is recommended, never a
// tollgate — manual building stays one click away). A quiet dismiss persists per
// browser so confident users keep their compact dashboard.
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Hammer, Map as MapIcon, Plug, Sparkles, X } from 'lucide-react';
import { getAiPreferences } from '../../client-runtime/flows/aiDefault';
import { useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

const SUGGESTIONS = [
  'Create a customer enquiry form',
  'Build an approval workflow',
  'Turn my idea into an app',
  'Show me what FormLogic can do',
];

const DISMISS_KEY = 'formlogic.createBand.dismissed';

export function CreateBand() {
  const navigate = useNavigate();
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const [mode, setMode] = useState<'loading' | 'ai' | 'no-ai'>('loading');
  const [prompt, setPrompt] = useState('');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    void getAiPreferences().then(
      (res) => {
        if (!cancelled) setMode(res.ok ? 'ai' : 'no-ai');
      },
      () => {
        if (!cancelled) setMode('no-ai');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — session-only dismiss */
    }
  }, []);

  const startChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      setChatSeed(trimmed === '' ? null : trimmed);
      setChatOpen(true);
      setPrompt('');
    },
    [setChatOpen, setChatSeed],
  );

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startChat(prompt);
    }
  };

  if (dismissed || mode === 'loading') return null;

  if (mode === 'ai') {
    return (
      <div className="relative mb-8 rounded-2xl border border-primary-200/70 bg-gradient-to-br from-primary-50/80 to-white p-5 sm:p-6 dark:border-primary-500/25 dark:from-primary-500/10 dark:to-slate-900">
        <button
          type="button"
          onClick={dismiss}
          title="Browse the builders instead"
          aria-label="Dismiss the creation prompt"
          className="absolute right-3 top-3 rounded-lg p-1.5 text-gray-400 hover:bg-primary-100/60 hover:text-gray-700 dark:hover:bg-primary-500/20 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-gray-900 dark:text-white">
          <Sparkles className="h-5 w-5 text-primary-600 dark:text-primary-300" />
          What do you want to create?
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          Describe an idea, process, form, workflow, or app — FormLogic helps design it and shows every change as it happens.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={2}
            placeholder="e.g. A maintenance request system for tenants…"
            aria-label="Describe what you want to create"
            className="w-full resize-none rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={() => startChat(prompt)}
            disabled={prompt.trim() === ''}
            aria-label="Start creating with AI"
            className={cn(
              'flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-primary-600 text-primary-foreground hover:bg-primary-700',
              prompt.trim() === '' && 'cursor-not-allowed opacity-50',
            )}
          >
            <ArrowRight className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => startChat(suggestion)}
              className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:border-primary-400 hover:text-primary-600 dark:border-slate-700 dark:text-slate-400 dark:hover:text-primary-300"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative mb-8 rounded-2xl border border-gray-200/80 bg-white p-5 sm:p-6 dark:border-slate-700/60 dark:bg-slate-900">
      <button
        type="button"
        onClick={dismiss}
        title="Skip for now"
        aria-label="Skip AI setup for now"
        className="absolute right-3 top-3 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <X className="h-4 w-4" />
      </button>
      <h2 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white">Build your way</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
        Connect an AI to create with a copilot, or start manually with the visual builders.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-xl border border-primary-300 bg-primary-50/60 p-3.5 text-left hover:border-primary-400 dark:border-primary-500/40 dark:bg-primary-500/10"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <Plug className="h-4 w-4 text-primary-600 dark:text-primary-300" /> Connect your AI
            <span className="rounded bg-primary-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">Recommended</span>
          </p>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
            A web provider, FormLogic Desktop, or an external assistant through MCP.
          </p>
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-xl border border-gray-200 p-3.5 text-left hover:border-primary-300 dark:border-slate-700"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <Hammer className="h-4 w-4 text-gray-500 dark:text-slate-400" /> Build manually
          </p>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
            Start with a form, app, diagram, or flow using the visual builders below.
          </p>
        </button>
        <button
          type="button"
          onClick={() => navigate('/packs')}
          className="rounded-xl border border-gray-200 p-3.5 text-left hover:border-primary-300 dark:border-slate-700"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <MapIcon className="h-4 w-4 text-gray-500 dark:text-slate-400" /> Explore examples
          </p>
          <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-slate-400">
            See working apps and packs — how an idea becomes a project.
          </p>
        </button>
      </div>
    </div>
  );
}
