// nodeCatalog ↔ executor parity (docs/FORMLOGIC_FLOWS.md §4, §9).
//
// The editor's node catalog and the v0 executor must agree on the executable node set exactly:
// a palette node the runner can't execute would let an author build a flow that fails at run
// time with `invalid_flow`, and an executor node missing from the catalog would be un-authorable.
import { describe, expect, it } from 'vitest';
import {
  CATALOG_EXECUTABLE_TYPES,
  EMPTY_FLOW_EDITOR_CONTEXT,
  NODE_SPECS,
  effectiveNodeData,
  evalShowIf,
  formatChipInsert,
  getNodeSpec,
  getReferenceSyntax,
  initialNodeData,
  isNodeAvailableInContext,
  type FlowEditorContext,
  type NodePropertySpec,
} from './nodeCatalog';
import { EXECUTABLE_NODE_TYPES } from '../../../client-runtime/flows/nodes';

describe('nodeCatalog ↔ executor parity', () => {
  it('every executable catalog node type is implemented by the executor', () => {
    const executor = new Set<string>(EXECUTABLE_NODE_TYPES);
    const missing = CATALOG_EXECUTABLE_TYPES.filter((t) => !executor.has(t));
    expect(missing).toEqual([]);
  });

  it('every executor node type has a catalog spec', () => {
    const catalog = new Set(CATALOG_EXECUTABLE_TYPES);
    const missing = EXECUTABLE_NODE_TYPES.filter((t) => !catalog.has(t));
    expect(missing).toEqual([]);
  });

  it('the two executable sets are identical', () => {
    expect([...CATALOG_EXECUTABLE_TYPES].sort()).toEqual([...EXECUTABLE_NODE_TYPES].sort());
  });

  it('every executable spec is marked executable and every executor spec resolves', () => {
    for (const type of EXECUTABLE_NODE_TYPES) {
      const spec = getNodeSpec(type);
      expect(spec, `missing spec for ${type}`).toBeDefined();
      expect(spec?.executable, `${type} must be executable`).toBe(true);
    }
  });

  it('display-only nodes are not in the executable set', () => {
    const executor = new Set<string>(EXECUTABLE_NODE_TYPES);
    for (const spec of NODE_SPECS) {
      if (!spec.executable) expect(executor.has(spec.type)).toBe(false);
    }
  });

  it('node ids are unique across the catalog', () => {
    const seen = new Set<string>();
    for (const s of NODE_SPECS) {
      expect(seen.has(s.type), `duplicate node type ${s.type}`).toBe(false);
      seen.add(s.type);
    }
  });

  it('every executable spec has an Output descriptor for the properties panel + docs', () => {
    for (const type of EXECUTABLE_NODE_TYPES) {
      const spec = getNodeSpec(type);
      expect(spec?.output, `${type} is missing an output descriptor`).toBeTruthy();
    }
  });

  it('initialNodeData seeds property/default values', () => {
    const http = getNodeSpec('http_request');
    expect(http).toBeDefined();
    // http_request's method select has a GET default.
    expect(initialNodeData(http!).method).toBe('GET');
    // input has no properties → empty seed.
    expect(initialNodeData(getNodeSpec('input')!)).toEqual({});
  });
});

