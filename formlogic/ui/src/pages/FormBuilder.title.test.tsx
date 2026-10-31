// @vitest-environment jsdom
// A typed title reaches the store on blur or unmount. Closing or reloading the tab with the cursor
// still in the box is neither, so the title went with no warning: the unload guard watched saves
// that had started, and this one never had.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/builder', () => ({
  ScriptEditor: () => null, FieldPalette: () => null, SortableFieldCard: () => null, FieldSettingsPanel: () => null,
  FormFlowsPanel: () => null, useFormPreview: () => ({ openPreview: () => undefined, previewChooser: null }),
}));
vi.mock('../components/builder/EmbedModal', () => ({ EmbedModal: () => null }));
vi.mock('../components/chat/SiteChatWidget', () => ({ SiteChatWidget: () => null }));
vi.mock('../components/custom-screen/ScreenModal', () => ({ ScreenModal: () => null }));
vi.mock('../components/studio/SoftnExportPanel', () => ({ SoftnExportPanel: () => null }));

import { useFormStore } from '../stores/formStore';
import type { Form } from '../types/form';
import FormBuilder from './FormBuilder';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

async function openBuilder(title: string) {
  const form = { id: 'f1', title, fields: [], settings: {}, theme: {}, status: 'draft', responseCount: 0 } as unknown as Form;
  useFormStore.setState({ forms: [form], storageMode: 'local', savingFormIds: {}, saveErrors: {} });
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/builder/f1']}><Routes><Route path="/builder/:formId" element={<FormBuilder />} /></Routes></MemoryRouter>);
  });
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useFormStore.setState({ forms: [] });
});

const unloadIsHeldUp = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

async function typeTitle(value: string) {
  const input = host.querySelector('input[aria-label="Form title"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('closing the tab while typing a title', () => {
  it('is held up by a title that has not reached the store', async () => {
    await openBuilder('Intake');
    expect(unloadIsHeldUp()).toBe(false);
    await typeTitle('Intake 2');
    expect(unloadIsHeldUp()).toBe(true);
  });

  it('is left alone once the title is saved, or put back', async () => {
    await openBuilder('Intake');
    await typeTitle('Intake');
    expect(unloadIsHeldUp()).toBe(false);
    await typeTitle('Intake 2');
    await act(async () => { (host.querySelector('input[aria-label="Form title"]') as HTMLInputElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(useFormStore.getState().forms[0].title).toBe('Intake 2');
    expect(unloadIsHeldUp()).toBe(false);
  });

  // Nobody typed anything here, and what a save would write says so.
  it.each([['empty', ''], ['spaces round it', '  Intake  ']])('is left alone by a stored title with %s', async (_name, title) => {
    await openBuilder(title);
    expect(unloadIsHeldUp()).toBe(false);
  });

  it('is held up by a real edit of such a title', async () => {
    await openBuilder('  Intake  ');
    await typeTitle('Intake 2');
    expect(unloadIsHeldUp()).toBe(true);
  });
});
