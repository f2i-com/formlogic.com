// The scripted demo scenarios are pure over the DemoStage seam — these tests replay
// them against an in-memory stage and pin the story each one tells: what gets created,
// what gets published, where the viewer is taken, and the honest local-only outro.
import { describe, expect, it } from 'vitest';
import {
  DEMO_FALLBACK_REPLY,
  DEMO_ROOT_SCENARIOS,
  matchDemoScenario,
  type DemoMemory,
  type DemoStage,
} from './demoChatScript';
import type { Form, FormField } from '../../types/form';

function makeStage() {
  const events: string[] = [];
  const says: string[] = [];
  const forms = new Map<string, Form>();
  const records = new Map<string, Array<Record<string, unknown>>>();
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
  };
  return { stage, events, says, forms, records };
}

const [feedback, poll, booking] = DEMO_ROOT_SCENARIOS;

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

  it('follow-ups extend the root build: phone field appends, dark theme restyles', async () => {
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

  it('matchDemoScenario matches chip labels case-insensitively, else null', () => {
    expect(matchDemoScenario('  create a CUSTOMER feedback form ', DEMO_ROOT_SCENARIOS)).toBe(feedback);
    expect(matchDemoScenario('build me a spaceship', DEMO_ROOT_SCENARIOS)).toBeNull();
  });

  it('the fallback reply is honest about the script and steers to the chips', () => {
    expect(DEMO_FALLBACK_REPLY).toContain('script');
    expect(DEMO_FALLBACK_REPLY).toContain('guided builds');
  });
});
