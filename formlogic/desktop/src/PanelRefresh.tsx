import { useState } from 'react';

/**
 * Manual refresh affordance for the section panels: a small right-aligned
 * button with a spinner while the refresh promise is in flight. The panels
 * poll on their own — this exists for the "I want it NOW" moment (and as
 * visible feedback that a reload is actually happening).
 */
export function PanelRefresh({ onRefresh, label = 'Refresh' }: { onRefresh: () => Promise<unknown>; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel-refresh-row">
      <button
        type="button"
        className="btn-tiny panel-refresh-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onRefresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <span className="spinner spinner-inline" aria-hidden="true" /> : <span aria-hidden="true">↻</span>}
        {busy ? 'Refreshing…' : label}
      </button>
    </div>
  );
}
