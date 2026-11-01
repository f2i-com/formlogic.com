// A field's id is the name its value has in show-if rules and calculations, which are JavaScript
// expressions: `total > 100`. An id that is a word of the language cannot be read there at all
// (`class == "5A"` does not parse), so a rule about a field labelled Class, Case, New or Default
// never ran, and the form showed the field it was meant to hide. Such a label gets a suffixed id,
// as a label that would hide one of the expression helpers (count, sum) already did.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form, FormField } from '../types/form';
import { createFieldVariableMap, isReservedExpressionName, replaceIdsWithVariables, replaceVariablesWithIds } from '../lib/utils';
import { safeFieldId } from '../lib/ai-app-builder/engine';

vi.mock('../lib/api', () => ({
  api: {
    isDemoMode: vi.fn(() => false),
    isAdminActing: vi.fn(() => false),
    setAdminActing: vi.fn(),
    getForm: vi.fn(),
    getForms: vi.fn(async () => ({ data: { forms: [] } })),
    createForm: vi.fn(),
    updateForm: vi.fn(),
    deleteForm: vi.fn(),
  },
}));
vi.mock('./toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { clearAllDebounceTimers, generateFieldId, useFormStore } from './formStore';

const add = (label: string) =>
  useFormStore.getState().addField('f1', { type: 'short_text', label, required: false, properties: {} } as Omit<FormField, 'id' | 'order'>);

/** Does `name == "x"` parse as an expression that reads a variable? */
const readable = (name: string) => {
  try { new Function(`return (${name} == "x");`); return true; } catch { return false; }
};

beforeEach(() => {
  clearAllDebounceTimers();
  const form = {
    id: 'f1', title: 'Enrolment', description: '', status: 'draft', fields: [],
    settings: {}, theme: {}, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z',
  } as unknown as Form;
  useFormStore.setState({ forms: [form], storageMode: 'local', isInitialized: true, pendingDeletions: [], syncConflicts: null, savingFormIds: {}, saveErrors: {} });
});

describe('the id a new field is given', () => {
  it('can be read in an expression, whatever word the label is', () => {
    for (const label of ['Class', 'Case', 'New', 'Default', 'Return', 'Function', 'Package', 'In', 'For', 'This', 'Null', 'True', 'Delete', 'Export']) {
      const id = add(label).id;
      expect(readable(id), `${label} -> ${id}`).toBe(true);
      expect(id.startsWith(label.toLowerCase()), `${label} -> ${id}`).toBe(true);
    }
  });

  // The engine runs an expression with eval, and puts each answer in a global named after its
  // field: an answer named eval would replace it and stop every expression on the form.
  it('does not take the name the engine itself needs', () => {
    expect(add('Eval').id).not.toBe('eval');
    expect(add('Undefined').id).not.toBe('undefined');
  });

  // The server refuses to save a form whose field id is one of these (FormService::validateFieldId,
  // "Field ID is reserved and cannot be used"): a field labelled Print or Console could not be saved.
  it('is never one the server refuses, for a label that slugs to it', () => {
    const php = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/src/Services/FormService.php'), 'utf8');
    const list = php.match(/private const RESERVED_FIELD_IDS = \[([\s\S]*?)\];/)?.[1] ?? '';
    // The list has comments between its entries, with apostrophes of their own.
    const refused = [...list.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(refused.length).toBeGreaterThan(20);
    expect(refused).toContain('print');
    for (const id of refused) expect(isReservedExpressionName(id), id).toBe(true);
    expect(add('Print').id).toBe('print_1');
    expect(add('Console').id).toBe('console_1');
  });

  it('is the same for the AI app builder’s fields', () => {
    const used = new Set<string>();
    expect(safeFieldId('Class', used)).toBe('class_1');
    expect(safeFieldId('Print', used)).toBe('print_1');
    expect(safeFieldId('Class name', used)).toBe('class_name');
  });

  it('is still the plain slug for an ordinary label', () => {
    expect(add('Class name').id).toBe('class_name');
    expect(add('Email').id).toBe('email');
    expect(add('Count').id).toBe('count_1');
  });
});

describe('the name a field has in the expression editors', () => {
  it('can be read in an expression when the label is a word of the language', () => {
    const { toId, toVar } = createFieldVariableMap([{ id: 'class_1', label: 'Class' }, { id: 'case_1', label: 'Case' }, { id: 'age', label: 'Age' }]);
    expect(readable(toVar.class_1)).toBe(true);
    expect(readable(toVar.case_1)).toBe(true);
    expect(toVar.age).toBe('age');
    // What the editor shows goes back to the ids it was made from, and parses once it has.
    const shown = replaceIdsWithVariables('class_1 == "5A" && age > 10', toVar);
    expect(replaceVariablesWithIds(shown, toId)).toBe('class_1 == "5A" && age > 10');
  });

  // A field labelled Count would be shown as `count`, the helper's own name: `count(items) > 2`
  // was then saved as `count_1(items) > 2`, a call to an answer.
  it('is not the name of an expression helper, so a helper typed in an expression stays one', () => {
    const { toId, toVar } = createFieldVariableMap([{ id: 'count_1', label: 'Count' }, { id: 'items', label: 'Items' }, { id: 'is_empty', label: 'Is empty' }]);
    expect(toVar.count_1).not.toBe('count');
    expect(toVar.is_empty).not.toBe('isEmpty');
    expect(replaceVariablesWithIds('count(items) > 2 && !isEmpty(items)', toId)).toBe('count(items) > 2 && !isEmpty(items)');
    expect(replaceVariablesWithIds(`${toVar.count_1} > 2`, toId)).toBe('count_1 > 2');
  });
});

// `role === "manager"` beside a field labelled Manager: the quoted text is the answer it is
// compared with, and saving it as that field's id made a rule that could never be true.
describe('quoted text in an expression', () => {
  const { toId, toVar } = createFieldVariableMap([{ id: 'mgr_1', label: 'Manager' }, { id: 'role_1', label: 'Role' }]);

  it('is left alone when an expression is saved, while the code around it is not', () => {
    expect(replaceVariablesWithIds(`${toVar.role_1} === "manager"`, toId)).toBe('role_1 === "manager"');
    expect(replaceVariablesWithIds(`${toVar.role_1} === 'manager'`, toId)).toBe(`role_1 === 'manager'`);
    expect(replaceVariablesWithIds('role == "manager" || manager == "role"', toId)).toBe('role_1 == "manager" || mgr_1 == "role"');
  });

  it('is left alone when an expression is shown', () => {
    const { toVar: shown } = createFieldVariableMap([{ id: 'email', label: 'Email address' }, { id: 'method', label: 'Method' }]);
    expect(replaceIdsWithVariables('method == "email" && email != ""', shown)).toBe('method == "email" && emailAddress != ""');
  });

  it('copes with a quote inside the text', () => {
    expect(replaceVariablesWithIds(String.raw`role == "the \"manager\" one" && manager`, toId)).toBe(String.raw`role_1 == "the \"manager\" one" && mgr_1`);
    expect(replaceVariablesWithIds(`role == "it's the manager" && manager`, toId)).toBe(`role_1 == "it's the manager" && mgr_1`);
  });

  it('reads a template as text, and what is inside its ${ } as code', () => {
    expect(replaceVariablesWithIds('`manager: ${manager}, role: ${ {a: role}.a }`', toId)).toBe('`manager: ${mgr_1}, role: ${ {a: role_1}.a }`');
  });

  it('does not run on past the line when a quote is never closed', () => {
    expect(replaceVariablesWithIds(`role == 'open\n&& manager`, toId)).toBe(`role_1 == 'open\n&& mgr_1`);
  });

  // A quote in a regex read as the start of text, so the code after it was left as typed, and the
  // rule failed at run time on a name that was no field's id.
  describe('a regex', () => {
    const saved = (typed: string) => replaceVariablesWithIds(typed, toId);

    it('is not where text starts', () => {
      expect(saved('role.replace(/"/g, "") + manager')).toBe('role_1.replace(/"/g, "") + mgr_1');
      expect(saved(`/'/.test(role) && manager`)).toBe(`/'/.test(role_1) && mgr_1`);
    });

    it.each(['(', ',', '=', ':', '!', '&', '|', '?', '{', '}', ';'])('opens after %s', (before) => {
      expect(saved(`${before} /"/ + manager`)).toBe(`${before} /"/ + mgr_1`);
    });

    it('is left as typed, a field\'s name in it included', () => {
      expect(saved('/manager/i.test(role)')).toBe('/manager/i.test(role_1)');
    });

    it('reads through an escaped slash and a class holding one', () => {
      expect(saved(String.raw`/a\/"/.test(role) && manager`)).toBe(String.raw`/a\/"/.test(role_1) && mgr_1`);
      expect(saved(`/[/"]/.test(role) && manager`)).toBe(`/[/"]/.test(role_1) && mgr_1`);
    });

    it('takes its flags with it, even where a field has the same name', () => {
      expect(saved('role.replace(/"/gi, "") + manager')).toBe('role_1.replace(/"/gi, "") + mgr_1');
      expect(replaceVariablesWithIds('/a/i.test(role) && i', { i: 'field_i', role: 'role_1' })).toBe('/a/i.test(role_1) && field_i');
    });

    it('takes a regex after => and [ and return for one, so a quote in it is not text', () => {
      const toId = { Price: 'price_1', Total: 'total_1', Name: 'name_1' };
      expect(replaceVariablesWithIds('x => /"/.test(x) ? Price : Total', toId)).toBe('x => /"/.test(x) ? price_1 : total_1');
      expect(replaceVariablesWithIds('[/"/.test(Name), Total]', toId)).toBe('[/"/.test(name_1), total_1]');
      expect(replaceVariablesWithIds('return /"/.test(Name) && Total', toId)).toBe('return /"/.test(name_1) && total_1');
    });

    it('still divides where a name or a ++ comes before the /', () => {
      const toId = { Price: 'price_1', Total: 'total_1' };
      expect(replaceVariablesWithIds('x++ / Price / Total', toId)).toBe('x++ / price_1 / total_1');
      expect(replaceVariablesWithIds('returned / Price / Total', toId)).toBe('returned / price_1 / total_1');
      expect(replaceVariablesWithIds('a.return / Price / Total', toId)).toBe('a.return / price_1 / total_1');
    });

    it('is read as code in a template\'s ${ }', () => {
      expect(saved('`${/"/.test(role)} ${manager}`')).toBe('`${/"/.test(role_1)} ${mgr_1}`');
    });

    it('does not count its braces as the code\'s', () => {
      expect(saved('`${/}/.test(role)} manager ${manager}`')).toBe('`${/}/.test(role_1)} manager ${mgr_1}`');
    });
  });

  describe('a division', () => {
    const saved = (typed: string) => replaceVariablesWithIds(typed, toId);

    it('is no regex after a name, a number, a bracket or a quote', () => {
      expect(saved('role / 2 / manager')).toBe('role_1 / 2 / mgr_1');
      expect(saved('(role) / 2 + manager / 3')).toBe('(role_1) / 2 + mgr_1 / 3');
      expect(saved('items[0] / role / manager')).toBe('items[0] / role_1 / mgr_1');
      expect(saved('"6" / role / manager')).toBe('"6" / role_1 / mgr_1');
      expect(saved('`6` / role / manager')).toBe('`6` / role_1 / mgr_1');
    });

    it('stays code when a / that could open a regex never closes', () => {
      expect(saved('(/ role && manager')).toBe('(/ role_1 && mgr_1');
    });

    it('reads a regex after one as a regex', () => {
      expect(saved('role / 2 > 1 && /"/.test(manager)')).toBe('role_1 / 2 > 1 && /"/.test(mgr_1)');
    });
  });

  describe('a comment', () => {
    const saved = (typed: string) => replaceVariablesWithIds(typed, toId);

    it('is not where text starts', () => {
      expect(saved(`role /* don't */ && manager`)).toBe(`role_1 /* don't */ && mgr_1`);
      expect(saved(`role // don't\n&& manager`)).toBe(`role_1 // don't\n&& mgr_1`);
    });

    it('is left as typed, a field\'s name in it included', () => {
      expect(saved('role // the manager\n&& manager')).toBe('role_1 // the manager\n&& mgr_1');
      expect(saved('role /* the manager */ && manager')).toBe('role_1 /* the manager */ && mgr_1');
    });

    it('is not a regex', () => {
      expect(saved(`(/* a " */ role) && manager`)).toBe(`(/* a " */ role_1) && mgr_1`);
    });

    it('lets what stood before it decide what a / after it is', () => {
      expect(saved('role /* half */ / 2 / manager')).toBe('role_1 /* half */ / 2 / mgr_1');
    });
  });

  it.each([
    'field_x.replace(/"/g, "") + role_1',
    '/mgr_1/.test(role_1) && mgr_1 / 2 > 1',
    'role_1 === "mgr_1" /* it\'s */ && /[/"]/.test(mgr_1)',
  ])('shows and saves %s to what is stored', (stored) => {
    expect(replaceVariablesWithIds(replaceIdsWithVariables(stored, toVar), toId)).toBe(stored);
  });

  // A rule saved before this reads as it is stored: it could never have matched "manager".
  it('shows an old rule as it is stored, and saves it unchanged', () => {
    const stored = 'role_1 === "mgr_1"';
    const shown = replaceIdsWithVariables(stored, toVar);
    expect(shown).toBe('role === "mgr_1"');
    expect(replaceVariablesWithIds(shown, toId)).toBe(stored);
  });
});

describe('generateFieldId, for those adding a field outside the builder', () => {
  it('gives what addField gives, with the reserved names and the ids in use', () => {
    expect(generateFieldId('Customer name', [])).toBe('customer_name');
    expect(generateFieldId('Value', [])).toBe('value_1');
    expect(generateFieldId('Class', [])).toBe('class_1');
    expect(generateFieldId('Customer', ['customer', 'customer_1'])).toBe('customer_2');
    expect(generateFieldId('???', [])).toBe('field');
    expect(generateFieldId('401k', [])).toBe('_401k');
  });
});
