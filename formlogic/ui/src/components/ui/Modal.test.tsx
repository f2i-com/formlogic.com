// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('only dismisses the top dialog and restores focus to its opener', async () => {
  const parentClose = vi.fn(), childClose = vi.fn();
  const render = (child: boolean) => <>
    <Modal isOpen onClose={parentClose} title="Parent"><button id="opener">Open details</button></Modal>
    <Modal isOpen={child} onClose={childClose} title="Details"><button>Save</button></Modal>
  </>;
  await act(async () => { root.render(render(false)); });
  document.getElementById('opener')!.focus();
  await act(async () => { root.render(render(true)); });
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(childClose).toHaveBeenCalledTimes(1);
  expect(parentClose).not.toHaveBeenCalled();
  await act(async () => { root.render(render(false)); });
  expect(document.activeElement?.id).toBe('opener');
  expect(document.body.style.overflow).toBe('hidden');
});

it('wraps keyboard focus past hidden controls and recovers focus outside the panel', async () => {
  await act(async () => root.render(<Modal isOpen onClose={() => {}} title="Actions" showCloseButton={false}>
    <button hidden>Hidden</button><div style={{ display: 'none' }}><button>Collapsed section</button></div><button id="first">First</button><button id="last">Last</button>
  </Modal>));
  document.getElementById('last')!.focus();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement?.id).toBe('first');
  container.tabIndex = 0;
  container.focus();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement?.id).toBe('last');
});
