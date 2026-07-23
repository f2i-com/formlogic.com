// Director behavior: scenario prompts run the scripted build end-to-end (messages into
// the REAL chat store, activities running → done, navigation beats), anything else gets
// the honest fallback, failures apologise and reset, and stop() cancels cleanly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setDemoStageDepsForTests,
  __setDemoWaitForTests,
  demoChatDirector,
} from './demoChatDirector';
import { DEMO_FALLBACK_REPLY, DEMO_ROOT_SCENARIOS } from './demoChatScript';
import { __resetChatStoresForTests, __setChatStoreIndexedDbForTests, getChatStore } from './chatStore';
import type { Form } from '../../types/form';

const USER = 'demo-user';

function makeLocalWorld() {
  const forms = new Map<string, Form>();
  const records = new Map<string, Array<Record<string, unknown>>>();
  let seq = 0;
  __setDemoStageDepsForTests({
    createForm: async (title, description) => {
      seq += 1;
      const form = {
        id: `demolocal_f${seq}`,
        title,
        description,
        fields: [],
        settings: {},
        theme: {},
        createdAt: '',
        updatedAt: '',
        status: 'draft',
        responseCount: 0,
      } as unknown as Form;
      forms.set(form.id, form);
      return form;
    },
    updateForm: async (id, updates) => {
      const current = forms.get(id);
      if (!current) throw new Error(`unknown form ${id}`);
      forms.set(id, { ...current, ...updates } as Form);
    },
    seedRecord: async (formId, answers) => {
      records.set(formId, [...(records.get(formId) ?? []), answers]);
    },
  });
  return { forms, records };
}

async function newThread() {
  return (await getChatStore(USER).createThread('demo')).id;
}

async function transcript(threadId: string) {
  const { messages } = await getChatStore(USER).listMessages(threadId);
  return messages.map((m) => m.content);
}

beforeEach(() => {
  __resetChatStoresForTests();
  __setChatStoreIndexedDbForTests(null); // memory-backed store
  __setDemoWaitForTests(async () => {});
  demoChatDirector.__resetForTests();
});

afterEach(() => {
  demoChatDirector.__resetForTests();
  __setDemoWaitForTests(null);
  __setDemoStageDepsForTests(null);
  __resetChatStoresForTests();
  __setChatStoreIndexedDbForTests(undefined);
});

describe('demoChatDirector', () => {
  it('starts idle with the root scenario chips', () => {
    const snap = demoChatDirector.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.chips).toEqual(DEMO_ROOT_SCENARIOS.map((s) => s.prompt));
  });

  it('answers unmatched text with the honest fallback (no build, chips kept)', async () => {
    makeLocalWorld();
    const nav: string[] = [];
    demoChatDirector.attach({ userId: USER, navigate: (p) => nav.push(p) });
    const threadId = await newThread();

    await demoChatDirector.respond('write me a poem', threadId);

    expect(await transcript(threadId)).toEqual([DEMO_FALLBACK_REPLY]);
    expect(nav).toEqual([]);
    const snap = demoChatDirector.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.chips).toEqual(DEMO_ROOT_SCENARIOS.map((s) => s.prompt));
  });

  it('runs a root scenario: real mutations, done cards, navigation, follow-up chips', async () => {
    const { forms } = makeLocalWorld();
    const nav: string[] = [];
    demoChatDirector.attach({ userId: USER, navigate: (p) => nav.push(p) });
    const threadId = await newThread();
    const feedback = DEMO_ROOT_SCENARIOS[0];

    await demoChatDirector.respond(feedback.prompt, threadId);

    // The build happened for real (against the injected local world).
    const built = [...forms.values()][0];
    expect(built.title).toBe('Customer feedback');
    expect(built.status).toBe('published');
    // The viewer was walked to the builder and then the live preview.
    expect(nav.some((p) => p.startsWith('/builder/'))).toBe(true);
    expect(nav.some((p) => p.startsWith('/preview/'))).toBe(true);
    // Assistant narration landed in the real chat store.
    const texts = await transcript(threadId);
    expect(texts.length).toBeGreaterThanOrEqual(3);
    expect(texts.at(-1)).toContain('no AI credits');
    // All tool cards completed; the snapshot settled with follow-ups first.
    const snap = demoChatDirector.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.activities.length).toBeGreaterThanOrEqual(3);
    expect(snap.activities.every((a) => a.status === 'done')).toBe(true);
    expect(snap.chips.slice(0, feedback.followUps!.length)).toEqual(feedback.followUps!.map((s) => s.prompt));
    // …and a follow-up chip is now runnable against the remembered form (the phone
    // field slots in right after Email — the demoChatScript suite pins the exact spot).
    await demoChatDirector.respond(feedback.followUps![0].prompt, threadId);
    expect([...forms.values()][0].fields.some((f) => f.type === 'phone')).toBe(true);
  });

  it('a failing step apologises, resets the chips, and marks the card failed', async () => {
    makeLocalWorld();
    __setDemoStageDepsForTests({
      createForm: async () => {
        throw new Error('kaboom');
      },
    });
    demoChatDirector.attach({ userId: USER, navigate: () => undefined });
    const threadId = await newThread();

    await demoChatDirector.respond(DEMO_ROOT_SCENARIOS[0].prompt, threadId);

    const snap = demoChatDirector.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.activities.some((a) => a.status === 'failed')).toBe(true);
    expect(snap.chips).toEqual(DEMO_ROOT_SCENARIOS.map((s) => s.prompt));
    expect((await transcript(threadId)).at(-1)).toContain('try again');
  });

  it('stop() cancels a run mid-flight without an apology message', async () => {
    makeLocalWorld();
    // Cancel from inside the first pacing beat — deterministic mid-run stop.
    let stopped = false;
    __setDemoWaitForTests(async () => {
      if (!stopped) {
        stopped = true;
        demoChatDirector.stop();
      }
    });
    demoChatDirector.attach({ userId: USER, navigate: () => undefined });
    const threadId = await newThread();

    await demoChatDirector.respond(DEMO_ROOT_SCENARIOS[0].prompt, threadId);

    expect(demoChatDirector.getSnapshot().running).toBe(false);
    const texts = await transcript(threadId);
    expect(texts.every((t) => !t.includes('try again'))).toBe(true);
  });

  it('ignores respond() while a scenario is already running', async () => {
    makeLocalWorld();
    // Re-enter from inside a pacing beat while the first scenario is mid-run.
    let reentered = false;
    const threadIdPromise = newThread();
    __setDemoWaitForTests(async () => {
      if (!reentered) {
        reentered = true;
        await demoChatDirector.respond('write me a poem', await threadIdPromise);
      }
    });
    demoChatDirector.attach({ userId: USER, navigate: () => undefined });
    const threadId = await threadIdPromise;

    await demoChatDirector.respond(DEMO_ROOT_SCENARIOS[0].prompt, threadId);

    // The re-entrant call was dropped: no fallback reply spliced into the build story.
    const texts = await transcript(threadId);
    expect(texts).not.toContain(DEMO_FALLBACK_REPLY);
    expect(demoChatDirector.getSnapshot().running).toBe(false);
  });
});
