// Behavioral tests for the pack-owned TSX screens: each screen's `files` are bundled with the
// REAL sandbox semantics (vfs + embedded preact + automatic JSX via screenCompile's pipeline,
// driven by the native esbuild package through the test seam) and EXECUTED in a JSDOM document
// against a mocked window.FormLogic — the compiled artifact is what's under test, exactly what
// the iframe runs. Runs in node env: esbuild's load-time invariant check breaks under vitest's
// jsdom globals (cross-realm typed arrays), so the DOM comes from explicit JSDOM instances.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AOKIE_CALL_TRANSCRIPT_SCREEN } from './transcriptScreen';
import { flushScreen as flush, runScreen, setupScreenTestEsbuild, teardownScreenTestEsbuild } from '../../aokieScreenTestHarness';

beforeAll(() => setupScreenTestEsbuild());
afterAll(() => teardownScreenTestEsbuild());

describe('transcript record screen (TSX)', () => {
  const related = (records: Array<{ id: string; fields: Record<string, unknown>; submittedAt?: string }>) => ({
    'transcript-turns.call_link': {
      fieldId: 'call_link',
      columns: [{ id: 'speaker' }, { id: 'text' }, { id: 'turn_index' }, { id: 'timestamp' }, { id: 'source' }],
      records,
    },
  });

  it('renders turns as bubbles in true conversation order with the corrected badge', async () => {
    const { root } = await runScreen(AOKIE_CALL_TRANSCRIPT_SCREEN, {
      related: () => Promise.resolve(related([
        // Committed AFTER the bot line but SPOKEN before it — must sort first (overlap case).
        { id: 'overlap', fields: { speaker: 'caller', text: 'Wait, hold on', turn_index: 5, timestamp: '2026-07-17T00:00:03Z' }, submittedAt: '2026-07-17T00:00:09Z' },
        { id: 'bot', fields: { speaker: 'agent', text: 'Your booking is confirmed', turn_index: 4, timestamp: '2026-07-17T00:00:05Z', source: 'audio_model' }, submittedAt: '2026-07-17T00:00:06Z' },
      ])),
    });
    await flush();
    const texts = [...root.querySelectorAll('.text')].map((el) => el.textContent);
    expect(texts).toEqual(['Wait, hold on', 'Your booking is confirmed']);
    // Sides: caller right/neutral, agent left/accent.
    expect(root.querySelectorAll('.turn.caller').length).toBe(1);
    expect(root.querySelectorAll('.turn.agent').length).toBe(1);
    // The audio-model corrected row carries the badge + tooltip.
    const badge = root.querySelector('.corrected');
    expect(badge?.getAttribute('title')).toBe('Corrected by the audio model');
    expect(root.querySelector('.count')?.textContent).toBe('2 turns');
  });

  it('record values render as TEXT — markup in a turn can never inject', async () => {
    const { root } = await runScreen(AOKIE_CALL_TRANSCRIPT_SCREEN, {
      related: () => Promise.resolve(related([
        { id: 'x', fields: { speaker: 'caller', text: '<img src=x onerror=alert(1)>', turn_index: 1 }, submittedAt: '2026-07-17T00:00:01Z' },
      ])),
    });
    await flush();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.text')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('pages long transcripts behind Load more', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      id: `t${i}`,
      fields: { speaker: i % 2 ? 'caller' : 'agent', text: `line ${i}`, turn_index: i },
      submittedAt: `2026-07-17T00:00:${String(10 + i).slice(-2)}Z`,
    }));
    const { root } = await runScreen(AOKIE_CALL_TRANSCRIPT_SCREEN, {
      related: () => Promise.resolve(related(rows)),
    });
    await flush();
    expect(root.querySelectorAll('.turn').length).toBe(30);
    const more = root.querySelector<HTMLButtonElement>('.more');
    expect(more?.textContent).toContain('15 more');
    more!.click();
    await flush();
    expect(root.querySelectorAll('.turn').length).toBe(45);
    expect(root.querySelector('.more')).toBeNull();
  });

  it('shows the empty and error states honestly', async () => {
    const empty = await runScreen(AOKIE_CALL_TRANSCRIPT_SCREEN, {
      related: () => Promise.resolve({}),
    });
    await flush();
    expect(empty.root.textContent).toContain('No transcript was recorded');

    const err = await runScreen(AOKIE_CALL_TRANSCRIPT_SCREEN, {
      related: () => Promise.reject(new Error('related failed')),
    });
    await flush();
    expect(err.root.querySelector('.state.error')?.textContent).toBe('related failed');
  });
});
