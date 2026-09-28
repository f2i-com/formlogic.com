// Events that reach FormLogic late must not make the pack say something that is
// no longer true.
//
// OAIY works offline and delivers Aokie's events through a durable outbox when
// it reconnects, possibly hours later. Every flow that texts or rings a caller
// judges the triggering event's own time (the envelope's occurredAt): an
// apology or a callback only within the hour, a confirmation only while the
// appointment is still ahead. Otherwise the text is skipped and a person is
// told, on the task.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aokieReceptionistPack as pack } from './pack';
import { triggerInputNames } from '../../../components/flows/flowGraphLint';

// A Tuesday afternoon, local time.
const NOW = new Date(2026, 8, 29, 15, 0, 0);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(NOW);
const NEXT_WEEK = iso(new Date(2026, 9, 6));

function expr(slug: string, node: string): string {
  const flow = pack.flows!.find((f) => f.slug === slug)!;
  return String((flow.flowJson.nodes.find((n) => n.id === node)!.data as { expr: string }).expr);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(slug: string, node: string, inputs: object, nodes: object = {}): any {
  return new Function('inputs', 'nodes', `return ${expr(slug, node)};`)(inputs, nodes);
}
const settings = (over: Record<string, unknown> = {}) => ({ responses: [{ answers: { business_name: 'Pirate Cuts', active: 'yes', ...over } }] });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('every flow that texts or rings a caller can read the event time', () => {
  // The approved-drafts drain sends texts a person approved (nothing in them
  // depends on the event that woke the sweep) and the callback drain dials a
  // queued task judged by the task's own age.
  const notEventTimed = new Set(['sms-approved-drain', 'callback-drain']);

  it('maps $event.occurredAt into each such binding and declares it on the flow', () => {
    const timed = new Set<string>();
    for (const b of pack.flowBindings ?? []) {
      const sends = (b.outputActions ?? []).some((a) => a.type === 'connector.request'
        && ['sms.send', 'call.dial'].includes(String((a as { command?: string }).command)));
      if (!sends || notEventTimed.has(b.flow)) continue;
      timed.add(b.flow);
      expect((b.inputMap as Record<string, string>).occurredAt, `${b.flow} on ${b.event}`).toBe('$event.occurredAt');
      const flow = pack.flows!.find((f) => f.slug === b.flow)!;
      expect(triggerInputNames(flow.flowJson), b.flow).toContain('occurredAt');
    }
    expect([...timed].sort()).toEqual([
      'after-call-actions',
      'appointment-request-apply',
      'hold-lost-apology',
      'missed-call-follow-up',
      'outbound-callback-result',
      'sms-followup-conversation',
    ]);
  });
});

describe('hold-lost-apology: "we had you on hold and lost you" only for just now', () => {
  const nodes = { customers: { responses: [] }, settings: settings() };
  const input = (occurredAt?: string) => ({ callId: 'call_1', callerPhone: '+61400000000', ...(occurredAt ? { occurredAt } : {}) });

  it('texts within the hour', () => {
    const r = run('hold-lost-apology', 'plan', input(ago(10)), nodes);
    expect(r.hasSms).toBe(true);
    expect(r.hasTask).toBe(false);
  });

  it('a late event raises a task instead, saying why', () => {
    const r = run('hold-lost-apology', 'plan', input(ago(180)), nodes);
    expect(r.hasSms).toBe(false);
    expect(r.hasTask).toBe(true);
    expect(r.task.summary).toContain('3 hours ago');
    expect(r.task.summary).toContain('no apology text was sent');
    expect(r.summaryLine).toContain('late');
  });

  it('reads the envelope OAIY hands over when the binding maps no time', () => {
    const r = run('hold-lost-apology', 'plan', { callId: 'call_1', callerPhone: '+61400000000', event: { occurredAt: ago(120) } }, nodes);
    expect(r.hasSms).toBe(false);
    expect(r.hasTask).toBe(true);
  });

  it('an unknown or future-stamped time counts as fresh, never as late', () => {
    expect(run('hold-lost-apology', 'plan', input(), nodes).hasSms).toBe(true);
    expect(run('hold-lost-apology', 'plan', input('not a time'), nodes).hasSms).toBe(true);
    expect(run('hold-lost-apology', 'plan', input(new Date(NOW.getTime() + 5 * 60000).toISOString()), nodes).hasSms).toBe(true);
  });
});

describe('outbound-callback-result: the apology only for a callback that just failed', () => {
  const task = { id: 'task-1', answers: { status: 'open', callback_state: 'queued', summary: 'Missed call from Lance' } };
  const nodes = { tasks: { responses: [task] }, customers: { responses: [] }, settings: settings() };

  it('texts within the hour', () => {
    const r = run('outbound-callback-result', 'plan', { callId: 'call_2', to: '+61400000000', outcome: 'no_answer', occurredAt: ago(5) }, nodes);
    expect(r.hasSms).toBe(true);
    expect(r.taskUpdate.callback_state).toBe('sms_queued');
  });

  it('a late one goes to a person, with no text', () => {
    const r = run('outbound-callback-result', 'plan', { callId: 'call_2', to: '+61400000000', outcome: 'no_answer', occurredAt: ago(240) }, nodes);
    expect(r.hasSms).toBe(false);
    expect(r.taskUpdate).toMatchObject({ callback_state: 'needs_human', priority: 'urgent' });
    expect(r.taskUpdate.summary).toContain('4 hours late');
  });

  it('a callback that reached them still closes the task, however late', () => {
    const r = run('outbound-callback-result', 'plan', { callId: 'call_2', to: '+61400000000', outcome: 'completed', occurredAt: ago(240) }, nodes);
    expect(r.taskUpdate).toMatchObject({ status: 'done', callback_state: 'reached' });
  });
});

describe('missed-call-follow-up: no machine callback for a missed call that arrives late', () => {
  const nodes = (route = '') => ({ customers: { responses: [] }, tasks: { responses: [] }, settings: settings({ call_route: route }), appts: { responses: [] } });
  const input = (occurredAt: string) => ({ callId: 'call_3', callerPhone: '+61400000000', outcome: 'missed', occurredAt });

  it('rings back within the hour', () => {
    const r = run('missed-call-follow-up', 'task', input(ago(2)), nodes());
    expect(r.wantsCallback).toBe(true);
    expect(r.task.callback_state).toBe('queued');
  });

  it('a late one is a task for a person, never queued for the drain', () => {
    const r = run('missed-call-follow-up', 'task', input(ago(150)), nodes());
    expect(r.wantsCallback).toBe(false);
    expect(r.late).toBe(true);
    expect(r.task.callback_state).toBe('');
    expect(r.task.callback_number).toBeUndefined();
    expect(r.task.summary).toContain('3 hours ago');
    expect(r.task.summary).toContain('did not ring them back');
  });

  it('on the OAIY route the task still says OAIY owns callbacks', () => {
    const r = run('missed-call-follow-up', 'task', input(ago(150)), nodes('oaiy'));
    expect(r.task.summary).toContain('OAIY calls back missed calls');
  });
});

describe('appointment-request-apply: a confirmation only while the appointment is ahead', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    requestId: 'apptreq_0123456789abcdef0123456789abcdef',
    callId: 'call_5685374790b241a1a48dd8549c0c6a4c',
    from: '0491570156',
    callerName: 'Lance',
    service: 'Haircut',
    date: TODAY,
    time: '17:00',
    agreementTurn: 4,
    at: ago(300),
    occurredAt: ago(300),
    ...over,
  });
  const nodes = () => ({
    requestAppointments: { responses: [] }, callAppointments: { responses: [] }, requestTasks: { responses: [] },
    callTasks: { responses: [] }, calls: { responses: [] }, customers: { responses: [] }, phoneTasks: { responses: [] },
    settings: settings({ default_country_code: '61' }),
  });

  it('a late request for a slot still ahead is still confirmed by text', () => {
    const r = run('appointment-request-apply', 'plan', base(), nodes());
    expect(r.ok).toBe(true);
    expect(r.hasKickoffSms).toBe(true);
  });

  it('a request that arrives after its time records the booking, texts nothing, and tells the task', () => {
    const r = run('appointment-request-apply', 'plan', base({ time: '11:00' }), nodes());
    expect(r.ok).toBe(true);
    expect(r.hasAppointment).toBe(true);
    expect(r.hasKickoffSms).toBe(false);
    expect(r.task.sms_state).toBeUndefined();
    expect(r.task.summary).toContain('no confirmation text: the appointment time had passed when this request reached FormLogic, 5 hours late');
    expect(r.summaryLine).toContain('No confirmation text');
  });
});

