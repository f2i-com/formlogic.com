// A text the phone never acknowledges must not stay "queued" forever.
//
// Every outbound text is written to Messages as `queued` with a pre-minted
// message_id before sms.send goes out; aokie.sms.sent / aokie.sms.failed move it
// on. When no acknowledgement ever comes (the plugin was not running, the
// desktop could not reach it, Aokie's journal refused the request), the
// acknowledgement sweep marks it `unconfirmed` after 15 minutes. A later
// acknowledgement still wins, and a repeated one changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aokieReceptionistPack as pack } from './pack';

const NOW = new Date(2026, 8, 29, 15, 0, 0);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

function expr(slug: string, node: string): string {
  const flow = pack.flows!.find((f) => f.slug === slug)!;
  return String((flow.flowJson.nodes.find((n) => n.id === node)!.data as { expr: string }).expr);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(slug: string, node: string, inputs: object, nodes: object = {}): any {
  return new Function('inputs', 'nodes', `return ${expr(slug, node)};`)(inputs, nodes);
}
const bindingsFor = (flow: string) => (pack.flowBindings ?? []).filter((b) => b.flow === flow);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sms-ack-sweep: queued texts with no acknowledgement become unconfirmed', () => {
  const row = (id: string, over: Record<string, unknown> = {}, submittedAt?: string) => ({
    id,
    ...(submittedAt ? { submittedAt } : {}),
    answers: { direction: 'outbound', status: 'queued', message_id: 'sms-' + id, phone: '+61400000000', body: 'Hi', timestamp: minutesAgo(20), ...over },
  });
  const sweep = (rows: unknown[], tasks: unknown[] = []) =>
    run('sms-ack-sweep', 'plan', { sweepReason: 'an incoming call' }, { queued: { responses: rows }, tasks: { responses: tasks } });

  it('marks a text queued 15 minutes or more ago unconfirmed, with the note', () => {
    const r = sweep([row('a')]);
    expect(r.hasStale).toBe(true);
    expect(r.hasStale1).toBe(true);
    expect(r.staleId1).toBe('a');
    expect(r.staleUpdate1).toEqual({ status: 'unconfirmed', delivery_note: 'The phone never confirmed this text: check it was sent.' });
    expect(r.summaryLine).toContain('never confirmed by the phone');
  });

  it('leaves a recent text alone: the phone has 15 minutes to answer', () => {
    const r = sweep([row('fresh', { timestamp: minutesAgo(14) })]);
    expect(r.hasStale).toBe(false);
    expect(r.hasStale1).toBe(false);
    expect(r.summaryLine).toContain('recent or acknowledged');
  });

  it('only ever touches queued outbound rows, whatever the listing returns', () => {
    const r = sweep([
      row('sent', { status: 'sent' }),
      row('failed', { status: 'failed' }),
      row('already', { status: 'unconfirmed' }),
      row('draft', { status: 'draft' }),
      row('inbound', { direction: 'inbound', status: 'received' }),
    ]);
    expect(r.hasStale).toBe(false);
  });

  it('measures from the send time, falling back to the server stamp, and never guesses without one', () => {
    // No timestamp: the zone-less UTC server stamp decides.
    const serverStamp = new Date(NOW.getTime() - 30 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    expect(sweep([row('stamped', { timestamp: '' }, serverStamp)]).staleId1).toBe('stamped');
    // Neither: nothing to measure by, so the row is left for a later sweep.
    expect(sweep([row('unknown', { timestamp: '' })]).hasStale).toBe(false);
  });

  it('oldest first, three per sweep, and says how many are still waiting', () => {
    const r = sweep([
      row('c', { timestamp: minutesAgo(30) }),
      row('a', { timestamp: minutesAgo(90) }),
      row('d', { timestamp: minutesAgo(20) }),
      row('b', { timestamp: minutesAgo(60) }),
    ]);
    expect([r.staleId1, r.staleId2, r.staleId3]).toEqual(['a', 'b', 'c']);
    expect(r.stale).toBe(4);
    expect(r.summaryLine).toContain('1 more on the next sweep');
  });

  it('moves the missed-call apology task that waits on that text to sms_unconfirmed', () => {
    const task = { id: 'task-1', answers: { status: 'open', callback_state: 'sms_queued', callback_sms_id: 'sms-a', summary: 'Missed call from Lance' } };
    const other = { id: 'task-2', answers: { status: 'open', callback_state: 'sms_queued', callback_sms_id: 'sms-zzz', summary: 'Other' } };
    const r = sweep([row('a')], [other, task]);
    expect(r.hasTask1).toBe(true);
    expect(r.taskId1).toBe('task-1');
    expect(r.taskUpdate1.callback_state).toBe('sms_unconfirmed');
    expect(r.taskUpdate1.priority).toBe('urgent');
    expect(r.taskUpdate1.summary).toContain('never confirmed the apology text');
    // A closed task is never reopened.
    const closed = { id: 'task-3', answers: { ...task.answers, status: 'done' } };
    expect(sweep([row('a')], [closed]).hasTask1).toBe(false);
  });

  it('rides the events that happen anyway, writes records only, and toasts only when it found something', () => {
    const bindings = bindingsFor('sms-ack-sweep');
    expect(bindings.map((b) => b.event).sort()).toEqual(['aokie.call.ended', 'aokie.call.incoming', 'aokie.sms.received']);
    for (const b of bindings) {
      expect(b.mode).toBe('async');
      expect(b.retryPolicy).toBeUndefined();
      const actions = b.outputActions ?? [];
      expect(actions.some((a) => a.type === 'connector.request')).toBe(false);
      for (const a of actions) expect((a as { when?: string }).when, `${b.event} ${a.type}`).toMatch(/^\$result\.has/);
      expect(actions.filter((a) => a.type === 'formlogic.updateResponse').map((a) => (a as { form: string }).form)).toEqual([
        '@pack:sms-messages', '@pack:follow-up-tasks', '@pack:sms-messages', '@pack:follow-up-tasks', '@pack:sms-messages', '@pack:follow-up-tasks',
      ]);
    }
    const flow = pack.flows!.find((f) => f.slug === 'sms-ack-sweep')!;
    expect(flow.flowJson.nodes.find((n) => n.id === 'queued')!.data).toMatchObject({
      form: '@pack:sms-messages',
      filters: [{ field: 'status', op: 'eq', value: 'queued' }, { field: 'direction', op: 'eq', value: 'outbound' }],
    });
  });
});

