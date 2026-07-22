// flow_call authoring checks (§6.4 lattice wired into the property panel). Pins the
// conservative contract: selectors and unknown children stay quiet/amber, literal type
// mismatches error only at conversion-required/incompatible, and the child's contract is
// the union of Trigger-declared names and inputSchema properties.
import { describe, expect, it } from 'vitest';
import { checkFlowCallInput, flowPickOptions, literalPortType } from './flowCallChecks';
import type { FlowPickOption } from './nodeCatalog';
import type { FlowDefinition } from '../../../types/flows';

function child(overrides: Partial<FlowPickOption>): FlowPickOption {
  return { id: 'child-1', name: 'Child', slug: 'child', declaredInputs: [], inputSchema: null, ...overrides };
}

describe('flowPickOptions', () => {
  it('derives declared inputs from the Trigger node and passes inputSchema through', () => {
    const flow = {
      id: 'f1',
      ownerUserId: 'o',
      appId: 'a',
      name: 'F',
      slug: 'f',
      description: null,
      engine: 'formlogic@1',
      flowJson: {
        nodes: [{ id: 'trigger', type: 'input', position: { x: 0, y: 0 }, data: { inputs: [{ name: 'customerId' }, { name: 'note' }] } }],
        edges: [],
      },
      inputSchema: { type: 'object', properties: { customerId: { type: 'string' } } },
      outputSchema: null,
      nodeCapabilities: null,
      version: 1,
      enabled: true,
      createdAt: '',
      updatedAt: '',
    } as unknown as FlowDefinition;
    const [option] = flowPickOptions([flow]);
    expect(option.declaredInputs).toEqual(['customerId', 'note']);
    expect(option.inputSchema).toEqual({ type: 'object', properties: { customerId: { type: 'string' } } });
  });
});

describe('literalPortType', () => {
  it('maps JSON literals onto the lattice', () => {
    expect(literalPortType('x').types).toEqual(['string']);
    expect(literalPortType(3).types).toEqual(['integer']);
    expect(literalPortType(3.5).types).toEqual(['number']);
    expect(literalPortType(true).types).toEqual(['boolean']);
    expect(literalPortType(null).types).toEqual(['null']);
    expect(literalPortType([1]).types).toEqual(['array']);
    expect(literalPortType({ a: 1 }).types).toEqual(['object']);
  });
});

describe('checkFlowCallInput', () => {
  it('is quiet for an empty mapping against an unknown child', () => {
    expect(checkFlowCallInput(undefined, null)).toEqual([]);
    expect(checkFlowCallInput({}, null)).toEqual([]);
  });

  it('a whole-object selector defers everything to run time (one info line)', () => {
    const issues = checkFlowCallInput('$inputs.childArgs', child({ declaredInputs: ['a'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
  });

  it('warns when the input was kept as raw non-JSON text', () => {
    const issues = checkFlowCallInput('{ broken', child({}));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].message).toContain('not valid JSON');
  });

  it('warns on a non-object mapping (arrays run the child with no inputs)', () => {
    expect(checkFlowCallInput([1, 2], child({}))[0]?.severity).toBe('warn');
  });

  it('errors on missing required inputs and infos on missing declared ones', () => {
    const c = child({
      declaredInputs: ['customerId', 'note'],
      inputSchema: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string' } } },
    });
    const issues = checkFlowCallInput({}, c);
    expect(issues.find((i) => i.key === 'customerId')?.severity).toBe('error');
    expect(issues.find((i) => i.key === 'note')?.severity).toBe('info');
  });

  it('flags keys outside the declared contract as probable typos', () => {
    const issues = checkFlowCallInput({ customerid: 'x' }, child({ declaredInputs: ['customerId'] }));
    const typo = issues.find((i) => i.key === 'customerid');
    expect(typo?.severity).toBe('warn');
    expect(typo?.message).toContain('typo');
  });

  it('accepts any key when the child declares no contract at all', () => {
    expect(checkFlowCallInput({ whatever: 1 }, child({}))).toEqual([]);
  });

  it('applies §6.4 levels to literal values against inputSchema properties', () => {
    const c = child({
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          flag: { type: 'boolean' },
        },
      },
    });
    // exact: silent; integer→number: safe-widening info; string→boolean: conversion error.
    const issues = checkFlowCallInput({ name: 'x', count: 3, flag: 'yes' }, c);
    expect(issues.filter((i) => i.key === 'name')).toEqual([]);
    expect(issues.find((i) => i.key === 'count')?.severity).toBe('info');
    const flag = issues.find((i) => i.key === 'flag');
    expect(flag?.severity).toBe('error');
    expect(flag?.message).toContain('conversion');
  });

  it('never judges selector values against the schema (runtime checks own them)', () => {
    const c = child({ inputSchema: { type: 'object', properties: { flag: { type: 'boolean' } } } });
    expect(checkFlowCallInput({ flag: '$nodes.check.result' }, c)).toEqual([]);
  });

  it('orders errors before warns before infos', () => {
    const c = child({
      declaredInputs: ['note'],
      inputSchema: { type: 'object', required: ['customerId'], properties: { customerId: { type: 'string' } } },
    });
    const issues = checkFlowCallInput({ extra: 1 }, c);
    expect(issues.map((i) => i.severity)).toEqual(['error', 'warn', 'info']);
  });
});
