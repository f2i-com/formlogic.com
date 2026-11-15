// @vitest-environment jsdom
// A form's preview draws its OK and Submit buttons as the published page does: in the form's
// accent, with words that read on it (readableForegroundColor). Left to the button's own text
// colour they took the site's theme, which in the dark theme is navy: unreadable on a navy accent.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FormPreview from './FormPreview';

const h = vi.hoisted(() => ({ form: null as unknown, mode: 'classic' as 'classic' | 'focused' }));

vi.mock('../stores/formStore', () => ({
  useFormStore: () => ({ getForm: () => h.form, loadFullForm: async () => undefined }),
}));
vi.mock('../stores/uiStore', () => ({
  useUIStore: () => ({ previewDevice: 'desktop', setPreviewDevice: () => undefined, previewMode: h.mode, setPreviewMode: () => undefined }),
}));
vi.mock('../lib/api', () => ({ api: { isDemoMode: () => false } }));
vi.mock('../hooks/useFormLogic', () => ({
  useConditionalLogic: () => ({ isFieldVisible: () => true, isFieldRequired: () => false, isEvaluating: false }),
}));
// What is around the form is not what this is about.
vi.mock('./FormResponse', () => ({ FieldResponse: ({ field }: { field: { label: string } }) => <p>{field.label}</p> }));
vi.mock('../components/chat/SiteChatWidget', () => ({ SiteChatWidget: () => null }));
vi.mock('../components/chat/useChatDockOffset', () => ({ useChatDockOffset: () => false }));
vi.mock('../components/builder/EmbedModal', () => ({ EmbedModal: () => null }));
vi.mock('../components/builder/NigoDashboard', () => ({ NigoDashboard: () => null }));
vi.mock('../components/custom-screen/CustomScreenRuntime', () => ({ CustomScreenRuntime: () => null }));
vi.mock('../components/custom-screen/FormWidgetDashboard', () => ({ FormWidgetDashboard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function formWithAccent(primaryColor: string) {
  return {
    id: 'f1', title: 'Room booking', description: '', status: 'draft', icon: null,
    theme: { primaryColor, backgroundColor: '#ffffff', textColor: '#1f2937', fontFamily: 'DM Sans', borderRadius: 'medium' },
    settings: { submitButtonText: '' },
    fields: [
      { id: 'f_name', type: 'short_text', label: 'Your name', required: true, properties: {}, order: 0 },
      { id: 'f_room', type: 'short_text', label: 'Room', required: false, properties: {}, order: 1 },
    ],
  };
}

async function preview() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/preview/f1']}>
        <Routes><Route path="/preview/:formId" element={<FormPreview />} /></Routes>
      </MemoryRouter>,
    );
  });
}

const buttonStartingWith = (words: string) => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim().startsWith(words));

describe('FormPreview: the buttons in the form accent', () => {
  it('draws Submit in words that read on a navy accent, as the published page does', async () => {
    h.form = formWithAccent('#1e3a8a');
    h.mode = 'classic';
    await preview();
    const submit = buttonStartingWith('Submit')!;
    expect(submit.style.backgroundColor).toBe('rgb(30, 58, 138)');
    expect(submit.style.color).toBe('rgb(255, 255, 255)');
  });

  it("draws OK the same in the focused preview, and dark words on a light accent", async () => {
    h.form = formWithAccent('#a3e635');
    h.mode = 'focused';
    await preview();
    const ok = buttonStartingWith('OK')!;
    expect(ok.style.backgroundColor).toBe('rgb(163, 230, 53)');
    // Not white on lime: the near-black the published page uses.
    expect(ok.style.color).not.toBe('');
    expect(ok.style.color).not.toBe('rgb(255, 255, 255)');
  });
});
