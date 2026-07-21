// @vitest-environment jsdom
// DOM tests for the "Run on" dropdown + notices (plan §5.7): the three options render with
// the plan's copy, selection reports through onChange, the Cloud option disables with a
// reason, and the cloud_unsupported_node warning names the offending nodes inline while
// the Cloud selection stays in place (run-time honesty — the selection remains saveable).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionLocationNotice, ExecutionLocationSelect } from './ExecutionLocationSelect';
import type { FlowExecutionLocation } from './executionLocation';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(ui);
  });
  return container;
}

function selectOf(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('select');
  if (!el) throw new Error('Run on <select> not rendered');
  return el;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  document.body.innerHTML = '';
});

describe('ExecutionLocationSelect', () => {
  it('renders Auto / Desktop / Cloud with the plan §5.7 descriptions as titles', async () => {
    const container = await render(<ExecutionLocationSelect value="auto" onChange={() => undefined} />);
    const select = selectOf(container);
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'desktop', 'cloud']);
    expect(select.options[0].title).toBe('Let FormLogic decide (browser or your desktop)');
    expect(select.options[1].title).toBe('Your FormLogic Desktop (private, unmetered)');
    expect(select.options[2].title).toBe('FormLogic Cloud (uses plan credits)');
    expect(select.value).toBe('auto');
  });

  it('reports a new selection through onChange', async () => {
    const changes: FlowExecutionLocation[] = [];
    const container = await render(<ExecutionLocationSelect value="auto" onChange={(l) => changes.push(l)} />);
    const select = selectOf(container);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'cloud');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changes).toEqual(['cloud']);
  });

  it('disables the Cloud option with the reason when the server cannot run cloud flows', async () => {
    const container = await render(
      <ExecutionLocationSelect value="auto" onChange={() => undefined} cloudDisabledReason="this FormLogic server has no cloud runner" />
    );
    const select = selectOf(container);
    const cloud = [...select.options].find((o) => o.value === 'cloud');
    expect(cloud?.disabled).toBe(true);
    expect(cloud?.title).toBe('this FormLogic server has no cloud runner');
    // Auto/Desktop stay selectable.
    expect(select.options[0].disabled).toBe(false);
    expect(select.options[1].disabled).toBe(false);
  });
});

describe('ExecutionLocationNotice', () => {
  it('names the offending nodes when the cloud runner refused them', async () => {
    const container = await render(
      <ExecutionLocationNotice value="cloud" cloudUnsupportedNodes={['logic_block', 'condition']} />
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('logic_block, condition');
    expect(alert!.textContent).toContain("can't run this flow yet");
  });

  it('explains when a saved Cloud selection can no longer execute here', async () => {
    const container = await render(
      <ExecutionLocationNotice value="cloud" cloudDisabledReason="this FormLogic server has no cloud runner" />
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Cloud runs are unavailable');
  });

  it('renders nothing for Auto and nothing for Cloud without feedback', async () => {
    const autoContainer = await render(<ExecutionLocationNotice value="auto" cloudUnsupportedNodes={['logic_block']} />);
    expect(autoContainer.querySelector('[role="alert"]')).toBeNull();
    const cloudContainer = await render(<ExecutionLocationNotice value="cloud" />);
    expect(cloudContainer.querySelector('[role="alert"]')).toBeNull();
  });
});
