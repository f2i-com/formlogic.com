// @vitest-environment jsdom
// Publish is never blocked on a list that was not read: with the form list failed, every landing
// form looked removed, and "Landing screen references a removed form" stopped the release.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { App } from '../../../types/app';
import type { UnpublishedChanges } from '../studioSteps';

vi.mock('../../../lib/api', () => ({ api: { isDemoMode: () => false, isAdminActing: () => false, setAdminActing: () => {} } }));

import { PublishStep } from './PublishStep';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const app = { id: 'a1', name: 'Shop', slug: 'shop', status: 'draft', settings: { landingPage: 'f-gone' }, theme: {} } as unknown as App;
const changes = { count: 0, everPublished: false, changed: [] } as unknown as UnpublishedChanges;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(formCountKnown: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <PublishStep app={app} appForms={[]} formsById={{}} flows={[]} roles={[]} domains={[]} versions={[]} memberCount={1} formCountKnown={formCountKnown} changes={changes} onStepChange={() => {}} onPublished={async () => {}} />
      </MemoryRouter>
    );
  });
}

it('does not call a landing form removed when the form list could not be read', async () => {
  await render(false);
  expect(document.body.textContent).not.toContain('Landing screen references a removed form');
});

it('still does when the list was read and the form is not on it', async () => {
  await render(true);
  expect(document.body.textContent).toContain('Landing screen references a removed form');
});
