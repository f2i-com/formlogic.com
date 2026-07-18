/** @jsxImportSource preact */
// Start fresh: the whole-app record reset. Double-gated by design - the inline
// type-'delete all'-to-confirm input arms the button, and the HOST then owns
// the reset ceremony (its own confirm dialog, its own bulk clear); this screen
// only asks. 'denied' = the operator cancelled the host dialog (no noise).
import { useState } from 'preact/hooks';

interface Props {
  demo: boolean;
  busy: boolean;
  note: string;
  onStartFresh: () => void;
}

export function FreshCard({ demo, busy, note, onStartFresh }: Props) {
  const [confirm, setConfirm] = useState('');
  const armed = confirm.trim().toLowerCase() === 'delete all';
  return (
    <section class="card danger" id="fresh">
      <h2>Start fresh</h2>
      <p class="muted">
        {'Deletes '}
        <strong>every record</strong>
        {' in this app - calls, transcripts, appointments, customers, follow-up tasks, messages and hardware events - so testing starts from a clean slate. Your Receptionist Settings, forms and flows are '}
        <strong>not</strong>
        {' touched.'}
      </p>
      {demo ? (
        <p class="faint footnote">Not available in the shared demo.</p>
      ) : (
        <div class="freshrow">
          <input
            type="text"
            id="fresh-confirm"
            placeholder='Type "delete all" to enable'
            autocomplete="off"
            spellcheck={false}
            value={confirm}
            onInput={(e) => setConfirm(e.currentTarget.value)}
          />
          <button
            type="button"
            class="btn danger-btn"
            id="fresh-go"
            disabled={!armed || busy}
            onClick={() => { if (armed && !busy) onStartFresh(); }}
          >
            {busy ? 'Waiting for confirmation...' : 'Delete all records'}
          </button>
          <span class="faint" id="fresh-note">{note}</span>
        </div>
      )}
    </section>
  );
}