describe('context-aware palette (docs §4)', () => {
  const aokieSpeak = getNodeSpec('aokie_speak')!;
  const workspaceCtx = EMPTY_FLOW_EDITOR_CONTEXT;
  const aokieCtx: FlowEditorContext = {
    appScoped: true,
    connectors: [{ id: 'aokie', commands: ['call.operatorSpeak', 'sms.send'] }],
  };

  it('hides connector-gated nodes (aokie_speak) in a workspace flow with no app context', () => {
    expect(isNodeAvailableInContext(aokieSpeak, workspaceCtx)).toBe(false);
  });

  it('shows aokie_speak when an installed app provides the aokie connector', () => {
    expect(isNodeAvailableInContext(aokieSpeak, aokieCtx)).toBe(true);
  });

  it('hides aokie_speak in an app that does not grant the aokie connector', () => {
    expect(isNodeAvailableInContext(aokieSpeak, { appScoped: true, connectors: [{ id: 'stripe', commands: [] }] })).toBe(false);
  });

  it('always shows generic nodes regardless of context', () => {
    for (const type of ['input', 'output', 'condition', 'template', 'logic_block', 'llm_chat', 'http_request', 'formlogic_list_responses', 'connector_request', 'storage_get', 'storage_set']) {
      expect(isNodeAvailableInContext(getNodeSpec(type)!, workspaceCtx), `${type} should always show`).toBe(true);
    }
  });

  it('models speech nodes as endpoint-based AI nodes, not desktop-service-required nodes', () => {
    for (const type of ['stt_transcribe', 'tts_speak']) {
      const spec = getNodeSpec(type)!;
      expect(spec.category).toBe('ai');
      expect(spec.requiresDesktopService).toBeUndefined();
      expect(spec.description).toContain('OpenAI-compatible endpoint');
      expect(spec.properties.find((property) => property.key === 'service')?.type).toBe('desktopService');
    }
  });

  it('uses the registry human name for the Krea image service picker/badge', () => {
    const spec = getNodeSpec('image_gen')!;
    expect(spec.requiresDesktopService).toBe('Krea-2 Turbo (Text-to-Image)');
    expect(spec.properties.find((property) => property.key === 'service')?.type).toBe('desktopService');
  });
});

describe('evalShowIf (conditional property visibility)', () => {
  it('shows when there is no predicate', () => {
    expect(evalShowIf(undefined, {})).toBe(true);
  });

  it('equals: shows only on a strict match', () => {
    expect(evalShowIf({ property: 'action', equals: 'goto' }, { action: 'goto' })).toBe(true);
    expect(evalShowIf({ property: 'action', equals: 'goto' }, { action: 'click' })).toBe(false);
    expect(evalShowIf({ property: 'action', equals: 'goto' }, {})).toBe(false);
  });

  it('notEquals: hides only on a match (http body hidden for GET)', () => {
    expect(evalShowIf({ property: 'method', notEquals: 'GET' }, { method: 'POST' })).toBe(true);
    expect(evalShowIf({ property: 'method', notEquals: 'GET' }, { method: 'GET' })).toBe(false);
  });

  it('in: shows when the value is one of the set', () => {
    const showIf = { property: 'action', in: ['click', 'type', 'extract_text'] };
    expect(evalShowIf(showIf, { action: 'type' })).toBe(true);
    expect(evalShowIf(showIf, { action: 'goto' })).toBe(false);
  });

  it('ANDs multiple clauses', () => {
    const showIf = { property: 'action', equals: 'type', notEquals: 'type' }; // contradictory → never
    expect(evalShowIf(showIf, { action: 'type' })).toBe(false);
  });

  it('reflects the real catalog: browser_action gates fields on the action', () => {
    const spec = getNodeSpec('browser_action')!;
    const url = spec.properties.find((p) => p.key === 'url')!;
    const script = spec.properties.find((p) => p.key === 'script')!;
    expect(evalShowIf(url.showIf, { action: 'goto' })).toBe(true);
    expect(evalShowIf(url.showIf, { action: 'evaluate' })).toBe(false);
    expect(evalShowIf(script.showIf, { action: 'evaluate' })).toBe(true);
  });
});

