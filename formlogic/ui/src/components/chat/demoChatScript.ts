// Scripted "guided build" scenarios for the shared Demo account (owner direction: the
// demo chat is an honest magic trick, not live AI — zero AI credits, zero server writes).
// Each scenario replays a co-creation conversation through the SAME local mutation
// pipeline every demo visitor already has (formStore demo-local forms + the demoLocal
// record overlay), narrated with the chat's normal tool-activity cards and walked across
// the app with real navigation, so it feels like the real copilot — because apart from
// where the words come from, it IS the real pipeline.
//
// Kept framework-free and dependency-injected (DemoStage) so scenarios are unit-testable
// without React, IndexedDB, or timers.
import { generateId } from '../../lib/utils';
import type { ChatToolActivity } from './chatEngine';
import type { Form, FormField, FormTheme } from '../../types/form';

// ---------------------------------------------------------------------------
// Stage contract — everything a scenario may do, injected by the director.
// ---------------------------------------------------------------------------

export interface DemoToolOutcome {
  /** Deep link stamped on the finished tool card (same shapes as real tool activity). */
  link?: NonNullable<ChatToolActivity['link']>;
  /** Navigate here right after the card completes (the "follow the AI" beat). */
  goTo?: string;
}

export interface DemoStage {
  /** Append one assistant message (the director shows a typing beat first). */
  say(text: string): Promise<void>;
  /** Run one "tool call": a running card, the local mutation, then a done card. */
  tool(name: string, detail: string, work: () => Promise<DemoToolOutcome | void>): Promise<void>;
  /** Navigate the viewer (used for beats that are pure movement, no tool card). */
  go(path: string): void;
  /** Create a demo-local form (formStore mints a demolocal_ id — browser-only). */
  createForm(title: string, description?: string): Promise<Form | null>;
  /** Patch a demo-local form in place (fields, theme, status, customScreen, …). */
  updateForm(id: string, updates: Partial<Form>): Promise<void>;
  /** Seed one record into the demo overlay (what records()/Responses read back). */
  seedRecord(formId: string, answers: Record<string, unknown>): Promise<void>;
  /** Create a demo-local WORKSPACE flow (the /flows demo overlay). */
  createFlow(input: { name: string; slug: string; description?: string; flowJson: Record<string, unknown> }): Promise<{ id: string; slug: string }>;
  /** Bind a demo-local form's event to a workspace flow (demo overlay). */
  createFormBinding(formId: string, payload: Record<string, unknown>): Promise<void>;
  /** Create a demo-local DIAGRAM (a demolocal_ blueprint in this browser). */
  createDiagram(name: string): Promise<{ id: string }>;
  /** Commit one operation batch through the demo diagrams mini gateway (throws on refusal). */
  commitDiagram(diagramId: string, batch: { baseSemanticRevision?: number; operations: Array<Record<string, unknown>> }): Promise<void>;
}

/** Cross-step notes: follow-up scenarios build on what the root scenario created. */
export interface DemoMemory {
  formId?: string;
  ratingFieldId?: string;
  pollFieldId?: string;
  /** The last field set written, so follow-ups can append without re-reading the store. */
  fieldsRef?: () => FormField[];
}

export interface DemoScenario {
  id: string;
  /** Chip label AND the typed text that triggers it (matched case-insensitively). */
  prompt: string;
  /** Extra trigger phrases (the Dashboard CreateBand's suggestion chips land here). */
  aliases?: string[];
  /** Follow-up scenarios extend the parent build's memory instead of resetting it. */
  followUp?: true;
  run(stage: DemoStage, memory: DemoMemory): Promise<void>;
  /** Offered as chips once this scenario completes (before the remaining roots). */
  followUps?: DemoScenario[];
}

// ---------------------------------------------------------------------------
// Small builders.
// ---------------------------------------------------------------------------

function field(order: number, type: FormField['type'], label: string, extra: Partial<FormField> = {}): FormField {
  return { id: generateId(), type, label, required: false, properties: {}, order, ...extra };
}

