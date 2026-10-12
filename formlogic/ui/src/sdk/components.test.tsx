// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppRuntimeStore } from '../stores/appRuntimeStore';
import { ResponseList } from './components';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const original = useAppRuntimeStore.getState().fetchRecentRows;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useAppRuntimeStore.setState({ fetchRecentRows: original });
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
