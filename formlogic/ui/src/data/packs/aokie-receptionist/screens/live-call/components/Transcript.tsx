/** @jsxImportSource preact */
// The conversation card: final transcript turns (live event lane on the local bridge,
// or the stored-turns poll in remote/demo mode), the in-flight operator line, and the
// operator composer. Copy, gating, and the corrected-turn tooltip match the previous
// embedded-JS console.
import { useEffect, useRef } from 'preact/hooks';
import type { CallInfo, ConsoleController, Turn } from '../controller';
import { clock } from '../phone';

function turnMeta(speaker: string): { side: 'caller' | 'agent'; label: string; initial: string } {
  if (speaker === 'caller') return { side: 'caller', label: 'Caller', initial: 'C' };
  if (speaker === 'operator') return { side: 'agent', label: 'You', initial: 'Y' };
  return { side: 'agent', label: 'Aokie', initial: 'A' };
}

function TurnBubble({ turn }: { turn: Turn }) {
  const mt = turnMeta(turn.speaker);
  const time = clock(turn.occurredAt);
  return (
    <div class={'turn ' + mt.side}>
      <span class="tav" aria-hidden="true">{mt.initial}</span>
      <div class="tbody">
        <div class="twho">
          {mt.label}
          {time ? <span class="ttime mono">{time}</span> : null}
        </div>
        <p class="ttext" title={turn.corrected ? 'Corrected by the audio model' : undefined}>{turn.text}</p>
      </div>
    </div>
  );
}

export function Transcript({ c, call }: { c: ConsoleController; call: CallInfo | null }) {
  const s = c.state;
  const heading = call ? 'Conversation' : c.remoteMode() ? 'Latest call' : 'Last call';
  const turns = s.turns;
  const box = useRef<HTMLDivElement>(null);
  const lastKey = turns.length > 0 ? turns[turns.length - 1].key : '';
  // Keep the newest turn in view as the conversation grows. (The old screen pinned
  // the scroll on EVERY repaint; pinning only when the content changes lets the
  // operator scroll back through a long call without being yanked down.)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns.length, lastKey, s.pendingSpeak]);

  const reason = call
    ? call.state === 'ringing'
      ? 'Answer the call to speak'
      : !c.can('connector.aokie.call.operatorSpeak')
        ? 'Speaking is not granted to this app'
        : null
    : null;
  const disabled = reason !== null || s.busy !== null;

  return (
    <section class="card">
      <div class="thead"><h2>{heading}</h2></div>
      {turns.length === 0 && s.pendingSpeak === null ? (
        <p class="muted tempty">
          {c.remoteMode()
            ? 'No transcript recorded for the latest call yet.'
            : 'Final transcript turns stream in here during a call.'}
        </p>
      ) : (
        <div class="turns" ref={box}>
          {turns.map((t) => <TurnBubble key={t.key} turn={t} />)}
          {s.pendingSpeak !== null && (
            <div class="turn agent pending">
              <span class="tav" aria-hidden="true">Y</span>
              <div class="tbody">
                <div class="twho">You<span class="ttime">sending...</span></div>
                <p class="ttext">{s.pendingSpeak}</p>
              </div>
            </div>
          )}
        </div>
      )}
      {call !== null && (
        <div class="composer">
          <input
            id="speak"
            type="text"
            placeholder={reason || 'Speak to the caller as the operator...'}
            disabled={disabled}
            value={s.speakText}
            onInput={(e) => c.setSpeakText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void c.sendSpeak();
              }
            }}
          />
          <button type="button" class="send" id="send" data-act="send" aria-label="Send to caller"
            disabled={disabled} onClick={() => void c.sendSpeak()}>
            {'\u203A'}
          </button>
        </div>
      )}
    </section>
  );
}