describe('after-call-actions: dates are the day of the call; the text only names what is ahead', () => {
  // The call happened yesterday evening; OAIY delivered it this afternoon.
  const callAt = new Date(2026, 8, 28, 19, 0, 0).toISOString();

  it('tells the model the day of the call, not today', () => {
    const ctx = run('after-call-actions', 'ctx', { callId: 'call_4', callerPhone: '+61400000000', occurredAt: callAt }, {
      settings: settings(), customers: { responses: [] }, turns: { responses: [] },
    });
    expect(ctx.today).toContain('2026-09-28');
  });

  const plan = (appointments: unknown[], occurredAt: string) => run('after-call-actions', 'plan', { callId: 'call_4', occurredAt }, {
    ctx: { hasTranscript: true, phone: '+61400000000', customerId: null, customerName: '' },
    extract: { content: JSON.stringify({ intent: 'appointment', caller_name: 'Lance', service: 'Haircut', appointments, summary: 'Wants a haircut.' }) },
    calls: { responses: [] }, appts: { responses: [] }, direct_appts: { responses: [] }, tasks: { responses: [] }, direct_tasks: { responses: [] },
    settings: settings(), customers: { responses: [] },
  });

  it('a booking that has started by the time the call arrives gets no text; the task says to call', () => {
    const r = plan([{ service: 'Haircut', date: TODAY, time: '10:00' }], ago(360));
    expect(r.hasAppointment).toBe(true);
    expect(r.hasKickoffSms).toBe(false);
    expect(r.task.sms_state).toBeUndefined();
    expect(r.task.summary).toContain('no confirmation text: the booking time had passed when this call reached FormLogic, 6 hours late');
    expect(r.summaryLine).toContain('SMS skipped');
  });

  it('a late call whose booking is still ahead is confirmed by text', () => {
    const r = plan([{ service: 'Haircut', date: NEXT_WEEK, time: '10:00' }], ago(360));
    expect(r.hasKickoffSms).toBe(true);
    expect(r.kickoffSms.body).toContain('Tue Oct 06 2026 at 10 AM');
  });

  it('with no day agreed, "what suits you?" goes out only within the hour', () => {
    expect(plan([], ago(20)).hasKickoffSms).toBe(true);
    const late = plan([], ago(120));
    expect(late.hasKickoffSms).toBe(false);
    expect(late.task.summary).toContain('no follow-up text: this call reached FormLogic 2 hours late');
  });
});