describe('getReferenceSyntax + formatChipInsert (chip-insert must match the executor\'s resolution mechanism)', () => {
  const field = (over: Partial<NodePropertySpec> = {}): NodePropertySpec => ({
    key: 'x',
    label: 'X',
    type: 'text',
    ...over,
  });

  it('defaults a plain text/textarea field to selector (resolveSelector / resolveDeep both want the bare string)', () => {
    expect(getReferenceSyntax(field({ type: 'text' }))).toBe('selector');
    expect(getReferenceSyntax(field({ type: 'textarea' }))).toBe('selector');
  });

  it('infers quickjs from a code field with quickjs:true, without needing an explicit override', () => {
    expect(getReferenceSyntax(field({ type: 'code', quickjs: true }))).toBe('quickjs');
  });

  it('defaults a JSON code field (quickjs falsy) to selector — resolveDeep wants a bare selector string', () => {
    expect(getReferenceSyntax(field({ type: 'code', quickjs: false, language: 'json' }))).toBe('selector');
    expect(getReferenceSyntax(field({ type: 'code' }))).toBe('selector');
  });

  it('an explicit referenceSyntax always wins over the inferred default', () => {
    expect(getReferenceSyntax(field({ type: 'textarea', referenceSyntax: 'template' }))).toBe('template');
    expect(getReferenceSyntax(field({ type: 'code', quickjs: true, referenceSyntax: 'selector' }))).toBe('selector');
  });

  it('every field explicitly marked template in the real catalog resolves via interpolateTemplate in nodes.ts (cross-checked field list)', () => {
    // Each pair is [nodeType, propertyKey] for a field this session confirmed is interpolateTemplate-resolved.
    const expected: Array<[string, string]> = [
      ['template', 'template'],
      ['llm_chat', 'system'],
      ['llm_chat', 'prompt'],
      ['llm_chat', 'model'],
      ['http_request', 'url'],
      ['aokie_speak', 'text'],
      ['browser_action', 'url'],
      ['browser_action', 'text'],
      ['image_gen', 'prompt'],
      ['tts_speak', 'text'],
    ];
    for (const [type, key] of expected) {
      const spec = getNodeSpec(type)!;
      const prop = spec.properties.find((p) => p.key === key)!;
      expect(prop, `${type}.${key} should exist`).toBeDefined();
      expect(getReferenceSyntax(prop), `${type}.${key} should be 'template'`).toBe('template');
    }
  });

  it('formatChipInsert: selector mode inserts the bare string unchanged', () => {
    expect(formatChipInsert('$nodes.lookup.first', 'selector')).toBe('$nodes.lookup.first');
    expect(formatChipInsert('$inputs.callerPhone', 'selector')).toBe('$inputs.callerPhone');
    expect(formatChipInsert('$event', 'selector')).toBe('$event');
  });

  it('formatChipInsert: template mode wraps the selector in {{ }} (interpolateTemplate tolerates the leading $)', () => {
    expect(formatChipInsert('$nodes.lookup.first', 'template')).toBe('{{ $nodes.lookup.first }}');
    expect(formatChipInsert('$event', 'template')).toBe('{{ $event }}');
  });

  it('formatChipInsert: quickjs mode strips the leading $ to the plain JS variable the sandbox exposes', () => {
    expect(formatChipInsert('$nodes.lookup.first', 'quickjs')).toBe('nodes.lookup.first');
    expect(formatChipInsert('$inputs.name', 'quickjs')).toBe('inputs.name');
    expect(formatChipInsert('$event', 'quickjs')).toBe('event');
  });

  it('formatChipInsert: quickjs mode bracket-quotes a node id containing a hyphen (real shape: mintNodeId yields `<type>-<n>`)', () => {
    // A bare `.` would parse as `nodes.condition - 1` (subtraction), not a property lookup —
    // this is the exact hint FlowEditor's insertHints emits for every non-trigger node.
    expect(formatChipInsert('$nodes.condition-1', 'quickjs')).toBe('nodes["condition-1"]');
    expect(formatChipInsert('$nodes.http_request-2', 'quickjs')).toBe('nodes["http_request-2"]');
  });

  it('formatChipInsert: quickjs mode bracket-quotes any non-identifier path segment, not just the node id', () => {
    expect(formatChipInsert('$nodes.condition-1.found', 'quickjs')).toBe('nodes["condition-1"].found');
    expect(formatChipInsert('$inputs.caller phone', 'quickjs')).toBe('inputs["caller phone"]');
  });
});

describe('effectiveNodeData (fills spec defaults so showIf keys off defaulted selects)', () => {
  it('fills an unset property from its default', () => {
    const http = getNodeSpec('http_request')!;
    // method defaults to GET → a graph that never persisted it still hides the body.
    expect(effectiveNodeData(http, {}).method).toBe('GET');
  });

  it('leaves set values untouched and returns the same object when nothing to fill', () => {
    const http = getNodeSpec('http_request')!;
    expect(effectiveNodeData(http, { method: 'POST' }).method).toBe('POST');
    const input = getNodeSpec('input')!;
    const data = { inputs: [] };
    expect(effectiveNodeData(input, data)).toBe(data); // no defaults → identity
  });
});
