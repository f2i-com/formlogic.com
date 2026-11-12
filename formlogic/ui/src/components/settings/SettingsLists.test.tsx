// @vitest-environment jsdom
// The two lists of Settings are drawn twice, as a table and as cards, and the width decides which
// is on show. Whichever it is has to say everything known of a row and carry its one action.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiKey, DesktopConnection } from '../../lib/api';
import { ApiKeysList } from './ApiKeysList';
import { LinkedDesktopsList } from './LinkedDesktopsList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const day = (iso: string) => new Date(iso).toLocaleDateString();

describe('ApiKeysList', () => {
  const keys: ApiKey[] = [
    { id: 'k1', name: 'CRM integration', keyPrefix: 'flk_9a2b', scopes: ['forms:read', 'responses:write'], formIds: null, lastUsedAt: '2026-11-10T02:00:00Z', lastUsedIp: '203.0.113.42', expiresAt: null, createdAt: '2026-10-01T02:00:00Z' },
    { id: 'k2', name: 'Warehouse scanner', keyPrefix: 'flk_77aa', scopes: ['responses:write'], formIds: ['f1'], lastUsedAt: null, expiresAt: '2027-01-11T02:00:00Z', createdAt: '2026-11-09T02:00:00Z' },
  ];

  it('says everything known of a key on its card and in its table row', async () => {
    await act(async () => root.render(<ApiKeysList keys={keys} onRevoke={() => {}} />));
    const cards = [...host.querySelectorAll('li')].map((card) => card.textContent ?? '');
    const rows = [...host.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
    expect(cards).toHaveLength(2);
    expect(rows).toHaveLength(2);

    for (const text of [cards[0], rows[0]]) {
      for (const fact of ['CRM integration', 'flk_9a2b...', 'forms:read', 'responses:write', `${day(keys[0].lastUsedAt!)} from 203.0.113.42`, day(keys[0].createdAt), 'All forms']) expect(text).toContain(fact);
    }
    expect(cards[0]).toContain('Never expires');
    expect(rows[0]).toContain('Never');

    for (const text of [cards[1], rows[1]]) {
      for (const fact of ['Warehouse scanner', 'flk_77aa...', 'responses:write', day(keys[1].createdAt), day(keys[1].expiresAt!), '1 form']) expect(text).toContain(fact);
    }
    expect(cards[1]).toContain('Never used');
    expect([...host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Key', 'Scopes', 'Last used', 'Created', 'Expires', 'Forms', 'Actions']);
  });

  it('revokes the key whose button is pressed, from either drawing', async () => {
    const onRevoke = vi.fn();
    await act(async () => root.render(<ApiKeysList keys={keys} onRevoke={onRevoke} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Revoke Warehouse scanner"]')];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) await act(async () => { button.click(); });
    expect(onRevoke.mock.calls.map(([key]) => key.id)).toEqual(['k2', 'k2']);
  });
});

describe('LinkedDesktopsList', () => {
  const base = { desktopInstanceId: 'i', apiKeyId: null, capabilities: [], trustedOrigins: [], updatedAt: '2026-11-01T00:00:00Z' };
  const connections: DesktopConnection[] = [
    { ...base, id: 'd1', deviceName: 'Studio PC', lastSeenAt: '2026-11-12T00:00:00Z', createdAt: '2026-09-08T00:00:00Z' },
    { ...base, id: 'd2', deviceName: 'Cupboard server', lastSeenAt: null, createdAt: '2026-10-23T00:00:00Z', aiOnly: true },
  ];

  it('says which computer is online, which was never seen and which is for AI only', async () => {
    await act(async () => root.render(<LinkedDesktopsList connections={connections} isOnline={(connection) => connection.id === 'd1'} onUnlink={() => {}} />));
    const cards = [...host.querySelectorAll('li')].map((card) => card.textContent ?? '');
    const rows = [...host.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
    for (const text of [cards[0], rows[0]]) {
      expect(text).toContain('Studio PC');
      expect(text).toContain('Online now');
      expect(text).not.toContain('AI only');
    }
    for (const text of [cards[1], rows[1]]) {
      expect(text).toContain('Cupboard server');
      expect(text).toContain('AI only');
      expect(text).toContain('Never connected');
      expect(text).not.toContain('Online now');
    }
    expect(cards[0]).toContain('Linked ');
  });

  it('unlinks the computer whose button is pressed', async () => {
    const onUnlink = vi.fn();
    await act(async () => root.render(<LinkedDesktopsList connections={connections} isOnline={() => false} onUnlink={onUnlink} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Unlink Cupboard server"]')];
    expect(buttons).toHaveLength(2);
    await act(async () => { buttons[0].click(); });
    expect(onUnlink.mock.calls.map(([connection]) => connection.id)).toEqual(['d2']);
    // A computer that is not online says when it was last heard from.
    expect(host.querySelector('li')?.textContent).toContain('Last seen ');
  });
});
