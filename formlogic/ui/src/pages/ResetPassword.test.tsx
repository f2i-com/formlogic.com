// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resetPassword } = vi.hoisted(() => ({ resetPassword: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { resetPassword } }));

import { ResetPassword } from './ResetPassword';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const reset = async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/reset-password?token=abc']}><ResetPassword /></MemoryRouter>
  ));
  await act(async () => {
    for (const input of host.querySelectorAll<HTMLInputElement>('input')) type(input, 'a-strong-password-123');
  });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

describe('ResetPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('says what the reset ended, and leaves it on the screen to be read', async () => {
    resetPassword.mockResolvedValue({ data: { success: true } });
    await reset();
    expect(resetPassword).toHaveBeenCalledWith('abc', 'a-strong-password-123');

    const said = () => host.textContent ?? '';
    expect(said()).toContain('API keys were turned off');
    expect(said()).toContain('such as OAIY were signed out');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(said()).toContain('such as OAIY were signed out');
    expect(host.querySelector('a[href="/login"]')?.textContent).toBe('Sign in');
  });

  it('says nothing of the kind when the reset failed', async () => {
    resetPassword.mockResolvedValue({ error: 'This reset link is invalid or has expired.' });
    await reset();
    expect(host.textContent).toContain('invalid or has expired');
    expect(host.textContent).not.toContain('API keys');
  });
});
