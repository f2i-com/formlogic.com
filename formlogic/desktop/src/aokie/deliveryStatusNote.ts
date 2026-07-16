import type { FlowRuntimeStatus } from '../api';

export function deliveryStatusNote(
  status: Pick<FlowRuntimeStatus, 'linked' | 'lastError' | 'recordsWritten' | 'relayPollOk'>,
): string {
  const lastError = status.lastError?.trim() ?? '';
  const recoveredRelayError = status.relayPollOk === true && lastError.startsWith('relay poll:');
  if (lastError && !recoveredRelayError) return lastError;
  return status.linked
    ? `${status.recordsWritten} records written`
    : 'link an account to deliver records';
}
