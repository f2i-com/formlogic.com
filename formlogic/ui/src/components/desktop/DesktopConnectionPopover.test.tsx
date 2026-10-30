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
  oaiyDetected: false,
  oaiy: {
    listServices: vi.fn(),
    serviceAction: vi.fn(),
    listPlugins: vi.fn(),
    startPlugin: vi.fn(),
    stopPlugin: vi.fn(),
    restartPlugin: vi.fn(),
  },
}));

vi.mock('../flows/useFlowsDesktopPresence', () => ({
  useFlowsDesktopPresence: () => h.presence,
  describeFlowsLastSeen: () => 'just now',
}));
vi.mock('../../client-runtime/desktop/desktopClient', () => ({ desktopClient: h.desktopClient }));
vi.mock('../../client-runtime/desktop/desktopOps', () => ({ runDesktopOp: h.runDesktopOp }));
vi.mock('../../client-runtime/oaiy/oaiyDetection', () => ({
  getOaiyStatus: () => ({ available: h.oaiyDetected }),
  subscribeOaiyStatus: () => () => {},
}));
vi.mock('../../client-runtime/oaiy/oaiyRuntime', () => ({
  listOaiyPlugins: h.oaiy.listPlugins,
  startOaiyPlugin: h.oaiy.startPlugin,
  stopOaiyPlugin: h.oaiy.stopPlugin,
  restartOaiyPlugin: h.oaiy.restartPlugin,
  setOaiyToken: vi.fn(),
  setOaiyTokenAccount: vi.fn(),
  forgetOaiyTokenOf: vi.fn(),
}));
vi.mock('../../client-runtime/oaiy/oaiyServices', () => ({
  listOaiyServices: h.oaiy.listServices,
  oaiyServiceAction: h.oaiy.serviceAction,
}));

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

