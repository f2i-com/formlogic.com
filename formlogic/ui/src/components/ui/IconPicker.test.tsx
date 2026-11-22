// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconPicker } from './IconPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
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
});

describe('IconPicker', () => {
  it('portals its dropdown into document.body with fixed positioning and high z-index', async () => {
    const onChange = vi.fn();
    await render(
      <div className="overflow-hidden" data-testid="clipped-card">
        <IconPicker value="DoorOpen" onChange={onChange} />
      </div>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Choose form icon"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      trigger.click();
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Icon picker"]');
    expect(dialog).not.toBeNull();
    // Portaled outside the clipped card directly under document.body so it can never be occluded by sibling panels.
    expect(container.contains(dialog)).toBe(false);
    expect(dialog!.parentElement).toBe(document.body);
    expect(dialog!.style.position).toBe('fixed');
    expect(dialog!.className).toContain('z-[200]');
  });

  it('filters icons by search query, selects an icon, and closes', async () => {
    const onChange = vi.fn();
    await render(<IconPicker value={undefined} onChange={onChange} />);

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Choose form icon"]')!;
    await act(async () => {
      trigger.click();
    });

    const search = document.body.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!;
    expect(search).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'door');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const option = document.body.querySelector<HTMLButtonElement>('button[aria-label="DoorOpen"]')!;
    expect(option).not.toBeNull();

    await act(async () => {
      option.click();
    });

    expect(onChange).toHaveBeenCalledWith('DoorOpen');
    expect(document.body.querySelector('[role="dialog"][aria-label="Icon picker"]')).toBeNull();
  });

  it('clears the icon and closes on Escape or outside click', async () => {
    const onChange = vi.fn();
    await render(
      <div>
        <IconPicker value="DoorOpen" onChange={onChange} />
        <button type="button" id="outside-btn">Outside</button>
      </div>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Choose form icon"]')!;
    await act(async () => {
      trigger.click();
    });

    const removeBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Remove icon'),
    )!;
    expect(removeBtn).toBeDefined();
    await act(async () => {
      removeBtn.click();
    });
    expect(onChange).toHaveBeenCalledWith(null);
    expect(document.body.querySelector('[role="dialog"][aria-label="Icon picker"]')).toBeNull();

    // Reopen and dismiss via Escape
    await act(async () => {
      trigger.click();
    });
    expect(document.body.querySelector('[role="dialog"][aria-label="Icon picker"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"][aria-label="Icon picker"]')).toBeNull();

    // Reopen and dismiss via outside click
    await act(async () => {
      trigger.click();
    });
    const outside = container.querySelector<HTMLButtonElement>('#outside-btn')!;
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"][aria-label="Icon picker"]')).toBeNull();
  });
});
