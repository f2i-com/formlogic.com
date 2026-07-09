import { describe, expect, it } from 'vitest';
import type { FormField } from '../../types/form';
import type { FlowDefinition } from '../../types/flows';
import { buildFormSubmissionFlowSeed, triggerInputNamesFromFlow } from './formFlowSeed';

const fields: FormField[] = [
  {
    id: 'name',
    type: 'short_text',
    label: 'Customer name',
    required: true,
    properties: {},
    order: 0,
  },
  {
    id: 'notes',
    type: 'long_text',
    label: 'Notes',
    required: false,
    properties: {},
    order: 1,
  },
  {
    id: 'intro',
    type: 'statement',
    label: 'Intro copy',
    required: false,
    properties: {},
    order: 2,
  },
];

describe('buildFormSubmissionFlowSeed', () => {
  it('builds a form-submission graph and inputMap from real answer fields', () => {
    const seed = buildFormSubmissionFlowSeed({
      formTitle: 'Client intake',
      fields,
      existingSlugs: ['client-intake-on-submit'],
    });

    expect(seed.name).toBe('Client intake — on submit');
    expect(seed.slug).toBe('client-intake-on-submit-2');
    expect(seed.inputMap).toEqual({
      formId: '$event.data.formId',
      responseId: '$event.data.responseId',
      answers: '$event.data.answers',
      name: '$event.data.answers.name',
      notes: '$event.data.answers.notes',
    });
    expect(seed.exampleAnswers).toEqual({ name: 'Customer name', notes: 'Notes' });
    expect(seed.flowJson.nodes.map((node) => node.type)).toEqual(['input', 'template', 'output']);
    expect(triggerInputNamesFromFlow({ flowJson: seed.flowJson } as FlowDefinition)).toEqual([
      'formId',
      'responseId',
      'answers',
      'name',
      'notes',
    ]);
  });
});

describe('triggerInputNamesFromFlow', () => {
  it('extracts names declared on the Trigger node', () => {
    const seed = buildFormSubmissionFlowSeed({ formTitle: 'X', fields });
    expect(triggerInputNamesFromFlow({ flowJson: seed.flowJson } as FlowDefinition)).toContain('name');
  });

  it('returns an empty list when the flow has no Trigger', () => {
    expect(triggerInputNamesFromFlow({
      flowJson: { nodes: [{ id: 'out', type: 'output' }], edges: [] },
    } as FlowDefinition)).toEqual([]);
  });
});