async function renderPopover(initialPath = '/flows') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
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
  h.oaiyDetected = false;
  h.oaiy.listServices.mockResolvedValue(SERVICES);
  h.oaiy.listPlugins.mockResolvedValue(PLUGINS);
  for (const fn of [h.oaiy.serviceAction, h.oaiy.startPlugin, h.oaiy.stopPlugin, h.oaiy.restartPlugin]) fn.mockResolvedValue({ ok: true });
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

  it('tells OAIY paired here from OAIY only found here, and a linked desktop outranks asking for a code', () => {
    expect(deriveConnectionView({ kind: 'local', runtime: 'oaiy', label: 'OAIY' }, false).label).toBe('OAIY connected');
    expect(deriveConnectionView({ kind: 'none' }, false, undefined, true).label).toBe('Connect OAIY');
    expect(deriveConnectionView({ kind: 'remote', label: 'SHOP-PC' }, false, undefined, true).kind).toBe('remote');
    expect(deriveConnectionView({ kind: 'local', runtime: 'oaiy', label: 'OAIY' }, true).kind).toBe('demo');
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
  it('keeps the current desktop lists when an earlier transport replies late', async () => {
    let finishLocal!: (result: unknown) => void;
    h.desktopClient.services.list.mockImplementationOnce(() => new Promise((resolve) => { finishLocal = resolve; }));
    h.runDesktopOp.mockImplementation(async (req: { op: string }) => ({
      ok: true,
      outcome: {
        status: 'done', commandId: 'remote-list',
        result: req.op === 'desktop.services.list'
          ? { services: [{ ...SERVICES[0], name: 'Remote model service' }] }
          : { plugins: PLUGINS },
      },
    }));
    await renderPopover();
    await openPanel();
    expect(h.desktopClient.services.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      h.presence = { kind: 'remote', label: 'OTHER-PC', lastSeenMs: Date.now() };
      // The real presence hook subscribes externally; this store change triggers
      // the same rerender for the test's controlled presence value.
      useUIStore.setState({ sidebarCollapsed: true });
    });
    expect(panel()!.textContent).toContain('Remote model service');
    await act(async () => { finishLocal({ ok: true, data: SERVICES }); });
    expect(panel()!.textContent).toContain('Remote model service');
    expect(panel()!.textContent).not.toContain('llama.cpp');
  });

  it('stays out of the App Studio on a phone, where the section owns the bottom edge', async () => {
    useUIStore.setState({ isMobile: true });
    await renderPopover('/apps/a1/studio/automations');
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
  });

  it('floats over a phone\'s page only when a desktop is linked, not to say none is', async () => {
    useUIStore.setState({ isMobile: true });
    h.presence = { kind: 'none' };
    await renderPopover('/apps/new');
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();
    await act(async () => { root.unmount(); });
    container.remove();
    h.presence = { kind: 'remote', label: 'OTHER-PC', lastSeenMs: Date.now() };
    await renderPopover('/apps/new');
    expect(trigger().textContent).toContain('Desktop — OTHER-PC');
  });

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

describe('DesktopConnectionPopover — OAIY paired on this computer', () => {
  beforeEach(() => {
    h.presence = { kind: 'local', runtime: 'oaiy', label: 'OAIY' };
    h.oaiyDetected = true;
  });

  it('opens the menu rather than leaving for Settings, listing OAIY\'s services and plugins', async () => {
    await renderPopover();
    expect(trigger().textContent).toContain('OAIY connected');
    await openPanel();
    expect(h.lastLocation).toBe('/flows');
    expect(panel()!.textContent).toContain('llama.cpp');
    expect(panel()!.textContent).toContain('Aokie Receptionist');
    // Never the legacy companion's routes or the relay: this is OAIY's own runtime.
    expect(h.desktopClient.services.list).not.toHaveBeenCalled();
    expect(h.runDesktopOp).not.toHaveBeenCalled();
  });

  it.each(['Stop', 'Restart', 'Repair'])('%ss a service through OAIY', async (button) => {
    await renderPopover();
    await openPanel();
    await act(async () => {
      panelButton(button, 'Services')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.oaiy.serviceAction).toHaveBeenCalledWith('llama-cpp', button.toLowerCase());
    expect(h.desktopClient.services[button.toLowerCase() as 'stop']).not.toHaveBeenCalled();
    expect(h.oaiy.listServices).toHaveBeenCalledTimes(2); // the list follows what was done
  });

  it('starts a stopped service, and restarts a plugin, through OAIY', async () => {
    h.oaiy.listServices.mockResolvedValue([{ id: 'llama-cpp', name: 'llama.cpp', status: 'stopped', port: 8080 }]);
    await renderPopover();
    await openPanel();
    await act(async () => {
      panelButton('Start', 'Services')!.click();
    });
    await act(async () => {
      panelButton('Restart', 'Plugins')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.oaiy.serviceAction).toHaveBeenCalledWith('llama-cpp', 'start');
    expect(h.oaiy.restartPlugin).toHaveBeenCalledWith('aokie');
  });

  it('says what OAIY said when an action fails', async () => {
    h.oaiy.serviceAction.mockResolvedValue({ ok: false, error: 'port 8080 is in use' });
    await renderPopover();
    await openPanel();
    await act(async () => {
      panelButton('Stop', 'Services')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(panel()!.querySelector('[role="status"]')!.textContent).toContain('port 8080 is in use');
  });

  it('says so when OAIY stops answering, and keeps a way to its settings', async () => {
    h.oaiy.listServices.mockResolvedValue(null);
    h.oaiy.listPlugins.mockResolvedValue(null);
    await renderPopover();
    await openPanel();
    expect(panel()!.textContent).toContain('OAIY Desktop did not answer.');
    await act(async () => {
      panelButton('Connection settings')!.click();
    });
    expect(h.lastLocation).toBe('/settings#local-runtime');
  });
});

describe('DesktopConnectionPopover — OAIY on this computer, not paired', () => {
  beforeEach(() => {
    h.oaiyDetected = true;
  });

  it('drives a desktop linked to the account through the relay, asking for no code', async () => {
    h.presence = { kind: 'remote', label: 'SHOP-PC' };
    await renderPopover();
    await openPanel();
    expect(trigger().textContent).toContain('SHOP-PC');
    expect(panel()!.textContent).not.toContain('Connect this computer');
    expect(h.runDesktopOp).toHaveBeenCalledWith({ op: 'desktop.services.list' });
    expect(h.oaiy.listServices).not.toHaveBeenCalled();
  });

  it('asks to connect only when nothing reaches it, and sends the person to pair', async () => {
    h.presence = { kind: 'none' };
    await renderPopover();
    expect(trigger().textContent).toContain('Connect OAIY');
    await openPanel();
    expect(h.oaiy.listServices).not.toHaveBeenCalled();
    await act(async () => {
      panelButton('Connect this computer')!.click();
    });
    expect(h.lastLocation).toBe('/settings#local-runtime');
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
    expect(h.lastLocation).toBe('/settings#local-runtime');
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
