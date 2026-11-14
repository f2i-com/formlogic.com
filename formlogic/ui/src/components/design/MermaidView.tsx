// The design as Mermaid's ER diagram text (lib/mermaidErd), to read, copy, or write in: each edit that
// reads as an ER diagram changes the design at once, and one that does not says where, by line,
// leaving the design as it last read. On a wide screen the diagram is drawn beside it.
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/Button';
import { adoptIds, type DatabaseDesign, type DesignProblem } from '../../lib/databaseDesign';
import { readMermaid, toMermaid, type MermaidProblem } from '../../lib/mermaidErd';
import { DesignDiagram } from './DesignDiagram';

export function MermaidView({ design, problems, access, onChange, wide, narrow }: {
  design: DatabaseDesign;
  problems: DesignProblem[];
  access?: 'members' | 'application';
  onChange: (design: DatabaseDesign) => void;
  wide: boolean;
  narrow: boolean;
}) {
  // The text is the person's while they are in it: written from the design when the view opens.
  const [text, setText] = useState(() => toMermaid(design));
  const [wrong, setWrong] = useState<MermaidProblem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const edit = (next: string) => {
    setText(next);
    setCopied(false);
    const read = readMermaid(next, access);
    setWrong(read.problems);
    if (!read.design) return;
    setNotes(read.notes);
    onChange(adoptIds(design, read.design, true));
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  };

  const editor = <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
        Mermaid’s ER diagram, the same design as the diagram. Write in it, or paste one made in Mermaid’s editor or by an AI.
      </p>
      <Button size="sm" variant="secondary" className="max-sm:min-h-11" leftIcon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
    {/* Tab moves on, as in any box: Mermaid needs no indenting, and a box that kept Tab would trap a keyboard. */}
    <textarea aria-label="The design in Mermaid" value={text} spellCheck={false} autoCapitalize="none" autoComplete="off" wrap="off"
      onChange={event => edit(event.target.value)}
      className="min-h-64 w-full flex-1 resize-none rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs leading-5 text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100" />
    {wrong.length > 0 && <div role="alert" className="rounded-lg bg-red-50 p-2.5 text-xs leading-5 text-red-800 dark:bg-red-950/40 dark:text-red-200">
      <p className="font-semibold">Not read yet: the design stays as it last was.</p>
      <ul className="mt-1 space-y-0.5">{wrong.map((problem, index) => <li key={index}>Line {problem.line}: {problem.text}</li>)}</ul>
    </div>}
    {!wrong.length && notes.length > 0 && <ul className="max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs leading-5 text-slate-500 dark:text-slate-400">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    <details className="text-xs leading-5 text-slate-600 dark:text-slate-300">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-8">What it can say</summary>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] leading-5 dark:bg-slate-800/60">{`erDiagram
  customers {
    integer id PK
    text name "required"
    email email UK
    choice status "default: new; one of: new, paid"
    integer customer_id FK
    datetime created_at
  }
  customers ||--o{ orders : customer_id   each order belongs to one customer
  customers |o--o{ notes : customer_id    ... or to none
  students }o--o{ courses : takes          many of each other: a table joins them`}</pre>
      <p className="mt-1">Types: text, long_text, integer, decimal, boolean, date, datetime, email, url, choice (or SQL’s: varchar, int, …). PK is the id, UK no two the same, FK a connection’s column.</p>
    </details>
  </div>;

  if (!wide) return <div className="flex h-full min-h-0 flex-col overflow-y-auto">{editor}</div>;
  return <div className="grid h-full min-h-0 grid-cols-[minmax(22rem,2fr)_3fr]">
    <div className="flex min-h-0 flex-col border-r border-slate-200 dark:border-slate-700">{editor}</div>
    <div className="min-h-0 bg-slate-50/70 dark:bg-slate-900/40">
      <DesignDiagram design={design} problems={problems} access={access} selected={null} onSelect={() => {}} onChange={onChange} narrow={narrow} readOnly />
    </div>
  </div>;
}
