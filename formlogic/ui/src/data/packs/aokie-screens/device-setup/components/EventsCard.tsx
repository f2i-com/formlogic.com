/** @jsxImportSource preact */
// Recent hardware events: the newest 8 of up to 100 loaded records, each with
// its per-row timestamp (occurred_at, else submittedAt) and severity pill.
// Clear is double-gated (ask -> confirm) and never offered in the demo.
import { asRecord, whenLabel } from '../format';
import { Loading } from './Loading';

/** Rows rendered in the card; the rest stay counted in the footer line. */
const EVENTS_SHOWN = 8;

interface Props {
  demo: boolean;
  rows: FlScreenRecord[] | null;
  confirmClear: boolean;
  clearing: boolean;
  onClearAsk: () => void;
  onClearCancel: () => void;
  onClear: () => void;
}

export function EventsCard({ demo, rows, confirmClear, clearing, onClearAsk, onClearCancel, onClear }: Props) {
  let body;
  if (rows === null) {
    body = <Loading />;
  } else if (rows.length === 0) {
    body = <p class="faint">No hardware events recorded. Errors from the dongle/plugin land here automatically.</p>;
  } else {
    const shown = rows.slice(0, EVENTS_SHOWN);
    body = (
      <div>
        <ul>
          {shown.map((r) => {
            const a = asRecord(r.answers);
            const when = whenLabel(typeof a.occurred_at === 'string' && a.occurred_at !== '' ? a.occurred_at : r.submittedAt);
            const sev = String(a.severity || 'info');
            const sevClass = sev === 'error' ? 'pill bad' : sev === 'warning' ? 'pill warn' : 'pill';
            return (
              <li key={r.id}>
                <div class="rowmain">
                  <span class="rowname">{String(a.event_name || 'event')}</span>
                  {' '}
                  <span class="muted">{String(a.message || '')}</span>
                </div>
                <span class="evmeta">
                  {when && <span class="faint" title={when.full}>{when.short}</span>}
                  <span class={sevClass}>{sev}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {rows.length > EVENTS_SHOWN && (
          <p class="faint shownote">{'Showing the ' + EVENTS_SHOWN + ' most recent of ' + rows.length + '.'}</p>
        )}
      </div>
    );
  }
  return (
    <section class="card" id="events">
      <div class="sectionrow">
        <h2>Recent hardware events</h2>
        {rows && rows.length > 0 && !demo && (
          confirmClear ? (
            <span>
              <button type="button" class="btn danger-btn" disabled={clearing} onClick={onClear}>
                {clearing ? 'Clearing...' : 'Confirm clear'}
              </button>
              {' '}
              <button type="button" class="btn" onClick={onClearCancel}>Cancel</button>
            </span>
          ) : (
            <button type="button" class="btn" title="Delete every recorded hardware event." onClick={onClearAsk}>Clear</button>
          )
        )}
      </div>
      {body}
    </section>
  );
}
