// @vitest-environment jsdom
// Site Chat widget (plan Phase 6 steps 5-7): launcher/panel mounting, the send path
// (store append + streamed reply), tool activity + confirm-mode proposal cards with the
// approve wiring, deep links, the demo banner, typed-error rendering, and the privacy
// badge. The chat LOGIC burden lives in chatEngine.test.ts / chatStore.test.ts — these
// tests keep to the widget's wiring.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteChatWidget } from './SiteChatWidget';
import { chatPrivacyBadge, chatThreadTitle, chatToolLinkPath } from './siteChatView';
import { __resetChatStoresForTests, __setChatStoreIndexedDbForTests, getChatStore } from './chatStore';
import type { ChatTurnOutcome, SendChatTurnOptions } from './chatEngine';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { useToastStore } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';
import { logger } from '../../lib/logger';

const h = vi.hoisted(() => ({
  sendChatTurn: vi.fn(),
  answerToolProposal: vi.fn(),
  getAiPreferences: vi.fn(),
  downscaleChatImage: vi.fn(),
  demoAttach: vi.fn(),
  demoRespond: vi.fn(),
  lastLocation: '',
}));

vi.mock('./chatEngine', async () => {
  const actual = await vi.importActual<typeof import('./chatEngine')>('./chatEngine');
  return { ...actual, sendChatTurn: h.sendChatTurn, answerToolProposal: h.answerToolProposal };
});

// jsdom has no canvas to downscale on; the rest of chatImages is what these tests are after.
vi.mock('./chatImages', async () => {
  const actual = await vi.importActual<typeof import('./chatImages')>('./chatImages');
  return { ...actual, downscaleChatImage: h.downscaleChatImage };
});

// The scripted demo director is its own unit (demoChatDirector.test.ts) — here it is a
// deterministic fake so the widget tests pin only the WIRING (chips render, sends route
// to the director instead of the live engine).
vi.mock('./demoChatDirector', () => {
  const snapshot = {
    running: false,
    typing: false,
    threadId: null,
    activities: [],
    chips: ['Chip one', 'Chip two'],
    version: 0,
  };
  return {
    demoChatDirector: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      attach: h.demoAttach,
      respond: h.demoRespond,
      stop: () => undefined,
    },
  };
});

vi.mock('../../client-runtime/flows/aiDefault', () => ({
  getAiPreferences: h.getAiPreferences,
}));

// framer-motion is drag/animation plumbing the widget test doesn't exercise — render
// motion.* as plain elements so jsdom stays out of the gesture/rAF business.
vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const stripped = new Set([
    'drag',
    'dragListener',
    'dragControls',
    'dragConstraints',
    'dragMomentum',
    'dragElastic',
    'onDragEnd',
    'style',
  ]);
  return {
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
            const domProps: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!stripped.has(key)) domProps[key] = value;
            }
            return ReactModule.createElement(tag, domProps, children);
          },
      }
    ),
    useMotionValue: (initial: number) => ({ get: () => initial, set: () => undefined }),
    useDragControls: () => ({ start: () => undefined }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS = {
  aiSource: 'site' as const,
  desktopProviderId: null,
  desktopModel: null,
  customProviderId: null,
  chatToolMode: 'auto' as const,
};

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const loc = useLocation();
  React.useEffect(() => {
    h.lastLocation = loc.pathname + loc.search;
  }, [loc.pathname, loc.search]);
  return null;
}

async function renderWidget(initialPath = '/') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationProbe />
        <SiteChatWidget />
      </MemoryRouter>
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function launcher(): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Open chat"], button[aria-label="Restore chat"]');
}

function panel(): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

async function openPanel() {
  await act(async () => {
    launcher()!.click();
  });
  await flush();
}

