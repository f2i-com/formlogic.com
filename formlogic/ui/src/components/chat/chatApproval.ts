import { toolLabel, type SendChatTurnOptions } from './chatEngine';

/** Resolve one visible proposal once. Closing/stopping a turn also releases the pending request. */
export function requestChatApproval(opts: SendChatTurnOptions, call: { id: string; name: string; arguments: unknown }): Promise<boolean> {
  if (!opts.events?.onToolProposal || opts.signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let pending = true;
    const cancel = () => respond(false);
    const respond = (approved: boolean) => {
      if (!pending) return false;
      pending = false;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
      resolve(approved);
      return true;
    };
    const timer = setTimeout(cancel, 120000);
    opts.signal?.addEventListener('abort', cancel, { once: true });
    opts.events!.onToolProposal!({ callId: call.id, requestId: opts.threadId, tool: call.name, toolLabel: toolLabel(call.name), input: call.arguments, status: 'pending', respond });
  });
}
