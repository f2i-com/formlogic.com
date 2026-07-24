// §11B O1 — the availability-routed creation band on the Dashboard.
//
// "Start with an idea. Build it by hand, with AI, or together." Routed by AI
// AVAILABILITY, not plan: a resolvable default AI source lands on the creation
// composer; no usable source lands on the "Build your way" trio. A quiet dismiss
// persists per browser so confident users keep their compact dashboard.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hammer, ImagePlus, Loader2, Map as MapIcon, Plug, Send, Sparkles, X } from 'lucide-react';
import { getAiReadiness } from '../../client-runtime/flows/aiDefault';
import { useUIStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { CHAT_IMAGES_PER_MESSAGE, downscaleChatImage } from './chatImages';

const SUGGESTIONS = [
  'Create a customer enquiry form',
  'Build an approval workflow',
  'Turn my idea into an app',
  'Show me what FormLogic can do',
];

const DISMISS_KEY = 'formlogic.createBand.dismissed';

export function CreateBand() {
  const navigate = useNavigate();
  const chatLaunch = useUIStore((s) => s.chatLaunch);
  const setChatLaunch = useUIStore((s) => s.setChatLaunch);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const [mode, setMode] = useState<'loading' | 'ai' | 'no-ai'>('loading');
  const [prompt, setPrompt] = useState('');
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const submitLockRef = useRef(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    // Source-specific readiness (audit FL-23): only offer the composer when the
    // configured default source can actually execute the first request.
    void getAiReadiness().then(
      (res) => {
        if (!cancelled) setMode(res.ready ? 'ai' : 'no-ai');
      },
      () => {
        if (!cancelled) setMode('no-ai');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!submitting || chatLaunch !== null) return;
    // The chat has consumed the launch. Return the Dashboard composer to a fresh
    // state so closing the panel never leaves it stuck on "Opening chat…".
    submitLockRef.current = false;
    setPrompt('');
    setPendingImages([]);
    setSubmitting(false);
  }, [chatLaunch, submitting]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — session-only dismiss */
    }
  }, []);

  const startChat = useCallback(
    (text: string, images = pendingImages) => {
      if (submitLockRef.current) return;
      const trimmed = text.trim();
      if (trimmed === '' && images.length === 0) return;

      // The launch object is consumed exactly once by SiteChatWidget. Locking here
      // prevents a fast second click from queueing the same opening message twice.
      submitLockRef.current = true;
      setSubmitting(true);
      // Clear the controlled composer before the external-store updates below can
      // open the chat and synchronously re-render both surfaces.
      setPrompt('');
      setPendingImages([]);
      setChatLaunch({
        text: trimmed,
        ...(images.length > 0 ? { images } : {}),
      });
      setChatOpen(true);
      setChatMinimized(false);
    },
    [pendingImages, setChatLaunch, setChatMinimized, setChatOpen],
  );

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      startChat(prompt);
    }
  };

  const addAttachments = useCallback(async (files: Iterable<File>) => {
    setAttaching(true);
    const prepared: string[] = [];
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const url = await downscaleChatImage(file);
        if (!url) {
          toast.error('Could not attach that image', 'It is unreadable or too large even after downscaling.');
          continue;
        }
        prepared.push(url);
      }
      setPendingImages((current) => [...current, ...prepared].slice(0, CHAT_IMAGES_PER_MESSAGE));
    } finally {
      setAttaching(false);
    }
  }, []);

  if (dismissed || mode === 'loading') return null;

  if (mode === 'ai') {
    const canSubmit = prompt.trim() !== '' || pendingImages.length > 0;
    return (
      <section className="relative mb-8 overflow-hidden rounded-3xl border border-primary-200/80 bg-gradient-to-br from-primary-50 via-white to-primary-50/40 p-5 shadow-sm shadow-primary-900/[0.03] sm:p-6 dark:border-primary-500/25 dark:from-primary-500/10 dark:via-slate-900 dark:to-slate-900">
        <div
          className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-primary-200/25 blur-3xl dark:bg-primary-500/10"
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={dismiss}
          title="Browse the builders instead"
          aria-label="Dismiss the creation prompt"
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-primary-100/70 hover:text-gray-700 dark:hover:bg-primary-500/20 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative">
          <div className="flex items-start gap-3 pr-8">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-primary-100 text-primary-700 ring-1 ring-inset ring-primary-200/80 dark:bg-primary-500/15 dark:text-primary-300 dark:ring-primary-500/20">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary-700 dark:text-primary-300">
                Create with AI
              </p>
              <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl dark:text-white">
                What do you want to create?
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-gray-500 dark:text-slate-400">
                Describe an idea, process, form, workflow, or app. Add a reference image if it helps — FormLogic will open the chat and start building straight away.
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-gray-200/90 bg-white/90 p-2 shadow-md shadow-gray-900/[0.04] ring-1 ring-white/80 transition focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-500/15 dark:border-slate-700 dark:bg-slate-900/80 dark:ring-white/[0.03] dark:focus-within:border-primary-500/60">
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-1 pb-2 pt-1" aria-label="Attached images">
                {pendingImages.map((src, index) => (
                  <span key={`${src.slice(-18)}-${index}`} className="relative inline-block">
                    <img
                      src={src}
                      alt={`Attached reference ${index + 1}`}
                      className="h-16 w-16 rounded-xl border border-gray-200 object-cover shadow-sm dark:border-slate-700"
                    />
                    <button
                      type="button"
                      aria-label={`Remove attached image ${index + 1}`}
                      onClick={() => setPendingImages((current) => current.filter((_, i) => i !== index))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-white shadow-sm transition hover:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              value={prompt}
              onChange={(event) => {
                // Ignore a late input event once this draft has been handed to
                // chat; otherwise an exceptionally fast click can restore the
                // just-submitted text after the composer has been cleared.
                if (!submitLockRef.current) setPrompt(event.target.value);
              }}
              onKeyDown={onComposerKeyDown}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
                if (files.length > 0) {
                  event.preventDefault();
                  void addAttachments(files);
                }
              }}
              rows={3}
              placeholder="e.g. Create a maintenance request app for tenants and property managers…"
              aria-label="Describe what you want to create"
              className="max-h-36 min-h-[5.25rem] w-full resize-none border-0 bg-transparent px-2.5 py-2 text-sm leading-relaxed text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-white dark:placeholder:text-slate-500"
            />

            <div className="flex flex-col gap-2 border-t border-gray-100 px-1 pt-2 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.06]">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) void addAttachments(event.target.files);
                    event.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => attachInputRef.current?.click()}
                  disabled={attaching || submitting || pendingImages.length >= CHAT_IMAGES_PER_MESSAGE}
                  aria-label="Attach reference image"
                  title="Attach an image or paste one into the message"
                  className="inline-flex h-9 flex-none items-center gap-2 rounded-xl px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
                >
                  {attaching
                    ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
                  {attaching ? 'Adding…' : 'Add image'}
                </button>
                <span className="hidden truncate text-[10px] text-gray-400 md:inline dark:text-slate-500">
                  Enter to send · Shift+Enter for a new line
                </span>
              </div>
              <button
                type="button"
                onClick={() => startChat(prompt)}
                disabled={!canSubmit || attaching || submitting}
                aria-label="Start creating with AI"
                className={cn(
                  'inline-flex h-10 w-full flex-none items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 text-sm font-semibold text-primary-foreground shadow-sm shadow-primary-900/10 transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 sm:w-auto dark:focus:ring-offset-slate-900',
                  (!canSubmit || attaching || submitting) && 'cursor-not-allowed opacity-50',
                )}
              >
                {submitting
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <Send className="h-4 w-4" aria-hidden="true" />}
                {submitting ? 'Opening chat…' : 'Create with AI'}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="flex-none text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">
              Try a starting point
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={submitting}
                  onClick={() => startChat(suggestion)}
                  className="rounded-full border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-white/[0.025] dark:text-slate-400 dark:hover:border-primary-500/40 dark:hover:bg-primary-500/10 dark:hover:text-primary-300"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
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
          onClick={() => navigate('/connect-ai')}
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