async function send(text: string) {
  const textarea = panel()!.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    panel()!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  h.lastLocation = '';
  __resetChatStoresForTests();
  __setChatStoreIndexedDbForTests(null); // memory-backed history for every test
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' }, isLoading: false, isInitialized: true, error: null });
  useUIStore.setState({
    isMobile: false,
    chatOpen: false,
    chatMinimized: false,
    chatPosition: null,
    chatSeed: null,
    chatLaunch: null,
  });
  h.getAiPreferences.mockResolvedValue({ ok: true, data: { ...PREFS } });
  h.answerToolProposal.mockResolvedValue({ ok: true });
  h.sendChatTurn.mockImplementation(async (opts: SendChatTurnOptions): Promise<ChatTurnOutcome> => {
    opts.events?.onDelta?.('Hi', 'Hi');
    opts.events?.onDelta?.(' there', 'Hi there');
    return { ok: true, source: 'site', content: 'Hi there' };
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  document.body.innerHTML = '';
  useAuthStore.setState({ user: null, isLoading: false, isInitialized: true, error: null });
  __resetChatStoresForTests();
  vi.restoreAllMocks();
});

describe('pure helpers', () => {
  it('maps tool links onto real router paths (response honestly unresolvable)', () => {
    expect(chatToolLinkPath({ kind: 'form', id: 'f1' })).toBe('/builder/f1');
    // App links land in the App Studio; a step rides along when the tool's
    // effect belongs to one (Follow-AI walks the wizard), invalid steps drop.
    expect(chatToolLinkPath({ kind: 'app', id: 'a1' })).toBe('/apps/a1/studio');
    expect(chatToolLinkPath({ kind: 'app', id: 'a1', step: 'data' })).toBe('/apps/a1/studio/data');
    expect(chatToolLinkPath({ kind: 'app', id: 'a1', step: 'bogus' })).toBe('/apps/a1/studio');
    expect(chatToolLinkPath({ kind: 'flow', id: 'fl1' })).toBe('/flows?flow=fl1');
    expect(chatToolLinkPath({ kind: 'formScreen', id: 'f1' })).toBe('/forms/f1/screen/edit');
    expect(chatToolLinkPath({ kind: 'appScreen', id: 'a1' })).toBe('/apps/a1/home/edit');
    expect(chatToolLinkPath({ kind: 'response', id: 'r1' })).toBeNull();
  });

  it('badges each source per §7 and titles threads from the opener', () => {
    expect(chatPrivacyBadge('desktop', null)?.label).toContain('end-to-end encrypted');
    expect(chatPrivacyBadge(null, { ...PREFS })?.label).toContain('FormLogic Cloud');
    expect(chatPrivacyBadge('custom', { ...PREFS, customProviderId: 'my-llm' })?.label).toContain('my-llm');
    expect(chatPrivacyBadge(null, null)).toBeNull();
    expect(chatThreadTitle('  hello\n world  ')).toBe('hello world');
    expect(chatThreadTitle('x'.repeat(60))).toHaveLength(48);
    expect(chatThreadTitle('   ')).toBe('New chat');
  });
});

describe('mounting', () => {
  it('renders nothing when signed out', async () => {
    useAuthStore.setState({ user: null, isLoading: false, isInitialized: true, error: null });
    await renderWidget();
    expect(container.innerHTML).toBe('');
  });

  it('shows the launcher and opens the panel with the privacy badge from preferences', async () => {
    await renderWidget();
    expect(launcher()).not.toBeNull();
    expect(panel()).toBeNull();

    await openPanel();

    expect(panel()).not.toBeNull();
    expect(launcher()).toBeNull(); // the launcher yields to the open panel
    expect(h.getAiPreferences).toHaveBeenCalledTimes(1);
    expect(panel()!.querySelector('[data-testid="chat-privacy-badge"]')!.textContent).toContain('Hosted — processed by FormLogic Cloud');
  });

  // The App Studio owns the bottom edge of a phone screen, so the floating
  // launcher stands down there — chat is reached from the studio's own controls.
  it('yields the floating launcher inside the App Studio on a phone', async () => {
    useUIStore.setState({ isMobile: true });
    await renderWidget('/apps/a1/studio/data');
    expect(launcher()).toBeNull();
  });

  it('keeps the launcher in the studio on desktop, where nothing collides', async () => {
    useUIStore.setState({ isMobile: false });
    await renderWidget('/apps/a1/studio/data');
    expect(launcher()).not.toBeNull();
  });

  it('minimize brings the launcher back; close resets open state', async () => {
    await renderWidget();
    await openPanel();

    await act(async () => {
      (panel()!.querySelector('button[aria-label="Minimize chat"]') as HTMLButtonElement).click();
    });
    expect(panel()).toBeNull();
    expect(useUIStore.getState().chatMinimized).toBe(true);
    expect(useUIStore.getState().chatOpen).toBe(true);
    expect(launcher()!.getAttribute('aria-label')).toBe('Restore chat');

    await openPanel();
    await act(async () => {
      (panel()!.querySelector('button[aria-label="Close chat"]') as HTMLButtonElement).click();
    });
    expect(useUIStore.getState().chatOpen).toBe(false);
  });
});

describe('send path', () => {
  it('keeps the reply on screen and leaves Send usable when the reply cannot be saved', async () => {
    const store = getChatStore('u1');
    const append = store.appendMessage.bind(store);
    vi.spyOn(store, 'appendMessage').mockImplementation(async (threadId, role, ...rest) => {
      if (role === 'assistant') throw new Error('disk full');
      return append(threadId, role, ...rest);
    });
    await renderWidget();
    await openPanel();

    await send('first');
    expect(panel()!.textContent).toContain('Hi there');
    await send('second');

    expect(h.sendChatTurn).toHaveBeenCalledTimes(2);
  });

  it('tells the person when history moved to memory during the session', async () => {
    const persistent = vi.spyOn(getChatStore('u1'), 'persistent', 'get').mockReturnValue(true);
    await renderWidget();
    await openPanel();
    await send('first');
    expect(panel()!.textContent).not.toContain('lasts for this session only');

    persistent.mockReturnValue(false);
    await send('second');

    expect(panel()!.textContent).toContain('lasts for this session only');
  });

  it('keeps a Dashboard launch queued until the chat user is ready', async () => {
    useAuthStore.setState({ user: null, isLoading: true, isInitialized: false, error: null });
    useUIStore.setState({
      chatOpen: true,
      chatLaunch: { text: 'Build after sign-in' },
    });

    await renderWidget();
    await flush();

    expect(h.sendChatTurn).not.toHaveBeenCalled();
    expect(useUIStore.getState().chatLaunch).toEqual({ text: 'Build after sign-in' });

    await act(async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'u1@example.com' },
        isLoading: false,
        isInitialized: true,
        error: null,
      });
    });
    await flush();

    expect(h.sendChatTurn).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().chatLaunch).toBeNull();
  });

  it('consumes a Dashboard launch once and immediately submits its text and image', async () => {
    const image = 'data:image/jpeg;base64,REF';
    useUIStore.setState({
      chatOpen: true,
      chatLaunch: { text: 'Build this layout', images: [image] },
    });

    await renderWidget();
    await flush();

    expect(panel()).not.toBeNull();
    expect(h.sendChatTurn).toHaveBeenCalledTimes(1);
    expect((h.sendChatTurn.mock.calls[0][0] as SendChatTurnOptions).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Build this layout' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ]);
    expect(useUIStore.getState().chatLaunch).toBeNull();

    const store = getChatStore('u1');
    const threads = await store.listThreads();
    const { messages } = await store.listMessages(threads[0].id);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Build this layout',
      images: [image],
    });
  });

  it('appends the user message + streamed assistant reply to the store and transcript', async () => {
    await renderWidget();
    await openPanel();
    await send('make me a contact form');

    expect(h.sendChatTurn).toHaveBeenCalledTimes(1);
    const opts = h.sendChatTurn.mock.calls[0][0] as SendChatTurnOptions;
    expect(opts.isDemo).toBe(false);
    expect(opts.messages).toEqual([{ role: 'user', content: 'make me a contact form' }]);
    expect(typeof opts.threadId).toBe('string');

    // Both turns landed in the per-user store, in order.
    const store = getChatStore('u1');
    const threads = await store.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('make me a contact form');
    const { messages } = await store.listMessages(threads[0].id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'make me a contact form'],
      ['assistant', 'Hi there'],
    ]);

    // And the transcript shows them.
    expect(panel()!.textContent).toContain('make me a contact form');
    expect(panel()!.textContent).toContain('Hi there');
  });

  it('derives screen-Studio page context from the route (formScreen / appScreen)', async () => {
    // The custom-screen Studios are their own page-context kind so "this screen"
    // steers the AI to set_form_screen / set_app_home instead of the generic form/app.
    await renderWidget('/forms/f-9/screen/edit');
    await openPanel();
    await send('make it nicer');
    expect((h.sendChatTurn.mock.calls[0][0] as SendChatTurnOptions).pageContext).toEqual({ kind: 'formScreen', id: 'f-9' });

    await act(async () => {
      root.unmount();
    });
    container.remove();
    useUIStore.setState({ chatOpen: false, chatMinimized: false });
    await renderWidget('/apps/a-4/home/edit');
    await openPanel();
    await send('add a stats card');
    const last = h.sendChatTurn.mock.calls.at(-1)![0] as SendChatTurnOptions;
    expect(last.pageContext).toEqual({ kind: 'appScreen', id: 'a-4' });
  });

  it('clears the conversation from the header with a two-tap confirm', async () => {
    await renderWidget();
    await openPanel();
    await send('make me a contact form');
    expect(panel()!.textContent).toContain('Hi there');

    // First tap arms the confirmation; the transcript is untouched.
    const clear = () => panel()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear conversation"], button[aria-label="Confirm clear conversation"]'
    );
    expect(clear()).not.toBeNull();
    await act(async () => {
      clear()!.click();
    });
    expect(clear()!.getAttribute('aria-label')).toBe('Confirm clear conversation');
    expect(panel()!.textContent).toContain('Hi there');

    // Second tap deletes the thread: transcript resets, store is empty, button gone.
    await act(async () => {
      clear()!.click();
    });
    await flush();
    expect(panel()!.textContent).not.toContain('Hi there');
    expect(clear()).toBeNull();
    expect(await getChatStore('u1').listThreads()).toHaveLength(0);
  });

  it('renders a typed error inline with a retry affordance', async () => {
    h.sendChatTurn.mockResolvedValue({
      ok: false,
      source: 'desktop',
      error: { code: 'desktop_offline', message: 'The desktop is not reachable right now.' },
    } satisfies ChatTurnOutcome);
    await renderWidget();
    await openPanel();
    await send('hello?');

    const error = panel()!.querySelector('[data-testid="chat-turn-error"]')!;
    expect(error.textContent).toContain('The desktop is not reachable right now.');
    // The failed turn's source drives the badge honestly.
    expect(panel()!.querySelector('[data-testid="chat-privacy-badge"]')!.textContent).toContain('end-to-end encrypted');

    // Retry re-runs the same turn without duplicating the user message.
    h.sendChatTurn.mockResolvedValue({ ok: true, source: 'desktop', content: 'back online' } satisfies ChatTurnOutcome);
    await act(async () => {
      (error.querySelector('button') as HTMLButtonElement).click();
    });
    await flush();
    expect(h.sendChatTurn).toHaveBeenCalledTimes(2);
    const store = getChatStore('u1');
    const threads = await store.listThreads();
    const { messages } = await store.listMessages(threads[0].id);
    expect(messages.map((m) => m.content)).toEqual(['hello?', 'back online']);
  });
});

