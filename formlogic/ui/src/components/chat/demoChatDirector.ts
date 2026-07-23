// The demo chat DIRECTOR: a module-level singleton that performs the scripted guided
// builds for the shared Demo account. It lives OUTSIDE the widget component because the
// script deliberately navigates across full-screen routes (builder, preview) — each
// navigation remounts SiteChatWidget, and a component-held script would die mid-trick.
// Messages are appended straight to the per-user chatStore (the widget re-reads on every
// `version` bump), tool cards + typing live in the snapshot, and navigation goes through
// whichever widget instance registered last.
//
// The mutations are REAL: formStore demo-local forms + the demoLocal record overlay —
// the same command surface a demo visitor drives by hand. Nothing touches the server.
import { getChatStore } from './chatStore';
import { useFormStore } from '../../stores/formStore';
import {
  addDemoRecord,
  commitDemoBlueprintOperations,
  createDemoBlueprint,
  demoCreateFlow,
  demoCreateFormBinding,
} from '../../lib/demoLocal';
import { generateId } from '../../lib/utils';
import { logger } from '../../lib/logger';
import type { ChatToolActivity } from './chatEngine';
import {
  DEMO_FALLBACK_REPLY,
  DEMO_MATCHABLE_SCENARIOS,
  DEMO_ROOT_SCENARIOS,
  matchDemoScenario,
  type DemoMemory,
  type DemoScenario,
  type DemoStage,
} from './demoChatScript';

export interface DemoDirectorSnapshot {
  running: boolean;
  typing: boolean;
  /** The thread the current/most recent script belongs to (cards render there only). */
  threadId: string | null;
  activities: ChatToolActivity[];
  /** Current suggestion chips (roots when idle; follow-ups + remaining roots after a run). */
  chips: string[];
  /** Bumps whenever the director appended a message — the widget reloads the thread. */
  version: number;
}

type Listener = () => void;