function options(...labels: string[]) {
  return labels.map((label) => ({ id: generateId(), label, value: label }));
}

const LIGHT_THEME: FormTheme = {
  primaryColor: '#0ea5e9',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'large',
};

const DARK_THEME: FormTheme = {
  primaryColor: '#a3e635',
  backgroundColor: '#0f172a',
  textColor: '#e2e8f0',
  fontFamily: 'Inter',
  borderRadius: 'large',
};

const OUTRO =
  'That is the whole loop: described in chat, built in the workspace, published — in under a minute. ' +
  'Everything you watched stayed on this device; nothing touched the server and no AI credits were used. ' +
  'The builder is fully live, so take over whenever you like — and when you are ready, create a free ' +
  'account to keep your work and connect an AI of your own.';

/**
 * The poll results screen, composed with the REAL field id the scenario just created.
 * Plain HTML + TypeScript on the sandbox SDK (records/submit) and the --fl-* theme vars;
 * ASCII-only and backtick-free so it survives being carried as a string.
 */
function pollScreenFiles(questionFieldId: string, optionLabels: string[]) {
  const ts = [
    '// Live poll results over this form\'s records, via the sandboxed FormLogic SDK.',
    'const QID = ' + JSON.stringify(questionFieldId) + ';',
    'const OPTIONS: string[] = ' + JSON.stringify(optionLabels) + ';',
    'const app = document.getElementById("app")!;',
    '',
    'async function render() {',
    '  const records = await FormLogic.records({ limit: 200 });',
    '  const counts = new Map<string, number>(OPTIONS.map((o) => [o, 0]));',
    '  for (const r of records) {',
    '    const v = String((r.answers || {})[QID] || "");',
    '    if (counts.has(v)) counts.set(v, (counts.get(v) || 0) + 1);',
    '  }',
    '  const total = records.length || 1;',
    '  const rows = OPTIONS.map((o) => {',
    '    const n = counts.get(o) || 0;',
    '    const pct = Math.round((n / total) * 100);',
    '    return \'<div class="row"><div class="label">\' + o + \' <span class="n">\' + n + \'</span></div>\' +',
    '      \'<div class="track"><div class="bar" style="width:\' + pct + \'%"></div></div>\' +',
    '      \'<button class="vote" data-opt="\' + o + \'">Vote</button></div>\';',
    '  }).join("");',
    '  app.innerHTML = \'<h1>Team lunch poll</h1><p class="hint">\' + records.length +',
    '    \' vote(s) so far - tap Vote to add yours.</p>\' + rows;',
    '  app.querySelectorAll<HTMLButtonElement>(".vote").forEach((btn) => {',
    '    btn.addEventListener("click", async () => {',
    '      btn.disabled = true;',
    '      const answers: Record<string, unknown> = {};',
    '      answers[QID] = btn.dataset.opt;',
    '      await FormLogic.submit(answers);',
    '      FormLogic.toast.success("Vote counted");',
    '      render();',
    '    });',
    '  });',
    '}',
    '',
    'render();',
  ].join('\n');
  const css = [
    'body { margin: 0; padding: 24px; font-family: system-ui, sans-serif; background: var(--fl-bg); color: var(--fl-text); }',
    'h1 { font-size: 20px; margin: 0 0 4px; }',
    '.hint { color: var(--fl-muted); font-size: 13px; margin: 0 0 16px; }',
    '.row { display: grid; grid-template-columns: 160px 1fr auto; gap: 10px; align-items: center; margin-bottom: 10px; }',
    '.label { font-size: 14px; }',
    '.n { color: var(--fl-muted); font-size: 12px; }',
    '.track { height: 10px; border-radius: 999px; background: var(--fl-track); overflow: hidden; }',
    '.bar { height: 100%; border-radius: 999px; background: var(--fl-accent); transition: width .4s ease; }',
    '.vote { border: 1px solid var(--fl-border); background: var(--fl-surface); color: var(--fl-text); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }',
    '.vote:hover { border-color: var(--fl-accent); }',
  ].join('\n');
  return [
    { path: 'index.html', content: '<div id="app"></div>' },
    { path: 'styles.css', content: css },
    { path: 'index.ts', content: ts },
  ];
}

