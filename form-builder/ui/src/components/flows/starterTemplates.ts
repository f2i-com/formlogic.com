// FormLogic Flows workspace — "New flow" starter templates.
//
// Ported from the Aokie Receptionist starter flows (data/packs/aokieReceptionistPack.ts) into
// standalone, placed canvases the workspace "New flow" dialog can drop in. Form references are
// left as editable placeholders (no `@pack:` remap outside a pack import) so the author points
// them at their own forms. Node types are the v0 executable set only, so every template runs.
import type { WorkflowGraph } from '../../types/flows';

export interface FlowStarterTemplate {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** What the flow reads/writes — surfaced in the picker. */
  summary: string;
  /** Optional "works with <app>" hint for templates that only make sense with a given app/connector. */
  appHint?: string;
  nodeCapabilities: string[];
  flowJson: WorkflowGraph;
}

const SMS_DRAFT_EXPR =
  "const text = String((nodes.draft && nodes.draft.content) || '').trim();\n" +
  "return text\n" +
  "  ? { hasDraft: true, draftMessage: { direction: 'outbound', body: text, approval_status: 'pending_approval', is_ai_reply: 'yes' } }\n" +
  "  : { hasDraft: false };";

export const FLOW_STARTER_TEMPLATES: FlowStarterTemplate[] = [
  {
    id: 'blank',
    name: 'Blank flow',
    slug: 'new-flow',
    description:
      'Start from a Trigger and an Output. Declare the inputs your flow receives on the Trigger, add steps between the two, and return a result from the Output.',
    summary: 'A Trigger + Output to build on.',
    nodeCapabilities: [],
    flowJson: {
      nodes: [
        { id: 'trigger', type: 'input', position: { x: 120, y: 160 }, data: { inputs: [{ name: 'value', example: 'hello' }] } },
        { id: 'out', type: 'output', position: { x: 480, y: 160 }, data: { value: { echo: '$inputs.value' } } },
      ],
      edges: [{ source: 'trigger', target: 'out' }],
    },
  },
  {
    id: 'caller-lookup',
    name: 'Caller lookup',
    slug: 'caller-lookup',
    description:
      'When a call comes in, the Trigger provides the caller\'s phone number. Find the first Customer whose phone matches, check whether one was found, and greet a known caller by name. The worked example from the node reference.',
    summary: 'Looks up a caller by phone, then greets them by name.',
    appHint: 'Works with the Aokie Receptionist app',
    nodeCapabilities: ['formlogic.responses.read'],
    flowJson: {
      nodes: [
        { id: 'trigger', type: 'input', position: { x: 60, y: 200 }, data: { inputs: [{ name: 'callerPhone', example: '+61400000000' }] } },
        {
          id: 'lookup',
          type: 'formlogic_list_responses',
          position: { x: 340, y: 200 },
          data: {
            form: 'REPLACE_WITH_CUSTOMERS_FORM_ID',
            filters: [{ field: 'phone', op: 'eq', value: '$inputs.callerPhone' }],
            return: 'first',
            limit: 50,
          },
        },
        { id: 'known', type: 'condition', position: { x: 640, y: 200 }, data: { expr: 'nodes.lookup.found' } },
        { id: 'greet', type: 'template', position: { x: 940, y: 110 }, data: { template: 'Welcome back, {{nodes.lookup.first.answers.name}}!' } },
        {
          id: 'out',
          type: 'output',
          position: { x: 1240, y: 200 },
          data: { value: { found: '$nodes.lookup.found', name: '$nodes.lookup.first.answers.name', greeting: '$nodes.greet' } },
        },
      ],
      edges: [
        { source: 'trigger', target: 'lookup' },
        { source: 'lookup', target: 'known' },
        { source: 'known', target: 'greet', sourceHandle: 'true' },
        { source: 'greet', target: 'out' },
        { source: 'known', target: 'out', sourceHandle: 'false' },
      ],
    },
  },
  {
    id: 'call-summary',
    name: 'Call summary',
    slug: 'call-summary',
    description:
      'The Trigger provides the call transcript. Build a prompt from it, ask the local AI for a two-sentence summary, and return that summary.',
    summary: 'Summarises a call transcript with the AI.',
    appHint: 'Works with the Aokie Receptionist app',
    nodeCapabilities: ['model.llm.local'],
    flowJson: {
      nodes: [
        { id: 'trigger', type: 'input', position: { x: 60, y: 180 }, data: { inputs: [{ name: 'transcript', example: 'Caller: Hi, I need to reschedule my Friday booking.' }] } },
        { id: 'context', type: 'template', position: { x: 340, y: 180 }, data: { template: 'Transcript:\n{{$inputs.transcript}}' } },
        {
          id: 'summary',
          type: 'llm_chat',
          position: { x: 620, y: 180 },
          data: {
            system: 'You are the note-taker for a small-business phone receptionist. Be brief and factual.',
            prompt: 'Summarise this phone call in at most two sentences.\n\n{{nodes.context}}',
            maxTokens: 200,
          },
        },
        { id: 'out', type: 'output', position: { x: 900, y: 180 }, data: { value: { summary: '$nodes.summary.content' } } },
      ],
      edges: [
        { source: 'trigger', target: 'context' },
        { source: 'context', target: 'summary' },
        { source: 'summary', target: 'out' },
      ],
    },
  },
  {
    id: 'sms-auto-draft',
    name: 'SMS auto-draft',
    slug: 'sms-auto-draft',
    description:
      'The Trigger provides the sender and the incoming SMS. Ask the local AI for a short reply, then return it as a pending-approval message for a human to approve before it is sent.',
    summary: 'Drafts an SMS reply for a human to approve.',
    appHint: 'Works with the Aokie Receptionist app',
    nodeCapabilities: ['model.llm.local'],
    flowJson: {
      nodes: [
        { id: 'trigger', type: 'input', position: { x: 60, y: 180 }, data: { inputs: [{ name: 'from', example: '+61400000000' }, { name: 'body', example: 'Are you open on Sunday?' }] } },
        {
          id: 'draft',
          type: 'llm_chat',
          position: { x: 360, y: 180 },
          data: {
            system: 'You draft short, friendly SMS replies for a small-business receptionist. Reply with the SMS text only — no preamble.',
            prompt: 'Draft a reply to this SMS from {{$inputs.from}}:\n\n{{$inputs.body}}',
            maxTokens: 120,
          },
        },
        { id: 'build', type: 'logic_block', position: { x: 640, y: 180 }, data: { expr: SMS_DRAFT_EXPR } },
        { id: 'out', type: 'output', position: { x: 920, y: 180 }, data: { value: { hasDraft: '$nodes.build.hasDraft', draftMessage: '$nodes.build.draftMessage' } } },
      ],
      edges: [
        { source: 'trigger', target: 'draft' },
        { source: 'draft', target: 'build' },
        { source: 'build', target: 'out' },
      ],
    },
  },
];

/** Slugify a name for the flow slug (a-z0-9 + single hyphens). */
export function slugifyFlowName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'new-flow';
}

/** The create payload for a chosen starter template + optional custom name (pure — testable). */
export interface FlowCreateInput {
  name: string;
  slug: string;
  description: string;
  template: FlowStarterTemplate;
}

/**
 * Build the "New flow" create payload from a selected template id + the (possibly blank) name box.
 * A blank name falls back to the template's name; the slug is derived from whichever name wins.
 */
export function buildFlowCreateInput(templateId: string, name: string): FlowCreateInput {
  const template = FLOW_STARTER_TEMPLATES.find((t) => t.id === templateId) ?? FLOW_STARTER_TEMPLATES[0];
  const trimmed = name.trim();
  // Quick-create: a blank Blank flow gets an auto "Untitled flow" name so it can be created in one
  // click; the purposeful templates fall back to their own name. FlowsWorkspace dedupes the slug.
  const blankFallback = template.id === 'blank';
  const effectiveName = trimmed || (blankFallback ? 'Untitled flow' : template.name);
  return {
    name: effectiveName,
    slug: slugifyFlowName(trimmed || (blankFallback ? 'untitled-flow' : template.slug)),
    description: template.description,
    template,
  };
}
