// A hosted project's source, as its owner edits it: every file in one list, grouped by what it is
// for (pages, logic, styles, the backend, the database's changes, the project's own files), with
// the open file beside it. A file is added, a database change is added and listed, and a file is
// removed, all in the draft: nothing reaches the app until the draft is published.
// The rules (which file is listed where, which stay as they are) are lib/projectSource.
import { useMemo, useState, type FormEvent } from 'react';
import { Braces, Database, FileCode2, FileJson, FilePlus2, Paintbrush, Search, Server, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import { NativeSourceEditor } from './NativeSourceEditor';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import type { NativeProject } from '../../lib/nativeHosting';
import {
  groupSourceFiles, hasDatabase, newSourceProblem, nextMigrationPath, removedSourceFiles, sourceFileState, sourceLockReason,
  sourceGroupOf, sourceRemoveProblem, strayedMigration, withInstalledFile, withSourceFile, withoutSourceFile, type SourceGroupId,
} from '../../lib/projectSource';

const ICONS: Record<SourceGroupId, LucideIcon> = { pages: FileCode2, logic: Braces, styles: Paintbrush, backend: Server, migrations: Database, project: FileJson };
const STATE_LABEL = { new: 'New', changed: 'Changed' } as const;
/** The folder a group's files are all in, which its heading stands for. */
const GROUP_FOLDER: Partial<Record<SourceGroupId, string>> = { backend: 'server/', migrations: 'server/migrations/' };
/** As tall as the dialog leaves it: the dialog is at most 90dvh, less its header, footer and messages. */
const EDITOR_HEIGHT = 'clamp(300px, calc(90dvh - 19rem), 60rem)';

export function ProjectSourcePane({ appId, project, installed, readOnly, file, onFile, onEdit, onNotice }: {
  appId: string;
  /** The open draft. */
  project: NativeProject;
  /** The installed version's files, or null when nothing is installed. */
  installed: Readonly<Record<string, string>> | null;
  /** Nothing may be changed: the shared demo, or a save in flight. */
  readOnly: boolean;
  /** The chosen file; one that is not in the project opens the first file. */
  file: string;
  onFile(path: string): void;
  onEdit(next: NativeProject): void;
  /** Said after a file is added or removed. */
  onNotice?(message: string): void;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const groups = useMemo(() => groupSourceFiles(project.files), [project.files]);
  const count = Object.keys(project.files).length;
  const open = Object.hasOwn(project.files, file) ? file : groups[0]?.files[0] ?? '';
  const wanted = query.trim().toLowerCase();
  const shown = wanted ? groups.map(group => ({ ...group, files: group.files.filter(path => path.toLowerCase().includes(wanted)) })).filter(group => group.files.length) : groups;
  const removed = removedSourceFiles(project.files, installed);
  const lock = open ? sourceLockReason(open, installed) : null;
  const removeProblem = open ? sourceRemoveProblem(open, project.files, installed) : 'No file is open.';
  // A copy of a database change that has run, other than the one that ran: nothing installs it.
  const strayed = open !== '' && strayedMigration(open, project.files, installed);
  const putBack = (path: string) => {
    if (!installed) return;
    onEdit(withInstalledFile(project, path, installed));
    onFile(path);
    onNotice?.(`${path} is as the installed version has it again.`);
  };

  const add = (path: string) => {
    const made = withSourceFile(project, path);
    onEdit(made.project);
    onFile(path);
    setQuery(''); setAdding(false); setName(''); setProblem('');
    onNotice?.(made.listed
      ? `${path} was added to your draft.`
      : `${path} was added to your draft. List it under server.database.migrations in manifest.json, or it never runs.`);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const path = name.trim().replace(/^\/+/, '');
    const refused = newSourceProblem(path, project.files);
    if (refused) { setProblem(refused); return; }
    add(path);
  };
  const remove = () => {
    if (!open || removeProblem || !window.confirm(`Remove ${open} from the project? It goes when you publish; until then, discarding your changes brings it back.`)) return;
    onEdit(withoutSourceFile(project, open));
    onFile('');
    // The list is whole again: a search that found only the file just removed would leave it empty.
    setQuery('');
    onNotice?.(`${open} was removed from your draft.`);
  };

  return <div className="grid min-w-0 gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]">
    {/* Wide: the list is as tall as the editor beside it and scrolls inside. Narrow: a short list above it. */}
    <div className="min-w-0 lg:relative">
      <nav aria-label="Project files" className="flex max-h-64 min-h-0 flex-col overflow-hidden rounded-xl border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-950 lg:absolute lg:inset-0 lg:max-h-none">
        {/* While something is being looked for the box stays, however few files are left: it is the way to stop looking. */}
        {(count > 8 || query !== '') && <label className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-700">
          <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          {/* Escape clears what is typed, and is kept from the dialog around the pane, which it would close. */}
          <input type="search" aria-label="Find a file" placeholder="Find a file" value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); } }}
            className="min-h-10 w-full min-w-0 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-white" />
        </label>}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {shown.map(group => {
            const Icon = ICONS[group.id];
            return <section key={group.id} aria-label={group.label}>
              <h4 title={group.hint} className="px-1.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{group.label}</h4>
              <ul>{group.files.map(path => {
                const state = sourceFileState(path, project.files, installed);
                // The group already says the folder its files are in, so a long name keeps its end: the number of a database change.
                const said = GROUP_FOLDER[group.id] && path.startsWith(GROUP_FOLDER[group.id]!) ? path.slice(GROUP_FOLDER[group.id]!.length) : path;
                const cut = said.lastIndexOf('/') + 1;
                return <li key={path}>
                  <button type="button" title={path} aria-label={state ? `${path}, ${STATE_LABEL[state].toLowerCase()}` : path} aria-current={open === path ? 'true' : undefined} onClick={() => onFile(path)}
                    className={cn('flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 max-lg:min-h-11',
                      open === path ? 'bg-primary-50 font-medium text-primary-800 dark:bg-primary-500/10 dark:text-primary-200' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/5')}>
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', open === path ? 'text-primary-600 dark:text-primary-300' : 'text-slate-400')} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono">{cut > 0 && <span className="text-slate-400 dark:text-slate-500">{said.slice(0, cut)}</span>}{said.slice(cut)}</span>
                    {state && <span className={cn('shrink-0 rounded px-1 text-[10px] font-semibold uppercase', state === 'new' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300')}>{STATE_LABEL[state]}</span>}
                  </button>
                </li>;
              })}</ul>
            </section>;
          })}
          {!shown.length && <p className="px-1.5 pt-3 text-sm text-slate-500 dark:text-slate-400">No file matches.</p>}
          {/* What the draft took out of the installed version, each with the way to have it back. */}
          {removed.length > 0 && <section aria-label="Removed in this draft" className="pt-3">
            <h4 className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Removed in this draft</h4>
            <ul>{removed.map(path => <li key={path} className="flex min-h-9 items-center gap-2 px-1.5 text-[13px] text-slate-500 dark:text-slate-400">
              <span title={path} className="min-w-0 flex-1 truncate font-mono line-through">{path}</span>
              {!readOnly && <button type="button" onClick={() => putBack(path)} aria-label={`Put ${path} back`}
                className="inline-flex min-h-7 flex-none cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-300 dark:hover:bg-primary-500/10">
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />Put back</button>}
            </li>)}</ul>
          </section>}
        </div>
        {!readOnly && <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-700">
          {adding
            ? <form onSubmit={submit} className="space-y-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">New file&rsquo;s name
                <input autoFocus aria-describedby="new-source-help" aria-invalid={problem ? true : undefined} value={name} onChange={event => { setName(event.target.value); setProblem(''); }} placeholder="pages/about.html"
                  // Escape leaves the name, not the dialog around the pane.
                  onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setAdding(false); setName(''); setProblem(''); } }}
                  className="mt-1 min-h-10 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white" />
              </label>
              <p id="new-source-help" role={problem ? 'alert' : undefined} className={cn('text-xs leading-5', problem ? 'text-red-700 dark:text-red-300' : 'text-slate-500 dark:text-slate-400')}>
                {problem || 'Its ending says what it is: .html a page, .js logic, .css styles.'}
              </p>
              <div className="flex gap-2"><Button type="submit" size="sm">Add file</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setName(''); setProblem(''); }}>Cancel</Button></div>
            </form>
            : <div className="flex flex-col gap-1">
              <Button size="sm" variant="ghost" className="justify-start" leftIcon={<FilePlus2 className="h-4 w-4" />} onClick={() => setAdding(true)}>New file</Button>
              {/* A change to the database is a new numbered file that the manifest lists: both in one step. */}
              {hasDatabase(project.files) && <Button size="sm" variant="ghost" className="justify-start" leftIcon={<Database className="h-4 w-4" />} onClick={() => add(nextMigrationPath(project.files, installed))}>New database change</Button>}
            </div>}
        </div>}
      </nav>
    </div>
    {open
      ? <NativeSourceEditor appId={appId} file={open} height={EDITOR_HEIGHT}
        label={{ backend: 'Private backend source', migrations: 'Private backend source', project: 'Project file source', pages: 'Interface source', logic: 'Interface source', styles: 'Interface source' }[sourceGroupOf(open)]}
        readOnly={readOnly || lock !== null} value={project.files[open] ?? ''} onChange={value => onEdit({ ...project, files: { ...project.files, [open]: value } })}
        note={strayed
          ? 'This change has already run on the app’s database, and this draft holds a different copy of it. It cannot be published like this: put the installed copy back.'
          : lock ?? (open === 'manifest.json' ? 'The manifest names the first page, and the backend’s routes and database changes. It is checked when you publish.' : undefined)}
        actions={readOnly ? undefined
          // A copy that cannot be typed in or removed has one repair: the copy that ran.
          : strayed ? <button type="button" onClick={() => putBack(open)} aria-label={`Put the installed copy of ${open} back`}
            className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-300 dark:hover:bg-primary-500/10">
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />Put the installed copy back</button>
          : !removeProblem ? <button type="button" onClick={remove} aria-label={`Remove ${open}`} title="Remove this file from the project"
            className="inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-400 dark:hover:bg-red-500/10 dark:hover:text-red-300">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove</button> : undefined} />
      : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">This project has no source files yet.</p>}
  </div>;
}