// ---------------------------------------------------------------------------
// Follow-up scenarios (offered after their root completes).
// ---------------------------------------------------------------------------

const addPhoneField: DemoScenario = {
  id: 'follow-phone-field',
  prompt: 'Add a phone number field',
  followUp: true,
  async run(stage, memory) {
    const formId = memory.formId;
    if (!formId) {
      await stage.say('I lost track of the form we built — pick one of the other builds to start fresh.');
      return;
    }
    await stage.say('Good idea — a phone number makes follow-ups personal. I will slot it in right after the email field.');
    await stage.tool('update_form', 'Adding a phone field after Email', async () => {
      const current = memory.fieldsRef?.() ?? [];
      const phone = field(0, 'phone', 'Phone number', { placeholder: '0491 570 156' });
      // Right after the email field (or at the end when there is none) — a contact
      // block that reads name → email → phone, not a phone number dangling last.
      const emailAt = current.findIndex((f) => f.type === 'email');
      const insertAt = emailAt === -1 ? current.length : emailAt + 1;
      const next = [...current.slice(0, insertAt), phone, ...current.slice(insertAt)].map((f, order) => ({ ...f, order }));
      memory.fieldsRef = () => next;
      await stage.updateForm(formId, { fields: next });
      return { link: { kind: 'form', id: formId }, goTo: `/builder/${formId}` };
    });
    await stage.say('Done — the phone field sits right under the email address. Anything else? The builder is all yours too.');
  },
};

const makeItDark: DemoScenario = {
  id: 'follow-dark-theme',
  prompt: 'Give it a dark theme',
  followUp: true,
  async run(stage, memory) {
    const formId = memory.formId;
    if (!formId) {
      await stage.say('I lost track of the form we built — pick one of the other builds to start fresh.');
      return;
    }
    await stage.say('Switching it to a dark look with a lime accent.');
    await stage.tool('update_form', 'Applying the dark theme', async () => {
      await stage.updateForm(formId, { theme: { ...DARK_THEME } });
      return { link: { kind: 'form', id: formId }, goTo: `/preview/${formId}?form=1` };
    });
    await stage.say('There it is — same form, new mood. Want it back to light? Just say so, or tweak it yourself in the builder.');
  },
};

const seedMoreVotes: DemoScenario = {
  id: 'follow-seed-votes',
  prompt: 'Add a few more votes',
  followUp: true,
  async run(stage, memory) {
    const formId = memory.formId;
    const pollFieldId = memory.pollFieldId;
    if (!formId || !pollFieldId) {
      await stage.say('I lost track of the poll — pick one of the other builds to start fresh.');
      return;
    }
    await stage.say('Stuffing the ballot box (strictly for demonstration purposes).');
    await stage.tool('add_response', 'Recording 3 more votes', async () => {
      await stage.seedRecord(formId, { [pollFieldId]: 'Pizza' });
      await stage.seedRecord(formId, { [pollFieldId]: 'Sushi' });
      await stage.seedRecord(formId, { [pollFieldId]: 'Pizza' });
      return { goTo: `/preview/${formId}` };
    });
    await stage.say('Three more votes are in — watch the bars move. Every one of those is a real record you can open under Responses.');
  },
};

// ---------------------------------------------------------------------------
// Root scenarios.
// ---------------------------------------------------------------------------