describe('sms-delivery-status: a later acknowledgement wins, a repeated one changes nothing', () => {
  const msg = (status: string) => ({ id: 'msg-1', answers: { direction: 'outbound', status, message_id: 'sms-1' } });
  const ack = (outcome: string, status: string, extra: Record<string, unknown> = {}, tasks: unknown[] = []) =>
    run('sms-delivery-status', 'mark', { messageId: 'sms-1', to: '+61400000000', outcome, ...extra }, { messages: { responses: [msg(status)] }, tasks: { responses: tasks } });

  it('sent wins over queued, unconfirmed and failed', () => {
    expect(ack('sent', 'queued').update).toEqual({ status: 'sent', delivery_note: '' });
    const late = ack('sent', 'unconfirmed');
    expect(late.update.status).toBe('sent');
    expect(late.update.delivery_note).toContain('confirmed this text late');
    const retried = ack('sent', 'failed');
    expect(retried.update.status).toBe('sent');
    expect(retried.update.delivery_note).toContain('later try');
  });

  it('failed wins over queued and unconfirmed, never over sent', () => {
    expect(ack('failed', 'queued').update.status).toBe('failed');
    expect(ack('failed', 'unconfirmed').update.status).toBe('failed');
    const afterSent = ack('failed', 'sent');
    expect(afterSent.hasUpdate).toBe(false);
    expect(afterSent.notify).toBe(false);
  });

  it('a second refusal of the same text writes nothing and raises no second notice', () => {
    const first = ack('failed', 'queued', { reason: 'invalid number', refused: true });
    expect(first.hasUpdate).toBe(true);
    expect(first.notify).toBe(true);
    const again = ack('failed', 'failed', { reason: 'invalid number', refused: true });
    expect(again.hasUpdate).toBe(false);
    expect(again.hasTaskUpdate).toBe(false);
    expect(again.notify).toBe(false);
    expect(again.summaryLine).toContain('already recorded');
  });

  it('records why: a refusal and a radio failure read differently', () => {
    expect(ack('failed', 'queued', { reason: 'no radio', refused: true }).update.delivery_note).toBe('Aokie refused to send this text: no radio.');
    expect(ack('failed', 'queued', { reason: 'MAP PUT failed' }).update.delivery_note).toBe('The phone could not send this text: MAP PUT failed.');
  });

  it('an apology task marked unconfirmed still moves on when the acknowledgement arrives', () => {
    const task = { id: 'task-1', answers: { status: 'open', callback_state: 'sms_unconfirmed', callback_sms_id: 'sms-1', summary: 'Missed call' } };
    const sent = ack('sent', 'unconfirmed', {}, [task]);
    expect(sent.taskUpdate).toMatchObject({ callback_state: 'sms_sent', priority: 'high' });
    expect(sent.taskUpdate.summary).toContain('late');
    const failed = ack('failed', 'unconfirmed', {}, [task]);
    expect(failed.taskUpdate).toMatchObject({ callback_state: 'needs_human', priority: 'urgent' });
    expect(failed.notify).toBe(true);
  });

  it('the failure toast is gated on a change, and the refusal flag reaches the flow', () => {
    const failed = bindingsFor('sms-delivery-status').find((b) => b.event === 'aokie.sms.failed')!;
    expect(failed.inputMap).toMatchObject({ outcome: 'failed', reason: '$event.data.reason', refused: '$event.data.refused' });
    const toast = (failed.outputActions ?? []).find((a) => a.type === 'formlogic.toast') as { when?: string };
    expect(toast.when).toBe('$result.notify');
  });
});

