// FormLogic Flows editor — flow_call authoring checks (extensible-flows plan §6.4 first
// consumer: the assignability lattice wired into the property panel).
//
// Edges in this engine carry ACTIVATION, not data — data rides `$` selectors — so "wire
// checks" live where values actually bind: the flow_call node's input mapping against the
// child flow's advertised contract (its Trigger-declared input names + optional §6.5-subset
// inputSchema). Everything here is presentation-time advice: nothing blocks a save, and the
// runtime keeps its own validation. Conservative like the lattice itself: a `$` selector or
// an unknown child proves nothing and stays quiet/amber — never a false green, never a
// false error.
import { assignability, normalizePortType, type AssignabilityLevel, type NormalizedPortType } from '../../../lib/schema/flowAssignability';
import { declaredInputNames } from './nodeSummary';
import type { FlowPickOption } from './nodeCatalog';
import type { FlowDefinition, WorkflowGraph } from '../../../types/flows';

export interface FlowCallIssue {
  severity: 'error' | 'warn' | 'info';
  /** The input-mapping key the issue is about; absent for whole-mapping issues. */
  key?: string;
  message: string;
}

/** Build the flow-picker options a context carries from full flow definitions. */
export function flowPickOptions(flows: FlowDefinition[]): FlowPickOption[] {
  return flows.map((flow) => {
    const trigger = (flow.flowJson as WorkflowGraph | undefined)?.nodes?.find((n) => n.type === 'input');
    return {
      id: flow.id,
      name: flow.name,
      slug: flow.slug,
      declaredInputs: trigger ? declaredInputNames((trigger.data ?? {}) as Record<string, unknown>) : [],
      inputSchema: flow.inputSchema ?? null,
    };
  });
}

/**
 * The §6.4 input contract of one catalog service action — the service_action panel's
 * checks reuse the flow_call machinery (same conservative rules, different source of
 * truth: the Desktop v3 catalog's declared `inputSchema` instead of a sibling flow's).
 * Null when the action declares no inputSchema: nothing provable, so nothing flagged.
 */
export function serviceActionContract(
  action: { id: string; title?: string; inputSchema?: Record<string, unknown> } | null | undefined,
): FlowPickOption | null {
  if (!action?.inputSchema || typeof action.inputSchema !== 'object') return null;
  return {
    id: action.id,
    name: action.title && action.title !== '' ? action.title : action.id,
    slug: action.id,
    declaredInputs: [],
    inputSchema: action.inputSchema,
  };
}

/** The lattice type of a LITERAL mapping value (never a selector — callers filter those). */
export function literalPortType(value: unknown): NormalizedPortType {
  if (value === null) return { types: ['null'] };
  switch (typeof value) {
    case 'string':
      return { types: ['string'] };
    case 'boolean':
      return { types: ['boolean'] };
    case 'number':
      return { types: [Number.isInteger(value) ? 'integer' : 'number'] };
    case 'object':
      if (Array.isArray(value)) {
        return { types: ['array'] };
      }
      return { types: ['object'] };
    default:
      return { types: ['any'] };
  }
}

function isSelector(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}

function schemaProperties(schema: FlowPickOption['inputSchema']): Record<string, unknown> {
  const props = schema && typeof schema === 'object' ? (schema as Record<string, unknown>).properties : undefined;
  return props && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
}

function schemaRequired(schema: FlowPickOption['inputSchema']): string[] {
  const req = schema && typeof schema === 'object' ? (schema as Record<string, unknown>).required : undefined;
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : [];
}

const SEVERITY_ORDER: Record<FlowCallIssue['severity'], number> = { error: 0, warn: 1, info: 2 };

/**
 * Static advice for a flow_call node's `input` mapping against the picked child. The
 * checks mirror how the runtime reads the node (nodes.ts runFlowCall): the mapping is
 * resolveDeep'd, non-object results collapse to {}, and each child input is looked up by
 * key. Levels map per plan §6.4: exact stays silent, widening/runtime-checkable inform,
 * conversion-required/incompatible error (values are never coerced silently).
 */
export function checkFlowCallInput(input: unknown, child: FlowPickOption | null): FlowCallIssue[] {
  const issues: FlowCallIssue[] = [];

  if (isSelector(input)) {
    issues.push({ severity: 'info', message: 'The whole input object comes from a selector — keys are checked at run time.' });
    return issues;
  }
  if (typeof input === 'string' && input.trim() !== '') {
    issues.push({ severity: 'warn', message: 'Input is not valid JSON — it was kept as raw text and the child will receive no inputs.' });
    return issues;
  }
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    issues.push({ severity: 'warn', message: 'Input must be a JSON object of child-input values — anything else runs the child with no inputs.' });
    return issues;
  }
  if (!child) return issues;

  const mapping = (input ?? {}) as Record<string, unknown>;
  const properties = schemaProperties(child.inputSchema);
  const required = new Set(schemaRequired(child.inputSchema));
  const declared = new Set<string>([...child.declaredInputs, ...Object.keys(properties)]);

  for (const name of declared) {
    if (name in mapping) continue;
    if (required.has(name)) {
      issues.push({ severity: 'error', key: name, message: `Missing required input "${name}".` });
    } else {
      issues.push({ severity: 'info', key: name, message: `"${name}" is not provided — the child sees undefined.` });
    }
  }

  for (const [key, value] of Object.entries(mapping)) {
    if (declared.size > 0 && !declared.has(key)) {
      issues.push({ severity: 'warn', key, message: `"${key}" is not one of ${child.name}'s declared inputs — check for a typo.` });
      continue;
    }
    const propSchema = properties[key];
    if (propSchema === undefined || isSelector(value)) continue; // untyped or resolved at run time
    const result = assignability(literalPortType(value), normalizePortType(propSchema));
    const messageFor: Record<AssignabilityLevel, string | null> = {
      'exact': null,
      'safe-widening': `"${key}": ${result.note ?? 'safe widening'}.`,
      'runtime-checkable': `"${key}": ${result.note ?? 'validated at run time'}.`,
      'conversion-required': `"${key}": this value ${result.note ?? 'needs an explicit conversion'} — the child would refuse it.`,
      'incompatible': `"${key}": ${result.note ?? 'these types can never match'}.`,
    };
    const message = messageFor[result.level];
    if (message === null) continue;
    issues.push({
      severity: result.level === 'conversion-required' || result.level === 'incompatible' ? 'error' : 'info',
      key,
      message,
    });
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.key ?? '').localeCompare(b.key ?? ''));
  return issues;
}
