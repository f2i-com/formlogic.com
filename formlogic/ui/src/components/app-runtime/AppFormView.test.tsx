// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFormView } from './AppFormView';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { setSessionOwner } from '../../lib/sessionGeneration';
import { DEFAULT_APP_SETTINGS, DEFAULT_APP_THEME } from '../../types/app';

const h = vi.hoisted(() => ({
  getAppForm: vi.fn(),
  getAppResponses: vi.fn(),
  uploadAppFile: vi.fn(),
  createResponse: vi.fn(),
  runScreenEnter: vi.fn(async () => undefined),
  runBeforeSubmit: vi.fn(async () => ({ rejected: false, values: {}, warnings: [] })),
  runAfterSubmit: vi.fn(async () => undefined),
}));
vi.mock('../../lib/api', () => ({ api: { getAppForm: h.getAppForm, getAppResponses: h.getAppResponses, uploadAppFile: h.uploadAppFile } }));
vi.mock('../custom-screen/screenBridge', () => ({ useScreenBridge: () => undefined, resolveScreenTarget: () => null }));
vi.mock('../custom-screen/screenCeremonies', () => ({ useScreenCeremonies: () => ({ onCeremony: () => undefined, ceremonyUi: null }) }));
vi.mock('../../client-runtime/logic/useCustomAppLogic', () => ({ useCustomAppLogic: () => ({
  enabled: false, runScreenEnter: h.runScreenEnter, runBeforeSubmit: h.runBeforeSubmit,
  runAfterSubmit: h.runAfterSubmit, runConnectorEvent: () => undefined,
}) }));
vi.mock('../../client-runtime/desktop/useDesktopConnectorEvents', () => ({ useDesktopConnectorEvents: () => undefined }));
vi.mock('../../client-runtime/flows/flowDispatcher', () => ({ dispatchFormEvent: async () => undefined }));
vi.mock('./AppSectionDashboard', () => ({ AppSectionDashboard: () => null }));
vi.mock('./LinkedRecordInput', () => ({ LinkedRecordInput: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let navigate: NavigateFunction;
function Navigator() {
  const routerNavigate = useNavigate();
  useEffect(() => { navigate = routerNavigate; }, [routerNavigate]);
  return null;
}
function form(id: string, extras: Array<Record<string, unknown>> = []) {
  return { id, title: `Form ${id}`, fields: [{ id: 'name', type: 'short_text', label: 'Name', properties: {}, required: false }, ...extras], settings: { presentationMode: 'classic' } };
}
async function mount(path: string) {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}>
    <Navigator /><Routes>
      <Route path="/app/:appSlug/form/:formId" element={<AppFormView />} />
      <Route path="/app/:appSlug/form/:formId/responses/:responseId" element={<p>record page</p>} />
    </Routes>
  </MemoryRouter>));
}
async function typeName(value: string) {
  const input = container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function button(label: string) {
  return Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === label)!;
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  useAppRuntimeStore.setState({
    config: { app: { id: 'demo', name: 'Demo', slug: 'demo', ownerId: 'owner', status: 'published', settings: DEFAULT_APP_SETTINGS, theme: DEFAULT_APP_THEME, navConfig: [], createdAt: '', updatedAt: '' }, forms: [], userPermissions: {} },
    canSubmit: () => true, canViewOwn: () => false, canViewAll: () => false, createResponse: h.createResponse,
  });
  h.getAppForm.mockImplementation(async (_slug: string, id: string) => ({ data: { form: form(id) } }));
  h.createResponse.mockResolvedValue({ id: 'saved' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('app form visit state', () => {
  it('clears the previous form before the next form loads and submits only the new answers', async () => {
    let resolveNext!: (value: unknown) => void;
    h.getAppForm.mockImplementation(async (_slug: string, id: string) => id === 'b'
      ? new Promise(resolve => { resolveNext = resolve; })
      : { data: { form: form(id) } });
    await mount('/app/demo/form/a');
    await typeName('First form answer');
    await act(async () => navigate('/app/demo/form/b'));
    expect(container.querySelector('input')).toBeNull();
    expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toContain('First form answer');
    await act(async () => resolveNext({ data: { form: form('b') } }));
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('');
    await typeName('Second form answer');
    await act(async () => button('Submit').click());
    expect(h.createResponse).toHaveBeenCalledWith('b', { name: 'Second form answer' });
  });

  it('preserves an offered draft and restores it alongside hidden defaults and a linked parent', async () => {
    sessionStorage.setItem('formlogic.runtimeDraft.demo.a', JSON.stringify({ name: 'Saved draft' }));
    h.getAppForm.mockResolvedValue({ data: { form: form('a', [
      { id: 'source', type: 'hidden', properties: { defaultValue: 'app' } },
      { id: 'parent', type: 'linked_record', label: 'Parent', properties: { allowMultiple: true } },
    ]) } });
    await mount('/app/demo/form/a?linkField=parent&linkTo=record-1');
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toContain('Saved draft');
    await act(async () => button('Restore my answers').click());
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Saved draft');
    await act(async () => button('Submit').click());
    expect(h.createResponse).toHaveBeenCalledWith('a', { name: 'Saved draft', source: 'app', parent: ['record-1'] });
    expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toBeNull();
  });

  // The key names its owner since v0.1.18: a tab open through the update keeps its draft under
  // the old one, and would otherwise lose it on the next reload.
  describe('a draft from before the key named its owner', () => {
    afterEach(() => setSessionOwner(null));

    it('is offered once, from under the old key, and then kept under the new one', async () => {
      setSessionOwner('u1');
      sessionStorage.setItem('formlogic.runtimeDraft.demo.a', JSON.stringify({ name: 'From before' }));
      await mount('/app/demo/form/a');

      await act(async () => button('Restore my answers').click());
      expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('From before');
      expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toBeNull();
      expect(sessionStorage.getItem('formlogic.runtimeDraft.u1.demo.a')).toContain('From before');
    });

    it('is not read over a draft under the new key', async () => {
      setSessionOwner('u1');
      sessionStorage.setItem('formlogic.runtimeDraft.demo.a', JSON.stringify({ name: 'From before' }));
      sessionStorage.setItem('formlogic.runtimeDraft.u1.demo.a', JSON.stringify({ name: 'Newer' }));
      await mount('/app/demo/form/a');

      await act(async () => button('Restore my answers').click());
      expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Newer');
      expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toContain('From before');
    });

    it('is not offered a second time to whoever signs in next', async () => {
      setSessionOwner('u1');
      sessionStorage.setItem('formlogic.runtimeDraft.demo.a', JSON.stringify({ name: 'From before' }));
      await mount('/app/demo/form/a');
      await act(async () => root.render(<div />));

      setSessionOwner('u2');
      await mount('/app/demo/form/a');
      expect(button('Restore my answers')).toBeUndefined();
    });
  });

  // An upload's answer only exists once it ends, so a submit in between went without the file.
  it('holds the submit until a file has finished uploading', async () => {
    let finishUpload!: (value: unknown) => void;
    h.uploadAppFile.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    h.getAppForm.mockResolvedValue({ data: { form: form('a', [{ id: 'cv', type: 'file_upload', label: 'CV', properties: {} }]) } });
    await mount('/app/demo/form/a');

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'cv.pdf')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });

    expect(button('Uploading...').disabled).toBe(true);
    expect(h.createResponse).not.toHaveBeenCalled();

    const file = { id: 'file-1', originalFilename: 'cv.pdf', storedFilename: 'x', size: 1, mimeType: 'application/pdf', url: '/f' };
    await act(async () => { finishUpload({ data: file }); });
    await act(async () => button('Submit').click());

    expect(h.createResponse).toHaveBeenCalledWith('a', { cv: [file] });
  });

  // createResponse rejecting is how the offline queue says it could not store the submission.
  it('keeps the draft and says so when a submission could not be saved anywhere', async () => {
    h.createResponse.mockRejectedValue(new Error('The quota has been exceeded.'));
    await mount('/app/demo/form/a');
    await typeName('Keep me');

    await act(async () => button('Submit').click());

    expect(container.textContent).not.toContain('Saved on this device');
    expect(container.textContent).toContain('The quota has been exceeded.');
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Keep me');
    expect(sessionStorage.getItem('formlogic.runtimeDraft.demo.a')).toContain('Keep me');
  });

  describe('a form with one record', () => {
    beforeEach(() => {
      const { config } = useAppRuntimeStore.getState();
      useAppRuntimeStore.setState({
        config: { ...config!, forms: [{ formId: 'a', settings: { singleRecord: true } } as never] },
        canViewOwn: () => true,
      });
      h.getAppResponses.mockResolvedValue({ data: { responses: [] } });
    });

    it('lands on its record once the server has stored it', async () => {
      await mount('/app/demo/form/a');
      await act(async () => button('Submit').click());
      expect(container.textContent).toContain('record page');
    });

    // The id of a queued submission is the queue's. It names no record, so the page said
    // "Couldn't load this record" and the submission looked lost.
    it('stays on "Saved on this device" when it is only queued', async () => {
      h.createResponse.mockResolvedValue({ id: 'queue-row', queued: true, answers: {}, submittedAt: '' });
      await mount('/app/demo/form/a');
      await act(async () => button('Submit').click());

      expect(container.textContent).not.toContain('record page');
      expect(container.textContent).toContain('Saved on this device');
    });
  });
});
