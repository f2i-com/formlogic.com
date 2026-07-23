// The scripted demo scenarios are pure over the DemoStage seam — these tests replay
// them against an in-memory stage and pin the story each one tells: what gets created,
// what gets published, where the viewer is taken, and the honest local-only outro.
import { describe, expect, it } from 'vitest';
import {
  DEMO_FALLBACK_REPLY,
  DEMO_MATCHABLE_SCENARIOS,
  DEMO_ROOT_SCENARIOS,
  matchDemoScenario,
  type DemoMemory,
  type DemoStage,
} from './demoChatScript';
import type { Form, FormField } from '../../types/form';

function scenario(id: string) {
  const found = DEMO_MATCHABLE_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found;
}

const feedback = scenario('root-feedback-form');
const poll = scenario('root-lunch-poll');
const booking = scenario('root-booking-form');
const enquiry = scenario('root-enquiry-form');
const approval = scenario('root-approval-workflow');
const ideaToApp = scenario('root-idea-to-app');
const showcase = scenario('root-showcase');

function makeStage() {
  const events: string[] = [];
  const says: string[] = [];
  const forms = new Map<string, Form>();
  const records = new Map<string, Array<Record<string, unknown>>>();
  const flows: Array<{ id: string; slug: string; name: string; flowJson: Record<string, unknown> }> = [];
  const bindings: Array<{ formId: string; payload: Record<string, unknown> }> = [];
  const diagrams = new Map<string, Array<Record<string, unknown>>>();
  let seq = 0;
  const stage: DemoStage = {
    say: async (text) => {
      says.push(text);
      events.push('say');
    },
    tool: async (name, _detail, work) => {
      events.push(`tool:${name}`);
      const out = (await work()) ?? {};
      if (out.link) events.push(`link:${out.link.kind}`);
      if (out.goTo) events.push(`go:${out.goTo}`);
    },
    go: (path) => {
      events.push(`go:${path}`);
    },
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
      if (!current) throw new Error(`updateForm on unknown form ${id}`);
      forms.set(id, { ...current, ...updates } as Form);
    },
    seedRecord: async (formId, answers) => {
      const arr = records.get(formId) ?? [];
      arr.push(answers);
      records.set(formId, arr);
    },
    createFlow: async (input) => {
      seq += 1;
      const flow = { id: `demolocal_fl${seq}`, slug: input.slug, name: input.name, flowJson: input.flowJson };
      flows.push(flow);
      return { id: flow.id, slug: flow.slug };
    },
    createFormBinding: async (formId, payload) => {
      bindings.push({ formId, payload });
    },
    createDiagram: async () => {
      seq += 1;
      const id = `demolocal_bp${seq}`;
      diagrams.set(id, []);
      return { id };
    },
    commitDiagram: async (diagramId, batch) => {
      const ops = diagrams.get(diagramId);
      if (!ops) throw new Error(`commit on unknown diagram ${diagramId}`);
      ops.push(...batch.operations);
    },
  };
  return { stage, events, says, forms, records, flows, bindings, diagrams };
}

