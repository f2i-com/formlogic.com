// @vitest-environment jsdom
// The diagrams index list: client-side name search + pagination (the list endpoint
// caps at 200 rows and demo-local diagrams merge client-side, so both live here).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiagramsIndex from './DiagramsIndex';

const h = vi.hoisted(() => ({
  listBlueprints: vi.fn(),
  deleteBlueprint: vi.fn(),
  isDemoMode: vi.fn(() => false),
}));

vi.mock('../../lib/api', () => ({
  api: { listBlueprints: h.listBlueprints, deleteBlueprint: h.deleteBlueprint, isDemoMode: h.isDemoMode },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  h.isDemoMode.mockReturnValue(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const bp = (id: string, name: string) => ({
  id,
  appId: null,
  name,
  status: 'draft',
  semanticRevision: 0,
  layoutRevision: 0,
  viewport: null,
  createdAt: '2026-07-23T00:00:00Z',
  updatedAt: '2026-07-23T00:00:00Z',
});

async function renderIndex() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/diagrams/all']}>
        <DiagramsIndex />
      </MemoryRouter>
    );
  });
}

function rowNames(): string[] {
  return Array.from(container.querySelectorAll('.group p.truncate')).map((el) => el.textContent ?? '');
}

function pagerLabel(): string | null {
  return Array.from(container.querySelectorAll('span')).find((el) => /^\d+ \/ \d+$/.test(el.textContent ?? ''))?.textContent ?? null;
}

async function setSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search diagrams"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('DiagramsIndex', () => {
  it('paginates past 10 rows with a working pager', async () => {
    h.listBlueprints.mockResolvedValue({
      data: { blueprints: Array.from({ length: 12 }, (_, i) => bp(`d${i}`, `Diagram ${String(i).padStart(2, '0')}`)) },
    });
    await renderIndex();

    expect(rowNames()).toHaveLength(10);
    expect(rowNames()[0]).toBe('Diagram 00');
    expect(pagerLabel()).toBe('1 / 2');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click();
    });
    expect(rowNames()).toEqual(['Diagram 10', 'Diagram 11']);
    expect(pagerLabel()).toBe('2 / 2');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.disabled).toBe(true);
  });

  it('searches by name (case-insensitive) and resets to page 1', async () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => bp(`d${i}`, `Diagram ${String(i).padStart(2, '0')}`)),
      bp('crm', 'Client CRM sketch'),
    ];
    h.listBlueprints.mockResolvedValue({ data: { blueprints: rows } });
    await renderIndex();

    // Walk to page 2 first, then search — the pager must snap back to page 1.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click();
    });
    await setSearch('client crm');
    expect(rowNames()).toEqual(['Client CRM sketch']);
    expect(pagerLabel()).toBeNull(); // one page — no pager chrome

    await setSearch('no such diagram');
    expect(rowNames()).toHaveLength(0);
    expect(container.textContent).toContain('No diagrams match');
  });

  it('shows no search/pager chrome confusion when the account has no diagrams at all', async () => {
    h.listBlueprints.mockResolvedValue({ data: { blueprints: [] } });
    await renderIndex();
    expect(container.textContent).toContain('No diagrams yet');
    expect(pagerLabel()).toBeNull();
  });
});
