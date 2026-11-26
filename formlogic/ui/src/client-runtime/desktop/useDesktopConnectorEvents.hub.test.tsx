// @vitest-environment jsdom
// The hook hands app logic every hub envelope whose connector is one this runtime has, reading an
// envelope with no connectorId as its source's. OAIY's own events about how its flows' runs ended
// come from the source "flows" with no connectorId, so an app with a connector under that name had
// its onConnectorEvent scripts run for every flow OAIY ran on the computer. The hub keeps those
// envelopes from its listeners now; what a real connector says still arrives.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesktopConnectorEvents, type RunConnectorEvent } from './useDesktopConnectorEvents';
import { __resetDesktopEventsForTests, ingestDesktopEvent } from './desktopEvents';
import { registerBrowserConnector, unregisterBrowserConnector } from '../connectors/nativeConnectorClient';
import { __resetFlowDispatcherForTests, __setFlowDispatcherDepsForTests } from '../flows/flowDispatcher';
import { __resetAppLocalAccessForTests, setOnScreenApp } from '../appLocalAccess';
import type { BrowserConnector } from '../connectors/connectorTypes';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const connector = (id: string): BrowserConnector => ({
  id, kind: 'test', label: id, commands: ['read'],
  status: () => ({ id, kind: 'test', available: true, source: 'mock', label: id }),
  request: async () => ({}),
});

function Listener({ run }: { run: RunConnectorEvent }) {
  useDesktopConnectorEvents({ appSlug: 'my-app', enabled: true, runConnectorEvent: run });
  return null;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('offline')));
  registerBrowserConnector(connector('flows'));
  registerBrowserConnector(connector('aokie'));
  setOnScreenApp({ id: 'app-1', slug: 'my-app', name: 'Mine', manages: true });
  __setFlowDispatcherDepsForTests({ desktopRuntimeFresh: async () => false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  unregisterBrowserConnector('flows');
  unregisterBrowserConnector('aokie');
  __resetDesktopEventsForTests();
  __resetFlowDispatcherForTests();
  __resetAppLocalAccessForTests();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

describe('desktop events for app logic', () => {
  it('do not include the end of a run OAIY made of its own flow, whatever the app calls its connector', async () => {
    const run = vi.fn<RunConnectorEvent>(async () => ({ ran: 0, rejected: false, warnings: [], values: {}, deniedPermissions: [], errors: [] }));
    await act(async () => { root.render(<Listener run={run} />); });

    ingestDesktopEvent({ schemaVersion: 1, source: 'flows', name: 'flow.failed', correlationId: 'run-9', idempotencyKey: 'flow:run-9:failed', occurredAt: '2026-11-01T00:00:00Z', data: { runId: 'run-9', status: 'failed' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();

    ingestDesktopEvent({ schemaVersion: 1, source: 'aokie', connectorId: 'aokie', name: 'vehicle.status.changed', correlationId: 'c-1', idempotencyKey: 'k-1', occurredAt: '2026-11-01T00:00:00Z', data: { ok: true } });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0]).toMatchObject({ connectorId: 'aokie', name: 'vehicle.status.changed' });
  });
});
