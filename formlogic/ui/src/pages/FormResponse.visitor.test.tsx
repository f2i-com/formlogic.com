// @vitest-environment jsdom
// The public form page as a visitor meets it: what shows before the form has loaded, whose records a
// custom screen reads, and what happens to a submit while a file is on its way.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  screen: vi.fn((props: { publicMode?: boolean }) => { void props; return null; }),
  dashboard: vi.fn((props: { publicMode?: boolean }) => { void props; return null; }),
}));
vi.mock('../components/custom-screen/CustomScreenRuntime', () => ({ CustomScreenRuntime: stubs.screen }));
vi.mock('../components/custom-screen/FormWidgetDashboard', () => ({ FormWidgetDashboard: stubs.dashboard }));
vi.mock('../hooks/usePublicConfig', () => ({ usePublicConfig: () => ({ maintenanceMode: false }) }));
vi.mock('../hooks/useFormLogic', () => ({
  useConditionalLogic: () => ({ isFieldVisible: () => true, isFieldRequired: () => false, isEvaluating: false }),
}));

import { api } from '../lib/api';
import { useFormStore } from '../stores/formStore';
import FormResponse from './FormResponse';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_FIELD = { id: 'cv', type: 'file_upload', label: 'Your CV', required: false, order: 0, properties: {} };

function publishedForm(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1', title: 'Apply', status: 'published', fields: [FILE_FIELD], responseCount: 0,
    settings: { presentationMode: 'classic' }, theme: { primaryColor: '#123456', backgroundColor: '#ffffff', textColor: '#111111' },
    ...overrides,
  };
}

const page = (
  <MemoryRouter initialEntries={['/form/f1']}>
    <Routes><Route path="/form/:formId" element={<FormResponse />} /></Routes>
  </MemoryRouter>
);

let root: Root;
let host: HTMLElement;

async function mount() {
  await act(async () => { root.render(page); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
async function pickFile() {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'cv.pdf', { type: 'application/pdf' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

beforeEach(() => {
  useFormStore.setState({ forms: [], storageMode: 'local' });
  vi.spyOn(api, 'isAuthenticated').mockReturnValue(false);
  vi.spyOn(api, 'recordFormStart').mockResolvedValue(undefined as never);
  vi.spyOn(api, 'getPublicForm').mockResolvedValue({ data: { form: publishedForm() } } as never);
  vi.spyOn(api, 'submitResponse').mockResolvedValue({ data: { response: { id: 'r1' } } } as never);
  stubs.screen.mockClear();
  stubs.dashboard.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('before the form has loaded', () => {
  it('paints a spinner, not "we couldn’t load this form"', () => {
    expect(renderToString(page)).not.toContain('load this form');
  });

  it('says so when it truly could not load', async () => {
    vi.mocked(api.getPublicForm).mockResolvedValue({ error: 'Form not found', status: 404 } as never);
    await mount();
    expect(host.textContent).toContain('load this form');
  });
});

// /forms/{id} and /forms/{id}/responses answer the form's owner alone. Someone signed in and not the
// owner was given the owner route, refused, and a screen with public records on read no records.
describe('a custom screen on a public link', () => {
  const withScreen = (customScreen: Record<string, unknown>) => publishedForm({ customScreen });
  const htmlScreen = { enabled: true, html: '<b>board</b>' };
  const lastProps = (stub: typeof stubs.screen) => stub.mock.calls[stub.mock.calls.length - 1]?.[0];

  it('reads as public for a signed-in viewer who does not own the form', async () => {
    vi.mocked(api.isAuthenticated).mockReturnValue(true);
    vi.spyOn(api, 'getForm').mockResolvedValue({ error: 'Form not found or access denied', status: 404 } as never);
    vi.mocked(api.getPublicForm).mockResolvedValue({ data: { form: withScreen(htmlScreen) } } as never);
    await mount();
    expect(lastProps(stubs.screen)?.publicMode).toBe(true);
  });

  it('reads as public for a dashboard too', async () => {
    vi.mocked(api.isAuthenticated).mockReturnValue(true);
    vi.spyOn(api, 'getForm').mockResolvedValue({ error: 'Form not found or access denied', status: 404 } as never);
    vi.mocked(api.getPublicForm).mockResolvedValue({ data: { form: withScreen({ enabled: true, kind: 'dashboard', dashboard: { widgets: [] } }) } } as never);
    await mount();
    expect(lastProps(stubs.dashboard)?.publicMode).toBe(true);
  });

  it('reads as the owner for the form’s owner', async () => {
    vi.mocked(api.isAuthenticated).mockReturnValue(true);
    vi.spyOn(api, 'getForm').mockResolvedValue({ data: { form: withScreen(htmlScreen) } } as never);
    await mount();
    expect(lastProps(stubs.screen)?.publicMode).toBe(false);
  });

  it('reads as public for a visitor who is not signed in', async () => {
    vi.mocked(api.getPublicForm).mockResolvedValue({ data: { form: withScreen(htmlScreen) } } as never);
    await mount();
    expect(lastProps(stubs.screen)?.publicMode).toBe(true);
  });
});

// A file's answer only exists once its upload has ended. Submitting in between showed the thank-you
// screen without the file and left it orphaned on the server.
describe('submitting while a file uploads', () => {
  let finishUpload: (value: unknown) => void;
  beforeEach(() => {
    vi.spyOn(api, 'uploadFile').mockImplementation(() => new Promise((resolve) => { finishUpload = resolve as (value: unknown) => void; }) as never);
  });
  const uploaded = { data: { id: 'file-1', originalFilename: 'cv.pdf', storedFilename: 'x', size: 1, mimeType: 'application/pdf', url: '/f' } };

  it('holds the submit until the upload ends, then sends the file (all questions)', async () => {
    await mount();
    await pickFile();

    const waiting = button('Uploading…');
    expect(waiting?.disabled).toBe(true);

    await act(async () => { finishUpload(uploaded); });
    await act(async () => { button('Submit')?.click(); });

    expect(api.submitResponse).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.submitResponse).mock.calls[0][1] as { answers: Record<string, unknown> };
    expect(sent.answers.cv).toEqual([uploaded.data]);
  });

  it('holds Enter and the Submit button (one at a time)', async () => {
    vi.mocked(api.getPublicForm).mockResolvedValue({
      data: { form: publishedForm({ settings: { presentationMode: 'focused' } }) },
    } as never);
    await mount();
    await pickFile();

    expect(button('Uploading…')?.disabled).toBe(true);
    await act(async () => {
      host.querySelector('[role="group"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(api.submitResponse).not.toHaveBeenCalled();

    await act(async () => { finishUpload(uploaded); });
    expect(button('Submit')?.disabled).toBe(false);
  });

  it('lets go when the upload fails, and the form can be sent without the file', async () => {
    vi.mocked(api.uploadFile).mockResolvedValueOnce({ error: 'Upload failed' } as never);
    await mount();
    await pickFile();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(button('Submit')?.disabled).toBe(false);
  });
});
