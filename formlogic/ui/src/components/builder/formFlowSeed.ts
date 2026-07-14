// Pure helpers for the builder's "create a flow for this form" path.
//
// The UI composes these helpers with formFlowBindingsSerialize.ts rather than changing that
// protected serializer: field ids become the same $event.data.answers.<fieldId> selectors the
// form-side and flow-side binding editors already understand.
import type { FormField } from '../../types/form';
import type { FlowDefinition, WorkflowGraph } from '../../types/flows';
import { FLOW_STARTER_TEMPLATES, slugifyFlowName } from '../flows/starterTemplates';
import { declaredInputNames } from '../flows/editor/nodeSummary';
import { fieldSelector } from './formFlowBindingsSerialize';

export const FORM_SUBMISSION_TEMPLATE_ID = 'form-submission';

const NON_ANSWER_FIELD_TYPES = new Set(['welcome_screen', 'thank_you', 'statement']);

export interface SeededFormFlow {
  name: string;
  slug: string;
  description: string;
  flowJson: WorkflowGraph;
  nodeCapabilities: string[];
  inputMap: Record<string, string>;
  exampleAnswers: Record<string, unknown>;
}

export function realAnswerFields(fields: readonly FormField[]): FormField[] {
  return fields.filter((field) => !NON_ANSWER_FIELD_TYPES.has(field.type));
}

export function triggerInputNamesFromFlow(flow: Pick<FlowDefinition, 'flowJson'> | null | undefined): string[] {
  if (!flow) return [];
  const trigger = flow.flowJson.nodes.find((node) => node.type === 'input');
  return trigger ? declaredInputNames((trigger.data ?? {}) as Record<string, unknown>) : [];
}

function dedupeSlug(base: string, existingSlugs: readonly string[]): string {
  const used = new Set(existingSlugs);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

function sampleAnswer(field: FormField): unknown {
  if (field.type === 'checkboxes') return ['Option 1'];
  if (field.type === 'rating' || field.type === 'scale' || field.type === 'number') return 5;
  if (field.type === 'email') return 'person@example.com';
  if (field.type === 'phone') return '+61400000000';
  if (field.type === 'date') return '2026-01-01';
  if (field.type === 'time') return '09:00';
  if (field.type === 'datetime') return '2026-01-01T09:00:00';
  if (field.type === 'dropdown' || field.type === 'multiple_choice') {
    return field.properties.options?.[0]?.value ?? field.properties.options?.[0]?.label ?? 'Option 1';
  }
  return field.label || field.id;
}

/**
 * Build the workspace/app flow create payload plus its initial form.submitted inputMap.
 * The base starter template declares formId/responseId/answers; this seeded graph also exposes
 * each real field id as a Trigger input so the binding editor can offer those inputs by name.
 */
export function buildFormSubmissionFlowSeed(params: {
  formTitle: string;
  fields: readonly FormField[];
  existingSlugs?: readonly string[];
}): SeededFormFlow {
  const title = params.formTitle.trim() || 'Untitled form';
  const name = `${title} — on submit`;
  const slug = dedupeSlug(slugifyFlowName(name), params.existingSlugs ?? []);
  const template = FLOW_STARTER_TEMPLATES.find((item) => item.id === FORM_SUBMISSION_TEMPLATE_ID);
  if (!template) throw new Error('Missing form-submission starter template');

  const fields = realAnswerFields(params.fields);
  const firstField = fields[0]?.id;
  const fieldInputs = fields.map((field) => ({ name: field.id, example: sampleAnswer(field) }));
  const exampleAnswers = Object.fromEntries(fields.map((field) => [field.id, sampleAnswer(field)]));
  const inputMap: Record<string, string> = {
    formId: '$event.data.formId',
    responseId: '$event.data.responseId',
    answers: '$event.data.answers',
  };
  for (const field of fields) inputMap[field.id] = fieldSelector(field.id);

  const flowJson: WorkflowGraph = {
    nodes: template.flowJson.nodes.map((node) => {
      if (node.id === 'trigger') {
        return {
          ...node,
          data: {
            inputs: [
              { name: 'formId', example: 'form_123' },
              { name: 'responseId', example: 'response_123' },
              { name: 'answers', example: exampleAnswers },
              ...fieldInputs,
            ],
          },
        };
      }
      if (node.id === 'summary') {
        return {
          ...node,
          data: {
            template: firstField
              ? `New {{inputs.answers.${firstField}}} submission for ${title}`
              : `New form submission for ${title}`,
          },
        };
      }
      return { ...node };
    }),
    edges: template.flowJson.edges.map((edge) => ({ ...edge })),
  };

  return {
    name,
    slug,
    description: `Runs when ${title} is submitted.`,
    flowJson,
    nodeCapabilities: [...template.nodeCapabilities],
    inputMap,
    exampleAnswers,
  };
}
