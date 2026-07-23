// @vitest-environment jsdom
// Audit FL-22/FL-28 — the /diagrams smart entry: resumes the newest UNPUBLISHED
// diagram anywhere in the ordering (not merely blueprints[0]), routes to a fresh
// draft only when none exists, and surfaces an API failure as a retryable error
// state instead of silently opening a new draft over existing work.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiagramsEntry from './DiagramsEntry';

const h = vi.hoisted(() => ({
  listBlueprints: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  api: { listBlueprints: h.listBlueprints },
}));

function LocationProbe() {
  // The navigated-to path is rendered (not written to an external binding —
  // react-hooks/immutability) and read back from the DOM by the assertions.
  return <div data-testid="probe">{useLocation().pathname}</div>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.listBlueprints.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function probedPath(): string | null {
  return container.querySelector('[data-testid="probe"]')?.textContent ?? null;
}

async function renderEntry() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/diagrams']}>
        <Routes>
          <Route path="/diagrams" element={<DiagramsEntry />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

const bp = (id: string, appId: string | null) => ({
  id,
  appId,
  name: `Diagram ${id}`,
  status: 'draft',
  semanticRevision: 0,
  layoutRevision: 0,
  viewport: null,
  createdAt: '',
  updatedAt: '',
});

describe('DiagramsEntry', () => {
  it('resumes the newest UNPUBLISHED diagram even when a published one is newer', async () => {
    h.listBlueprints.mockResolvedValue({
      data: { blueprints: [bp('published-newest', 'app-1'), bp('unpublished-older', null)] },
    });
    await renderEntry();
    expect(probedPath()).toBe('/diagrams/unpublished-older');
  });

  it('opens a fresh draft only when NO unpublished diagram exists', async () => {
    h.listBlueprints.mockResolvedValue({
      data: { blueprints: [bp('a', 'app-1'), bp('b', 'app-2')] },
    });
    await renderEntry();
    expect(probedPath()).toBe('/diagrams/new');
  });

  it('an API failure shows a retry state instead of silently opening a new draft', async () => {
    h.listBlueprints.mockResolvedValueOnce({ error: 'boom' });
    await renderEntry();
    expect(probedPath()).toBeNull(); // no navigation happened on failure
    const retry = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Try again')
    );
    expect(retry).toBeTruthy();

    // Retry succeeds → the entry resumes normally.
    h.listBlueprints.mockResolvedValueOnce({ data: { blueprints: [bp('resumed', null)] } });
    await act(async () => {
      retry!.click();
    });
    expect(probedPath()).toBe('/diagrams/resumed');
  });
});