const feedbackForm: DemoScenario = {
  id: 'root-feedback-form',
  prompt: 'Create a customer feedback form',
  followUps: [addPhoneField, makeItDark],
  async run(stage, memory) {
    await stage.say('On it — a customer feedback form. Watch the screen; I will take you along as I build.');
    let form: Form | null = null;
    await stage.tool('create_form', 'Customer feedback', async () => {
      form = await stage.createForm('Customer feedback', 'Tell us how we did — it only takes a minute.');
      if (!form) throw new Error('Could not create the demo form');
      memory.formId = form.id;
      return { link: { kind: 'form', id: form.id }, goTo: `/builder/${form.id}` };
    });
    await stage.say('This is the form builder — your new form is open in it. Now the fields.');
    await stage.tool('update_form', 'Adding 5 fields', async () => {
      const rating = field(2, 'rating', 'How did we do?', { required: true });
      memory.ratingFieldId = rating.id;
      const fields = [
        field(0, 'short_text', 'Your name', { placeholder: 'Ada Lovelace' }),
        field(1, 'email', 'Email', { placeholder: 'you@example.com' }),
        rating,
        field(3, 'long_text', 'What went well?'),
        field(4, 'long_text', 'What could we improve?'),
      ];
      memory.fieldsRef = () => fields;
      await stage.updateForm(memory.formId!, { fields });
      return { link: { kind: 'form', id: memory.formId! } };
    });
    await stage.say('Five fields: name, email, a required 1-5 rating, and two open questions. Next, a friendlier look.');
    await stage.tool('update_form', 'Applying a sky-blue theme', async () => {
      await stage.updateForm(memory.formId!, { theme: { ...LIGHT_THEME } });
      return { link: { kind: 'form', id: memory.formId! } };
    });
    await stage.tool('update_form', 'Publishing the form', async () => {
      await stage.updateForm(memory.formId!, { status: 'published' });
      return { link: { kind: 'form', id: memory.formId! }, goTo: `/preview/${memory.formId}?form=1` };
    });
    await stage.say('Published — this is the live form exactly as your customers would see it. ' + OUTRO);
  },
};

/** The shared lunch-poll build (form → code screen → seeded votes → publish → preview):
 *  the second act of BOTH 'Build a quick poll…' and 'Turn my idea into an app'. */
async function buildLunchPollApp(stage: DemoStage, memory: DemoMemory): Promise<void> {
  let form: Form | null = null;
  let pollField: FormField | null = null;
  const choices = ['Pizza', 'Sushi', 'Tacos', 'Salad'];
  await stage.tool('create_form', 'Team lunch poll', async () => {
    form = await stage.createForm('Team lunch poll', 'One tap — where are we eating on Friday?');
    if (!form) throw new Error('Could not create the demo form');
    memory.formId = form.id;
    pollField = field(0, 'multiple_choice', 'Where should we eat?', { required: true, properties: { options: options(...choices) } });
    memory.pollFieldId = pollField.id;
    await stage.updateForm(form.id, { fields: [pollField] });
    return { link: { kind: 'form', id: form.id }, goTo: `/builder/${form.id}` };
  });
  await stage.say('The poll form is ready. Now the fun part: a custom results screen — real code, running sandboxed over this form\'s records.');
  await stage.tool('set_form_screen', 'Writing the live results screen', async () => {
    await stage.updateForm(memory.formId!, {
      customScreen: { enabled: true, entry: 'index.ts', files: pollScreenFiles(memory.pollFieldId!, choices) },
    });
    return { link: { kind: 'formScreen', id: memory.formId! } };
  });
  await stage.tool('add_response', 'Seeding 4 example votes', async () => {
    await stage.seedRecord(memory.formId!, { [memory.pollFieldId!]: 'Pizza' });
    await stage.seedRecord(memory.formId!, { [memory.pollFieldId!]: 'Sushi' });
    await stage.seedRecord(memory.formId!, { [memory.pollFieldId!]: 'Pizza' });
    await stage.seedRecord(memory.formId!, { [memory.pollFieldId!]: 'Tacos' });
  });
  await stage.tool('update_form', 'Publishing the poll', async () => {
    await stage.updateForm(memory.formId!, { status: 'published' });
    return { link: { kind: 'formScreen', id: memory.formId! }, goTo: `/preview/${memory.formId}` };
  });
  await stage.say('And here is the results screen, live over the four votes I seeded — cast one yourself and watch the bars move. ' + OUTRO);
}

