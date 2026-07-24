// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateBand } from './CreateBand';
import { useUIStore } from '../../stores/uiStore';

const h = vi.hoisted(() => ({
  downscaleChatImage: vi.fn(),
}));

vi.mock('../../client-runtime/flows/aiDefault', () => ({
  getAiReadiness: () => Promise.resolve({ ready: true }),
}));

vi.mock('./chatImages', () => ({
  CHAT_IMAGES_PER_MESSAGE: 4,
  downscaleChatImage: h.downscaleChatImage,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function renderBand() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <CreateBand />
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('formlogic.createBand.dismissed');
  useUIStore.setState({
    chatOpen: false,
    chatMinimized: true,
    chatLaunch: null,
  });
  h.downscaleChatImage.mockResolvedValue('data:image/jpeg;base64,REF');
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
});

describe('Dashboard creation composer', () => {
  it('opens, restores, and submits the chat from one click', async () => {
    await renderBand();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe what you want to create"]')!;
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Start creating with AI"]')!;

    await act(async () => {
      setTextareaValue(textarea, '  Build a tenant maintenance app  ');
    });
    expect(send.disabled).toBe(false);

    await act(async () => {
      send.click();
      send.click();
    });

    expect(useUIStore.getState()).toMatchObject({
      chatOpen: true,
      chatMinimized: false,
      chatLaunch: { text: 'Build a tenant maintenance app' },
    });
    expect(textarea.value).toBe('');
    expect(send.disabled).toBe(true);
    expect(send.textContent).toContain('Opening chat');
  });

  it('previews an attached image and includes it in the one-shot chat launch', async () => {
    await renderBand();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const image = new File(['reference'], 'reference.png', { type: 'image/png' });

    await act(async () => {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(h.downscaleChatImage).toHaveBeenCalledWith(image);
    expect(container.querySelector('img[alt="Attached reference 1"]')).not.toBeNull();

    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Start creating with AI"]')!;
    expect(send.disabled).toBe(false); // image-only prompts are valid
    await act(async () => {
      send.click();
    });

    expect(useUIStore.getState().chatLaunch).toEqual({
      text: '',
      images: ['data:image/jpeg;base64,REF'],
    });
  });
});