// A turn that never ends used to keep Send locked until a reload, whatever else the person did.
describe('a turn that never answers', () => {
  const stopButton = () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
  const stopped = { ok: false, source: null, error: { code: 'stopped', message: 'Stopped.' } } satisfies ChatTurnOutcome;

  /** A turn that goes on until it is stopped, or until the test finishes it. */
  function hangingTurn() {
    let finish!: (outcome: ChatTurnOutcome) => void;
    h.sendChatTurn.mockImplementationOnce((opts: SendChatTurnOptions) => new Promise<ChatTurnOutcome>((resolve) => {
      finish = resolve;
      opts.signal?.addEventListener('abort', () => resolve(stopped));
    }));
    return (outcome: ChatTurnOutcome) => finish(outcome);
  }

  it('offers Stop while it runs, and Stop ends it with Retry and Send back', async () => {
    await renderWidget();
    await openPanel();
    expect(stopButton()).toBeNull();
    hangingTurn();
    await send('are you there?');

    await act(async () => stopButton()!.click());
    await flush();

    expect(stopButton()).toBeNull();
    const error = panel()!.querySelector('[data-testid="chat-turn-error"]')!;
    expect(error.textContent).toContain('Stopped.');
    expect(error.textContent).toContain('Retry');
    await send('and now?');
    expect(h.sendChatTurn).toHaveBeenCalledTimes(2);
  });

  it('shows a turn that threw as an error with Retry, and lets go of Send', async () => {
    await renderWidget();
    await openPanel();
    h.sendChatTurn.mockRejectedValueOnce(new Error('AI provider request template must render to valid JSON'));
    await send('hello?');

    const error = panel()!.querySelector('[data-testid="chat-turn-error"]')!;
    expect(error.textContent).toContain('must render to valid JSON');
    await act(async () => (error.querySelector('button') as HTMLButtonElement).click());
    await flush();
    expect(h.sendChatTurn).toHaveBeenCalledTimes(2);
    expect(stopButton()).toBeNull();
  });

  it('lets go of Send on New chat, and the turn still saves its reply to its own thread', async () => {
    await renderWidget();
    await openPanel();
    const finish = hangingTurn();
    await send('first thread');

    await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
    const newChat = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent?.includes('New chat'))!;
    await act(async () => newChat.click());
    expect(stopButton()).toBeNull();

    await send('second thread');
    expect(h.sendChatTurn).toHaveBeenCalledTimes(2);
    const before = await getChatStore('u1').listThreads();
    expect(before).toHaveLength(2);

    await act(async () => finish({ ok: true, source: 'site', content: 'late reply' }));
    await flush();

    const store = getChatStore('u1');
    const first = before.find((t) => t.title === 'first thread')!;
    expect((await store.listMessages(first.id)).messages.map((m) => m.content)).toEqual(['first thread', 'late reply']);
    expect(panel()!.textContent).not.toContain('late reply');
  });

  it('lets go of Send on moving to another thread, and a late end does not take the next turn\'s lock', async () => {
    const store = getChatStore('u1');
    const other = await store.createThread('other thread');
    await store.appendMessage(other.id, 'user', 'kept');
    await renderWidget();
    await openPanel();
    await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
    const newChat = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent?.includes('New chat'))!;
    await act(async () => newChat.click());
    const finish = hangingTurn();
    await send('stuck here');

    await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
    const row = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent === 'other thread')!;
    await act(async () => row.click());
    await flush();
    expect(stopButton()).toBeNull();

    const finishNext = hangingTurn();
    await send('next turn');
    expect(stopButton()).not.toBeNull();

    await act(async () => finish(stopped));
    await flush();
    expect(stopButton()).not.toBeNull();

    await act(async () => finishNext({ ok: true, source: 'site', content: 'done' }));
    await flush();
    expect(stopButton()).toBeNull();
  });

  it('stops the turn of a thread being deleted: there is nowhere left for its reply', async () => {
    await renderWidget();
    await openPanel();
    hangingTurn();
    await send('delete me');

    await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
    const remove = () => panel()!.querySelector<HTMLButtonElement>('button[aria-label^="Delete"], button[aria-label^="Confirm delete"]')!;
    await act(async () => remove().click());
    await act(async () => remove().click());
    await flush();

    const opts = h.sendChatTurn.mock.calls[0][0] as SendChatTurnOptions;
    expect(opts.signal?.aborted).toBe(true);
    expect(stopButton()).toBeNull();
  });

  // Moving away lets Send go without stopping the turn, so a delete had no way to reach it: the
  // reply was saved as a row nothing shows or removes, and its tools ran on.
  describe('a thread deleted after moving away from its turn', () => {
    /** A turn in a thread of its own, left running, with the panel on another thread. */
    async function turnLeftRunning() {
      const store = getChatStore('u1');
      const other = await store.createThread('other thread');
      await store.appendMessage(other.id, 'user', 'kept');
      await renderWidget();
      await openPanel();
      await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
      const newChat = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent?.includes('New chat'))!;
      await act(async () => newChat.click());
      const finish = hangingTurn();
      await send('leave me');
      const left = (await store.listThreads()).find((t) => t.title === 'leave me')!;

      await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
      const row = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent === 'other thread')!;
      await act(async () => row.click());
      await flush();
      expect(stopButton()).toBeNull();
      return { store, left, finish, opts: h.sendChatTurn.mock.calls.at(-1)![0] as SendChatTurnOptions };
    }
    async function deleteFromHistory() {
      await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
      const remove = () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Delete leave me"], button[aria-label="Confirm delete leave me"]')!;
      await act(async () => remove().click());
      await act(async () => remove().click());
      await flush();
    }

    it('stops the turn', async () => {
      const { opts } = await turnLeftRunning();
      await deleteFromHistory();
      expect(opts.signal?.aborted).toBe(true);
    });

    it('stops it from a mount of the widget that did not start it', async () => {
      const { opts } = await turnLeftRunning();
      await act(async () => root.unmount());
      container.remove();
      await renderWidget(); // chat stays open across a remount
      await flush();

      await deleteFromHistory();

      expect(opts.signal?.aborted).toBe(true);
    });

    it('saves nothing that comes in afterwards', async () => {
      const { store, left, finish } = await turnLeftRunning();
      await deleteFromHistory();

      await act(async () => finish({ ok: true, source: 'site', content: 'too late' }));
      await flush();

      expect((await store.listMessages(left.id)).messages).toEqual([]);
      expect((await store.listThreads()).map((t) => t.title)).toEqual(['other thread']);
    });

    it('leaves a turn running in another thread alone', async () => {
      const { opts } = await turnLeftRunning();
      await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')!.click());
      const remove = () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Delete other thread"], button[aria-label="Confirm delete other thread"]')!;
      await act(async () => remove().click());
      await act(async () => remove().click());
      await flush();

      expect(opts.signal?.aborted).toBe(false);
    });

    it('forgets a turn that has ended', async () => {
      const { opts, finish } = await turnLeftRunning();
      await act(async () => finish({ ok: true, source: 'site', content: 'in time' }));
      await flush();

      await deleteFromHistory();

      expect(opts.signal?.aborted).toBe(false);
    });
  });

  it('holds Send during a compact too, and Stop ends it without an error', async () => {
    const store = getChatStore('u1');
    const thread = await store.createThread('long');
    for (let i = 0; i < 30; i += 1) await store.appendMessage(thread.id, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`);
    useToastStore.getState().clearToasts();
    await renderWidget();
    await openPanel();
    hangingTurn();

    await act(async () => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Compact the conversation"]')!.click());
    await flush();
    expect(stopButton()).not.toBeNull();

    await act(async () => stopButton()!.click());
    await flush();

    expect(stopButton()).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

describe('attaching an image', () => {
  async function attach(url: string) {
    h.downscaleChatImage.mockResolvedValueOnce(url);
    const input = panel()!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }
  const attached = () => panel()!.querySelectorAll('img[alt="Pending attachment"]').length;
  const errors = () => useToastStore.getState().toasts.filter((t) => t.type === 'error');

  beforeEach(() => useToastStore.getState().clearToasts());

  it('refuses one too large for Desktop AI, in plain words, when it is attached', async () => {
    h.getAiPreferences.mockResolvedValue({ ok: true, data: { ...PREFS, aiSource: 'desktop', desktopProviderId: 'p' } });
    await renderWidget();
    await openPanel();

    await attach(`data:image/jpeg;base64,${'A'.repeat(262_000)}`);

    expect(attached()).toBe(0);
    expect(errors()).toEqual([expect.objectContaining({ title: 'That image is too large for FormLogic Desktop' })]);
  });

  it('counts what is already on the message: four small images can overflow one request together', async () => {
    h.getAiPreferences.mockResolvedValue({ ok: true, data: { ...PREFS, aiSource: 'desktop', desktopProviderId: 'p' } });
    await renderWidget();
    await openPanel();
    const url = `data:image/jpeg;base64,${'A'.repeat(100_000)}`;

    await attach(url);
    await attach(url);
    await attach(url);

    expect(attached()).toBe(2);
    expect(errors()).toHaveLength(1);
  });

  it('takes the same image for Site AI, which has the room', async () => {
    await renderWidget();
    await openPanel();

    await attach(`data:image/jpeg;base64,${'A'.repeat(262_000)}`);

    expect(attached()).toBe(1);
    expect(errors()).toEqual([]);
  });
});

describe('Ask first / Auto toggle', () => {
  const toggle = () =>
    Array.from(panel()!.querySelectorAll('button')).find((b) => /^(Auto|Ask first)$/.test(b.textContent ?? ''))!;
  const errors = () => useToastStore.getState().toasts.filter((t) => t.type === 'error');

  beforeEach(() => useToastStore.getState().clearToasts());

  it('sends back what is saved now, not what chat opened with', async () => {
    const put = vi.spyOn(api, 'putAiPreferences').mockResolvedValue({ data: { ...PREFS, chatToolMode: 'confirm' } } as never);
    await renderWidget();
    await openPanel();
    // Settings moves the account to Desktop while the widget stays mounted.
    h.getAiPreferences.mockResolvedValue({ ok: true, data: { ...PREFS, aiSource: 'desktop', desktopProviderId: 'picked-in-settings' } });

    await act(async () => toggle().click());
    await flush();

    expect(h.getAiPreferences).toHaveBeenLastCalledWith({ fresh: true });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ aiSource: 'desktop', desktopProviderId: 'picked-in-settings', chatToolMode: 'confirm' }));
    expect(toggle().textContent).toBe('Ask first');
  });

  it('saves nothing and says so when the fresh read fails', async () => {
    const put = vi.spyOn(api, 'putAiPreferences');
    await renderWidget();
    await openPanel();
    h.getAiPreferences.mockResolvedValue({ ok: false, error: { code: 'transport', message: 'offline' } });

    await act(async () => toggle().click());
    await flush();

    expect(put).not.toHaveBeenCalled();
    expect(errors()).toEqual([expect.objectContaining({ message: 'offline' })]);
    expect(toggle().textContent).toBe('Auto');
  });

  it('says so when the save is refused', async () => {
    vi.spyOn(api, 'putAiPreferences').mockResolvedValue({ error: 'refused' } as never);
    await renderWidget();
    await openPanel();

    await act(async () => toggle().click());
    await flush();

    expect(errors()).toEqual([expect.objectContaining({ message: 'refused' })]);
    expect(toggle().textContent).toBe('Auto');
  });
});

describe('tool cards', () => {
  // update_form runs on the server. Left behind, the builder's copy has its next save refused as
  // someone else's change, when the only one there is the person who asked the chat for it.
  it('brings the builder up to date when the chat has changed a form', async () => {
    const held = { id: 'f-77', title: 'F', fields: [], settings: {}, theme: {}, status: 'draft', fieldsRevision: 'before', _fieldsLoaded: true };
    useFormStore.setState({ forms: [held as never], storageMode: 'api', savingFormIds: {}, saveErrors: {} });
    const getForm = vi.spyOn(api, 'getForm').mockResolvedValue({ data: { form: { ...held, fieldsRevision: 'after' } as never } });
    h.sendChatTurn.mockImplementation(async (opts: SendChatTurnOptions): Promise<ChatTurnOutcome> => {
      opts.events?.onToolActivity?.({ id: 'act-1', name: 'update_form', status: 'running' });
      expect(getForm).not.toHaveBeenCalled();
      opts.events?.onToolActivity?.({ id: 'act-1', name: 'update_form', status: 'done', link: { kind: 'form', id: 'f-77' } });
      return { ok: true, source: 'site', content: 'Added it.' };
    });
    await renderWidget();
    await openPanel();
    await send('add a phone field');
    await flush();

    expect(getForm).toHaveBeenCalledWith('f-77');
    expect(useFormStore.getState().forms[0].fieldsRevision).toBe('after');
    getForm.mockRestore();
    useFormStore.setState({ forms: [], storageMode: 'local' });
  });

  it('renders tool activity with a deep link and confirm-mode proposals with approve wiring', async () => {
    h.sendChatTurn.mockImplementation(async (opts: SendChatTurnOptions): Promise<ChatTurnOutcome> => {
      opts.events?.onToolActivity?.({ id: 'act-1', name: 'create_form', status: 'done', link: { kind: 'form', id: 'f-77' } });
      opts.events?.onToolProposal?.({
        callId: 'call-1',
        requestId: 'req-1',
        tool: 'create_app',
        input: { name: 'CRM' },
        status: 'pending',
      });
      return { ok: true, source: 'desktop', content: 'Created the form.', note: 'One action ran.' };
    });
    await renderWidget();
    await openPanel();
    await send('build it');

    const activity = panel()!.querySelector('[data-testid="chat-tool-activity"]')!;
    expect(activity.textContent).toContain('create_form');
    const proposalCard = panel()!.querySelector('[data-testid="chat-tool-proposal"]')!;
    expect(proposalCard.textContent).toContain('create_app');
    expect(proposalCard.textContent).toContain('120 seconds');
    expect(panel()!.querySelector('[data-testid="chat-turn-note"]')!.textContent).toBe('One action ran.');

    // The deep link resolves to the real builder route.
    await act(async () => {
      (Array.from(activity.querySelectorAll('button')).find((b) => b.textContent?.includes('Open')) as HTMLButtonElement).click();
    });
    expect(h.lastLocation).toBe('/builder/f-77');

    // Approve answers the proposal once and the buttons lock after the answer.
    // (Re-query from the live DOM — the react re-render after navigation may have
    // replaced the earlier card node.)
    const liveCard = panel()!.querySelector('[data-testid="chat-tool-proposal"]')!;
    const approve = Array.from(liveCard.querySelectorAll('button')).find((b) => b.textContent === 'Approve') as HTMLButtonElement;
    await act(async () => {
      approve.click();
    });
    await flush();
    expect(h.answerToolProposal).toHaveBeenCalledTimes(1);
    expect(h.answerToolProposal.mock.calls[0][0]).toMatchObject({ callId: 'call-1', requestId: 'req-1' });
    expect(h.answerToolProposal.mock.calls[0][1]).toBe(true);
    const after = panel()!.querySelector('[data-testid="chat-tool-proposal"]')!;
    expect(after.textContent).toContain('Approved.');
    for (const button of after.querySelectorAll('button')) expect(button.disabled).toBe(true);
  });
});

describe('demo account', () => {
  function signInDemo() {
    useAuthStore.setState({
      user: { id: 'demo', email: 'demo@formlogic.local', isDemo: true },
      isLoading: false,
      isInitialized: true,
      error: null,
    });
  }

  it('shows the guided-demo banner, chips, and never any tool-mode toggle', async () => {
    signInDemo();
    await renderWidget();
    await openPanel();

    expect(panel()!.textContent).toContain('Guided demo');
    expect(panel()!.textContent).toContain('no AI credits');
    // The Auto/Confirm toggle is pointless in the demo — hidden.
    expect(panel()!.querySelector('button[aria-pressed]')).toBeNull();
    // The scripted suggestion chips render from the director's snapshot.
    expect(panel()!.textContent).toContain('Chip one');
    expect(panel()!.textContent).toContain('Chip two');
    // The demo widget registered itself with the director (userId + navigator).
    expect(h.demoAttach).toHaveBeenCalled();
    expect(h.demoAttach.mock.calls[0][0].userId).toBe('demo');
  });

  it('routes typed messages to the scripted director, never the live engine', async () => {
    signInDemo();
    await renderWidget();
    await openPanel();
    await send('demo hello');

    expect(h.sendChatTurn).not.toHaveBeenCalled();
    expect(h.demoRespond).toHaveBeenCalledTimes(1);
    const [text, threadId] = h.demoRespond.mock.calls[0] as [string, string];
    expect(text).toBe('demo hello');
    expect(typeof threadId).toBe('string');
    // The user message was appended to the store before the director took over.
    const store = getChatStore('demo');
    const threads = await store.listThreads();
    const { messages } = await store.listMessages(threads[0].id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([['user', 'demo hello']]);
  });

  it('clicking a chip sends its label through the same demo path', async () => {
    signInDemo();
    await renderWidget();
    await openPanel();
    const chip = Array.from(panel()!.querySelectorAll('button')).find((b) => b.textContent === 'Chip one')!;
    await act(async () => {
      chip.click();
    });
    await flush();
    expect(h.demoRespond).toHaveBeenCalledWith('Chip one', expect.any(String));
    expect(h.sendChatTurn).not.toHaveBeenCalled();
  });
});
