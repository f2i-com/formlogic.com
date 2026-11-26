// @vitest-environment jsdom
// A form made private while it had a script keeps it stored. The Script control is closed to
// private forms, so its owner could open nothing that would take the script out. The server takes
// an empty script from a private form (and refuses any other but the one it holds), so that is what
// the builder has to send, and it may only say the script is gone when the server said so.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const privacy = vi.hoisted(() => ({ private: true }));

vi.mock('../components/builder', () => ({
  ScriptEditor: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="script-editor" /> : null),
  FieldPalette: () => null, SortableFieldCard: () => null, FieldSettingsPanel: () => null,
  FormFlowsPanel: () => null, useFormPreview: () => ({ openPreview: () => undefined, previewChooser: null }),
}));
vi.mock('../components/builder/EmbedModal', () => ({ EmbedModal: () => null }));
vi.mock('../components/chat/SiteChatWidget', () => ({ SiteChatWidget: () => null }));
vi.mock('../components/custom-screen/ScreenModal', () => ({ ScreenModal: () => null }));
vi.mock('../components/studio/SoftnExportPanel', () => ({ SoftnExportPanel: () => null }));
vi.mock('../lib/crypto/formCrypto', () => ({ getFormPrivacy: async () => privacy.private }));

import { AdminActingContext } from '../components/admin/AdminActingContext';
import { api } from '../lib/api';
import { useFormStore } from '../stores/formStore';
import { useToastStore } from '../stores/toastStore';
import type { Form } from '../types/form';
import FormBuilder from './FormBuilder';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT = 'function onSubmit(ctx) { ctx.db.addTag("vip"); }';
const REMOVE = 'Remove the stored logic script (it does not run on an end-to-end encrypted form)';

let root: Root;
let host: HTMLElement;
let save: MockInstance<typeof api.updateFormWithMeta>;

const OWNER = { ownerId: 'u-owner', ownerEmail: 'owner@example.com' };

/**
 * The builder on form f1. `served` is what the form's own payload says of it (the forms list's
 * isPrivate, the encryption manifest GET /forms/{id} serves with a private form); `acting`, a
 * platform admin working in the owner's account, as AdminActingBoundary mounts the page.
 */
