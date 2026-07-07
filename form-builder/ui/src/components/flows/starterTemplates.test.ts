import { describe, expect, it } from 'vitest';
import { FLOW_STARTER_TEMPLATES, buildFlowCreateInput, slugifyFlowName } from './starterTemplates';
import { validateWorkflowGraph } from '../../client-runtime/flows/flowExecutor';
import { lintFlowGraph, triggerInputNames } from './flowGraphLint';

describe('flow starter templates', () => {
  it('every template ships a valid v0 WorkflowGraph', () => {
    for (const t of FLOW_STARTER_TEMPLATES) {
      expect(validateWorkflowGraph(t.flowJson), t.id).toBeNull();
    }
  });

  it('every template lints clean (refs resolve, condition branches routed)', () => {
    for (const t of FLOW_STARTER_TEMPLATES) {
      expect(lintFlowGraph(t.flowJson), t.id).toEqual([]);
    }
  });

  it('every template has a Trigger node that declares its inputs', () => {
    for (const t of FLOW_STARTER_TEMPLATES) {
      const trigger = t.flowJson.nodes.find((n) => n.type === 'input');
      expect(trigger, `${t.id} has a Trigger`).toBeDefined();
      expect(triggerInputNames(t.flowJson).length, `${t.id} declares inputs`).toBeGreaterThan(0);
    }
  });

  it('caller-lookup finds the first Customer by $inputs.callerPhone, branches, and greets by name', () => {
    const t = FLOW_STARTER_TEMPLATES.find((x) => x.id === 'caller-lookup')!;
    // The Trigger declares callerPhone — the single, visible source of the flow input.
    expect(triggerInputNames(t.flowJson)).toContain('callerPhone');
    const lookup = t.flowJson.nodes.find((n) => n.id === 'lookup')!;
    expect(lookup.type).toBe('formlogic_list_responses');
    expect((lookup.data as { filters: unknown[] }).filters).toEqual([
      { field: 'phone', op: 'eq', value: '$inputs.callerPhone' },
    ]);
    expect((lookup.data as { return?: string }).return).toBe('first');
    // Branch on the structured `found`, greet with `first.answers.name`.
    const known = t.flowJson.nodes.find((n) => n.id === 'known')!;
    expect((known.data as { expr: string }).expr).toContain('nodes.lookup.found');
    const greet = t.flowJson.nodes.find((n) => n.id === 'greet')!;
    expect((greet.data as { template: string }).template).toContain('nodes.lookup.first.answers.name');
  });
});

describe('buildFlowCreateInput', () => {
  it('selects the chosen template and auto-fills the name when the box is blank', () => {
    const out = buildFlowCreateInput('caller-lookup', '');
    expect(out.template.id).toBe('caller-lookup');
    expect(out.name).toBe('Caller lookup');
    expect(out.slug).toBe('caller-lookup');
    expect(out.description).toBe(out.template.description);
  });

  it('uses a custom name + derived slug when the box is filled', () => {
    const out = buildFlowCreateInput('blank', '  My Cool Flow!  ');
    expect(out.template.id).toBe('blank');
    expect(out.name).toBe('My Cool Flow!');
    expect(out.slug).toBe('my-cool-flow');
  });

  it('falls back to the blank template for an unknown id', () => {
    expect(buildFlowCreateInput('nope', '').template.id).toBe('blank');
  });

  it('auto-names a blank Blank flow "Untitled flow" for one-click quick create', () => {
    const out = buildFlowCreateInput('blank', '   ');
    expect(out.template.id).toBe('blank');
    expect(out.name).toBe('Untitled flow');
    expect(out.slug).toBe('untitled-flow');
  });

  it('slugifyFlowName never yields an empty slug', () => {
    expect(slugifyFlowName('   ')).toBe('new-flow');
    expect(slugifyFlowName('!!!')).toBe('new-flow');
  });
});