const lunchPoll: DemoScenario = {
  id: 'root-lunch-poll',
  prompt: 'Build a quick poll with a live results screen',
  followUps: [seedMoreVotes],
  async run(stage, memory) {
    await stage.say('A poll with its own live results page — my favourite party trick. Building it now.');
    await buildLunchPollApp(stage, memory);
  },
};

// The CreateBand's "Turn my idea into an app": the idea is SKETCHED as a diagram first
// (a demolocal_ blueprint on the real canvas), then materialised — locally, since the
// demo can't create server apps — into the working poll mini-app.
const ideaToApp: DemoScenario = {
  id: 'root-idea-to-app',
  prompt: 'Turn my idea into an app',
  followUps: [seedMoreVotes],
  async run(stage, memory) {
    await stage.say(
      'Here is how an idea becomes an app in FormLogic: first we SKETCH it as a diagram, then the sketch turns into real forms and flows. Take "team lunch club" as the idea — watch the canvas.'
    );
    let diagramId = '';
    await stage.tool('blueprint_propose_elements', 'Sketching the idea as a diagram', async () => {
      const diagram = await stage.createDiagram('Team lunch club');
      diagramId = diagram.id;
      const op = (body: Record<string, unknown>) => ({ operationId: 'op-' + generateId(), ...body });
      await stage.commitDiagram(diagramId, {
        baseSemanticRevision: 0,
        operations: [
          op({ type: 'blueprint.element.create', targetId: 'el-poll', elementType: 'form', layout: { x: 80, y: 120 },
            properties: { title: 'Lunch poll', fields: [{ name: 'Choice', type: 'short_text' }, { name: 'Voter', type: 'short_text' }] } }),
          op({ type: 'blueprint.element.create', targetId: 'el-flow', elementType: 'flow', layout: { x: 420, y: 60 },
            properties: { title: 'Close voting at noon', description: 'Counts the votes and announces the winner.' } }),
          op({ type: 'blueprint.element.create', targetId: 'el-team', elementType: 'actor', layout: { x: 80, y: 340 },
            properties: { title: 'The team' } }),
          op({ type: 'blueprint.element.create', targetId: 'el-note', elementType: 'note', layout: { x: 420, y: 300 },
            properties: { text: 'The idea: one tap to vote for Friday lunch, live results on a screen in the kitchen.' } }),
          op({ type: 'blueprint.element.create', targetId: 'el-uses', elementType: 'edge',
            properties: { edgeType: 'uses', sourceId: 'el-team', targetId: 'el-poll' } }),
          op({ type: 'blueprint.element.create', targetId: 'el-triggers', elementType: 'edge',
            properties: { edgeType: 'triggers', sourceId: 'el-poll', targetId: 'el-flow' } }),
        ],
      });
      return { link: { kind: 'diagram', id: diagramId }, goTo: `/diagrams/${diagramId}` };
    });
    await stage.say(
      'That is the idea as a living sketch: who uses it, what they touch, what runs automatically. On a full account the "Create app" button materialises a diagram like this into a real app with linked forms and flows. The demo cannot create server apps, so I will build the heart of it right here instead — the poll with its live results screen.'
    );
    await buildLunchPollApp(stage, memory);
  },
};

