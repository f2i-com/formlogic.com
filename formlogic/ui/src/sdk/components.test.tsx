// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';
import { ResponseDetail, ResponseList } from './components';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const original = useAppRuntimeStore.getState().fetchRecentRows;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useAppRuntimeStore.setState({ fetchRecentRows: original, appSlug: null });
  vi.restoreAllMocks();
});

describe('ResponseDetail', () => {
  async function renderDetail(answer: Awaited<ReturnType<typeof api.getAppResponseById>> | Promise<never>) {
    useAppRuntimeStore.setState({ appSlug: 'crm' });
    const byId = vi.spyOn(api, 'getAppResponseById').mockReturnValue(Promise.resolve(answer));
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<ResponseDetail form="calls" id="r1" />);
    });
    return byId;
  }

  it('fetches the record by id, however old it is', async () => {
    const recent = vi.spyOn(useAppRuntimeStore.getState(), 'fetchRecentRows');
    const byId = await renderDetail({ data: { response: { id: 'r1', answers: { name: 'Alex' }, submittedAt: '2026-07-01 20:00:00' } } });
    expect(byId).toHaveBeenCalledWith('crm', 'calls', 'r1');
    expect(recent).not.toHaveBeenCalled();
    expect(host!.querySelector('dd')?.textContent).toBe('Alex');
  });

  it('renders an object answer as its contents', async () => {
    await renderDetail({ data: { response: { id: 'r1', answers: { where: { room: 2 }, done: true } } } });
    const shown = Array.from(host!.querySelectorAll('dd')).map((dd) => dd.textContent);
    expect(shown).toEqual(['{"room":2}', 'Yes']);
  });

  it('says loading, not "not found", until the answer arrives', async () => {
    await renderDetail(new Promise<never>(() => undefined));
    expect(host!.textContent).toBe('Loading…');
  });

  it('shows a load failure as a failure', async () => {
    await renderDetail({ error: 'You do not have access to this form', status: 403 });
    expect(host!.textContent).toBe('You do not have access to this form');
  });

  it('says not found only when the server does', async () => {
    await renderDetail({ error: 'Not found', status: 404 });
    expect(host!.textContent).toContain('Record not found');
  });
});

describe('ResponseList', () => {
  it('dates a record by the UTC instant the server stored, from its offset-less datetime', async () => {
    // Records arrive with the MySQL submitted_at as it is. Pinned to a zone where 20:00 UTC is
    // already the next day, so reading it as local time shows the wrong date on any machine.
    const zone = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    try {
      useAppRuntimeStore.setState({
        fetchRecentRows: async () => [{ id: 'r1', answers: { name: 'Alex' }, submittedAt: '2026-07-01 20:00:00' }],
      });
      host = document.createElement('div');
      document.body.appendChild(host);
      await act(async () => {
        root = createRoot(host!);
        root.render(<ResponseList form="calls" titleField="name" />);
      });
      expect(host.querySelector('time')?.textContent).toBe(new Date(Date.UTC(2026, 6, 1, 20)).toLocaleDateString());
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });
});