describe('sms-followup-conversation: a late text is handed to a person, not answered', () => {
  const nodes = () => ({
    settings: settings(),
    tasks: { responses: [{ id: 'task-1', answers: { status: 'open', sms_state: 'active', call_id: 'call_1', sms_exchanges: 1, summary: 'Confirm haircut' } }] },
    appointments: { responses: [{ id: 'appt-1', answers: { call_id: 'call_1', service: 'Haircut', date: NEXT_WEEK, time: '14:00', status: 'requested' } }] },
    messages: { responses: [] },
  });

  it('a fresh YES still confirms; a late one does not', () => {
    expect(run('sms-followup-conversation', 'ctx', { from: '+61400000000', body: 'YES', occurredAt: ago(3) }, nodes()).verdict).toBe('yes');
    const ctx = run('sms-followup-conversation', 'ctx', { from: '+61400000000', body: 'YES', occurredAt: ago(200) }, nodes());
    expect(ctx.verdict).toBe('late');
    const plan = run('sms-followup-conversation', 'plan', { from: '+61400000000', body: 'YES' }, { ctx });
    expect(plan.hasReply).toBe(false);
    expect(plan.hasApptUpdate).toBe(false);
    expect(plan.taskUpdate).toMatchObject({ sms_state: 'handoff', priority: 'high' });
    expect(plan.taskUpdate.summary).toContain('their text "YES" reached FormLogic 3 hours late - not answered automatically');
  });

  it('STOP is still recorded, however late', () => {
    expect(run('sms-followup-conversation', 'ctx', { from: '+61400000000', body: 'STOP', occurredAt: ago(600) }, nodes()).verdict).toBe('stop');
  });

  it('dates in the text are the day it was sent', () => {
    const ctx = run('sms-followup-conversation', 'ctx', { from: '+61400000000', body: 'tomorrow?', occurredAt: new Date(2026, 8, 29, 14, 30).toISOString() }, nodes());
    expect(ctx.today).toContain('2026-09-29');
  });
});
