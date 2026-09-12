import { describe, it, expect } from 'vitest';
import { aokieReceptionistPack as pack } from './pack';
// Exercise the exact authored logic used by the desktop flow compiler.
function run(slug: string, node: string, inputs: object, nodes: object = {}) {
  const expression = pack.flows!.find(f => f.slug === slug)!.flowJson.nodes.find(n => n.id === node)!.data!.expr;
  return new Function('inputs','nodes',`return ${expression};`)(inputs,nodes);
}
describe('follow-up acknowledgement and phone guards', () => {
  it('retains interruption metadata with the spoken text and deduplicates replayed turns', () => {
    const script = pack.apps[0].customLogic!.scripts.find(s => s.id === 'aokie-call-turn')!;
    const execute = new Function('ctx', `${script.source}; return run(ctx);`);
    const event = {name:'aokie.call.turn.final',idempotencyKey:'outbound-interrupt-3',data:{callId:'outbound-test',turn:3,speaker:'bot',text:'The time is',delivery:'interrupted',overlapped:false}};
    const result = execute({event,storage:{}});
    expect(result.effects[0].answers).toMatchObject({text:'The time is',delivery:'interrupted',speaker:'aokie',turn_key:'outbound-test:3'});
    expect(execute({event,storage:{'seen-outbound-interrupt-3':1}})).toEqual({});
    const caller = execute({event:{...event,idempotencyKey:'outbound-interrupt-4',data:{...event.data,turn:4,speaker:'caller',text:'Wait, I meant Friday afternoon',delivery:undefined,overlapped:true}},storage:{}});
    expect(caller.effects[0].answers).toMatchObject({text:'Wait, I meant Friday afternoon',overlapped:['yes'],speaker:'caller'});
  });
  it('creates approval-required drafts from both desktop text and browser message results', () => {
    for (const draft of ['Thanks for letting us know!', {content:'Thanks for letting us know!'}]) {
      const result = run('sms-auto-reply-draft','build',{from:'+61400000000'},{draft});
      expect(result.hasDraft).toBe(true);
      expect(result.draftMessage.body).toBe('Thanks for letting us know!');
      expect(result.draftMessage.approval_status).toBe('pending_approval');
    }
  });
  it('uses the radio from field when callerPhone is absent', () => {
    expect(run('missed-call-follow-up','phone',{from:'+61400000000'})).toEqual({phone:'+61400000000',usable:true});
    expect(run('hold-lost-apology','phone',{callerPhone:'',from:'+61400000000'}).usable).toBe(true);
  });
  it('does not run phone lookups for withheld or malformed numbers', () => {
    for (const from of ['', 'private', 'unknown']) expect(run('missed-call-follow-up','phone',{from}).usable).toBe(false);
    expect(run('outbound-callback-result','phone',{to:''}).usable).toBe(false);
  });
  const task = {id:'task',answers:{status:'open',callback_state:'sms_queued',callback_sms_id:'sms-1',summary:'Apology queued'}};
  const nodes = {tasks:{responses:[task]},messages:{responses:[{id:'message',answers:{direction:'outbound',message_id:'sms-1',status:'queued'}}]}};
  it('moves the matching callback to sent only after the phone acknowledgement', () => {
    const result=run('sms-delivery-status','mark',{messageId:'sms-1',outcome:'sent'},nodes);
    expect(result.hasUpdate).toBe(true);expect(result.taskId).toBe('task');expect(result.taskUpdate.callback_state).toBe('sms_sent');
  });
  it('raises a human follow-up when the apology fails', () => {
    const result=run('sms-delivery-status','mark',{messageId:'sms-1',outcome:'failed'},nodes);
    expect(result.update.status).toBe('failed');expect(result.taskUpdate.callback_state).toBe('needs_human');expect(result.taskUpdate.priority).toBe('urgent');
  });
  it('does not cross-match messages, accept unknown outcomes, or reopen closed tasks', () => {
    for(const input of [{messageId:'other',outcome:'sent'},{messageId:'sms-1',outcome:'unknown'}]) expect(run('sms-delivery-status','mark',input,nodes).hasTaskUpdate).toBe(false);
    expect(run('sms-delivery-status','mark',{messageId:'sms-1',outcome:'failed'},{tasks:{responses:[{...task,answers:{...task.answers,status:'done'}}]}}).hasTaskUpdate).toBe(false);
  });
});
