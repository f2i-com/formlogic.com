// What the list of flows says in its "Starts on" and "Last run" columns, and which rows a page holds.
import { describe, expect, it } from 'vitest';
import { lastRunByFlow, pageOf, triggerSummary } from './flowListFacts';
import type { FlowBinding, FlowDefinition, FlowRunLog } from '../../types/flows';

const binding = (over: Partial<FlowBinding>) => ({ id: 'b', event: 'form.submitted', formId: null, enabled: true, ...over }) as unknown as FlowBinding;
const flow = (id: string, slug = id) => ({ id, slug }) as unknown as FlowDefinition;
const run = (runId: string, over: Partial<FlowRunLog>) => ({ runId, flowDefinitionId: null, flow: null, ...over }) as unknown as FlowRunLog;
const titles = (id: string) => ({ f1: 'Support Ticket' } as Record<string, string>)[id];

describe('triggerSummary', () => {
  it('says there is no trigger, which is not the same as triggers that are off', () => {
    expect(triggerSummary([], titles)).toEqual({ text: 'No trigger', detail: '', allOff: false });
  });

  it('names the event in words, and the form it listens to', () => {
    expect(triggerSummary([binding({ formId: 'f1' })], titles).text).toBe('Form submitted · Support Ticket');
    // A form the page does not know, and an event the catalog does not know, still read as something.
    expect(triggerSummary([binding({ formId: 'gone' })], titles).text).toBe('Form submitted');
    expect(triggerSummary([binding({ event: 'shop.order' })], titles).text).toBe('Shop Order');
  });

  it('puts a trigger that is on first and counts the rest, each on a line of the hover', () => {
    const summary = triggerSummary([binding({ id: 'off', event: 'shop.order', enabled: false }), binding({ id: 'on', formId: 'f1' })], titles);
    expect(summary.text).toBe('Form submitted · Support Ticket + 1 more');
    expect(summary.detail).toBe('Form submitted · Support Ticket\nShop Order (off)');
    expect(summary.allOff).toBe(false);
  });

  it('says so when every trigger is off', () => {
    expect(triggerSummary([binding({ enabled: false })], titles)).toMatchObject({ text: 'Form submitted (off)', allOff: true });
  });
});

describe('lastRunByFlow', () => {
  it('keeps the newest run of each flow, by id or else by slug, and leaves out runs of flows not listed', () => {
    const last = lastRunByFlow(
      [run('r3', { flowDefinitionId: 'a' }), run('r2', { flow: 'b-slug' }), run('r1', { flowDefinitionId: 'a' }), run('r0', { flowDefinitionId: 'deleted', flow: 'gone' })],
      [flow('a'), flow('b', 'b-slug')],
    );
    expect([...last].map(([id, r]) => [id, r.runId])).toEqual([['a', 'r3'], ['b', 'r2']]);
  });
});

describe('pageOf', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i + 1);

  it('gives a page its rows and where they stand in the whole', () => {
    expect(pageOf(rows, 1, 12)).toMatchObject({ page: 1, pages: 2, from: 1, to: 12 });
    expect(pageOf(rows, 2, 12)).toMatchObject({ page: 2, pages: 2, from: 13, to: 23 });
    expect(pageOf(rows, 2, 12).rows).toHaveLength(11);
  });

  it('holds a page number in range (a search that leaves fewer pages than the one open)', () => {
    expect(pageOf(rows, 9, 12).page).toBe(2);
    expect(pageOf(rows, 0, 12).page).toBe(1);
    expect(pageOf([], 3, 12)).toEqual({ rows: [], page: 1, pages: 1, from: 0, to: 0 });
  });
});
