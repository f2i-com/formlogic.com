// FormLogic Flows editor — form-picker scoping + search (the "too many forms" fix).
import { describe, expect, it } from 'vitest';
import { filterForms, formsForContext, shouldSearch } from './formPicker';
import { EMPTY_FLOW_EDITOR_CONTEXT, type FlowEditorContext } from './nodeCatalog';
import type { FlowFormOption } from './NodeProperties';

const forms: FlowFormOption[] = [
  { id: 'f-customers', title: 'Customers', fields: [] },
  { id: 'f-calls', title: 'Calls', fields: [] },
  { id: 'f-orders', title: 'Orders', fields: [] },
  { id: 'f-random', title: 'Marketing Signups', fields: [] },
];

describe('filterForms typeahead', () => {
  it('narrows by a case-insensitive title match', () => {
    expect(filterForms(forms, 'cust').map((f) => f.id)).toEqual(['f-customers']);
    expect(filterForms(forms, 'CALL').map((f) => f.id)).toEqual(['f-calls']);
  });

  it('returns everything for a blank query', () => {
    expect(filterForms(forms, '   ')).toHaveLength(4);
  });

  it('matches on id for the power user', () => {
    expect(filterForms(forms, 'f-orders').map((f) => f.id)).toEqual(['f-orders']);
  });
});

describe('formsForContext scoping', () => {
  it('app-scoped shows ONLY the app forms, in app order', () => {
    const ctx: FlowEditorContext = { appScoped: true, connectors: [], appFormIds: ['f-calls', 'f-customers'] };
    expect(formsForContext(forms, ctx).map((f) => f.id)).toEqual(['f-calls', 'f-customers']);
  });

  it('workspace flows see every form', () => {
    expect(formsForContext(forms, EMPTY_FLOW_EDITOR_CONTEXT)).toHaveLength(4);
  });

  it('falls back to all forms when the app declares none that resolve', () => {
    const ctx: FlowEditorContext = { appScoped: true, connectors: [], appFormIds: ['nope-1', 'nope-2'] };
    expect(formsForContext(forms, ctx)).toHaveLength(4);
  });
});

describe('shouldSearch', () => {
  it('a short app-scoped list is a plain list, not a search box', () => {
    const ctx: FlowEditorContext = { appScoped: true, connectors: [], appFormIds: ['f-calls', 'f-customers'] };
    expect(shouldSearch(formsForContext(forms, ctx), ctx)).toBe(false);
  });

  it('a long workspace list becomes searchable', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `f-${i}`, title: `Form ${i}`, fields: [] }));
    expect(shouldSearch(many, EMPTY_FLOW_EDITOR_CONTEXT)).toBe(true);
  });
});