const bookingForm: DemoScenario = {
  id: 'root-booking-form',
  prompt: 'Make a booking request form',
  followUps: [addPhoneField, makeItDark],
  async run(stage, memory) {
    await stage.say('A booking request form, coming right up — watch the screen.');
    let form: Form | null = null;
    await stage.tool('create_form', 'Booking request', async () => {
      form = await stage.createForm('Booking request', 'Pick a service and a time that suits — we will confirm by email.');
      if (!form) throw new Error('Could not create the demo form');
      memory.formId = form.id;
      return { link: { kind: 'form', id: form.id }, goTo: `/builder/${form.id}` };
    });
    await stage.tool('update_form', 'Adding the booking fields', async () => {
      const fields = [
        field(0, 'short_text', 'Your name', { required: true }),
        field(1, 'email', 'Email', { required: true }),
        field(2, 'dropdown', 'Service', { required: true, properties: { options: options('Consultation', 'Follow-up visit', 'Full service') } }),
        field(3, 'date', 'Preferred date', { required: true }),
        field(4, 'long_text', 'Anything we should know?' ),
      ];
      memory.fieldsRef = () => fields;
      await stage.updateForm(memory.formId!, { fields });
      return { link: { kind: 'form', id: memory.formId! } };
    });
    await stage.say('Name, email, a service picker, a date, and a notes box. In a real account a Flow could confirm each booking automatically — here I will just publish it.');
    await stage.tool('update_form', 'Publishing the form', async () => {
      await stage.updateForm(memory.formId!, { status: 'published' });
      return { link: { kind: 'form', id: memory.formId! }, goTo: `/preview/${memory.formId}?form=1` };
    });
    await stage.say('Published and ready for bookings. ' + OUTRO);
  },
};

// The CreateBand's "Create a customer enquiry form" — name/contact/topic/message.
const enquiryForm: DemoScenario = {
  id: 'root-enquiry-form',
  prompt: 'Create a customer enquiry form',
  followUps: [makeItDark],
  async run(stage, memory) {
    await stage.say('A customer enquiry form, coming up — watch the screen.');
    let form: Form | null = null;
    await stage.tool('create_form', 'Customer enquiries', async () => {
      form = await stage.createForm('Customer enquiries', 'Ask us anything — we usually reply within one business day.');
      if (!form) throw new Error('Could not create the demo form');
      memory.formId = form.id;
      return { link: { kind: 'form', id: form.id }, goTo: `/builder/${form.id}` };
    });
    await stage.tool('update_form', 'Adding the enquiry fields', async () => {
      const fields = [
        field(0, 'short_text', 'Your name', { required: true }),
        field(1, 'email', 'Email', { required: true }),
        field(2, 'phone', 'Phone (optional)', { placeholder: '0491 570 156' }),
        field(3, 'dropdown', 'Topic', { required: true, properties: { options: options('General', 'Sales', 'Support') } }),
        field(4, 'long_text', 'How can we help?', { required: true }),
      ];
      memory.fieldsRef = () => fields;
      await stage.updateForm(memory.formId!, { fields });
      return { link: { kind: 'form', id: memory.formId! } };
    });
    await stage.tool('update_form', 'Publishing the form', async () => {
      await stage.updateForm(memory.formId!, { status: 'published' });
      return { link: { kind: 'form', id: memory.formId! }, goTo: `/preview/${memory.formId}?form=1` };
    });
    await stage.say('Published — name, contact details, a topic picker and a message box, ready for enquiries. ' + OUTRO);
  },
};

