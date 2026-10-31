// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSupportAccess = vi.fn();
const setSupportAccess = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { getSupportAccess: () => getSupportAccess(), setSupportAccess: (allow: boolean) => setSupportAccess(allow) },
}));

import { useAuthStore } from '../../stores/authStore';
import { SupportAccessPanel } from './SupportAccessPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = { id: 'owner-1', email: 'owner@example.com', name: 'Owner' };
let root: Root;
let container: HTMLDivElement;

async function open() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<SupportAccessPanel />));
}

const button = (name: string) => Array.from(container.querySelectorAll('button')).find(found => found.textContent?.includes(name));

beforeEach(() => {
  getSupportAccess.mockReset().mockResolvedValue({ data: { until: null, activity: [] } });
  setSupportAccess.mockReset();
  useAuthStore.setState({ user: owner as never });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAuthStore.setState({ user: null });
});

describe('SupportAccessPanel', () => {
  it('is off until the owner allows it, for a day, and can be ended', async () => {
    await open();
    expect(container.textContent).toContain('No administrator has been in your account');
    setSupportAccess.mockResolvedValue({ data: { until: '2026-11-01T10:00:00+00:00' } });
    await act(async () => { button('Allow for 24 hours')?.click(); });
    expect(setSupportAccess).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain('Allowed until');

    setSupportAccess.mockResolvedValue({ data: { until: null } });
    await act(async () => { button('End now')?.click(); });
    expect(setSupportAccess).toHaveBeenLastCalledWith(false);
    expect(button('Allow for 24 hours')).toBeDefined();
  });

  it('shows what administrators did here', async () => {
    getSupportAccess.mockResolvedValue({ data: { until: null, activity: [{ at: '2026-10-31T10:00:00+00:00', what: 'An administrator opened your account' }] } });
    await open();
    expect(container.textContent).toContain('An administrator opened your account');
  });

  it('says so when it could not be read, rather than showing it as off', async () => {
    getSupportAccess.mockResolvedValue({ error: 'Network error' });
    await open();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('Allow for 24 hours')).toBeUndefined();
  });

  it('does not take the page down over a reply it cannot read', async () => {
    getSupportAccess.mockResolvedValue({ data: { keys: [] } });
    await open();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('is not shown in the shared demo', async () => {
    useAuthStore.setState({ user: { ...owner, isDemo: true } as never });
    await open();
    expect(container.textContent).toBe('');
    expect(getSupportAccess).not.toHaveBeenCalled();
  });
});
