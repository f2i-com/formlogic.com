/** @jsxImportSource preact */
// Pack-owned Calls transcript record screen — TSX edition (bundled in the sandbox on Preact).
//
// Runtime contract (CustomScreenRuntime + RecordScreenPanel):
//  - runs in an opaque-origin iframe (sandbox="allow-scripts", strict CSP, no network);
//  - `window.FormLogic` is the only bridge: this screen uses `related()` (the record's
//    related-record groups) — a record()-class TRUSTED_ONLY action, so the form's
//    custom_screen_trust must be owner/verified;
//  - theme comes from the injected `--fl-*` CSS variables and the `fl-dark` root class,
//    so light/dark both work with token-only styling;
//  - JSX text is auto-escaped, so record values can never inject markup.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { compareTurns } from './sort';

/** Turns rendered per "Load more" click; the full set stays in memory so a long call
 *  does not paint hundreds of bubbles up front. */
const TURN_PAGE = 30;
/** The related endpoint's match-join cap: a group at exactly this size is almost
 *  certainly truncated to the newest turns. */
const SERVER_TURN_CAP = 500;

interface Turn {
  id: string;
  speaker: string;
  text: string;
  turnIndex: number | null;
  spokenAt: string | null;
  submittedAt?: string;
  /** The audio model re-heard and corrected this line (source=audio_model). */
  corrected: boolean;
}

interface RelatedGroup {
  fieldId?: string;
  columns?: Array<{ id: string; label?: string }>;
  records?: Array<{ id: string; fields: Record<string, unknown>; submittedAt?: string }>;
}

function toTurn(r: { id: string; fields: Record<string, unknown>; submittedAt?: string }): Turn {
  const f = r.fields || {};
  const idx = f.turn_index;
  const turnIndex = typeof idx === 'number' ? idx
    : (typeof idx === 'string' && idx !== '' && !isNaN(Number(idx)) ? Number(idx) : null);
  return {
    id: r.id,
    speaker: typeof f.speaker === 'string' && f.speaker ? f.speaker : 'system',
    text: typeof f.text === 'string' ? f.text : String(f.text == null ? '' : f.text),
    turnIndex,
    spokenAt: typeof f.timestamp === 'string' && f.timestamp !== '' ? f.timestamp : null,
    submittedAt: r.submittedAt,
    corrected: f.source === 'audio_model',
  };
}

/** Caller sits right and neutral; the receptionist's own voice (Aokie, or the operator
 *  standing in for it) sits left in the app accent. */
function speakerMeta(speaker: string): { label: string; side: 'caller' | 'agent'; initial: string } {
  if (speaker === 'caller') return { label: 'Caller', side: 'caller', initial: 'C' };
  if (speaker === 'operator') return { label: 'You', side: 'agent', initial: 'Y' };
  return { label: 'Aokie', side: 'agent', initial: 'A' };
}

/** Several forms link to Calls through a field named call_link (follow-up tasks do too),
 *  so a fieldId match alone can pick the wrong group — require the group to actually
 *  carry transcript turns (speaker + text). */
function looksLikeTurns(g: RelatedGroup): boolean {
  const cols = g.columns || [];
  const hasCol = (id: string) => cols.some((c) => c.id === id);
  if (hasCol('speaker') && hasCol('text')) return true;
  const f = g.records && g.records[0] && g.records[0].fields;
  return !!f && 'speaker' in f && 'text' in f;
}

function Bubble({ turn }: { turn: Turn }) {
  const who = speakerMeta(turn.speaker);
  return (
    <div class={`turn ${who.side}`}>
      <span class="avatar" aria-hidden="true">{who.initial}</span>
      <div class="bubble">
        <span class="who">
          {who.label}
          {turn.corrected && (
            <span class="corrected" title="Corrected by the audio model">corrected</span>
          )}
        </span>
        <p class="text">{turn.text}</p>
      </div>
    </div>
  );
}

function Transcript() {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(TURN_PAGE);

  useEffect(() => {
    FormLogic.related()
      .then((related) => {
        const groups = Object.values(related || {}) as RelatedGroup[];
        const group = groups.find((g) => g && g.fieldId === 'call_link' && looksLikeTurns(g)) || null;
        const rows = ((group && group.records) || []).map(toTurn);
        rows.sort(compareTurns);
        setTurns(rows);
      })
      .catch((e: unknown) => {
        setError((e instanceof Error && e.message) || 'Failed to load the transcript');
      });
  }, []);

  if (error) return <p class="state error">{error}</p>;
  if (turns === null) {
    return (
      <div role="status" aria-label="Loading transcript">
        <div class="skeleton" />
        <div class="skeleton right" />
        <div class="skeleton" />
      </div>
    );
  }
  if (turns.length === 0) {
    return <p class="state">No transcript was recorded for this call.</p>;
  }

  const shown = turns.slice(0, visible);
  const remaining = turns.length - shown.length;
  return (
    <div class="wrap">
      <div class="meta">
        <span class="count">{turns.length === 1 ? '1 turn' : `${turns.length} turns`}</span>
        {turns.length >= SERVER_TURN_CAP && <span class="note">showing the most recent turns</span>}
      </div>
      <div class="turns">
        {shown.map((t) => <Bubble key={t.id} turn={t} />)}
        {remaining > 0 && (
          <button type="button" class="more" onClick={() => setVisible(visible + TURN_PAGE)}>
            Load more ({remaining} more {remaining === 1 ? 'turn' : 'turns'})
          </button>
        )}
      </div>
    </div>
  );
}

render(<Transcript />, document.getElementById('root')!);
