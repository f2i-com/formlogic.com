// @vitest-environment jsdom
// "Create in": where a new automation lives. A few apps are a button each; an owner of many
// chooses from one list, so a dozen buttons do not stand between the name and the starting points.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewFlowDialog } from './NewFlowDialog';
import type { AppListItem } from '../../types/app';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onCreate = vi.fn();

const apps = (count: number): AppListItem[] => Array.from({ length: count }, (_, index) => ({
  id: `app-${index + 1}`, name: `App ${index + 1}`, slug: `app-${index + 1}`, ownerId: 'u1', status: 'published',
  settings: {}, theme: {}, navConfig: [], createdAt: '2026-07-23 00:00:00', updatedAt: '2026-07-23 00:00:00', canManage: true,
}) as unknown as AppListItem);

async function show(list: AppListItem[]) {
  await act(async () => {
    root.render(<NewFlowDialog isOpen embedded creating={false} apps={list} onClose={() => {}} onCreate={onCreate} />);
  });
}
const buttonNamed = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim().startsWith(name));
const appList = () => container.querySelector<HTMLSelectElement>('select[aria-label="Create in an app"]');
const submit = () => act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

beforeEach(() => {
  onCreate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('where a new automation is created', () => {
  it('offers a button an app while they are few', async () => {
    await show(apps(2));
    expect(appList()).toBeNull();
    expect(buttonNamed('Workspace')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { buttonNamed('App 2')!.click(); });
    expect(buttonNamed('App 2')?.getAttribute('aria-pressed')).toBe('true');
    await submit();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-2' }));
  });

  it('offers one list of the apps when there are many, beside the workspace', async () => {
    await show(apps(11));
    expect(buttonNamed('App 1')).toBeUndefined();
    expect(buttonNamed('Workspace')?.getAttribute('aria-pressed')).toBe('true');
    const list = appList()!;
    expect(Array.from(list.options).map((option) => option.textContent)).toEqual(['Choose an app…', ...apps(11).map((app) => app.name)]);

    await act(async () => {
      list.value = 'app-7';
      list.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(buttonNamed('Workspace')?.getAttribute('aria-pressed')).toBe('false');
    await submit();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-7' }));
  });

  it('goes back to the workspace from the list', async () => {
    await show(apps(11));
    const list = appList()!;
    await act(async () => { list.value = 'app-3'; list.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { buttonNamed('Workspace')!.click(); });
    expect(appList()!.value).toBe('');
    await submit();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ appId: null }));
  });
});