async function openBuilder(logicScript: string | undefined, { served = {}, acting = false }: { served?: Partial<Form>; acting?: boolean } = {}) {
  const form = { id: 'f1', title: 'Intake', fields: [], settings: {}, theme: {}, status: 'draft', responseCount: 0, logicScript, ...served } as unknown as Form;
  useFormStore.setState({ forms: [form], storageMode: 'api', savingFormIds: {}, saveErrors: {} });
  vi.spyOn(useFormStore.getState(), 'loadFullForm').mockResolvedValue(undefined);
  api.setAdminActing(acting ? { ownerId: OWNER.ownerId } : null);
  const page = <MemoryRouter initialEntries={['/builder/f1']}><Routes><Route path="/builder/:formId" element={<FormBuilder />} /></Routes></MemoryRouter>;
  await act(async () => {
    root.render(acting ? <AdminActingContext.Provider value={OWNER}>{page}</AdminActingContext.Provider> : page);
  });
  // The privacy lookup is a dynamic import and then a request: let both land.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const control = (name: string) => host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null;
const dialogButton = (label: string) => Array.from(document.body.querySelectorAll('[role="dialog"] button'))
  .find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
const storedScript = () => useFormStore.getState().forms[0].logicScript;
const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.type}: ${toast.title}`);

async function click(button: HTMLElement | null | undefined) {
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  privacy.private = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(api, 'listFormFlowBindings').mockResolvedValue({ data: { bindings: [] } } as never);
  vi.spyOn(api, 'getFormAppContexts').mockResolvedValue({ data: { contexts: [] } } as never);
  save = vi.spyOn(api, 'updateFormWithMeta').mockResolvedValue({ ok: true, status: 200, body: { form: { id: 'f1', logicScript: '' } } });
  useToastStore.setState({ toasts: [] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  api.setAdminActing(null);
  useFormStore.setState({ forms: [], storageMode: 'local' });
  vi.restoreAllMocks();
});

describe('a private form that still stores a logic script', () => {
  it('offers to remove it, sends the empty script the server takes, and then says it is gone', async () => {
    await openBuilder(SCRIPT);
    const remove = control(REMOVE);
    expect(remove?.disabled).toBe(false);

    await click(remove);
    expect(save).not.toHaveBeenCalled();
    await click(dialogButton('Remove script'));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('f1', { logicScript: '' });
    expect(storedScript()).toBe('');
    expect(toasts()).toEqual(['success: Script removed']);
    // Nothing is left to remove, and a private form takes no new script.
    expect(control(REMOVE)).toBeNull();
    expect(control('Logic scripts are not available on end-to-end encrypted forms')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="script-editor"]')).toBeNull();
  });

  it('keeps the script and the way to remove it when the server refuses', async () => {
    save.mockResolvedValue({ ok: false, status: 409, body: { error: true, message: 'Try again in a moment.' } });
    await openBuilder(SCRIPT);
    await click(control(REMOVE));
    await click(dialogButton('Remove script'));

    expect(storedScript()).toBe(SCRIPT);
    expect(toasts()).toEqual(['error: Script not removed']);
    expect(control(REMOVE)?.disabled).toBe(false);
  });

  it('does not say the script is gone when the saved form still has it', async () => {
    save.mockResolvedValue({ ok: true, status: 200, body: { form: { id: 'f1', logicScript: SCRIPT } } });
    await openBuilder(SCRIPT);
    await click(control(REMOVE));
    await click(dialogButton('Remove script'));

    expect(storedScript()).toBe(SCRIPT);
    expect(toasts()).toEqual(['error: Script not removed']);
  });

  it('removes nothing when the owner backs out', async () => {
    await openBuilder(SCRIPT);
    await click(control(REMOVE));
    await click(dialogButton('Cancel'));

    expect(save).not.toHaveBeenCalled();
    expect(storedScript()).toBe(SCRIPT);
  });
});

describe('the Script control everywhere else', () => {
  it('stays closed on a private form with no script', async () => {
    await openBuilder(undefined);
    expect(control(REMOVE)).toBeNull();
    expect(control('Logic scripts are not available on end-to-end encrypted forms')?.disabled).toBe(true);
  });

  it('opens the editor on a form that is not private, script or none', async () => {
    privacy.private = false;
    await openBuilder(SCRIPT);
    expect(control(REMOVE)).toBeNull();
    await click(control('Backend Logic Script'));
    expect(host.querySelector('[data-testid="script-editor"]')).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});

// A platform admin working in another account opens the owner's builder. The privacy lookup is the
// owner's own (it hands over their key grant) and is never made for the admin, so the builder took
// every private form for a plain one: it offered the Script editor, whose save the server refused.
// The admin reads the form as the owner does: from what the form itself says.
describe('an admin acting on the owner\'s private form', () => {
  const manifest = { encryption: { mode: 'private' } } as unknown as Partial<Form>;
  beforeEach(() => {
    // What the owner-only lookup would answer for the admin, were it made: nothing private.
    privacy.private = false;
  });

  it('sees the form as private by its encryption manifest, and is offered the removal, not the editor', async () => {
    await openBuilder(SCRIPT, { served: manifest, acting: true });
    expect(control('Backend Logic Script')).toBeNull();
    const remove = control(REMOVE);
    expect(remove?.disabled).toBe(false);

    await click(remove);
    await click(dialogButton('Remove script'));
    expect(save).toHaveBeenCalledWith('f1', { logicScript: '' });
    expect(storedScript()).toBe('');
    expect(host.querySelector('[data-testid="script-editor"]')).toBeNull();
    expect(control('Logic scripts are not available on end-to-end encrypted forms')?.disabled).toBe(true);
  });

  it('sees it as private by the forms list\'s flag, as the owner\'s own builder does', async () => {
    await openBuilder(undefined, { served: { isPrivate: true }, acting: true });
    expect(control('Logic scripts are not available on end-to-end encrypted forms')?.disabled).toBe(true);
    await openBuilder(undefined, { served: { isPrivate: true } });
    expect(control('Logic scripts are not available on end-to-end encrypted forms')?.disabled).toBe(true);
  });

  it('still opens the editor on a form that is not private', async () => {
    await openBuilder(SCRIPT, { acting: true });
    await click(control('Backend Logic Script'));
    expect(host.querySelector('[data-testid="script-editor"]')).not.toBeNull();
  });
});