describe('unconfirmed shows wherever message status does', () => {
  const messages = pack.forms.find((f) => f.packFormId === 'sms-messages')!;

  it('Messages carries the status, the note (last, for live upgrades) and shows both', () => {
    const status = messages.fields.find((f) => f.id === 'status')!;
    expect((status.properties as { options: Array<{ value: string; label: string }> }).options.find((o) => o.value === 'unconfirmed')?.label)
      .toBe('Not confirmed by the phone');
    expect(messages.fields[messages.fields.length - 1]).toMatchObject({ id: 'delivery_note', type: 'short_text', required: false });
    const thread = messages.fields.find((f) => f.id === 'thread_link')!;
    expect((thread.properties as { relatedColumnFieldIds: string[] }).relatedColumnFieldIds).toEqual(['body', 'direction', 'status', 'delivery_note']);
    const list = ((messages.customScreen as { dashboard: { widgets: Array<{ id: string; list?: { metaField?: string } }> } }).dashboard.widgets)
      .find((w) => w.id === 'l1')!;
    expect(list.list?.metaField).toBe('status');
  });

  it('the SMS conversation the model reads marks texts the customer may never have seen', () => {
    const ctx = run('sms-followup-conversation', 'ctx', { from: '+61400000000', body: 'Can we do Friday?', occurredAt: minutesAgo(1) }, {
      settings: { responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes' } }] },
      tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', call_id: 'call_1', sms_exchanges: 1, summary: 'Confirm' } }] },
      appointments: { responses: [] },
      messages: { responses: [
        { id: 'm1', answers: { direction: 'outbound', status: 'sent', body: 'Delivered one', timestamp: minutesAgo(50) } },
        { id: 'm2', answers: { direction: 'outbound', status: 'unconfirmed', body: 'Maybe not delivered', timestamp: minutesAgo(40) } },
        { id: 'm3', answers: { direction: 'outbound', status: 'failed', body: 'Never went', timestamp: minutesAgo(30) } },
        { id: 'm4', answers: { direction: 'outbound', status: 'draft', body: 'Unapproved draft', timestamp: minutesAgo(20) } },
        { id: 'm5', answers: { direction: 'inbound', status: 'received', body: 'Can we do Friday?', timestamp: minutesAgo(1) } },
      ] },
    });
    expect(ctx.llmContext).toContain('Business: Delivered one');
    expect(ctx.llmContext).toContain('Business (the phone never confirmed sending this text): Maybe not delivered');
    expect(ctx.llmContext).toContain('Business (this text was NOT sent): Never went');
    expect(ctx.llmContext).not.toContain('Unapproved draft');
  });

  it('an approved draft is stamped with the time it went to the phone, which the sweep measures from', () => {
    const r = run('sms-approved-drain', 'plan', { sweepReason: 'an incoming call' }, {
      drafts: { responses: [{ id: 'd1', submittedAt: '2026-09-29 01:00:00', answers: { direction: 'outbound', approval_status: 'approved', status: 'draft', phone: '+61400000000', body: 'See you then!' } }] },
      settings: { responses: [{ answers: { active: 'yes' } }] },
    });
    expect(r.sendUpdate1).toEqual({ status: 'queued', message_id: 'smsappr_d1', timestamp: NOW.toISOString() });
  });
});
