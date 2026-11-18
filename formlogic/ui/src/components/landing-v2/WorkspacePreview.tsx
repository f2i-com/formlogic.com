import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Database, NotebookPen, Plus, Table2 } from 'lucide-react';

const views = ['Notebook', 'Records'] as const;
type View = (typeof views)[number];
const initialNotes = [
  { id: 2, text: 'Leave the workshop keys at reception.' },
  { id: 1, text: 'Bring the new colour samples to the site visit.' },
];

/** A self-contained notebook and its records. This public example keeps visitor input
 * in component state, independent of sessions, customer apps and hosted databases. */
export function WorkspacePreview() {
  const id = useId();
  const [view, setView] = useState<View>('Notebook');
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  function addNote(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setNotes(existing => [{ id: existing[0].id + 1, text }, ...existing]);
    setDraft('');
    setAnnouncement('Note added. ' + (notes.length + 1) + ' records in this sample.');
    input.current?.focus({ preventScroll: true });
    if (list.current) list.current.scrollTop = 0;
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = 1 - index;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = views.length - 1;
    else return;
    event.preventDefault();
    setView(views[next]);
    tabs.current[next]?.focus();
  }

  return (
    <figure className="fl-notebook" aria-label="Interactive Field Notes sample">
      <div className="fl-notebook__sheet">
        <div className="fl-notebook__head">
          <span className="fl-notebook__brand"><span className="fl-notebook__mark"><NotebookPen size={19} aria-hidden="true" /></span> Field Notes</span>
          <span className="fl-notebook__sample">Sample app</span>
        </div>
        <div className="fl-notebook__tabs" role="tablist" aria-label="Field Notes views">
          {views.map((item, index) => {
            const Icon = index === 0 ? NotebookPen : Table2;
            return <button type="button" key={item} role="tab" ref={node => { tabs.current[index] = node; }}
              id={id + item} aria-selected={view === item} tabIndex={view === item ? 0 : -1}
              aria-controls={id + '-panel'} onClick={() => setView(item)} onKeyDown={event => moveTab(event, index)}>
              <Icon size={15} aria-hidden="true" />{item}
            </button>;
          })}
        </div>
        <div className="fl-notebook__panel" role="tabpanel" id={id + '-panel'} aria-labelledby={id + view} tabIndex={0}>
          {view === 'Notebook' ? <>
            <h2>Team notebook</h2>
            <form onSubmit={addNote}>
              <label htmlFor={id + '-note'}>Add a field note</label>
              <div className="fl-notebook__formrow">
                <input id={id + '-note'} ref={input} value={draft} onChange={event => setDraft(event.target.value)}
                  maxLength={240} autoComplete="off" placeholder="Write a note…" />
                <button type="submit" disabled={!draft.trim()} aria-label="Add note">
                  <Plus size={16} aria-hidden="true" /><span>Add</span>
                </button>
              </div>
            </form>
            <div className="fl-notebook__list" ref={list}>
              <ul aria-label="Field notes">{notes.map(note => <li key={note.id}>
                <span aria-hidden="true" className="fl-notebook__number">{String(note.id).padStart(2, '0')}</span>
                {note.text}
              </li>)}</ul>
            </div>
          </> : <>
            <h2>Saved records</h2>
            <div className="fl-notebook__table-name"><Database size={14} aria-hidden="true" />notes</div>
            <div className="fl-notebook__list">
              <table aria-label="Notes records">
                <thead><tr><th scope="col">id</th><th scope="col">text</th></tr></thead>
                <tbody>{notes.map(note => <tr key={note.id}><td>{note.id}</td><td>{note.text}</td></tr>)}</tbody>
              </table>
            </div>
          </>}
        </div>
        <div className="fl-notebook__status"><span><Check size={14} aria-hidden="true" />{notes.length} records</span><span>Resets on refresh</span></div>
      </div>
      <figcaption><Link to="/docs#hosted-apps">How to host an app <ArrowRight size={14} aria-hidden="true" /></Link></figcaption>
      <span className="sr-only" role="status">{announcement}</span>
    </figure>
  );
}
