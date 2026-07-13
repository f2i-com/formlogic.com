// FormLogic Flows editor — plain-language node summaries.
//
// Turns a node's stored `data` into ONE short sentence describing what it does with its current
// config, so the canvas reads like a chain of rules ("Find Customers where phone is
// {{$inputs.callerPhone}}") instead of a row of type slugs. Presentation only — never executes.
import type { FlowFilterOp } from '../../../client-runtime/flows/nodes';

/** A form the summary can name (id → title), so a picked form reads by name, not its UUID. */
export interface NodeSummaryForms {
  titleById(id: string): string | undefined;
}

const OP_WORDS: Record<FlowFilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  gt: '>',
  lt: '<',
  in: 'is one of',
  phone_eq: 'phone matches',
};

/** Trim a value/selector to something short and readable for a one-line summary. */
function short(v: unknown, max = 28): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** How a Find records / Submit / Update node should name its form (title if known, else the ref). */
function formLabel(data: Record<string, unknown>, forms?: NodeSummaryForms): string | null {
  const raw = data.form ?? data.formId;
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.startsWith('$')) return short(raw);
  if (raw.startsWith('@pack:')) return raw.slice('@pack:'.length);
  return forms?.titleById(raw) ?? short(raw);
}

/** One AND-ed filter rendered as "field is value". */
function filterPhrase(f: unknown): string | null {
  if (!f || typeof f !== 'object') return null;
  const r = f as { field?: unknown; op?: unknown; value?: unknown };
  if (typeof r.field !== 'string' || r.field === '') return null;
  const op = OP_WORDS[(r.op as FlowFilterOp) in OP_WORDS ? (r.op as FlowFilterOp) : 'eq'];
  const val = short(r.value);
  return `${r.field} ${op}${val ? ` ${val}` : ''}`;
}

/**
 * A single plain-language sentence for a node given its type + data, or null when there's nothing
 * configured yet (the card then shows just the node label). `forms` lets Find/Submit name the form.
 */
export function describeNode(
  type: string,
  data: Record<string, unknown>,
  forms?: NodeSummaryForms,
): string | null {
  switch (type) {
    case 'input': {
      const names = declaredInputNames(data);
      if (names.length === 0) return 'Provides no inputs yet';
      return `Provides ${names.map((n) => `$inputs.${n}`).join(', ')}`;
    }

    case 'output': {
      if (data.value === undefined) return 'Returns the previous step';
      return `Returns ${short(data.value, 40)}`;
    }

    case 'condition': {
      const expr = pickString(data, ['expr', 'expression', 'condition']);
      return expr ? `If ${short(expr, 40)}` : null;
    }

    case 'template': {
      const t = pickString(data, ['template', 'text']);
      return t ? short(t, 44) : null;
    }

    case 'logic_block':
      return 'Runs a bit of code';

    case 'llm_chat': {
      const prompt = pickString(data, ['prompt']);
      return prompt ? `Asks the AI: ${short(prompt, 34)}` : 'Asks the AI';
    }

    case 'http_request': {
      const method = pickString(data, ['method']) || 'GET';
      const url = pickString(data, ['url']);
      return url ? `${method.toUpperCase()} ${short(url, 32)}` : null;
    }

    case 'formlogic_list_responses': {
      const form = formLabel(data, forms);
      if (!form) return 'Finds records';
      const filters = Array.isArray(data.filters) ? data.filters.map(filterPhrase).filter(Boolean) : [];
      const useAll = data.return === 'all';
      const where = filters.length > 0 ? ` where ${filters.join(' and ')}` : '';
      return `Find ${useAll ? 'all' : 'first'} in ${form}${where}`;
    }

    case 'formlogic_submit_response': {
      const form = formLabel(data, forms);
      return form ? `Adds a record to ${form}` : 'Adds a record';
    }

    case 'formlogic_update_response': {
      const form = formLabel(data, forms);
      return form ? `Updates a record in ${form}` : 'Updates a record';
    }

    case 'connector_request': {
      const connector = pickString(data, ['connectorId', 'connector']);
      const command = pickString(data, ['command']);
      if (connector && command) return `Calls ${connector} · ${command}`;
      return connector ? `Calls ${connector}` : null;
    }

    case 'storage_get': {
      const key = pickString(data, ['key', 'k']);
      return key ? `Reads "${short(key, 24)}" from storage` : 'Reads from storage';
    }

    case 'storage_set': {
      const key = pickString(data, ['key', 'k']);
      return key ? `Saves "${short(key, 24)}" to storage` : 'Saves to storage';
    }

    case 'aokie_speak': {
      const text = pickString(data, ['text', 'message']);
      return text ? `Says "${short(text, 30)}" on the call` : 'Speaks on the call';
    }

    default:
      return null;
  }
}

/** The names declared on a Trigger node's `data.inputs` (each { name, example? }). */
export function declaredInputNames(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.inputs)) return [];
  const out: string[] = [];
  for (const row of data.inputs) {
    if (row && typeof row === 'object' && typeof (row as { name?: unknown }).name === 'string') {
      const name = (row as { name: string }).name.trim();
      if (name !== '') out.push(name);
    }
  }
  return out;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}
