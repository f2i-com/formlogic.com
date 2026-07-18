/** @jsxImportSource preact */
// The recent-calls card: rows come from FormLogic.records() (the attached Calls form).
// Each row opens its record detail via host.openRecord; "View all" opens the form's own
// records table via openRecords(). Enter/Space on a focused row opens it too.
import type { ConsoleController } from '../controller';
import { rec } from '../controller';

function statusClass(status: string): string {
  if (status === 'missed' || status === 'failed' || status === 'rejected') return 'cstat bad';
  if (status === 'completed' || status === 'answered') return 'cstat ok';
  return 'cstat';
}

export function RecentCalls({ c }: { c: ConsoleController }) {
  const rows = c.state.recent;
  return (
    <section class="card">
      <div class="thead">
        <h2>Recent calls</h2>
        <span class="link" data-act="viewall" role="button" tabIndex={0}
          onClick={() => c.viewAll()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              c.viewAll();
            }
          }}>
          View all
        </span>
      </div>
      {rows.length === 0 ? (
        <p class="muted tempty">No calls logged yet - they are recorded automatically from call events.</p>
      ) : (
        <ul class="calls">
          {rows.map((row) => {
            const a = rec(row.answers);
            const phone = String(a.caller_phone || '');
            const status = String(a.status || '');
            const open = () => c.openRecent(row.id);
            return (
              <li key={row.id} data-act="open" data-id={row.id} role="button" tabIndex={0}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                  }
                }}>
                <div class="cwho">
                  <span class="cwho-name">{String(a.caller_name || phone || 'Unknown caller')}</span>
                  {phone ? <span class="mono faint">{phone}</span> : null}
                </div>
                <span class={statusClass(status)}>{status || 'unknown'}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
