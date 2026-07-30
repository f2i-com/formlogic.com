// Floating Site Chat widget (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 6 steps
// 5-7): a launcher button + chat panel mounted globally in AppShell for signed-in users.
//
// - Turns run through components/chat/chatEngine (exactly one source per turn — site/
//   desktop/custom — with typed errors rendered honestly, never a silent source hop).
// - History is client-side only (components/chat/chatStore, IndexedDB per user, §7);
//   messages page older on scroll-top via the beforeSeq cursor.
// - Desktop panel: framer-motion drag (header handle), viewport-clamped via a fixed
//   inset constraints layer; position + open/minimized state persist in uiStore.
//   Small viewports get a fixed bottom sheet instead (docked above the mobile nav).
// - Privacy badge (§7): the last turn's source (or the preference before a first turn)
//   names where content goes — Desktop is E2E, Site is hosted, Custom names the service.
// - Auto/Confirm tool-mode toggle round-trips the full preferences via
//   api.putAiPreferences and invalidates the aiDefault cache the engine reads.
// - Z-order: z-40, under the z-50 offline/maintenance banners and mobile nav (plan
//   Phase 6 step 5), matching the DesktopConnectionPopover trigger.
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { motion, useDragControls, useMotionValue } from 'framer-motion';
import {
  ArrowUpRight,
  Check,
  History,
  Loader2,
  MessageCircle,
  Minus,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  X,
  Footprints,
  ImagePlus,
  PanelRight,
  Shrink,
  XCircle,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { cn, generateId } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import {
  getAiPreferences,
  invalidateAiPreferencesCache,
  type AiPreferences,
} from '../../client-runtime/flows/aiDefault';
import {
  answerToolProposal,
  sendChatTurn,
  type ChatSource,
  type ChatToolActivity,
  type ChatToolProposal,
  type ChatTurnError,
  SUMMARY_PREFIX,
  sinceLastSummary,
  historyFor,
} from './chatEngine';
import { getChatStore, type ChatMessage, type ChatThread } from './chatStore';
import { demoChatDirector } from './demoChatDirector';
import { CHAT_IMAGES_PER_MESSAGE, downscaleChatImage } from './chatImages';
import { CODEX_PROVIDER_ID, CODEX_REASONING_EFFORTS } from '../../client-runtime/desktop/desktopTunnel';
import { chatPrivacyBadge, chatThreadTitle, chatToolLinkPath } from './siteChatView';
import { useCanDockChat } from './useChatDockOffset';

const PAGE_SIZE = 30;
/** Desktop panel dock size (w-96 x h-[34rem]) used to clamp a restored drag offset. */
const PANEL_WIDTH = 384;
const PANEL_HEIGHT = 544;

// ---------------------------------------------------------------------------
// Per-turn transient state (tool cards + notes are live-turn only; history is text).
// ---------------------------------------------------------------------------

/** How many uncompacted messages before the Compact option appears. */
const COMPACT_THRESHOLD = 25;

interface LiveTurn {
  id: string;
  threadId: string;
  streamText: string;
  activities: ChatToolActivity[];
  proposals: ChatToolProposal[];
  note: string | null;
  error: ChatTurnError | null;
  status: 'running' | 'done' | 'failed';
}

type ChatWireMessage = import('./chatEngine').ChatEngineMessage;

// ---------------------------------------------------------------------------
// Small render pieces.
// ---------------------------------------------------------------------------

function activityIcon(status: string): React.ReactNode {
  if (status === 'failed' || status === 'error') return <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" aria-hidden="true" />;
  if (status === 'done' || status === 'completed') return <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" aria-hidden="true" />;
  return <Loader2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-spin text-gray-400 dark:text-slate-500" aria-hidden="true" />;
}

function ToolActivityCard({ activity, onOpenLink }: { activity: ChatToolActivity; onOpenLink: (path: string) => void }) {
  const path = activity.link ? chatToolLinkPath(activity.link) : null;
  return (
    <div
      data-testid="chat-tool-activity"
      className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800/60"
    >
      {activityIcon(activity.status)}
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-gray-800 dark:text-slate-200" title={activity.name}>{activity.label ?? activity.name}</span>
        {activity.detail && <span className="block break-words text-gray-500 dark:text-slate-400">{activity.detail}</span>}
        {activity.error && <span className="block break-words text-red-600 dark:text-red-400">{activity.error}</span>}
      </div>
      {path && (
        <button
          type="button"
          onClick={() => onOpenLink(path)}
          className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium text-primary-600 hover:bg-primary-50 dark:text-primary-400 dark:hover:bg-primary-500/10"
        >
          Open
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ToolProposalCard({
  proposal,
  busy,
  onAnswer,
}: {
  proposal: ChatToolProposal;
  busy: boolean;
  onAnswer: (proposal: ChatToolProposal, approved: boolean) => void;
}) {
  const answered = proposal.status !== 'pending';
  return (
    <div
      data-testid="chat-tool-proposal"
      className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      {/* The question is what the assistant is about to DO — the arguments are detail,
          not the question. It used to read: run "create_app_form"? above a JSON dump. */}
      <p className="font-medium text-amber-900 dark:text-amber-200" title={proposal.tool}>
        {proposal.toolLabel ?? proposal.tool}?
      </p>
      {proposal.input !== null && proposal.input !== undefined && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-amber-800/80 dark:text-amber-200/70">Show details</summary>
          <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-white/70 p-1.5 text-[11px] text-gray-700 dark:bg-slate-900/50 dark:text-slate-300">
            {JSON.stringify(proposal.input, null, 2)}
          </pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={answered || busy}
          onClick={() => onAnswer(proposal, true)}
          className="rounded-md bg-primary-600 px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={answered || busy}
          onClick={() => onAnswer(proposal, false)}
          className="rounded-md border border-gray-300 px-2.5 py-1 font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Deny
        </button>
        {!answered && (
          <span className="text-[11px] text-amber-700 dark:text-amber-300">Auto-denied after about 120 seconds.</span>
        )}
        {proposal.status === 'approved' && <span className="text-[11px] text-emerald-700 dark:text-emerald-400">Approved.</span>}
        {proposal.status === 'denied' && <span className="text-[11px] text-gray-500 dark:text-slate-400">Denied.</span>}
        {proposal.status === 'failed' && (
          <span className="text-[11px] text-red-600 dark:text-red-400">{proposal.error ?? 'The answer could not be delivered.'}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The widget.
// ---------------------------------------------------------------------------

export function SiteChatWidget() {
  const user = useAuthStore((s) => s.user);
  const isMobile = useUIStore((s) => s.isMobile);
  const chatOpen = useUIStore((s) => s.chatOpen);
  const chatSeed = useUIStore((s) => s.chatSeed);
  const setChatSeed = useUIStore((s) => s.setChatSeed);
  const chatLaunch = useUIStore((s) => s.chatLaunch);
  const setChatLaunch = useUIStore((s) => s.setChatLaunch);
  const chatFollowAi = useUIStore((s) => s.chatFollowAi);
  const setChatFollowAi = useUIStore((s) => s.setChatFollowAi);
  // Effective docking (stored preference AND enough room) — see useChatDockOffset.
  const canDockChat = useCanDockChat();
  const chatDocked = useUIStore((s) => s.chatDocked) && canDockChat;
  const setChatDocked = useUIStore((s) => s.setChatDocked);
  const chatMinimized = useUIStore((s) => s.chatMinimized);
  const setChatOpen = useUIStore((s) => s.setChatOpen);
  const setChatMinimized = useUIStore((s) => s.setChatMinimized);
  const setChatPosition = useUIStore((s) => s.setChatPosition);
  const fixedBottomBar = useUIStore((s) => s.fixedBottomBar);
  const navigate = useNavigate();
  // §11B O5a: what the user is looking at rides each chat turn, so "this form" just
  // works — the builder's chat button counts on this.
  const location = useLocation();
  const pageContextRef = useRef<{ kind: 'form' | 'app' | 'diagram' | 'formScreen' | 'appScreen' | 'appStudio'; id: string; step?: string } | null>(null);
  useEffect(() => {
    const form =
      matchPath('/builder/:formId', location.pathname) ?? matchPath('/preview/:formId', location.pathname);
    // The screen Studios are their own context kind: "this screen" must resolve to the
    // owning form/app AND steer the AI to the screen tools (set_form_screen/set_app_home).
    const formScreen =
      matchPath('/forms/:formId/screen/edit', location.pathname) ?? matchPath('/forms/:formId/screen', location.pathname);
    const appScreen = matchPath('/apps/:appId/home/edit', location.pathname);
    // The App Studio is its own kind (before the generic app match): the AI learns
    // which wizard step the user is on and can guide them through the sections.
    const appStudioStep = matchPath('/apps/:appId/studio/:step', location.pathname);
    const appStudioRoot = matchPath('/apps/:appId/studio', location.pathname);
    const app = matchPath('/apps/:appId/*', location.pathname);
    const diagram = matchPath('/diagrams/:diagramId', location.pathname);
    pageContextRef.current = form?.params.formId
      ? { kind: 'form', id: form.params.formId }
      : formScreen?.params.formId
        ? { kind: 'formScreen', id: formScreen.params.formId }
        : appScreen?.params.appId
          ? { kind: 'appScreen', id: appScreen.params.appId }
          : appStudioStep?.params.appId
            ? { kind: 'appStudio', id: appStudioStep.params.appId, ...(appStudioStep.params.step ? { step: appStudioStep.params.step } : {}) }
            : appStudioRoot?.params.appId
              ? { kind: 'appStudio', id: appStudioRoot.params.appId }
              : diagram?.params.diagramId
              ? { kind: 'diagram', id: diagram.params.diagramId }
              : app?.params.appId
                ? { kind: 'app', id: app.params.appId }
                : null;
  }, [location.pathname]);

  const [view, setView] = useState<'chat' | 'threads'>('chat');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState('');
  // §11B O1: the Dashboard's "What do you want to create?" composer seeds the chat.
  useEffect(() => {
    if (chatOpen && chatSeed) {
      setInput(chatSeed);
      setChatSeed(null);
    }
  }, [chatOpen, chatSeed, setChatSeed]);
  const [sending, setSending] = useState(false);
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [prefs, setPrefs] = useState<AiPreferences | null>(null);
  // Codex/ChatGPT reasoning effort for THIS chat (owner direction: per-task levels).
  // Seeded from the Settings default; only offered when the resolved source is the
  // Codex/ChatGPT desktop connector. Ref-mirrored for the runTurn closure.
  const [reasoning, setReasoning] = useState('');
  const reasoningRef = useRef('');
  useEffect(() => {
    reasoningRef.current = reasoning;
  }, [reasoning]);
  const [savingToolMode, setSavingToolMode] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [lastSource, setLastSource] = useState<ChatSource | null>(null);
  const [storePersistent, setStorePersistent] = useState(true);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initializedRef = useRef(false);
  const activeThreadIdRef = useRef<string | null>(null);
  const clientSeqRef = useRef<Record<string, number>>({});
  const lastSendRef = useRef<{ threadId: string; history: ChatWireMessage[] } | null>(null);

  const dragControls = useDragControls();
  const constraintsRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const userId = user?.id ?? null;
  const isDemo = !!user?.isDemo;
  const panelVisible = chatOpen && !chatMinimized;

  // The ref mirrors activeThreadId EAGERLY (every setter below writes both): async turn
  // completions consult it before touching the transcript, and a render may not have
  // happened yet between a state update and the awaited completion.
  const setActiveThread = useCallback((threadId: string | null) => {
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
  }, []);

  // Demo guided builds: a scripted DIRECTOR replaces live AI for the shared demo account
  // (the backend is read-only for demo — /api/ai/chat would 403 anyway). It is module-
  // level so the script survives its own navigations (each full-screen route remounts
  // this widget); the widget mirrors its snapshot, re-registers the navigator on every
  // mount, and re-reads the thread whenever the director appends a message.
  const demoSnap = useSyncExternalStore(demoChatDirector.subscribe, demoChatDirector.getSnapshot);
  const demoRunning = isDemo && demoSnap.running;
  useEffect(() => {
    if (isDemo && userId) demoChatDirector.attach({ userId, navigate });
  }, [isDemo, userId, navigate]);
  useEffect(() => {
    if (!isDemo || !userId) return;
    const threadId = demoSnap.threadId;
    if (!threadId || activeThreadIdRef.current !== threadId) return;
    let cancelled = false;
    void getChatStore(userId)
      .listMessages(threadId, { limit: PAGE_SIZE })
      .then((page) => {
        if (!cancelled && activeThreadIdRef.current === threadId) {
          setMessages(page.messages);
          setHasMore(page.hasMore);
          stickToBottomRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDemo, userId, demoSnap.version, demoSnap.threadId]);

  // A pending "Clear?" confirmation is scoped to the thread and view it was asked in.
  useEffect(() => {
    setConfirmingClear(false);
  }, [activeThreadId, view]);

  // Account switches never show another user's threads: reset all transcript state.
  useEffect(() => {
    initializedRef.current = false;
    setThreads([]);
    setActiveThread(null);
    setMessages([]);
    setHasMore(false);
    setLiveTurn(null);
    setPrefs(null);
    setLastSource(null);
    setView('chat');
    clientSeqRef.current = {};
    lastSendRef.current = null;
  }, [userId, setActiveThread]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!userId) return;
      setActiveThread(threadId);
      setLiveTurn(null);
      setView('chat');
      setConfirmingDeleteId(null);
      const page = await getChatStore(userId).listMessages(threadId, { limit: PAGE_SIZE });
      // Only apply if the user hasn't switched again while the page loaded.
      if (activeThreadIdRef.current === threadId) {
        setMessages(page.messages);
        setHasMore(page.hasMore);
        stickToBottomRef.current = true;
      }
    },
    [userId, setActiveThread]
  );

  // First open: load threads (+ resume the most recent one) and the AI preferences.
  useEffect(() => {
    if (!panelVisible || !userId || initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    void (async () => {
      const store = getChatStore(userId);
      const list = await store.listThreads();
      if (cancelled) return;
      setThreads(list);
      setStorePersistent(store.persistent);
      if (list.length > 0) void selectThread(list[0].id);
    })();
    void (async () => {
      const res = await getAiPreferences();
      if (!cancelled && res.ok) {
        setPrefs(res.data);
        setReasoning(res.data.desktopReasoning ?? '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panelVisible, userId, selectThread]);

  // Restore the persisted drag offset, clamped so the panel stays on screen.
  useEffect(() => {
    if (isMobile || !panelVisible || typeof window === 'undefined') return;
    const pos = useUIStore.getState().chatPosition;
    if (!pos) return;
    const minX = -Math.max(0, window.innerWidth - PANEL_WIDTH - 24);
    const minY = -Math.max(0, window.innerHeight - PANEL_HEIGHT - 24);
    x.set(Math.min(0, Math.max(minX, pos.x)));
    y.set(Math.min(0, Math.max(minY, pos.y)));
  }, [isMobile, panelVisible, x, y]);

  // Keep the transcript pinned to the bottom while streaming (unless reading older).
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveTurn]);

  const loadOlder = useCallback(async () => {
    if (!userId || !activeThreadId || loadingOlder || !hasMore) return;
    const oldest = messages[0]?.seq;
    if (oldest === undefined) return;
    setLoadingOlder(true);
    try {
      const el = listRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      const prevTop = el?.scrollTop ?? 0;
      const page = await getChatStore(userId).listMessages(activeThreadId, { limit: PAGE_SIZE, beforeSeq: oldest });
      setMessages((prev) => [...page.messages, ...prev]);
      setHasMore(page.hasMore);
      stickToBottomRef.current = false;
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight - prevHeight + prevTop;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [userId, activeThreadId, loadingOlder, hasMore, messages]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 48 && hasMore && !loadingOlder) void loadOlder();
  }, [hasMore, loadingOlder, loadOlder]);

  // §11B O4 Follow AI: while a turn streams, a COMPLETED tool activity that links to a
  // created/updated resource navigates there — so the user watches the project
  // assemble, room by room. Ref-mirrored (the SSE callbacks close over one send), and
  // each distinct path is followed at most once per turn.
  const followAiRef = useRef(chatFollowAi);
  useEffect(() => {
    followAiRef.current = chatFollowAi;
  }, [chatFollowAi]);
  const lastFollowedRef = useRef<string | null>(null);
  const followActivity = useCallback(
    (activity: ChatToolActivity) => {
      if (!followAiRef.current || activity.status !== 'done' || !activity.link) return;
      const path = chatToolLinkPath(activity.link);
      if (!path || path === lastFollowedRef.current) return;
      lastFollowedRef.current = path;
      if (!isMobile) navigate(path);
    },
    [isMobile, navigate]
  );


  const runTurn = useCallback(
    async (threadId: string, history: ChatWireMessage[]) => {
      if (!userId) return;
      const turnId = generateId();
      lastSendRef.current = { threadId, history };
      clientSeqRef.current[threadId] = (clientSeqRef.current[threadId] ?? 0) + 1;
      setSending(true);
      stickToBottomRef.current = true;
      lastFollowedRef.current = null;
      setLiveTurn({ id: turnId, threadId, streamText: '', activities: [], proposals: [], note: null, error: null, status: 'running' });

      const patchTurn = (patch: (turn: LiveTurn) => LiveTurn) =>
        setLiveTurn((turn) => (turn && turn.id === turnId ? patch(turn) : turn));

      const outcome = await sendChatTurn({
        threadId,
        messages: history,
        pageContext: pageContextRef.current,
        isDemo,
        reasoning: reasoningRef.current || undefined,
        clientSeq: clientSeqRef.current[threadId],
        events: {
          onDelta: (_delta, accumulated) => patchTurn((turn) => ({ ...turn, streamText: accumulated })),
          onToolActivity: (activity) => {
            followActivity(activity);
            patchTurn((turn) => {
              const index = turn.activities.findIndex((a) => a.id === activity.id);
              const activities =
                index === -1 ? [...turn.activities, activity] : turn.activities.map((a, i) => (i === index ? activity : a));
              return { ...turn, activities };
            });
          },
          onToolProposal: (proposal) => patchTurn((turn) => ({ ...turn, proposals: [...turn.proposals, proposal] })),
        },
      });

      if (outcome.ok) {
        setLastSource(outcome.source);
        const assistant = await getChatStore(userId).appendMessage(threadId, 'assistant', outcome.content);
        if (activeThreadIdRef.current === threadId) setMessages((prev) => [...prev, assistant]);
        patchTurn((turn) => ({ ...turn, streamText: '', note: outcome.note ?? null, status: 'done' }));
        setThreads(await getChatStore(userId).listThreads());
      } else {
        if (outcome.source) setLastSource(outcome.source);
        patchTurn((turn) => ({ ...turn, streamText: '', error: outcome.error, status: 'failed' }));
      }
      setSending(false);
    },
    [userId, isDemo, followActivity]
  );

  // Image attachments: downscaled client-side, sent as content parts, stored on
  // the user message so history re-sends them (owner direction: "send the image
  // to the AI attached").
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const launchInFlightRef = useRef(false);
  const addAttachment = useCallback(async (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const url = await downscaleChatImage(file);
      if (!url) {
        toast.error('Could not attach that image', 'It is unreadable or too large even after downscaling.');
        continue;
      }
      setPendingImages((current) =>
        current.length >= CHAT_IMAGES_PER_MESSAGE ? current : [...current, url]
      );
    }
  }, []);

  const handleSend = useCallback(async (textOverride?: string, imageOverride?: string[]) => {
    const text = (textOverride ?? input).trim();
    const images = textOverride === undefined ? pendingImages : (imageOverride ?? []);
    if ((text === '' && images.length === 0) || sending || demoRunning || !userId) return false;
    if (textOverride === undefined) {
      setInput('');
      setPendingImages([]);
    }
    const store = getChatStore(userId);
    let threadId = activeThreadId;
    let prior = messages;
    if (!threadId) {
      const thread = await store.createThread(chatThreadTitle(text !== '' ? text : 'Image attachment'));
      threadId = thread.id;
      prior = [];
      setThreads((existing) => [thread, ...existing]);
      setActiveThread(thread.id);
      setHasMore(false);
      setStorePersistent(store.persistent);
    }
    const userMessage = await store.appendMessage(threadId, 'user', text, undefined, images);
    const next = [...prior, userMessage];
    setMessages(next);
    // Demo account: the scripted director answers (guided builds / honest steering) —
    // the live engine is never called, so no credits burn and no server write is tried.
    if (isDemo) {
      void demoChatDirector.respond(text, threadId);
      return true;
    }
    await runTurn(threadId, historyFor(next));
    return true;
  }, [input, pendingImages, sending, demoRunning, isDemo, userId, activeThreadId, messages, runTurn, setActiveThread]);

  // Dashboard launches are a one-shot submit, not just a composer seed.
  useEffect(() => {
    // Keep the launch queued while the signed-in/demo user or chat runner is still
    // initialising. The in-flight ref also prevents a render between the IndexedDB
    // append and the send completion from submitting the same launch twice.
    if (!chatOpen || !chatLaunch || sending || demoRunning || !userId || launchInFlightRef.current) return;
    const launch = chatLaunch;
    launchInFlightRef.current = true;
    void handleSend(launch.text, launch.images ?? [])
      .then((sent) => {
        if (!sent || useUIStore.getState().chatLaunch !== launch) return;
        setChatLaunch(null);
        setInput('');
        setPendingImages([]);
      })
      .finally(() => {
        launchInFlightRef.current = false;
      });
  }, [chatLaunch, chatOpen, demoRunning, handleSend, sending, setChatLaunch, userId]);

  // §11B: compact the conversation — an AI summary becomes the carried history while
  // the thread keeps every message. Offered once the uncompacted tail reaches the
  // threshold; compacting again later re-summarises from the previous summary.
  const uncompactedCount = sinceLastSummary(messages).tail.length;
  const compactConversation = useCallback(async () => {
    if (sending || !userId || !activeThreadId) return;
    setSending(true);
    try {
      const outcome = await sendChatTurn({
        threadId: activeThreadId,
        messages: [
          ...historyFor(messages),
          {
            role: 'user',
            content:
              'Summarise our conversation so far into a compact brief a future assistant can continue from: goals, decisions made, the names and ids of anything created or edited, and open threads. Reply with ONLY the summary text.',
          },
        ],
        isDemo,
        noTools: true,
        clientSeq: clientSeqRef.current[activeThreadId],
      });
      if (!outcome.ok) {
        toast.error('Could not compact the chat', outcome.error.message);
        return;
      }
      const store = getChatStore(userId);
      const marker = await store.appendMessage(activeThreadId, 'assistant', `${SUMMARY_PREFIX}\n${outcome.content.trim()}`);
      setMessages((current) => [...current, marker]);
      toast.success('Chat compacted', 'Earlier messages stay in the thread; the summary carries the context forward.');
    } finally {
      setSending(false);
    }
  }, [sending, userId, activeThreadId, messages, isDemo]);

  const retryTurn = useCallback(() => {
    const last = lastSendRef.current;
    if (!last || sending) return;
    void runTurn(last.threadId, last.history);
  }, [sending, runTurn]);

  const answerProposal = useCallback(async (proposal: ChatToolProposal, approved: boolean) => {
    const patch = (status: ChatToolProposal['status'], error?: string) =>
      setLiveTurn((turn) =>
        turn
          ? {
              ...turn,
              proposals: turn.proposals.map((p) =>
                p.callId === proposal.callId ? { ...p, status, ...(error !== undefined ? { error } : {}) } : p
              ),
            }
          : turn
      );
    patch(approved ? 'approved' : 'denied'); // disable the buttons immediately
    const res = await answerToolProposal(proposal, approved);
    if (!res.ok) patch('failed', res.error);
  }, []);

  const startNewChat = useCallback(() => {
    setActiveThread(null);
    setMessages([]);
    setHasMore(false);
    setLiveTurn(null);
    setView('chat');
    setConfirmingDeleteId(null);
  }, [setActiveThread]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!userId) return;
      await getChatStore(userId).deleteThread(threadId);
      setThreads((existing) => existing.filter((t) => t.id !== threadId));
      setConfirmingDeleteId(null);
      if (activeThreadIdRef.current === threadId) {
        setActiveThread(null);
        setMessages([]);
        setHasMore(false);
        setLiveTurn(null);
      }
    },
    [userId, setActiveThread]
  );

  /** Header "Clear conversation": two-tap confirm, then delete the active thread (view resets to a fresh chat). */
  const clearConversation = useCallback(async () => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    await deleteThread(threadId);
    setConfirmingClear(false);
  }, [deleteThread]);

  const toggleToolMode = useCallback(async () => {
    if (!prefs || savingToolMode) return;
    const next = prefs.chatToolMode === 'confirm' ? 'auto' : 'confirm';
    setSavingToolMode(true);
    try {
      // Round-trip the COMPLETE preferences: PUT /api/ai/preferences replaces the row —
      // omitting desktopReasoning here silently cleared the user's chosen Codex
      // reasoning effort on every Ask-first/Auto toggle (audit FL-21).
      const res = await api.putAiPreferences({
        aiSource: prefs.aiSource,
        desktopProviderId: prefs.desktopProviderId,
        desktopModel: prefs.desktopModel,
        customProviderId: prefs.customProviderId,
        chatToolMode: next,
        desktopReasoning: prefs.desktopReasoning ?? null,
      });
      if (res.data) {
        invalidateAiPreferencesCache(); // the engine reads the aiDefault cache — keep it honest
        setPrefs({ ...prefs, chatToolMode: res.data.chatToolMode });
      }
    } finally {
      setSavingToolMode(false);
    }
  }, [prefs, savingToolMode]);

  const openLink = useCallback(
    (path: string) => {
      if (isMobile) setChatMinimized(true);
      navigate(path);
    },
    [isMobile, navigate, setChatMinimized]
  );

  if (!user) return null;

  const badge = chatPrivacyBadge(lastSource, prefs);
  // The conversation-controls strip renders only when it would hold something: a real
  // account always has Follow-AI, while the demo only ever gets Clear.
  const hasConversationControls =
    !isDemo || (view === 'chat' && activeThreadId !== null && messages.length > 0);
  const showReasoningSelect =
    prefs?.aiSource === 'desktop' && prefs.desktopProviderId === CODEX_PROVIDER_ID && !isDemo;
  const confirmMode = prefs?.chatToolMode === 'confirm';
  const turnForThread = liveTurn && liveTurn.threadId === activeThreadId ? liveTurn : null;
  const demoChipsVisible = isDemo && view === 'chat' && !demoRunning && demoSnap.chips.length > 0;

  const onHeaderPointerDown = (event: React.PointerEvent) => {
    if (isMobile) return;
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    dragControls.start(event);
  };

  const panelBody = (
    <>
      <header
        onPointerDown={onHeaderPointerDown}
        className={cn(
          'flex items-center gap-2 border-b border-gray-200/80 px-3 py-2 dark:border-slate-700/60',
          !isMobile && 'cursor-grab touch-none select-none active:cursor-grabbing'
        )}
      >
        <MessageCircle className="h-4 w-4 flex-shrink-0 text-primary-600 dark:text-primary-400" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-white">Chat</h2>
        <button
          type="button"
          aria-label="Chat history"
          onClick={() => setView((v) => (v === 'threads' ? 'chat' : 'threads'))}
          className="flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <History className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Minimize chat"
          onClick={() => setChatMinimized(true)}
          className="flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Close chat"
          onClick={() => setChatOpen(false)}
          className="flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      {/* Conversation controls, deliberately NOT in the header. Eight controls used to
          compete for one row: on a 320px phone the row needed ~320px of fixed width and
          the Close button was clipped off the end. Splitting them also separates two
          different jobs — the header is window chrome (history, minimise, close), this
          strip is how the conversation behaves — so a first-time user is not met with a
          row of eight unexplained icons. */}
      {hasConversationControls && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200/80 px-3 py-1.5 dark:border-slate-700/60">
        {prefs && !isDemo && (
          <button
            type="button"
            aria-pressed={confirmMode}
            disabled={savingToolMode}
            onClick={() => void toggleToolMode()}
            title={
              confirmMode
                ? 'Tool actions ask for approval per action — switch to run automatically'
                : 'Tool actions run automatically — switch to ask for approval per action'
            }
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {savingToolMode ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : confirmMode ? (
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Zap className="h-3 w-3" aria-hidden="true" />
            )}
            {confirmMode ? 'Ask first' : 'Auto'}
          </button>
        )}
        {view === 'chat' && activeThreadId !== null && messages.length > 0 && (
          <button
            type="button"
            aria-label={confirmingClear ? 'Confirm clear conversation' : 'Clear conversation'}
            disabled={sending || demoRunning}
            title="Clear this conversation"
            onClick={() => {
              if (confirmingClear) void clearConversation();
              else setConfirmingClear(true);
            }}
            className={cn(
              'ml-auto flex-shrink-0 rounded-md p-1.5 disabled:opacity-50',
              confirmingClear
                ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
            )}
          >
            {confirmingClear ? (
              <span className="px-0.5 text-[11px] font-semibold">Clear?</span>
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
        {!isDemo && (
        <button
          type="button"
          aria-label={chatFollowAi ? 'Stop following the AI between pages' : 'Follow the AI to what it builds'}
          aria-pressed={chatFollowAi}
          title={chatFollowAi ? 'Following AI — click to stay on this page' : 'Follow AI to what it builds'}
          onClick={() => setChatFollowAi(!chatFollowAi)}
          className={
            chatFollowAi
              ? 'flex-shrink-0 rounded-md bg-primary-100 p-1.5 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
              : 'flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
          }
        >
          <Footprints className="h-4 w-4" aria-hidden="true" />
        </button>
        )}
        {uncompactedCount >= COMPACT_THRESHOLD && !isDemo && (
          <button
            type="button"
            aria-label="Compact the conversation"
            title="Compact: summarise earlier messages so the chat stays sharp"
            disabled={sending}
            onClick={() => void compactConversation()}
            className="flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            <Shrink className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {!isMobile && !isDemo && canDockChat && (
          <button
            type="button"
            aria-label={chatDocked ? 'Float the chat' : 'Dock the chat beside the workspace'}
            aria-pressed={chatDocked}
            title={chatDocked ? 'Float the chat' : 'Dock beside the workspace'}
            onClick={() => setChatDocked(!chatDocked)}
            className={
              chatDocked
                ? 'flex-shrink-0 rounded-md bg-primary-100 p-1.5 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300'
                : 'flex-shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
            }
          >
            <PanelRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        </div>
      )}

      {badge && (
        <div
          data-testid="chat-privacy-badge"
          className={cn(
            'border-b px-3 py-1 text-[11px]',
            badge.tone === 'private' &&
              'border-emerald-200/80 bg-emerald-50 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
            badge.tone === 'hosted' &&
              'border-gray-200/80 bg-gray-50 text-gray-500 dark:border-slate-700/60 dark:bg-slate-800/60 dark:text-slate-400',
            badge.tone === 'custom' &&
              'border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'
          )}
        >
          {badge.label}
        </div>
      )}

      {showReasoningSelect && (
        <div className="flex items-center gap-1.5 border-b border-gray-200/80 bg-gray-50 px-3 py-1 text-[11px] text-gray-500 dark:border-slate-700/60 dark:bg-slate-800/60 dark:text-slate-400">
          <span>Reasoning</span>
          <select
            aria-label="Reasoning effort for this chat"
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
            className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-700 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="">Default</option>
            {CODEX_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <span className="ml-auto text-gray-400 dark:text-slate-500">applies to new messages</span>
        </div>
      )}

      {isDemo && (
        <div className="border-b border-amber-200/80 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          Guided demo — scripted builds, no AI credits used. Changes stay on this device and reset automatically.
        </div>
      )}

      {!storePersistent && (
        <div className="border-b border-gray-200/80 bg-gray-50 px-3 py-1 text-[11px] text-gray-500 dark:border-slate-700/60 dark:bg-slate-800/60 dark:text-slate-400">
          Chat history can’t be saved in this browser — it lasts for this session only.
        </div>
      )}

      {view === 'threads' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Chat threads">
          <button
            type="button"
            onClick={startNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New chat
          </button>
          {threads.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-gray-400 dark:text-slate-500">No chats yet.</p>
          )}
          <div className="mt-1 space-y-0.5">
            {threads.map((thread) => (
              <div key={thread.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void selectThread(thread.id)}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-xs',
                    thread.id === activeThreadId
                      ? 'bg-primary-50 font-medium text-primary-700 dark:bg-primary-500/10 dark:text-primary-300'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  )}
                >
                  {thread.title}
                </button>
                <button
                  type="button"
                  aria-label={confirmingDeleteId === thread.id ? `Confirm delete ${thread.title}` : `Delete ${thread.title}`}
                  onClick={() => {
                    if (confirmingDeleteId === thread.id) void deleteThread(thread.id);
                    else setConfirmingDeleteId(thread.id);
                  }}
                  className={cn(
                    'flex-shrink-0 rounded-md p-1.5',
                    confirmingDeleteId === thread.id
                      ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                      : 'text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-red-400'
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div ref={listRef} onScroll={onListScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2" aria-label="Chat messages">
          {hasMore && (
            <p className="text-center text-[11px] text-gray-400 dark:text-slate-500">
              {loadingOlder ? 'Loading older messages…' : 'Scroll up for older messages'}
            </p>
          )}
          {messages.length === 0 && !turnForThread && (
            isDemo ? (
              <div className="px-2 py-6 text-center">
                <p className="text-sm font-medium text-gray-700 dark:text-slate-300">Watch FormLogic build it</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  Pick a guided build below — it happens live in this workspace, on this device only,
                  and you can take over at any point.
                </p>
              </div>
            ) : (
              <div className="px-2 py-6 text-center">
                <p className="text-sm font-medium text-gray-700 dark:text-slate-300">What can I help with?</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                  I can answer questions and create forms, apps and flows in your workspace.
                </p>
              </div>
            )
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm',
                message.role === 'user'
                  ? 'ml-auto rounded-br-sm bg-primary-600 text-primary-foreground'
                  : 'mr-auto rounded-bl-sm bg-gray-100 text-gray-900 dark:bg-slate-800 dark:text-slate-100'
              )}
            >
              {message.images && message.images.length > 0 && (
                <span className="mb-1 flex flex-wrap gap-1.5">
                  {message.images.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt="Attached image"
                      className="max-h-28 max-w-full rounded-lg object-contain"
                    />
                  ))}
                </span>
              )}
              {message.content}
            </div>
          ))}
          {turnForThread && (
            <>
              {turnForThread.streamText !== '' && (
                <div className="mr-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-1.5 text-sm text-gray-900 dark:bg-slate-800 dark:text-slate-100">
                  {turnForThread.streamText}
                </div>
              )}
              {turnForThread.status === 'running' && turnForThread.streamText === '' && (
                <p className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-slate-500" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Thinking…
                </p>
              )}
              {turnForThread.activities.map((activity) => (
                <ToolActivityCard key={activity.id} activity={activity} onOpenLink={openLink} />
              ))}
              {turnForThread.proposals.map((proposal) => (
                <ToolProposalCard key={proposal.callId} proposal={proposal} busy={false} onAnswer={(p, ok) => void answerProposal(p, ok)} />
              ))}
              {turnForThread.note && (
                <p data-testid="chat-turn-note" className="text-[11px] italic text-gray-400 dark:text-slate-500">
                  {turnForThread.note}
                </p>
              )}
              {turnForThread.error && (
                <div
                  data-testid="chat-turn-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                >
                  <p className="break-words">{turnForThread.error.message}</p>
                  <button
                    type="button"
                    disabled={sending}
                    onClick={retryTurn}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-100 disabled:opacity-50 dark:border-red-500/40 dark:hover:bg-red-500/20"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Retry
                  </button>
                </div>
              )}
            </>
          )}
          {isDemo && demoSnap.threadId === activeThreadId && (
            <>
              {demoSnap.activities.map((activity) => (
                <ToolActivityCard key={activity.id} activity={activity} onOpenLink={openLink} />
              ))}
              {demoSnap.typing && (
                <p className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-slate-500" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Thinking…
                </p>
              )}
            </>
          )}
        </div>
      )}

      {demoChipsVisible && (
        <div className="flex flex-wrap gap-1.5 border-t border-gray-200/80 px-2.5 pt-2 dark:border-slate-700/60">
          {demoSnap.chips.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => void handleSend(label)}
              className="rounded-full border border-primary-200 bg-primary-50 px-2.5 py-1 text-[11px] font-medium text-primary-700 hover:bg-primary-100 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/20"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-gray-200/80 px-2.5 pt-2 dark:border-slate-700/60">
          {pendingImages.map((src, i) => (
            <span key={i} className="relative inline-block">
              <img src={src} alt="Pending attachment" className="h-12 w-12 rounded-lg border border-gray-200 object-cover dark:border-slate-700" />
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => setPendingImages((current) => current.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-white hover:bg-gray-900 dark:bg-slate-600 dark:hover:bg-slate-500"
              >
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSend();
        }}
        className={cn(
          'flex items-end gap-2 p-2.5',
          pendingImages.length === 0 && !demoChipsVisible && 'border-t border-gray-200/80 dark:border-slate-700/60'
        )}
      >
        <input
          ref={attachInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void addAttachment(event.target.files);
            event.target.value = '';
          }}
        />
        {!isDemo && (
        <button
          type="button"
          aria-label="Attach an image"
          title="Attach an image (or paste one into the message box)"
          disabled={sending || pendingImages.length >= CHAT_IMAGES_PER_MESSAGE}
          onClick={() => attachInputRef.current?.click()}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
        </button>
        )}
        <textarea
          rows={2}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
            if (files.length > 0) {
              event.preventDefault();
              void addAttachment(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          aria-label="Chat message"
          placeholder={isDemo ? 'Pick a guided build below — or ask what this demo can do.' : 'Ask anything — I can create forms, apps and flows.'}
          className="max-h-28 min-h-[3.5rem] min-w-0 flex-1 resize-none rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={sending || demoRunning || (input.trim() === '' && pendingImages.length === 0)}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-600 text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending || demoRunning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
        </button>
      </form>
    </>
  );

  return (
    <>
      {!panelVisible && !fixedBottomBar && (
        <button
          type="button"
          aria-label={chatOpen ? 'Restore chat' : 'Open chat'}
          onClick={() => {
            setChatOpen(true);
            setChatMinimized(false);
          }}
          className={cn(
            'fixed z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-primary-foreground shadow-lg transition-colors hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
            isMobile
              ? 'right-4 bottom-[var(--fl-mobile-float)]'
              : 'bottom-4 right-4'
          )}
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {panelVisible && isMobile && (
        <section
          role="dialog"
          aria-label="Site chat"
          className="fixed inset-x-0 bottom-[var(--fl-mobile-nav-h)] z-40 flex h-[65dvh] max-h-[65dvh] flex-col overflow-hidden rounded-t-2xl pb-[var(--fl-mobile-fab-h)] border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        >
          {panelBody}
        </section>
      )}

      {/* §11B O5 co-creation shell: docked = a full-height right rail beside the live
          workspace (AppShell clears space for it) — chat and canvas as coordinated
          surfaces instead of an overlay. */}
      {panelVisible && !isMobile && chatDocked && (
        <div
          role="dialog"
          aria-label="Site chat"
          className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col overflow-hidden border-l border-gray-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          {panelBody}
        </div>
      )}
      {panelVisible && !isMobile && !chatDocked && (
        // The fixed inset layer is the drag-constraints boundary: framer-motion clamps
        // the panel to it, so the chat can never be dragged off screen.
        <div ref={constraintsRef} className="pointer-events-none fixed inset-3 z-40">
          <motion.div
            role="dialog"
            aria-label="Site chat"
            drag
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={constraintsRef}
            dragMomentum={false}
            dragElastic={0}
            style={{ x, y }}
            onDragEnd={() => setChatPosition({ x: x.get(), y: y.get() })}
            className="pointer-events-auto absolute bottom-0 right-0 flex h-[34rem] max-h-full w-96 min-w-0 max-w-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            {panelBody}
          </motion.div>
        </div>
      )}
    </>
  );
}