// The CreateBand's "Build an approval workflow" — a request form, an automation with a
// real condition branch, and the trigger binding that wires them together.
const approvalWorkflow: DemoScenario = {
  id: 'root-approval-workflow',
  prompt: 'Build an approval workflow',
  async run(stage, memory) {
    await stage.say('An approval workflow has three parts: a request form, an automation that routes each request, and the trigger that connects them. Building all three.');
    let form: Form | null = null;
    await stage.tool('create_form', 'Purchase requests', async () => {
      form = await stage.createForm('Purchase requests', 'Request a purchase — anything over $500 goes to a manager.');
      if (!form) throw new Error('Could not create the demo form');
      memory.formId = form.id;
      const fields = [
        field(0, 'short_text', 'What do you need?', { required: true }),
        field(1, 'number', 'Amount (AUD)', { required: true }),
        field(2, 'short_text', 'Requested by', { required: true }),
        field(3, 'long_text', 'Why?' ),
      ];
      memory.fieldsRef = () => fields;
      await stage.updateForm(form.id, { fields, status: 'published' });
      return { link: { kind: 'form', id: form.id }, goTo: `/builder/${form.id}` };
    });
    await stage.say('The request form is live. Now the automation: a FLOW with a condition that splits big requests from small ones.');
    let flowId = '';
    await stage.tool('create_flow', 'Purchase approval routing', async () => {
      const flow = await stage.createFlow({
        name: 'Purchase approval',
        slug: 'purchase-approval',
        description: 'Requests of $500 or more go to a manager; smaller ones auto-approve.',
        flowJson: {
          nodes: [
            { id: 'in', type: 'input' },
            { id: 'check', type: 'condition', data: { expr: 'Number(inputs.amount) >= 500' } },
            { id: 'manager', type: 'template', data: { template: 'Needs sign-off: {{inputs.item}} at ${{inputs.amount}} — sent to the manager queue.' } },
            { id: 'auto', type: 'template', data: { template: 'Auto-approved: {{inputs.item}} is under the $500 limit.' } },
            { id: 'out', type: 'output' },
          ],
          edges: [
            { source: 'in', target: 'check' },
            { source: 'check', target: 'manager', sourceHandle: 'true' },
            { source: 'check', target: 'auto', sourceHandle: 'false' },
            { source: 'manager', target: 'out' },
            { source: 'auto', target: 'out' },
          ],
        },
      });
      flowId = flow.id;
      return { link: { kind: 'flow', id: flow.id }, goTo: `/flows?flow=${encodeURIComponent(flow.id)}` };
    });
    await stage.say('This is the flow editor — the condition node is the fork: $500 and over goes one way, everything else auto-approves. Last piece: the trigger.');
    await stage.tool('create_flow_binding', 'On new request, run the approval flow', async () => {
      await stage.createFormBinding(memory.formId!, { flow: 'purchase-approval', flowDefinitionId: flowId, event: 'form.submitted', mode: 'async', enabled: true });
    });
    await stage.say('Wired: every submitted request now triggers the approval flow automatically. ' + OUTRO);
  },
};

// The CreateBand's "Show me what FormLogic can do" — a one-line tour, then a real build.
const showcase: DemoScenario = {
  id: 'root-showcase',
  prompt: 'Show me what FormLogic can do',
  followUps: [addPhoneField, makeItDark],
  async run(stage, memory) {
    await stage.say(
      'The short version: FormLogic builds forms, turns groups of them into apps with dashboards and custom screens, automates them with flows, sketches ideas as diagrams — and an AI (me, or your own) can drive all of it from this chat. Easiest way to show you is to build something. Here is a customer feedback form, live.'
    );
    await feedbackForm.run(stage, memory);
  },
};

// The typed-anything fallback: honest about being scripted, steers to the chips.
export const DEMO_FALLBACK_REPLY =
  'In the shared demo I follow a script instead of live AI (so exploring costs nothing and nothing is saved to the server). ' +
  'Pick one of the guided builds below to watch me work — or sign up free to chat with a real AI connected to your own workspace.';

/** The chat panel's idle chips (kept to three; every matchable scenario still triggers by text). */
export const DEMO_ROOT_SCENARIOS: DemoScenario[] = [feedbackForm, ideaToApp, approvalWorkflow];

/** Everything a typed message can trigger — includes the Dashboard CreateBand's suggestion
 *  phrasings, so "What do you want to create?" flows straight into a guided build. */
export const DEMO_MATCHABLE_SCENARIOS: DemoScenario[] = [
  feedbackForm, ideaToApp, approvalWorkflow, lunchPoll, bookingForm, enquiryForm, showcase,
];

/** Find a scenario whose prompt (or alias) matches the typed text, case-insensitively. */
export function matchDemoScenario(text: string, available: DemoScenario[]): DemoScenario | null {
  const wanted = text.trim().toLowerCase();
  return (
    available.find(
      (s) => s.prompt.toLowerCase() === wanted || (s.aliases ?? []).some((alias) => alias.toLowerCase() === wanted)
    ) ?? null
  );
}
