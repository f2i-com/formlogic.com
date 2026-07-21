// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveConnectionView,
  describeOpOutcome,
  extractListResult,
} from './desktopConnection';
import { DesktopConnectionPopover } from './DesktopConnectionPopover';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../lib/api';

// Desktop Connection popover: presence-driven states (local/remote/none/demo), action
// dispatch over the loopback client vs the ops relay, honest 'uncertain' outcome copy,
// and the AI-source quick-switch's graceful degradation when the Wave-2 preferences
// methods are absent from lib/api.

const h = vi.hoisted(() => ({
  presence: { kind: 'local' } as unknown,
  lastLocation: '',
  desktopClient: {
    services: {
      list: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      repair: vi.fn(),
    },
    plugins: {
      list: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
    },
  },
  runDesktopOp: vi.fn(),
}));

vi.mock('../flows/useFlowsDesktopPresence', () => ({
  useFlowsDesktopPresence: () => h.presence,
  describeFlowsLastSeen: () => 'just now',
}));
vi.mock('../../client-runtime/desktop/desktopClient', () => ({ desktopClient: h.desktopClient }));
vi.mock('../../client-runtime/desktop/desktopOps', () => ({ runDesktopOp: h.runDesktopOp }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVICES = [{ id: 'llama-cpp', name: 'llama.cpp', status: 'running', port: 8080 }];
const PLUGINS = [{ id: 'aokie', name: 'Aokie Receptionist', state: 'running' }];

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const loc = useLocation();
  React.useEffect(() => {
    h.lastLocation = loc.pathname + loc.hash;
  }, [loc.pathname, loc.hash]);
  return null;
}

async function renderPopover() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <LocationProbe />
        <DesktopConnectionPopover />
      </MemoryRouter>
    );
  });
}

