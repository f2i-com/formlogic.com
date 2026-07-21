// @vitest-environment jsdom
// Admin "AI & credits allowances" card (Site AI plan Phase 2 step 9): renders the
// plan_allowances rows, stages edits, saves them per-row via PUT /api/admin/allowances,
// and keeps unsaved rows visibly dirty on failure.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { adminListAllowancesMock, adminPutAllowanceMock, toastSuccess, toastError } = vi.hoisted(() => ({
  adminListAllowancesMock: vi.fn(),
  adminPutAllowanceMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: {
    adminListAllowances: (...args: unknown[]) => adminListAllowancesMock(...args),
    adminPutAllowance: (...args: unknown[]) => adminPutAllowanceMock(...args),
  },
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import { AdminAllowancesCard } from './AdminAllowancesCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function rowOf(container: HTMLElement, plan: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('div.rounded-lg.border')).find((el) =>
    el.textContent?.includes(plan),
  );
  if (!row) throw new Error(`row for plan ${plan} not found`);
  return row;
}

describe('AdminAllowancesCard', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminAllowancesCard />);
    });
    await flush();
  }

  it('renders the allowance rows with plan, metric, value and toggle', async () => {
    adminListAllowancesMock.mockResolvedValue({
      data: {
        allowances: [
          { plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: true },
          { plan: 'free', metric: 'cloud_flow_runs', monthlyValue: 0, enabled: false },
        ],
      },
    });
    await mount();

    const cloud = rowOf(container!, 'cloud');
    expect(cloud.textContent).toContain('AI messages / month');
    const input = cloud.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value).toBe('500');
    expect(cloud.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('true');

    const free = rowOf(container!, 'free');
    expect(free.textContent).toContain('Cloud flow runs / month');
    expect(free.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the load error with retry when allowances cannot load', async () => {
    adminListAllowancesMock.mockResolvedValue({ error: 'Forbidden', status: 403 });
    await mount();
    expect(container!.textContent).toContain('Forbidden');
    expect(container!.textContent).toContain('Try again');
  });

  it('shows an honest empty state', async () => {
    adminListAllowancesMock.mockResolvedValue({ data: { allowances: [] } });
    await mount();
    expect(container!.textContent).toContain('No allowances are configured yet.');
  });

  it('saves an edited monthly value via PUT and clears the dirty flag', async () => {
    adminListAllowancesMock.mockResolvedValue({
      data: { allowances: [{ plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: true }] },
    });
    adminPutAllowanceMock.mockResolvedValue({
      data: { allowance: { plan: 'cloud', metric: 'ai_messages', monthlyValue: 750, enabled: true } },
    });
    await mount();

    const row = rowOf(container!, 'cloud');
    const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      setInputValue(input, '750');
    });
    expect(row.textContent).toContain('unsaved');

    const saveButton = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(adminPutAllowanceMock).toHaveBeenCalledWith({ plan: 'cloud', metric: 'ai_messages', monthlyValue: 750, enabled: true });
    expect(toastSuccess).toHaveBeenCalledWith('Allowance saved', expect.any(String));
    expect(rowOf(container!, 'cloud').textContent).not.toContain('unsaved');
  });

  it('saves a toggled enabled flag', async () => {
    adminListAllowancesMock.mockResolvedValue({
      data: { allowances: [{ plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: true }] },
    });
    adminPutAllowanceMock.mockResolvedValue({
      data: { allowance: { plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: false } },
    });
    await mount();

    const row = rowOf(container!, 'cloud');
    const toggle = row.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => {
      toggle.click();
    });
    const saveButton = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(adminPutAllowanceMock).toHaveBeenCalledWith({ plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: false });
  });

  it('keeps the row dirty and toasts when the save fails', async () => {
    adminListAllowancesMock.mockResolvedValue({
      data: { allowances: [{ plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: true }] },
    });
    adminPutAllowanceMock.mockResolvedValue({ error: 'database is locked', status: 500 });
    await mount();

    const row = rowOf(container!, 'cloud');
    const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      setInputValue(input, '900');
    });
    const saveButton = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(toastError).toHaveBeenCalledWith('Could not save the allowance', 'database is locked');
    expect(rowOf(container!, 'cloud').textContent).toContain('unsaved');
  });

  it('rejects a non-numeric monthly value before any PUT', async () => {
    adminListAllowancesMock.mockResolvedValue({
      data: { allowances: [{ plan: 'cloud', metric: 'ai_messages', monthlyValue: 500, enabled: true }] },
    });
    await mount();

    const row = rowOf(container!, 'cloud');
    const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      setInputValue(input, 'many');
    });
    const saveButton = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      saveButton.click();
    });
    await flush();

    expect(adminPutAllowanceMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Invalid monthly value', expect.any(String));
  });
});