// Pacing beats (ms). Injectable so tests run instantly.
const BEATS = { typing: 650, beforeTool: 450, toolWork: 500 };
let waitImpl = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test-only: replace the pacing waits (pass async () => {} for instant runs). */
export function __setDemoWaitForTests(impl: ((ms: number) => Promise<void>) | null): void {
  waitImpl = impl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

interface StageOverrides {
  createForm?: DemoStage['createForm'];
  updateForm?: DemoStage['updateForm'];
  seedRecord?: DemoStage['seedRecord'];
  createFlow?: DemoStage['createFlow'];
  createFormBinding?: DemoStage['createFormBinding'];
  createDiagram?: DemoStage['createDiagram'];
  commitDiagram?: DemoStage['commitDiagram'];
}

let stageOverrides: StageOverrides | null = null;

/** Test-only: swap the local-mutation deps (formStore / demoLocal) for fakes. */
export function __setDemoStageDepsForTests(overrides: StageOverrides | null): void {
  stageOverrides = overrides;
}

class DemoChatDirector {
  private listeners = new Set<Listener>();
  private snapshot: DemoDirectorSnapshot = {
    running: false,
    typing: false,
    threadId: null,
    activities: [],
    chips: DEMO_ROOT_SCENARIOS.map((s) => s.prompt),
    version: 0,
  };

  private userId: string | null = null;
  private navigateFn: ((path: string) => void) | null = null;
  /** Bumped to cancel an in-flight script (account switch, explicit stop). */
  private generation = 0;
  /** What the chips currently offer (roots + the last scenario's follow-ups). */
  private available: DemoScenario[] = [...DEMO_ROOT_SCENARIOS];
  private memory: DemoMemory = {};

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DemoDirectorSnapshot => this.snapshot;

  /** The widget registers itself (and re-registers on every remount/navigation). */
  attach(opts: { userId: string; navigate: (path: string) => void }): void {
    if (this.userId !== null && this.userId !== opts.userId) this.stop();
    this.userId = opts.userId;
    this.navigateFn = opts.navigate;
  }

  stop(): void {
    this.generation += 1;
    this.patch({ running: false, typing: false });
  }

  /**
   * Handle one user message in the demo chat (already appended to the store by the
   * widget). A prompt matching an offered scenario runs it; anything else gets the
   * honest scripted-demo steering reply.
   */
  async respond(text: string, threadId: string): Promise<void> {
    if (this.snapshot.running) return;
    // Offered chips first (follow-ups shadow same-named roots), then EVERY matchable
    // scenario — the Dashboard CreateBand's suggestion phrasings land here as typed
    // text and must start their guided build even when their chip isn't showing.
    const scenario = matchDemoScenario(text, [...this.available, ...DEMO_MATCHABLE_SCENARIOS]);
    if (!scenario) {
      const gen = ++this.generation;
      this.patch({ running: true, typing: true, threadId });
      await waitImpl(BEATS.typing);
      if (gen !== this.generation) return;
      await this.append(threadId, DEMO_FALLBACK_REPLY);
      this.patch({ running: false, typing: false, chips: this.available.map((s) => s.prompt) });
      return;
    }
    await this.runScenario(scenario, threadId);
  }

  private async runScenario(scenario: DemoScenario, threadId: string): Promise<void> {
    const gen = ++this.generation;
    // A fresh build starts a fresh memory; follow-ups extend the existing one.
    if (!scenario.followUp) this.memory = {};
    this.patch({ running: true, typing: false, threadId, activities: [], chips: [] });
    const cancelled = () => gen !== this.generation;
    const bail = new Error('demo-cancelled');
    const stage = this.buildStage(threadId, cancelled, bail);
    try {
      await scenario.run(stage, this.memory);
      if (cancelled()) return;
      const followUps = scenario.followUps ?? [];
      const roots = DEMO_ROOT_SCENARIOS.filter((s) => s !== scenario);
      this.available = [...followUps, ...roots];
      this.patch({ running: false, typing: false, chips: this.available.map((s) => s.prompt) });
    } catch (e) {
      if (e === bail || cancelled()) return; // superseded — the newer run owns the state
      logger.warn('[demo-chat] scenario failed:', e);
      try {
        await this.append(threadId, 'Something went sideways in the demo script — pick a build below to try again.');
      } catch { /* the transcript append is best-effort at this point */ }
      this.available = [...DEMO_ROOT_SCENARIOS];
      this.patch({ running: false, typing: false, chips: this.available.map((s) => s.prompt) });
    }
  }

  private buildStage(threadId: string, cancelled: () => boolean, bail: Error): DemoStage {
    const check = () => {
      if (cancelled()) throw bail;
    };
    const say = async (text: string) => {
      check();
      this.patch({ typing: true });
      await waitImpl(BEATS.typing);
      check();
      this.patch({ typing: false });
      await this.append(threadId, text);
    };
    const tool = async (name: string, detail: string, work: () => Promise<{ link?: NonNullable<ChatToolActivity['link']>; goTo?: string } | void>) => {
      check();
      await waitImpl(BEATS.beforeTool);
      check();
      const id = generateId();
      this.upsertActivity({ id, name, status: 'running', detail });
      await waitImpl(BEATS.toolWork);
      check();
      try {
        const outcome = (await work()) ?? {};
        check();
        this.upsertActivity({ id, name, status: 'done', detail, ...(outcome.link ? { link: outcome.link } : {}) });
        if (outcome.goTo) this.navigateFn?.(outcome.goTo);
      } catch (e) {
        if (e === bail) throw e;
        this.upsertActivity({ id, name, status: 'failed', detail, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    return {
      say,
      tool,
      go: (path: string) => {
        check();
        this.navigateFn?.(path);
      },
      createForm: stageOverrides?.createForm ?? ((title, description) => useFormStore.getState().createForm(title, description)),
      updateForm: stageOverrides?.updateForm ?? ((id, updates) => useFormStore.getState().updateForm(id, updates)),
      seedRecord:
        stageOverrides?.seedRecord ??
        (async (formId, answers) => {
          await addDemoRecord(formId, answers);
        }),
      createFlow:
        stageOverrides?.createFlow ??
        (async (input) => {
          const flow = await demoCreateFlow({
            appId: null, // workspace-scope: the demo's flows overlay list
            name: input.name,
            slug: input.slug,
            description: input.description,
            flowJson: input.flowJson as never,
          });
          return { id: flow.id, slug: flow.slug };
        }),
      createFormBinding:
        stageOverrides?.createFormBinding ??
        (async (formId, payload) => {
          await demoCreateFormBinding(formId, payload);
        }),
      createDiagram:
        stageOverrides?.createDiagram ??
        (async (name) => {
          const stored = await createDemoBlueprint(name);
          return { id: stored.row.id };
        }),
      commitDiagram:
        stageOverrides?.commitDiagram ??
        (async (diagramId, batch) => {
          const out = await commitDemoBlueprintOperations(diagramId, batch as never);
          if (!out.ok) throw new Error(`Diagram sketch refused (${out.code})`);
        }),
    };
  }

  private async append(threadId: string, text: string): Promise<void> {
    if (!this.userId) return;
    await getChatStore(this.userId).appendMessage(threadId, 'assistant', text);
    this.patch({ version: this.snapshot.version + 1 });
  }

  private upsertActivity(activity: ChatToolActivity): void {
    const index = this.snapshot.activities.findIndex((a) => a.id === activity.id);
    const activities =
      index === -1 ? [...this.snapshot.activities, activity] : this.snapshot.activities.map((a, i) => (i === index ? activity : a));
    this.patch({ activities });
  }

  private patch(partial: Partial<DemoDirectorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }

  /** Test-only: reset all module state between tests. */
  __resetForTests(): void {
    this.generation += 1;
    this.userId = null;
    this.navigateFn = null;
    this.available = [...DEMO_ROOT_SCENARIOS];
    this.memory = {};
    this.snapshot = {
      running: false,
      typing: false,
      threadId: null,
      activities: [],
      chips: DEMO_ROOT_SCENARIOS.map((s) => s.prompt),
      version: 0,
    };
    for (const listener of this.listeners) listener();
  }
}

export const demoChatDirector = new DemoChatDirector();
