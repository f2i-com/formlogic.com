// @vitest-environment jsdom
/**
 * The linked computers (Settings): one whose link is alive but which has not asked for AI requests lately says so
 * beside "Online now", as App AI calls it offline then; the two places agree on why.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DesktopConnection } from '../../lib/api';
import { LinkedDesktopsList } from './LinkedDesktopsList';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const computer = (id: string, over: Partial<DesktopConnection> = {}): DesktopConnection => ({
  id, deviceName: `PC ${id}`, desktopInstanceId: `inst-${id}`, apiKeyId: null, capabilities: [], trustedOrigins: [],
  lastSeenAt: '2026-11-14 10:00:00', createdAt: '2026-11-01 10:00:00', updatedAt: '2026-11-14 10:00:00', ...over,
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the linked computers', () => {
  it('say "AI not answering" for an online one that takes AI requests and has not asked lately, and only that one', async () => {
    const connections = [
      computer('quiet', { aiKey: true }),
      computer('answering', { aiKey: true }),
      computer('no-ai', { aiKey: false }),
      computer('off', { aiKey: true }),
    ];
    await act(async () => root.render(<LinkedDesktopsList connections={connections} isOnline={(c) => c.id !== 'off'} isAnsweringAi={(c) => c.id === 'answering'} onUnlink={() => {}} />));
    // (the narrow cards: one per computer)
    const cards = [...container.querySelectorAll('ul > li')];
    const says = (id: string) => cards.find((card) => card.textContent?.includes(`PC ${id}`))!.textContent ?? '';
    expect(says('quiet')).toContain('AI not answering');
    expect(says('quiet')).toContain('Online now');
    expect(says('answering')).not.toContain('AI not answering');
    expect(says('no-ai')).not.toContain('AI not answering');
    expect(says('off')).not.toContain('AI not answering');
  });

  it('say nothing of AI where the page does not say how to tell', async () => {
    await act(async () => root.render(<LinkedDesktopsList connections={[computer('a', { aiKey: true })]} isOnline={() => true} onUnlink={() => {}} />));
    expect(container.textContent).not.toContain('AI not answering');
  });
});
