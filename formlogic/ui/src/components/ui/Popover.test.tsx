// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

// Anchored popover primitive: portal rendering, Escape/outside-click close, focus
// trap, focus restore. Runs in jsdom via createRoot + React act (no testing-library
// in this repo — vitest.config.ts notes component tests opt into jsdom per-file).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness({
  onClose,
  placement,
}: {
  onClose: () => void;
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" ref={anchorRef} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <Popover
        isOpen={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        anchorRef={anchorRef}
        placement={placement}
        ariaLabel="Test popover"
      >
        <button type="button">first action</button>
        <button type="button">second action</button>
      </Popover>
    </>
  );
}

async function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
}

async function clickTrigger() {
  const trigger = container.querySelector('button')!;
  trigger.focus();
  await act(async () => {
    trigger.click();
  });
}

/** The initial-focus hand-off rides rAF (jsdom's pretendToBeVisual rAF ≈16ms) — wait past it. */
async function flushInitialFocus() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  document.body.innerHTML = '';
});

describe('Popover', () => {
  it('renders nothing when closed, then a labelled dialog in a portal when open', async () => {
    await render(<Harness onClose={vi.fn()} />);
    expect(panel()).toBeNull();

    await clickTrigger();

    const dialog = panel();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-label')).toBe('Test popover');
    // Portalled out of the harness container into document.body.
    expect(container.contains(dialog)).toBe(false);
    expect(dialog!.style.position).toBe('fixed');
    expect(dialog!.style.visibility).toBe('visible');
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus to the first focusable element inside the panel', async () => {
    await render(<Harness onClose={vi.fn()} />);
    await clickTrigger();
    await flushInitialFocus();
    expect(document.activeElement?.textContent).toBe('first action');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    await clickTrigger();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on an outside mousedown, but not on clicks inside the panel or on the anchor', async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    await clickTrigger();

    // Inside the panel: no close.
    await act(async () => {
      panel()!.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    // On the anchor (the trigger toggles itself): no close from the popover.
    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    // Outside both: closes.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab focus inside the panel (last -> first, first -> last on Shift+Tab)', async () => {
    await render(<Harness onClose={vi.fn()} />);
    await clickTrigger();
    await flushInitialFocus();

    const buttons = panel()!.querySelectorAll('button');
    const first = buttons[0] as HTMLElement;
    const last = buttons[buttons.length - 1] as HTMLElement;

    last.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    first.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, shiftKey: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the trigger when it closes', async () => {
    await render(<Harness onClose={vi.fn()} />);
    const trigger = container.querySelector('button')!;
    await clickTrigger();
    await flushInitialFocus();
    expect(document.activeElement).not.toBe(trigger);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('re-clamps when the open panel grows, so async content can never push it off-page', async () => {
    // jsdom has no ResizeObserver — stub one that hands us the callback to fire.
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callbacks.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    try {
      await render(<Harness onClose={vi.fn()} />);
      const trigger = container.querySelector('button')!;
      const rect = (top: number, height: number, width: number): DOMRect =>
        ({ top, bottom: top + height, left: 40, right: 40 + width, width, height, x: 40, y: top, toJSON: () => ({}) }) as DOMRect;
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(40, 20, 100));
      await clickTrigger();
      const el = panel()!;
      expect(callbacks.length).toBeGreaterThan(0);

      let panelHeight = 100;
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => rect(0, panelHeight, 200));
      // Small panel: sits below the anchor (60 + 8px margin), no clamping needed.
      await act(async () => {
        callbacks[callbacks.length - 1]([], {} as ResizeObserver);
      });
      expect(el.style.top).toBe('68px');

      // Content lands and the panel grows past the viewport bottom (68 + 360 > 400):
      // the observer re-clamps top to innerHeight - height - margin = 32.
      panelHeight = 360;
      await act(async () => {
        callbacks[callbacks.length - 1]([], {} as ResizeObserver);
      });
      expect(el.style.top).toBe('32px');
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    }
  });
});
