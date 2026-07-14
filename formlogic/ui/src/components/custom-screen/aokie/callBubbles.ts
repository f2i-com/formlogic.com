// Shared chat-bubble presentation for transcript turns (landing-console style), used by the
// live-call console (AokieLiveCallScreen) and the call-record transcript widget
// (AokieCallTranscriptScreen). Lives outside the component files so fast refresh keeps working
// (react-refresh/only-export-components).

/** Speaker → label + color. The palette carries meaning: caller is neutral, the receptionist's
 *  own voice (AI or the operator standing in for it) is brand-colored. */
export function describeSpeaker(speaker: string): { label: string; className: string } {
  if (speaker === 'caller') return { label: 'Caller', className: 'text-cyan-700 dark:text-[#8fe7ed]' };
  if (speaker === 'operator') return { label: 'You', className: 'text-primary-700 dark:text-[#c5b9ff]' };
  return { label: 'Aokie', className: 'text-primary-700 dark:text-[#c5b9ff]' };
}

/** Chat-bubble treatment per speaker: the caller sits right in teal, the receptionist's voice
 *  (Aokie or the operator) left in brand. */
export function turnBubble(speaker: string): { row: string; avatar: string; bubble: string; initial: string } {
  if (speaker === 'caller') {
    return {
      row: 'flex max-w-[86%] flex-row-reverse items-start gap-2 self-end',
      avatar: 'bg-cyan-100 text-cyan-700 dark:bg-[rgba(76,199,216,0.15)] dark:text-[#8fe7ed]',
      bubble: 'rounded-[12px_4px_12px_12px] bg-cyan-50/80 dark:bg-[rgba(63,178,195,0.08)]',
      initial: 'C',
    };
  }
  return {
    row: 'flex max-w-[86%] items-start gap-2',
    avatar: 'bg-primary-100 text-primary-700 dark:bg-[rgba(117,86,246,0.2)] dark:text-[#c5b9ff]',
    bubble: 'rounded-[4px_12px_12px_12px] bg-gray-100/80 dark:bg-white/[0.045]',
    initial: speaker === 'operator' ? 'Y' : 'A',
  };
}