describe('demo scenarios', () => {
  it('feedback form: builds, themes, publishes and walks builder → preview', async () => {
    const { stage, events, says, forms } = makeStage();
    const memory: DemoMemory = {};
    await feedback.run(stage, memory);

    expect(memory.formId).toBeTruthy();
    const form = forms.get(memory.formId!)!;
    expect(form.title).toBe('Customer feedback');
    expect(form.status).toBe('published');
    expect(form.fields).toHaveLength(5);
    const rating = form.fields.find((f: FormField) => f.type === 'rating')!;
    expect(rating.required).toBe(true);
    expect(memory.ratingFieldId).toBe(rating.id);
    expect(form.theme.primaryColor).toBe('#0ea5e9');

    // The walk: into the builder while building, to the live preview once published.
    expect(events).toContain(`go:/builder/${memory.formId}`);
    expect(events).toContain(`go:/preview/${memory.formId}?form=1`);
    // The last word is the honest local-only conversion outro.
    expect(says.at(-1)).toContain('no AI credits');
    expect(says.at(-1)).toContain('free');
  });

  it('lunch poll: writes a live results screen over the REAL field id and seeds votes', async () => {
    const { stage, events, forms, records } = makeStage();
    const memory: DemoMemory = {};
    await poll.run(stage, memory);

    const form = forms.get(memory.formId!)!;
    expect(form.status).toBe('published');
    expect(form.customScreen?.enabled).toBe(true);
    const files = form.customScreen?.files ?? [];
    expect(files.map((f) => f.path)).toEqual(['index.html', 'styles.css', 'index.ts']);
    // The screen's code is bound to the field the scenario actually created.
    expect(files[2].content).toContain(memory.pollFieldId);
    // Screens theme on the sandbox CSS vars, never hardcoded dark colors.
    expect(files[1].content).toContain('var(--fl-accent)');
    // Seeded votes give the results screen real data on arrival.
    expect(records.get(memory.formId!)).toHaveLength(4);
    // The finale lands on the screen preview (no ?form=1 — the screen IS the page).
    expect(events).toContain(`go:/preview/${memory.formId}`);
    expect(events).toContain('tool:set_form_screen');
    expect(events).toContain('link:formScreen');
  });

  it('idea-to-app: sketches the idea as a DIAGRAM first, then builds the poll app + its flow', async () => {
    const { stage, events, forms, flows, bindings, diagrams } = makeStage();
    const memory: DemoMemory = {};
    await ideaToApp.run(stage, memory);

    // One diagram, sketched with entities + edges (the idea made visible).
    expect(diagrams.size).toBe(1);
    const ops = [...diagrams.values()][0];
    const created = ops.filter((op) => op.type === 'blueprint.element.create');
    expect(created.map((op) => op.elementType)).toEqual(
      expect.arrayContaining(['form', 'flow', 'actor', 'note', 'edge'])
    );
    // The viewer was taken to the canvas, then the app build ran for real.
    expect(events).toContain('tool:blueprint_propose_elements');
    expect(events).toContain('link:diagram');
    expect(events.some((e) => e.startsWith('go:/diagrams/'))).toBe(true);
    expect(forms.get(memory.formId!)?.status).toBe('published');
    expect(forms.get(memory.formId!)?.customScreen?.enabled).toBe(true);
    // The flow the sketch promised is REALLY created (browser-local) and wired to the
    // poll's submits — the diagram's triggers edge made real.
    expect(flows).toHaveLength(1);
    expect(flows[0].slug).toBe('close-lunch-voting');
    expect(bindings).toEqual([
      { formId: memory.formId, payload: expect.objectContaining({ event: 'form.submitted', flow: 'close-lunch-voting' }) },
    ]);
    expect(events).toContain(`go:/flows?flow=${encodeURIComponent(flows[0].id)}`);
  });

  it('approval workflow: form + condition-branching flow + form.submitted binding', async () => {
    const { stage, events, forms, flows, bindings } = makeStage();
    const memory: DemoMemory = {};
    await approval.run(stage, memory);

    const form = forms.get(memory.formId!)!;
    expect(form.status).toBe('published');
    expect(form.fields.find((f: FormField) => f.type === 'number')).toBeTruthy();
    expect(flows).toHaveLength(1);
    const nodes = (flows[0].flowJson as { nodes: Array<{ type: string }> }).nodes;
    expect(nodes.map((n) => n.type)).toEqual(expect.arrayContaining(['input', 'condition', 'template', 'output']));
    expect(bindings).toEqual([
      { formId: memory.formId, payload: expect.objectContaining({ event: 'form.submitted', flow: 'purchase-approval' }) },
    ]);
    expect(events).toContain(`go:/flows?flow=${encodeURIComponent(flows[0].id)}`);
  });

  it('enquiry form: contact block + topic picker, published to preview', async () => {
    const { stage, forms } = makeStage();
    const memory: DemoMemory = {};
    await enquiry.run(stage, memory);
    const form = forms.get(memory.formId!)!;
    expect(form.status).toBe('published');
    expect(form.fields.map((f: FormField) => f.type)).toEqual(['short_text', 'email', 'phone', 'dropdown', 'long_text']);
  });

  it('showcase: a capabilities overview, then the real feedback build', async () => {
    const { stage, says, forms } = makeStage();
    const memory: DemoMemory = {};
    await showcase.run(stage, memory);
    expect(says[0]).toContain('flows');
    expect(says[0]).toContain('diagrams');
    expect(forms.get(memory.formId!)?.title).toBe('Customer feedback');
  });

  it('booking form: publishes with the service dropdown and required basics', async () => {
    const { stage, forms } = makeStage();
    const memory: DemoMemory = {};
    await booking.run(stage, memory);

    const form = forms.get(memory.formId!)!;
    expect(form.status).toBe('published');
    const dropdown = form.fields.find((f: FormField) => f.type === 'dropdown')!;
    expect(dropdown.properties.options).toHaveLength(3);
    expect(form.fields.filter((f: FormField) => f.required)).toHaveLength(4);
  });

  it('follow-ups extend the root build: phone field after email, dark theme restyles', async () => {
    const { stage, forms } = makeStage();
    const memory: DemoMemory = {};
    await feedback.run(stage, memory);

    const [addPhone, dark] = feedback.followUps!;
    await addPhone.run(stage, memory);
    const withPhone = forms.get(memory.formId!)!;
    expect(withPhone.fields).toHaveLength(6);
    // The phone slots in right after Email (a coherent contact block, not appended last),
    // and the whole set is renumbered 0..n.
    const emailAt = withPhone.fields.findIndex((f: FormField) => f.type === 'email');
    expect(withPhone.fields[emailAt + 1]!.type).toBe('phone');
    expect(withPhone.fields.map((f: FormField) => f.order)).toEqual([0, 1, 2, 3, 4, 5]);

    await dark.run(stage, memory);
    expect(forms.get(memory.formId!)!.theme.backgroundColor).toBe('#0f172a');
  });

  it('follow-ups without their root refuse honestly instead of crashing', async () => {
    const { stage, says, forms } = makeStage();
    await feedback.followUps![0].run(stage, {});
    expect(forms.size).toBe(0);
    expect(says.at(-1)).toContain('lost track');
  });

  it('the chat chips are three; every scenario stays typed-matchable', () => {
    expect(DEMO_ROOT_SCENARIOS.map((s) => s.id)).toEqual(['root-feedback-form', 'root-idea-to-app', 'root-approval-workflow']);
    for (const s of DEMO_ROOT_SCENARIOS) {
      expect(DEMO_MATCHABLE_SCENARIOS).toContain(s);
    }
  });

  it('matchDemoScenario covers the Dashboard CreateBand suggestion phrasings', () => {
    // The CreateBand's four "What do you want to create?" chips each land on a script.
    expect(matchDemoScenario('Create a customer enquiry form', DEMO_MATCHABLE_SCENARIOS)).toBe(enquiry);
    expect(matchDemoScenario('Build an approval workflow', DEMO_MATCHABLE_SCENARIOS)).toBe(approval);
    expect(matchDemoScenario('Turn my idea into an app', DEMO_MATCHABLE_SCENARIOS)).toBe(ideaToApp);
    expect(matchDemoScenario('show me what FORMLOGIC can do', DEMO_MATCHABLE_SCENARIOS)).toBe(showcase);
    expect(matchDemoScenario('  create a CUSTOMER feedback form ', DEMO_MATCHABLE_SCENARIOS)).toBe(feedback);
    expect(matchDemoScenario('build me a spaceship', DEMO_MATCHABLE_SCENARIOS)).toBeNull();
  });

  it('the fallback reply is honest about the script and steers to the chips', () => {
    expect(DEMO_FALLBACK_REPLY).toContain('script');
    expect(DEMO_FALLBACK_REPLY).toContain('guided builds');
  });
});
