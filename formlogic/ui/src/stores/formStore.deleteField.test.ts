// Deleting a field removes the show-if rules and calculations that read it: they would name a
// field that no longer exists. A rule that only compares against a quoted value which happens to
// be spelled like the deleted field's id does not read that field, and must be left alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form, FormField } from '../types/form';

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

import { clearAllDebounceTimers, useFormStore } from './formStore';

const field = (id: string, extra: Partial<FormField> = {}): FormField => ({
  id, type: 'short_text', label: id, required: false, properties: {}, order: 0, ...extra,
} as FormField);

function load(fields: FormField[]) {
  const form = {
    id: 'f1', title: 'Contact', description: '', status: 'draft',
    fields: fields.map((f, order) => ({ ...f, order })),
    settings: {}, theme: {}, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z',
  } as unknown as Form;
  useFormStore.setState({ forms: [form] });
}

const fieldAfter = (id: string) => useFormStore.getState().forms[0].fields.find((f) => f.id === id);

beforeEach(() => {
  clearAllDebounceTimers();
  useFormStore.setState({ forms: [], storageMode: 'local', isInitialized: true, pendingDeletions: [], syncConflicts: null, savingFormIds: {}, saveErrors: {} });
});

describe('deleteField and the rules of other fields', () => {
  it('removes a show-if rule and a calculation that read the deleted field', () => {
    load([
      field('price'),
      field('quantity'),
      field('discount_note', { conditionalLogic: { expression: 'price > 100', action: 'show' } }),
      field('total', { type: 'calculated', properties: { calculationExpression: 'price * quantity' } } as Partial<FormField>),
    ]);
    useFormStore.getState().deleteField('f1', 'price');
    expect(fieldAfter('discount_note')?.conditionalLogic).toBeUndefined();
    expect(fieldAfter('total')?.properties.calculationExpression).toBeUndefined();
  });

  // "How should we contact you?" with the options email and phone, an Email field, and a note
  // shown only when email is chosen. Deleting the Email field removed the note's rule, because
  // the option's value is spelled like the Email field's id; the note then showed to everyone.
  it('keeps a rule that only compares against a quoted value spelled like the deleted field', () => {
    load([
      field('contact_method', { type: 'dropdown' }),
      field('email'),
      field('email_note', { conditionalLogic: { expression: 'contact_method == "email"', action: 'show' } }),
      field('single_note', { conditionalLogic: { expression: "contact_method == 'email'", action: 'show' } }),
      field('label', { type: 'calculated', properties: { calculationExpression: 'contact_method == "email" ? "By email" : "By phone"' } } as Partial<FormField>),
    ]);
    useFormStore.getState().deleteField('f1', 'email');
    expect(fieldAfter('email')).toBeUndefined();
    expect(fieldAfter('email_note')?.conditionalLogic).toEqual({ expression: 'contact_method == "email"', action: 'show' });
    expect(fieldAfter('single_note')?.conditionalLogic?.expression).toBe("contact_method == 'email'");
    expect(fieldAfter('label')?.properties.calculationExpression).toBe('contact_method == "email" ? "By email" : "By phone"');
  });

  it('still removes a rule that reads the deleted field next to a quoted value with an escaped quote in it', () => {
    load([
      field('email'),
      field('note', { conditionalLogic: { expression: 'contains(email, "say \\"hi\\"") && email != "x"', action: 'show' } }),
    ]);
    useFormStore.getState().deleteField('f1', 'email');
    expect(fieldAfter('note')?.conditionalLogic).toBeUndefined();
  });

  it('leaves alone a rule about a field whose id only starts with the deleted one', () => {
    load([
      field('email'),
      field('email_address'),
      field('note', { conditionalLogic: { expression: 'isNotEmpty(email_address)', action: 'show' } }),
    ]);
    useFormStore.getState().deleteField('f1', 'email');
    expect(fieldAfter('note')?.conditionalLogic?.expression).toBe('isNotEmpty(email_address)');
  });
});
