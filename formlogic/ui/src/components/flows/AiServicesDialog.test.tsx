// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FlowsDesktopPresence } from './useFlowsDesktopPresence';

const services = vi.hoisted(() => ({ oaiy: vi.fn(), legacy: vi.fn() }));
vi.mock('../../client-runtime/oaiy/oaiyServices', () => ({ listOaiyServices: services.oaiy }));
vi.mock('../../client-runtime/desktop/desktopClient', () => ({ desktopClient: { services: { list: services.legacy } } }));
import AiServicesDialog from './AiServicesDialog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  services.oaiy.mockReset().mockResolvedValue([{ id: 'llamacpp', name: 'Local Qwen', status: 'running', port: 8081 }]);
  services.legacy.mockReset().mockResolvedValue({ ok: true, data: [{ id: 'legacy', name: 'Legacy model', status: 'running', port: 8082 }] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(presence: FlowsDesktopPresence) {
  await act(async () => root.render(<MemoryRouter><AiServicesDialog isOpen onClose={() => {}} desktopPresence={presence} /></MemoryRouter>));
}
it('lists the paired OAIY services without calling the legacy bridge', async () => {
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Local Qwen');
  expect(services.oaiy).toHaveBeenCalledOnce();
  expect(services.legacy).not.toHaveBeenCalled();
});
it('replaces the service list when the active local runtime changes', async () => {
  await render({ kind: 'local' });
  expect(document.body.textContent).toContain('Legacy model');
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Local Qwen');
  expect(document.body.textContent).not.toContain('Legacy model');
  await render({ kind: 'none' });
  expect(document.body.textContent).not.toContain('Local Qwen');
  expect(document.body.textContent).toContain('Connect OAIY');
});
it('shows an OAIY connection error instead of falling back to unrelated services', async () => {
  services.oaiy.mockResolvedValue(null);
  await render({ kind: 'local', runtime: 'oaiy' });
  expect(document.body.textContent).toContain('Could not load OAIY services');
  expect(document.body.textContent).not.toContain('Loading local services');
  expect(services.legacy).not.toHaveBeenCalled();
});
