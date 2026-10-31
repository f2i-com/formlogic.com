// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import { LiveDemoSection } from './LiveDemoSection';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderSection() {
  vi.spyOn(api, 'getDemoApps').mockResolvedValue({ data: { apps: [{ slug: 'crm', name: 'CRM', description: '', logoUrl: null }] } } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter><LiveDemoSection /></MemoryRouter>);
  });
}

const launchButton = () => Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.includes('Launch the live demo'))!;

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks();
});

describe('LiveDemoSection launch', () => {
  it('says so when the demo cannot start, and opens nothing', async () => {
    vi.spyOn(api, 'startDemo').mockResolvedValue({ error: 'The demo is unavailable' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderSection();

    await act(async () => launchButton().click());

    expect(open).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Could not start the demo', message: 'The demo is unavailable' }),
    ]);
    expect(launchButton().disabled).toBe(false);
  });

  it('opens the demo in a new tab when it starts', async () => {
    vi.spyOn(api, 'startDemo').mockResolvedValue({ data: { user: {} } } as never);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderSection();

    await act(async () => launchButton().click());

    expect(open).toHaveBeenCalledWith('/dashboard', '_blank', 'noopener');
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
