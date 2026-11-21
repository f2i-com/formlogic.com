import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, Check, Database, NotebookPen, Plus, Table2, Zap } from 'lucide-react';

const views = ['App', 'Shared SQLite', 'Charts & API'] as const;
type View = (typeof views)[number];
type Priority = 'Normal' | 'Urgent';
interface SampleItem {
  id: number;
  text: string;
  priority: Priority;
}

const initialNotes: SampleItem[] = [
  { id: 3, text: 'Inspect roof flashing at 42 Oak St.', priority: 'Urgent' },
  { id: 2, text: 'Leave the workshop keys at reception.', priority: 'Normal' },
  { id: 1, text: 'Bring the new colour samples to the site visit.', priority: 'Normal' },
];

/** Self-contained interactive preview showing an app, its shared SQLite table,
 *  and live charts + flow/API triggers staying in sync as the visitor adds items. */
export function WorkspacePreview() {
  const id = useId();
  const [view, setView] = useState<View>('App');
  const [notes, setNotes] = useState<SampleItem[]>(initialNotes);
  const [draft, setDraft] = useState('');
  const [priority, setPriority] = useState<Priority>('Normal');
  const [flowRuns, setFlowRuns] = useState(3);
  const [announcement, setAnnouncement] = useState('');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const urgentCount = notes.filter((n) => n.priority === 'Urgent').length;
  const normalCount = notes.length - urgentCount;
  const urgentPct = notes.length ? Math.round((urgentCount / notes.length) * 100) : 0;
  const normalPct = notes.length ? 100 - urgentPct : 0;

  function addNote(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setNotes((existing) => [{ id: existing[0].id + 1, text, priority }, ...existing]);
    setFlowRuns((n) => n + 1);
    setDraft('');
    setAnnouncement('Record added to shared SQLite and flow triggered. ' + (notes.length + 1) + ' records.');
    input.current?.focus({ preventScroll: true });
    if (list.current) list.current.scrollTop = 0;
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % views.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + views.length) % views.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = views.length - 1;
    else return;
    event.preventDefault();
    setView(views[next]);
    tabs.current[next]?.focus();
  }

  return (
    <figure className="fl-notebook" aria-label="Interactive Field Ops app, shared database and charts sample">
      <div className="fl-notebook__sheet">
        <div className="fl-notebook__head">
          <span className="fl-notebook__brand">
            <span className="fl-notebook__mark"><NotebookPen size={18} aria-hidden="true" /></span>
            Field Ops
          </span>
          <span className="fl-notebook__sample">Live interactive sample</span>
        </div>
        <div className="fl-notebook__tabs" role="tablist" aria-label="Field Ops views">
          {views.map((item, index) => {
            const Icon = index === 0 ? NotebookPen : index === 1 ? Table2 : BarChart3;
            return (
              <button
                type="button"
                key={item}
                role="tab"
                ref={(node) => { tabs.current[index] = node; }}
                id={id + item}
                aria-selected={view === item}
                tabIndex={view === item ? 0 : -1}
                aria-controls={id + '-panel'}
                onClick={() => setView(item)}
                onKeyDown={(event) => moveTab(event, index)}
              >
                <Icon size={14} aria-hidden="true" />{item}
              </button>
            );
          })}
        </div>
        <div className="fl-notebook__panel" role="tabpanel" id={id + '-panel'} aria-labelledby={id + view} tabIndex={0}>
          {view === 'App' ? (
            <>
              <h2>Team job notes</h2>
              <form onSubmit={addNote}>
                <label htmlFor={id + '-note'}>Add a job note — updates SQLite, charts &amp; flows live</label>
                <div className="fl-notebook__formrow">
                  <input
                    id={id + '-note'}
                    ref={input}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={240}
                    autoComplete="off"
                    placeholder="e.g. Replace kitchen valve…"
                  />
                  <select
                    aria-label="Priority"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as Priority)}
                    className="fl-notebook__select"
                  >
                    <option value="Normal">Normal</option>
                    <option value="Urgent">Urgent</option>
                  </select>
                  <button type="submit" disabled={!draft.trim()} aria-label="Add note">
                    <Plus size={15} aria-hidden="true" /><span>Add</span>
                  </button>
                </div>
              </form>
              <div className="fl-notebook__list" ref={list}>
                <ul aria-label="Field notes">
                  {notes.map((note) => (
                    <li key={note.id}>
                      <span aria-hidden="true" className="fl-notebook__number">{String(note.id).padStart(2, '0')}</span>
                      <span className="fl-notebook__text">{note.text}</span>
                      <span className={`fl-notebook__pill${note.priority === 'Urgent' ? ' is-urgent' : ''}`}>
                        {note.priority}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : view === 'Shared SQLite' ? (
            <>
              <h2>Shared SQLite table</h2>
              <div className="fl-notebook__table-name"><Database size={14} aria-hidden="true" />jobs (shared with Admin Forms &amp; API)</div>
              <div className="fl-notebook__list">
                <table aria-label="Jobs SQLite records">
                  <thead>
                    <tr><th scope="col">id</th><th scope="col">summary</th><th scope="col">priority</th></tr>
                  </thead>
                  <tbody>
                    {notes.map((note) => (
                      <tr key={note.id}>
                        <td>{note.id}</td>
                        <td>{note.text}</td>
                        <td><span className={`fl-notebook__pill${note.priority === 'Urgent' ? ' is-urgent' : ''}`}>{note.priority}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <h2>Management charts &amp; API</h2>
              <div className="fl-notebook__charts">
                <div className="fl-notebook__kpis">
                  <div><small>Total jobs</small><strong>{notes.length}</strong></div>
                  <div><small>Urgent</small><strong>{urgentCount}</strong></div>
                  <div><small>Flow runs</small><strong>{flowRuns}</strong></div>
                </div>
                <div className="fl-notebook__bars" aria-label="Jobs by priority">
                  <div className="fl-notebook__barrow">
                    <span>Normal ({normalCount})</span>
                    <div><i style={{ width: `${Math.max(12, normalPct)}%` }} /></div>
                  </div>
                  <div className="fl-notebook__barrow is-urgent">
                    <span>Urgent ({urgentCount})</span>
                    <div><i style={{ width: `${Math.max(12, urgentPct)}%` }} /></div>
                  </div>
                </div>
                <div className="fl-notebook__api">
                  <Zap size={13} aria-hidden="true" />
                  <code>POST /api/v1/apps/field-ops/invoke · app.record.created.jobs</code>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="fl-notebook__status">
          <span><Check size={14} aria-hidden="true" />{notes.length} SQLite rows · {flowRuns} flow runs</span>
          <span>Live in-browser sample</span>
        </div>
      </div>
      <figcaption><Link to="/docs#hosted-apps">See how shared app databases work <ArrowRight size={14} aria-hidden="true" /></Link></figcaption>
      <span className="sr-only" role="status">{announcement}</span>
    </figure>
  );
}
