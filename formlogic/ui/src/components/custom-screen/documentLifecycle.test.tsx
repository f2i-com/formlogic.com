// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCustomScreenRuntime } from './AppCustomScreenRuntime';
import { CustomScreenRuntime } from './CustomScreenRuntime';
import { useUIStore } from '../../stores/uiStore';

const h = vi.hoisted(() => ({ getAppResponses: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { getAppResponses: h.getAppResponses, isDemoMode: () => false } }));
vi.mock('../../lib/screenCompile', () => ({
  resolveScreenAssets: async (screen: { html?: string; css?: string; js?: string }) => ({
    html: screen.html || '', css: screen.css || '', js: screen.js || '',
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ theme: 'light' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe.each(['app', 'form'] as const)('%s custom-screen document lifecycle', (kind) => {
  async function render(html: string) {
    const screen = { html, css: '.content { padding: 12px; }', js: '', _trust: 'owner' as const };
    await act(async () => {
      root.render(<StrictMode>{kind === 'app'
        ? <AppCustomScreenRuntime screen={screen} appSlug="demo" appName="Demo" forms={[{ formId: 'notes', displayName: 'Notes', fields: [], settings: {} }]} />
        : <CustomScreenRuntime screen={screen} appSlug="demo" formId="notes" formTitle="Notes" />}</StrictMode>);
    });
    return container.querySelector('iframe')!;
  }

  function collectPortMessages(port: MessagePort): unknown[] {
    const msgs: unknown[] = [];
    port.onmessage = (e) => { msgs.push(e.data); };
    port.start();
    return msgs;
  }

  async function flushPorts() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }

  it('retains the live document for theme and identical-content updates, replacing it for changed content', async () => {
    const original = await render('<main>First document</main>');
    const sent = vi.spyOn(original.contentWindow!, 'postMessage');
    await act(async () => original.dispatchEvent(new Event('load')));
    const firstCall = sent.mock.calls.find(([message]) => message.__flScreenDoc) as unknown[] | undefined;
    const firstDocument = (firstCall?.[0] as { __flScreenDoc?: string } | undefined)?.__flScreenDoc as string;
    const firstPort = (firstCall?.[2] as Transferable[] | undefined)?.[0] as MessagePort;
    const firstGeneration = Number(firstDocument.match(/var __flGen=(\d+)/)?.[1]);
    expect(firstDocument).toContain('First document');
    expect(firstDocument).toContain('window.__flClaimPort');
    expect(firstPort).toBeDefined();
    const firstMsgs = collectPortMessages(firstPort);

    await act(async () => useUIStore.setState({ theme: 'dark' }));
    await flushPorts();
    expect(container.querySelector('iframe')).toBe(original);
    expect(firstMsgs).toContainEqual({ __flTheme: 'dark' });
    expect(await render('<main>First document</main>')).toBe(original);

    const replacement = await render('<main>Second document</main>');
    expect(replacement).not.toBe(original);
    const replacementSent = vi.spyOn(replacement.contentWindow!, 'postMessage');
    await act(async () => replacement.dispatchEvent(new Event('load')));
    const secondCall = replacementSent.mock.calls.find(([message]) => message.__flScreenDoc) as unknown[] | undefined;
    const secondDocument = (secondCall?.[0] as { __flScreenDoc?: string } | undefined)?.__flScreenDoc as string;
    const secondPort = (secondCall?.[2] as Transferable[] | undefined)?.[0] as MessagePort;
    expect(secondDocument).toContain('Second document');
    expect(secondDocument).toContain('<html class="fl-dark">');
    expect(secondDocument).toContain(`var __flGen=${firstGeneration + 1};`);
    expect(secondPort).toBeDefined();
    const secondMsgs = collectPortMessages(secondPort);

    // Stale generation stamped onto the new port is refused loudly.
    secondPort.postMessage({ __fl: true, action: 'context', id: 'previous-document', gen: firstGeneration });
    await flushPorts();
    expect(secondMsgs).toContainEqual({
      __flReply: true, id: 'previous-document', error: 'This screen was reloaded — request ignored.',
    });

    // A navigated/stalled external document without the private MessagePort cannot invoke the SDK via window.postMessage.
    const msgsBeforeForged = secondMsgs.length;
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      origin: 'null',
      source: replacement.contentWindow,
      data: { __fl: true, action: 'records', id: 'forged-window-post', gen: firstGeneration + 1, payload: { formId: 'notes' } },
    })));
    await flushPorts();
    expect(h.getAppResponses).not.toHaveBeenCalled();
    expect(secondMsgs.length).toBe(msgsBeforeForged);

    // screen-host.html hydrates in place without document.open()/write()/close(), so a
    // second iframe load unconditionally indicates an unexpected navigation escape — lock out SDK.
    await act(async () => replacement.dispatchEvent(new Event('load')));
    const msgsAfterEscape = secondMsgs.length;
    secondPort.postMessage({ __fl: true, action: 'context', id: 'after-escape', gen: firstGeneration + 1 });
    await flushPorts();
    expect(secondMsgs.length).toBe(msgsAfterEscape);

    firstPort.close();
    secondPort.close();
  });

  it('keeps a pending API reply from reaching a replacement document', async () => {
    let finish!: (result: unknown) => void;
    h.getAppResponses.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const original = await render('<main>First document</main>');
    const origSent = vi.spyOn(original.contentWindow!, 'postMessage');
    await act(async () => original.dispatchEvent(new Event('load')));
    const origCall = origSent.mock.calls.find(([m]) => m.__flScreenDoc) as unknown[] | undefined;
    const origPort = (origCall?.[2] as Transferable[] | undefined)?.[0] as MessagePort;
    const origMsgs = collectPortMessages(origPort);

    origPort.postMessage({ __fl: true, action: 'records', id: 'pending', gen: 0, payload: { formId: 'notes' } });
    await flushPorts();
    expect(h.getAppResponses).toHaveBeenCalledOnce();

    const replacement = await render('<main>Second document</main>');
    const repSent = vi.spyOn(replacement.contentWindow!, 'postMessage');
    await act(async () => replacement.dispatchEvent(new Event('load')));
    const repCall = repSent.mock.calls.find(([m]) => m.__flScreenDoc) as unknown[] | undefined;
    const repPort = (repCall?.[2] as Transferable[] | undefined)?.[0] as MessagePort;
    const repMsgs = collectPortMessages(repPort);

    await act(async () => finish({ data: { responses: [{ id: 'old-record', answers: { name: 'Previous screen' } }] } }));
    await flushPorts();
    expect(origMsgs.some((m) => (m as { __flReply?: boolean; id?: string }).__flReply && (m as { id?: string }).id === 'pending')).toBe(false);
    expect(repMsgs.some((m) => (m as { __flReply?: boolean; id?: string }).__flReply && (m as { id?: string }).id === 'pending')).toBe(false);

    origPort.close();
    repPort.close();
  });
});