function trigger(): HTMLButtonElement {
  return container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

async function openPanel() {
  await act(async () => {
    trigger().click();
  });
  // Flush the async list/preference loads.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function panelButton(text: string, sectionLabel?: string): HTMLButtonElement | undefined {
  const scope: ParentNode = sectionLabel
    ? (panel()?.querySelector(`section[aria-label="${sectionLabel}"]`) ?? panel()!)
    : panel()!;
  const buttons = Array.from(scope.querySelectorAll('button'));
  return buttons.find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  h.presence = { kind: 'local' };
  h.lastLocation = '';
  useAuthStore.setState({ user: { id: 'u1', email: 'u1@example.com' }, isLoading: false, isInitialized: true, error: null });
  useUIStore.setState({ isMobile: false, sidebarCollapsed: false });
  useToastStore.getState().clearToasts();
  h.desktopClient.services.list.mockResolvedValue({ ok: true, data: SERVICES });
  h.desktopClient.plugins.list.mockResolvedValue({ ok: true, data: PLUGINS });
  for (const fn of [h.desktopClient.services.start, h.desktopClient.services.stop, h.desktopClient.services.restart, h.desktopClient.services.repair]) {
    fn.mockResolvedValue({ ok: true, data: {} });
  }
  for (const fn of [h.desktopClient.plugins.start, h.desktopClient.plugins.stop, h.desktopClient.plugins.restart]) {
    fn.mockResolvedValue({ ok: true, data: {} });
  }
  h.runDesktopOp.mockImplementation(async (req: { op: string }) => {
    if (req.op === 'desktop.services.list') {
      return { ok: true, outcome: { status: 'done', result: { services: SERVICES }, commandId: 'l1' } };
    }
    if (req.op === 'desktop.plugins.list') {
      return { ok: true, outcome: { status: 'done', result: { plugins: PLUGINS }, commandId: 'l2' } };
    }
    return { ok: true, outcome: { status: 'done', result: { restarted: true }, commandId: 'a1' } };
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  document.body.innerHTML = '';
  useAuthStore.setState({ user: null, isLoading: false, isInitialized: true, error: null });
  delete (api as unknown as Record<string, unknown>).getAiPreferences;
  delete (api as unknown as Record<string, unknown>).putAiPreferences;
});

describe('deriveConnectionView', () => {
  it('maps each presence kind to a distinct trigger state', () => {
    expect(deriveConnectionView({ kind: 'local' }, false).kind).toBe('local');
    expect(deriveConnectionView({ kind: 'remote', label: 'SHOP-PC' }, false).label).toBe('Desktop — SHOP-PC');
    expect(deriveConnectionView({ kind: 'none' }, false).label).toBe('No desktop');
    // The demo account is ALWAYS the demo bridge, even with a paired local desktop.
    expect(deriveConnectionView({ kind: 'local' }, true).kind).toBe('demo');
  });
});

describe('describeOpOutcome', () => {
  it('names an uncertain outcome honestly instead of faking a failure', () => {
    const feedback = describeOpOutcome('restart aokie', { status: 'uncertain', commandId: 'c1' });
    expect(feedback.tone).toBe('warning');
    expect(feedback.text).toContain('outcome uncertain');
    expect(describeOpOutcome('restart aokie', { status: 'expired' }).tone).toBe('error');
    expect(describeOpOutcome('restart aokie', { status: 'done' }).tone).toBe('success');
  });
});

describe('extractListResult', () => {
  it('accepts the loopback body shape, a bare array, and a nested data wrapper', () => {
    expect(extractListResult({ services: [1] }, 'services')).toEqual([1]);
    expect(extractListResult([2], 'services')).toEqual([2]);
    expect(extractListResult({ data: { plugins: [3] } }, 'plugins')).toEqual([3]);
    expect(extractListResult({ other: [] }, 'services')).toEqual([]);
  });
});

describe('DesktopConnectionPopover — local presence', () => {
  it('shows the local label and lists services + plugins from the loopback client', async () => {
    await renderPopover();
    expect(trigger().textContent).toContain('Desktop — this device');

    await openPanel();

    expect(h.desktopClient.services.list).toHaveBeenCalledTimes(1);
    expect(h.desktopClient.plugins.list).toHaveBeenCalledTimes(1);
    expect(h.runDesktopOp).not.toHaveBeenCalled();
    expect(panel()!.textContent).toContain('llama.cpp');
    expect(panel()!.textContent).toContain('Aokie Receptionist');
    expect(panel()!.textContent).toContain('running');
    // The AI quick-switch degrades to hidden while lib/api has no preferences methods.
    expect(panel()!.textContent).not.toContain('AI source');
  });

  it('dispatches a service restart through the loopback client with success copy', async () => {
    await renderPopover();
    await openPanel();

    await act(async () => {
      panelButton('Restart')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.desktopClient.services.restart).toHaveBeenCalledWith('llama-cpp');
    expect(h.runDesktopOp).not.toHaveBeenCalled();
    expect(panel()!.querySelector('[role="status"]')!.textContent).toBe('restart llama-cpp completed.');
  });

  it('surfaces a typed loopback refusal as an error notice', async () => {
    h.desktopClient.services.restart.mockResolvedValue({
      ok: false,
      error: { code: 'command_failed', message: 'service failed to start' },
    });
    await renderPopover();
    await openPanel();

    await act(async () => {
      panelButton('Restart')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(panel()!.querySelector('[role="status"]')!.textContent).toContain('failed: service failed to start');
  });
});

describe('DesktopConnectionPopover — remote presence', () => {
  beforeEach(() => {
    h.presence = { kind: 'remote', label: 'DESKTOP-HESQH3A', lastSeenMs: Date.now() };
  });

  it('shows the device label and lists services + plugins through the ops relay', async () => {
    await renderPopover();
    expect(trigger().textContent).toContain('Desktop — DESKTOP-HESQH3A');

    await openPanel();

    const ops = h.runDesktopOp.mock.calls.map((c) => (c[0] as { op: string }).op);
    expect(ops).toContain('desktop.services.list');
    expect(ops).toContain('desktop.plugins.list');
    expect(h.desktopClient.services.list).not.toHaveBeenCalled();
    expect(panel()!.textContent).toContain('llama.cpp');
    expect(panel()!.textContent).toContain('Aokie Receptionist');
    expect(panel()!.textContent).toContain('last seen just now');
  });

  it('dispatches a plugin restart through the ops relay', async () => {
    await renderPopover();
    await openPanel();

    await act(async () => {
      panelButton('Restart', 'Plugins')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.runDesktopOp).toHaveBeenCalledWith({ op: 'desktop.plugins.restart', pluginId: 'aokie' });
    expect(h.desktopClient.plugins.restart).not.toHaveBeenCalled();
    expect(panel()!.querySelector('[role="status"]')!.textContent).toBe('restart aokie completed.');
  });

  it('renders a claimed-but-unreported relay outcome as uncertain copy', async () => {
    h.runDesktopOp.mockImplementation(async (req: { op: string }) => {
      if (req.op === 'desktop.services.list') {
        return { ok: true, outcome: { status: 'done', result: { services: SERVICES }, commandId: 'l1' } };
      }
      if (req.op === 'desktop.plugins.list') {
        return { ok: true, outcome: { status: 'done', result: { plugins: PLUGINS }, commandId: 'l2' } };
      }
      return { ok: true, outcome: { status: 'uncertain', commandId: 'a9' } };
    });
    await renderPopover();
    await openPanel();

    await act(async () => {
      panelButton('Restart')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const notice = panel()!.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain('outcome uncertain');
    expect(notice.textContent).toContain('may have completed');
  });
});

describe('DesktopConnectionPopover — no linked desktop', () => {
  it('shows the connect CTA deep-linking Settings → Linked Desktops', async () => {
    h.presence = { kind: 'none' };
    await renderPopover();
    expect(trigger().textContent).toContain('No desktop');

    await openPanel();
    expect(panel()!.textContent).toContain('Link a desktop');

    await act(async () => {
      panelButton('Link a desktop')!.click();
    });
    expect(h.lastLocation).toBe('/settings#linked-desktops');
    // No lifecycle traffic in the none state.
    expect(h.desktopClient.services.list).not.toHaveBeenCalled();
    expect(h.runDesktopOp).not.toHaveBeenCalled();
  });
});

describe('DesktopConnectionPopover — demo account', () => {
  it('shows the honest demo-bridge state and never touches a desktop', async () => {
    useAuthStore.setState({ user: { id: 'demo', email: 'demo@formlogic.local', isDemo: true }, isLoading: false, isInitialized: true, error: null });
    await renderPopover();
    expect(trigger().textContent).toContain('Demo bridge');

    await openPanel();

    expect(panel()!.textContent).toContain('hardware is simulated');
    expect(panel()!.textContent).not.toContain('Services');
    expect(h.desktopClient.services.list).not.toHaveBeenCalled();
    expect(h.runDesktopOp).not.toHaveBeenCalled();
  });
});

describe('DesktopConnectionPopover — AI-source quick-switch', () => {
  it('reads and writes the AI source through the Wave-2 preferences methods', async () => {
    let current: Record<string, unknown> = { aiSource: 'site' };
    (api as unknown as Record<string, unknown>).getAiPreferences = async () => ({ data: { ...current } });
    (api as unknown as Record<string, unknown>).putAiPreferences = async (prefs: Record<string, unknown>) => {
      current = { ...current, ...prefs };
      return { data: { ...current } };
    };

    await renderPopover();
    await openPanel();

    expect(panel()!.textContent).toContain('AI source');
    const desktopOption = Array.from(panel()!.querySelectorAll('[role="radio"]')).find(
      (el) => el.textContent?.includes('Desktop AI')
    ) as HTMLElement;
    expect(desktopOption.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      desktopOption.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(current.aiSource).toBe('desktop');
    expect(
      (Array.from(panel()!.querySelectorAll('[role="radio"]')).find((el) => el.textContent?.includes('Desktop AI')) as HTMLElement).getAttribute('aria-checked')
    ).toBe('true');
  });
});
