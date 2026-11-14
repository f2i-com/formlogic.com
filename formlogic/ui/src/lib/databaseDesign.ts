// A database designed in FormLogic's database designer (components/design): the tables an app keeps,
// the details of each, how they are connected, and what the app's page may do with each. From it
// come the backend's first migration (server/migrations/001.sql), its API (server/main.logic and
// the manifest's routes) and its server block: a backend added to an app that has none, through
// softnBackend.withBackend, so the same checks hold as for any other backend.
//
// What is made keeps to what the SoftN runner allows (apps/softn-runner host/src/sql.rs and the
// backend guide): a migration of CREATE TABLE and CREATE INDEX only, calling no function a request
// may not (the one clock call is a column's default); routes at exact /api/ paths, one per method;
// handlers that check what they are sent and every row a write names before writing, since a
// statement that fails answers 500.
import { STARTER_ORIGIN, type SoftnBackend } from './softnBackend';

/** What a detail holds: each kind is a column type, with the checks the database and the API make. */
export type FieldKind = 'text' | 'longText' | 'integer' | 'decimal' | 'boolean' | 'date' | 'dateTime' | 'email' | 'url' | 'choice';

export interface DesignField {
  id: string;
  /** The column's name: lowercase letters, digits and _, starting with a letter. */
  name: string;
  kind: FieldKind;
  required: boolean;
  /** No two rows may have the same value (empty ones aside). */
  unique: boolean;
  /** The value a new row takes when it is given none; '' for none. Yes/no: 'yes' or 'no'. */
  defaultValue: string;
  /** The values a choice may take, in order. */
  choices: string[];
}

/** What happens to the rows that belong to a row when that row is removed. */
export type OnDelete = 'cascade' | 'setNull' | 'restrict';

/** Each row of `from` belongs to one row of `to`: its column `column` holds that row's id. */
export interface DesignLink {
  id: string;
  from: string;
  to: string;
  column: string;
  required: boolean;
  onDelete: OnDelete;
  /** One to one: each row of `to` has at most one row of `from` (a profile of a user); the column is UNIQUE. */
  unique?: boolean;
}

/** What the app's page may do with a table through its API. The owner changes every row in the Data tab whatever this says. */
export interface DesignApi { read: boolean; add: boolean; change: boolean; remove: boolean }

export interface DesignTable {
  id: string;
  name: string;
  fields: DesignField[];
  /** Keeps when each row was added, in created_at. */
  stamped: boolean;
  /** Each combination of the rows it connects at most once (a table that joins two others). */
  uniqueLinks: boolean;
  api: DesignApi;
  /** Where the table sits in the diagram, once someone has moved it there. */
  at?: { x: number; y: number };
}

export interface DatabaseDesign { version: 1; tables: DesignTable[]; links: DesignLink[] }

export const EMPTY_DESIGN: DatabaseDesign = Object.freeze({ version: 1, tables: [], links: [] }) as DatabaseDesign;

export const FIELD_KINDS: readonly { kind: FieldKind; label: string; hint: string }[] = [
  { kind: 'text', label: 'Text', hint: 'A name, a title, a short answer' },
  { kind: 'longText', label: 'Long text', hint: 'A description, a note, a message' },
  { kind: 'integer', label: 'Whole number', hint: 'A count or a quantity' },
  { kind: 'decimal', label: 'Number', hint: 'A price, a weight, a score' },
  { kind: 'boolean', label: 'Yes or no', hint: 'Done, paid, published' },
  { kind: 'date', label: 'Date', hint: 'A day: 2026-01-31' },
  { kind: 'dateTime', label: 'Date and time', hint: 'A moment: 2026-01-31 09:30' },
  { kind: 'email', label: 'Email address', hint: 'Checked to look like one' },
  { kind: 'url', label: 'Web address', hint: 'Starting http:// or https://' },
  { kind: 'choice', label: 'One of a list', hint: 'A status, a size, a category' },
];

export const KIND_LABEL: Record<FieldKind, string> = Object.fromEntries(FIELD_KINDS.map(entry => [entry.kind, entry.label])) as Record<FieldKind, string>;

/** What removing a row (`owner`, one row in words) does to the rows that belong to it (`rows`, in words). */
export const ON_DELETE_LABEL: Record<OnDelete, (owner: string, rows: string) => string> = {
  cascade: (_owner, rows) => `Remove its ${rows} too`,
  setNull: (owner, rows) => `Keep its ${rows}, without ${article(owner)}`,
  restrict: (_owner, rows) => `Don’t allow it while it has ${rows}`,
};

/** The most a design may hold: well past any app the designer is for. */
export const DESIGN_LIMITS = Object.freeze({ tables: 40, fieldsPerTable: 60, choices: 50, choiceLength: 100, nameLength: 40 });

// SQLite's keywords (sqlite.org/lang_keywords.html) and its own names for a row's number: none
// may name a table or a column here, so what is made never needs a name quoted.
const SQL_WORDS = new Set(('abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade '
  + 'case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database '
  + 'default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail '
  + 'filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner '
  + 'insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of '
  + 'offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex '
  + 'release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction '
  + 'trigger unbounded union unique update using vacuum values view virtual when where window with without rowid oid _rowid_').split(' '));

/** A word suggested in place of an SQL word people often reach for. */
// None of them is a word the database keeps (groups is one, since window frames: so groupings).
const INSTEAD: Record<string, string> = { order: 'orders', group: 'groupings', from: 'starts', to: 'ends', key: 'code', index: 'position', table: 'tables', values: 'amounts', check: 'checks', default: 'standard' };

let counter = 0;
/** An id for a part of a design: only the designer reads it. */
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Letters a name may have from another language that do not come apart into a plain letter and its mark.
const SPELLED: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** A name as a column or table may have it: "Due date" is due_date, "Straße" strasse. */
export function cleanName(text: string): string {
  const spelled = text.toLowerCase().replace(/[ßæœøłđðþı]/g, letter => SPELLED[letter]);
  return spelled.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, DESIGN_LIMITS.nameLength);
}

/** Why a name cannot be one, or null when it can. `what` is 'table' or 'detail'. */
export function nameProblem(name: string, what: 'table' | 'detail' | 'connection'): string | null {
  if (!name) return `Give the ${what} a name.`;
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return 'A name is lowercase letters, digits and _, and starts with a letter.';
  if (name.length > DESIGN_LIMITS.nameLength) return `Keep a name to ${DESIGN_LIMITS.nameLength} characters.`;
  if (name.startsWith('sqlite_')) return 'Names starting sqlite_ are the database’s own.';
  // The runner reads no table so named at request time (its PRAGMA functions and dbstat).
  if (name.startsWith('pragma_') || name === 'dbstat') return 'Names like this are the database’s own.';
  if (SQL_WORDS.has(name)) return `“${name}” is a word the database keeps for itself${INSTEAD[name] ? `: try “${INSTEAD[name]}”` : ''}.`;
  // Every JavaScript object has one: the API's code would read it for a detail the page left out.
  if (name === 'constructor') return '“constructor” is a word the API’s code keeps for itself.';
  return null;
}

const IRREGULAR: Record<string, string> = {
  people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot', criteria: 'criterion',
  analyses: 'analysis', news: 'news', series: 'series', species: 'species', status: 'status', address: 'address',
  // The words whose f is a v before the s (other words in -ves, moves and archives, only add the s).
  shelves: 'shelf', knives: 'knife', leaves: 'leaf', lives: 'life', wives: 'wife', halves: 'half', wolves: 'wolf', calves: 'calf', loaves: 'loaf', thieves: 'thief', selves: 'self',
};

/** One of a table's rows, in words: customers → customer, categories → category, order_lines → order_line. */
export function singular(name: string): string {
  const at = name.lastIndexOf('_') + 1;
  const [lead, last] = [name.slice(0, at), name.slice(at)];
  if (IRREGULAR[last]) return lead + IRREGULAR[last];
  if (/ies$/.test(last) && last.length > 4) return `${lead}${last.slice(0, -3)}y`;
  if (/(ss|us|x|ch|sh)es$/.test(last)) return lead + last.slice(0, -2);
  if (/s$/.test(last) && !/(ss|us|is)$/.test(last) && last.length > 2) return lead + last.slice(0, -1);
  return name;
}

/** A name in words: order_items is "order items". */
export function words(name: string): string { return name.replace(/_/g, ' '); }

function article(name: string): string { return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`; }

// Both are asked of names still being typed (the routes are shown as the design changes): an empty name is ''.
function pascal(name: string): string { return name.split('_').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(''); }

function camel(name: string): string { const value = pascal(name); return value ? value[0].toLowerCase() + value.slice(1) : ''; }

export function newField(name = '', kind: FieldKind = 'text'): DesignField {
  return { id: newId(), name, kind, required: false, unique: false, defaultValue: '', choices: kind === 'choice' ? ['first', 'second'] : [] };
}

/** What the page may do with a new table: everything in an app only invited members open, reading and adding in one anyone may. */
export function defaultApi(access: 'members' | 'application' | undefined): DesignApi {
  return access === 'application' ? { read: true, add: true, change: false, remove: false } : { read: true, add: true, change: true, remove: true };
}

export function newTable(name: string, access?: 'members' | 'application'): DesignTable {
  return { id: newId(), name, fields: [], stamped: true, uniqueLinks: false, api: defaultApi(access) };
}

/** The column a link to `to` would be called in `from`, not taken there yet: customers → customer_id, customer_id_2. */
export function linkColumn(design: DatabaseDesign, from: DesignTable, to: DesignTable): string {
  const taken = new Set([...from.fields.map(field => field.name), ...design.links.filter(link => link.from === from.id).map(link => link.column), 'id', 'created_at']);
  return fixName(`${singular(to.name || 'row').slice(0, DESIGN_LIMITS.nameLength - 3)}_id`, taken);
}

/**
 * A link from `from` to `to`, named and with what fits its being required. One from a table to
 * itself (a comment that answers a comment) is optional: the first row has none to belong to.
 */
export function newLink(design: DatabaseDesign, from: DesignTable, to: DesignTable, required = true): DesignLink {
  const must = required && from.id !== to.id;
  return { id: newId(), from: from.id, to: to.id, column: linkColumn(design, from, to), required: must, onDelete: must ? 'cascade' : 'setNull' };
}

/**
 * Two tables whose rows can each have many of the other's (products in many orders, orders of
 * many products): a table that joins them, whose rows each name one of each, at most once.
 */
export function withJoin(design: DatabaseDesign, a: DesignTable, b: DesignTable, access?: 'members' | 'application'): DatabaseDesign {
  const name = fixName(`${a.name}_${b.name}`, new Set(design.tables.map(table => table.name)));
  const join: DesignTable = { ...newTable(name, access), uniqueLinks: true, api: { read: true, add: true, change: false, remove: true } };
  let next: DatabaseDesign = { ...design, tables: [...design.tables, join] };
  next = { ...next, links: [...next.links, newLink(next, join, a)] };
  next = { ...next, links: [...next.links, newLink(next, join, b)] };
  return next;
}

/** A table that keeps each combination once needs two connections: with fewer, it no longer says so. */
function withPairsKept(design: DatabaseDesign): DatabaseDesign {
  return { ...design, tables: design.tables.map(table => table.uniqueLinks && design.links.filter(link => link.from === table.id).length < 2 ? { ...table, uniqueLinks: false } : table) };
}

/** A design without one of its tables, and every link to or from it. */
export function withoutTable(design: DatabaseDesign, id: string): DatabaseDesign {
  return withPairsKept({ ...design, tables: design.tables.filter(table => table.id !== id), links: design.links.filter(link => link.from !== id && link.to !== id) });
}

/** A design without one of its connections. */
export function withoutLink(design: DatabaseDesign, id: string): DatabaseDesign {
  return withPairsKept({ ...design, links: design.links.filter(link => link.id !== id) });
}

export function tableById(design: DatabaseDesign, id: string): DesignTable | undefined { return design.tables.find(table => table.id === id); }

// ---------------------------------------------------------------- what is wrong with a design

/** Where a problem is: the step that fixes it and the part it is about. */
export interface DesignProblem { step: 'things' | 'details' | 'connections'; table?: string; field?: string; link?: string; text: string }

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Why a field's default would not be a value of it, or null when it would (or there is none). */
export function defaultProblem(field: DesignField): string | null {
  const value = field.defaultValue.trim();
  if (!value) return null;
  switch (field.kind) {
    case 'integer': return /^-?\d{1,15}$/.test(value) ? null : 'The default must be a whole number.';
    case 'decimal': return /^-?\d{1,15}(\.\d{1,10})?$/.test(value) ? null : 'The default must be a number, such as 9.95.';
    case 'boolean': return value === 'yes' || value === 'no' ? null : 'The default is yes or no.';
    case 'date': return DATE.test(value) ? null : 'Write the default date as 2026-01-31.';
    case 'dateTime': return DATE_TIME.test(value) ? null : 'Write the default as 2026-01-31 09:30.';
    case 'email': return /^[^\s@]+@[^\s@]+$/.test(value) ? null : 'The default must be an email address.';
    case 'url': return /^https?:\/\/\S+$/.test(value) ? null : 'The default must start with http:// or https://.';
    case 'choice': return field.choices.includes(value) ? null : 'The default must be one of the choices.';
    default: return value.length > 1000 ? 'Keep the default to 1000 characters.' : null;
  }
}

/** Everything that stands between a design and a backend made from it, in the order of the steps. */
export function designProblems(design: DatabaseDesign): DesignProblem[] {
  const problems: DesignProblem[] = [];
  if (!design.tables.length) problems.push({ step: 'things', text: 'Add at least one thing for the app to keep.' });
  if (design.tables.length > DESIGN_LIMITS.tables) problems.push({ step: 'things', text: `Keep it to ${DESIGN_LIMITS.tables} tables.` });
  // A name taken twice is said once, of the second: the one to rename.
  const tableNames = new Set<string>();
  for (const table of design.tables) {
    const named = nameProblem(table.name, 'table');
    if (named) problems.push({ step: 'things', table: table.id, text: `${table.name || 'A table'}: ${named}` });
    else if (tableNames.has(table.name)) problems.push({ step: 'things', table: table.id, text: `Two tables are called ${table.name}.` });
    tableNames.add(table.name);
  }
  for (const table of design.tables) {
    const label = table.name || 'A table';
    if (table.fields.length > DESIGN_LIMITS.fieldsPerTable) problems.push({ step: 'details', table: table.id, text: `${label}: keep it to ${DESIGN_LIMITS.fieldsPerTable} details.` });
    // A connection's column is the table's too: a detail may not take its name.
    const columns = new Set<string>(design.links.filter(link => link.from === table.id).map(link => link.column));
    for (const field of table.fields) {
      const where = { step: 'details' as const, table: table.id, field: field.id };
      const named = nameProblem(field.name, 'detail');
      if (named) { problems.push({ ...where, text: `${label}, ${field.name || 'a detail'}: ${named}` }); continue; }
      if (field.name === 'id') problems.push({ ...where, text: `${label}: every row is numbered by its id already; call this detail something else.` });
      else if (field.name === 'created_at' && table.stamped) problems.push({ ...where, text: `${label}: created_at keeps when each row was added; call this detail something else.` });
      else if (columns.has(field.name)) problems.push({ ...where, text: `${label}: two details or connections are called ${field.name}.` });
      columns.add(field.name);
      if (field.kind === 'choice') {
        const choices = field.choices.map(choice => choice.trim());
        if (!choices.length) problems.push({ ...where, text: `${label}, ${field.name}: give at least one choice.` });
        else if (choices.some(choice => !choice)) problems.push({ ...where, text: `${label}, ${field.name}: a choice is empty.` });
        else if (new Set(choices).size !== choices.length) problems.push({ ...where, text: `${label}, ${field.name}: a choice is there twice.` });
        else if (choices.length > DESIGN_LIMITS.choices || choices.some(choice => choice.length > DESIGN_LIMITS.choiceLength)) problems.push({ ...where, text: `${label}, ${field.name}: keep it to ${DESIGN_LIMITS.choices} choices of up to ${DESIGN_LIMITS.choiceLength} characters.` });
      }
      const fallback = defaultProblem(field);
      if (fallback) problems.push({ ...where, text: `${label}, ${field.name}: ${fallback}` });
    }
    const links = design.links.filter(link => link.from === table.id);
    if (table.uniqueLinks && links.length < 2) problems.push({ step: 'connections', table: table.id, text: `${label}: “each combination at most once” needs two connections from it.` });
  }
  for (const link of design.links) {
    const from = tableById(design, link.from);
    const to = tableById(design, link.to);
    const where = { step: 'connections' as const, link: link.id, table: link.from };
    if (!from || !to) { problems.push({ ...where, text: 'A connection is to a table that is no longer there.' }); continue; }
    const named = nameProblem(link.column, 'connection');
    if (named) problems.push({ ...where, text: `${from.name} → ${to.name}: ${named}` });
    else if (link.column === 'id' || (link.column === 'created_at' && from.stamped)) problems.push({ ...where, text: `${from.name} → ${to.name}: ${link.column} is taken; call the connection something else.` });
    if (link.required && link.onDelete === 'setNull') problems.push({ ...where, text: `${from.name} → ${to.name}: every ${words(singular(from.name))} must have ${article(words(singular(to.name)))}, so they cannot be kept without one. Choose what happens when one is removed.` });
    if (link.required && from.id === to.id) problems.push({ ...where, text: `${from.name}: a ${words(singular(from.name))} that belongs to another cannot be required, or the first could never be added. Make it optional.` });
  }
  // Tables that each need a row of the next, round to the first: none could ever be added first.
  for (const cycle of rings(design, link => link.required)) {
    const names = cycle.map(id => tableById(design, id)?.name ?? '?');
    problems.push({ step: 'connections', table: cycle[0], text: `${[...names, names[0]].join(' → ')}: each must have a row of the next, so no row could be added first. Make one of these connections optional.` });
  }
  // Tables that remove each other's rows round in a ring: what a removal would take could not be
  // checked before it is made (a table that removes its own rows, a tree, is checked).
  for (const cycle of rings(design, link => link.onDelete === 'cascade')) {
    const names = cycle.map(id => tableById(design, id)?.name ?? '?');
    problems.push({ step: 'connections', table: cycle[0], text: `${[...names, names[0]].join(' → ')}: removing a row of each removes rows of the next, round to the first. Let one of these connections keep its rows or refuse instead.` });
  }
  for (const table of design.tables) {
    if (rowBytes(design, table) > RESULT_BYTES) problems.push({ step: 'details', table: table.id, text: `${table.name || 'A table'}: its long texts together can hold more than one answer of the API may carry. Use fewer long texts in one table.` });
  }
  return problems;
}

/**
 * The tables that reach each other round a ring of the connections `along` picks (a → b → a),
 * each such group once, in the design's order: the strongly connected groups of two or more
 * (Tarjan's walk, once over every table and connection, however many rings there are).
 */
function rings(design: DatabaseDesign, along: (link: DesignLink) => boolean): string[][] {
  const next = new Map<string, string[]>();
  for (const link of design.links) if (along(link) && link.from !== link.to) next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let counter = 0;
  // Iterative, so a long chain of tables never runs out of call stack.
  for (const root of design.tables.map(table => table.id)) {
    if (order.has(root)) continue;
    const work: { id: string; edge: number }[] = [{ id: root, edge: 0 }];
    order.set(root, counter); low.set(root, counter); counter += 1;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = next.get(frame.id) ?? [];
      if (frame.edge < edges.length) {
        const to = edges[frame.edge];
        frame.edge += 1;
        if (!order.has(to)) {
          order.set(to, counter); low.set(to, counter); counter += 1;
          stack.push(to); onStack.add(to);
          work.push({ id: to, edge: 0 });
        } else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1].id; low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!)); }
      if (low.get(frame.id) === order.get(frame.id)) {
        const group: string[] = [];
        let member: string;
        do { member = stack.pop()!; onStack.delete(member); group.push(member); } while (member !== frame.id);
        if (group.length > 1) groups.push(design.tables.map(table => table.id).filter(id => group.includes(id)));
      }
    }
  }
  return groups;
}

// What one answer of the runner may carry (apps/softn-runner host/src/sql.rs RESULT_LIMIT, 2 MiB),
// with room to spare: a page of a table's rows is held under it, as the longest rows would be.
const RESULT_BYTES = Math.floor(2 * 1024 * 1024 * 0.75);
const TEXT_LONGEST = 1000;
const LONG_TEXT_LONGEST = 20000;

/** The most bytes one row could take in an answer: text of three bytes a character (as Chinese is), and room for the rest. */
function rowBytes(design: DatabaseDesign, table: DesignTable): number {
  let bytes = 96 + 24 * design.links.filter(link => link.from === table.id).length;
  for (const field of table.fields) bytes += field.kind === 'longText' ? LONG_TEXT_LONGEST * 3 : ['text', 'email', 'url', 'choice'].includes(field.kind) ? TEXT_LONGEST * 3 + 16 : 40;
  return bytes;
}

/** The most rows a page of a table's list may have: 200, or fewer where its rows could be long. */
export function pageMost(design: DatabaseDesign, table: DesignTable): number {
  return Math.max(1, Math.min(200, Math.floor(RESULT_BYTES / rowBytes(design, table))));
}

// ---------------------------------------------------------------- what is made of a design

/** The design's tables in the order they are made: each after the tables it names, where it can be. */
function ordered(design: DatabaseDesign): DesignTable[] {
  const done = new Set<string>();
  const out: DesignTable[] = [];
  const visit = (table: DesignTable, path: Set<string>) => {
    if (done.has(table.id) || path.has(table.id)) return;
    path.add(table.id);
    for (const link of design.links) if (link.from === table.id && link.to !== table.id) { const to = tableById(design, link.to); if (to) visit(to, path); }
    done.add(table.id);
    out.push(table);
  };
  for (const table of design.tables) visit(table, new Set());
  return out;
}

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

function columnSql(field: DesignField): string {
  const name = field.name;
  const type = field.kind === 'integer' || field.kind === 'boolean' ? 'INTEGER' : field.kind === 'decimal' ? 'REAL' : 'TEXT';
  const parts = [name, type];
  if (field.required) parts.push('NOT NULL');
  if (field.unique) parts.push('UNIQUE');
  const value = field.defaultValue.trim();
  if (value) {
    if (field.kind === 'boolean') parts.push(`DEFAULT ${value === 'yes' ? 1 : 0}`);
    else if (field.kind === 'integer' || field.kind === 'decimal') parts.push(`DEFAULT ${value}`);
    else parts.push(`DEFAULT ${quote(value)}`);
  } else if (field.kind === 'boolean' && field.required) parts.push('DEFAULT 0');
  // Checks call nothing a request may not (like and glob are on its list): a row the owner adds
  // in the Data tab is held to them as one the API adds is.
  switch (field.kind) {
    case 'boolean': parts.push(`CHECK (${name} IN (0, 1))`); break;
    case 'choice': parts.push(`CHECK (${name} IN (${field.choices.map(choice => quote(choice.trim())).join(', ')}))`); break;
    case 'email': parts.push(`CHECK (${name} LIKE '%_@_%')`); break;
    case 'url': parts.push(`CHECK (${name} LIKE 'http://%' OR ${name} LIKE 'https://%')`); break;
    case 'date': parts.push(`CHECK (${name} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`); break;
    case 'dateTime': parts.push(`CHECK (${name} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]*')`); break;
    default: break;
  }
  return parts.join(' ');
}

const ON_DELETE_SQL: Record<OnDelete, string> = { cascade: 'CASCADE', setNull: 'SET NULL', restrict: 'RESTRICT' };

/** The first migration: every table, and an index on each connection, so a row's rows are found at once. */
export function migrationSql(design: DatabaseDesign): string {
  const statements: string[] = [];
  for (const table of ordered(design)) {
    const lines = ['id INTEGER PRIMARY KEY', ...table.fields.map(columnSql)];
    const links = design.links.filter(link => link.from === table.id);
    for (const link of links) {
      const to = tableById(design, link.to);
      if (to) lines.push(`${link.column} INTEGER${link.required ? ' NOT NULL' : ''}${link.unique ? ' UNIQUE' : ''} REFERENCES ${to.name}(id) ON DELETE ${ON_DELETE_SQL[link.onDelete]}`);
    }
    if (table.stamped) lines.push("created_at TEXT NOT NULL DEFAULT (datetime('now'))");
    if (table.uniqueLinks && links.length >= 2) lines.push(`UNIQUE (${links.map(link => link.column).join(', ')})`);
    statements.push(`CREATE TABLE ${table.name} (\n  ${lines.join(',\n  ')}\n);`);
    // A unique pair has its own index already, led by its first column.
    // A one-to-one connection's UNIQUE has an index of its own already.
    for (const [index, link] of links.entries()) if (!(table.uniqueLinks && links.length >= 2 && index === 0) && !link.unique) statements.push(`CREATE INDEX ${table.name}_${link.column} ON ${table.name}(${link.column});`);
  }
  return `${statements.join('\n\n')}\n`;
}

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface DesignRoute { table: string; method: RouteMethod; path: string; handler: string; does: string }

interface Names { list: string; add: string; change: string; remove: string; fields: string }

/**
 * Each table's handler names, every one unique in the code: two tables with one singular (box and
 * boxes) take their table's name, and any name still taken (list and fields make listFields twice;
 * item_2 and item2 are both Item2) takes a number.
 */
function handlerNames(design: DatabaseDesign): Map<string, Names> {
  const out = new Map<string, Names>();
  const used = new Set<string>(['wholeNumber', 'decimalNumber', 'isDigits', 'isDate', 'isDateTime', 'paging', 'rowFrom', 'checkValue']);
  const claim = (...wanted: string[]) => {
    let name = wanted.find(candidate => !used.has(candidate)) ?? wanted[0];
    for (let n = 2; used.has(name); n += 1) name = `${wanted[0]}${n}`;
    used.add(name);
    return name;
  };
  for (const table of design.tables) {
    const all = pascal(table.name) || 'Table';
    const one = pascal(singular(table.name)) || all;
    out.set(table.id, {
      list: claim(`list${all}`), add: claim(`add${one}`, `addTo${all}`), change: claim(`change${one}`, `changeIn${all}`),
      remove: claim(`remove${one}`, `removeFrom${all}`), fields: claim(`${camel(table.name) || 'table'}Fields`),
    });
  }
  return out;
}

/**
 * What would stop a row of `table` being removed, each checked first (a removal the database
 * refuses answers 500): rows that may not lose it, and rows that may not lose a row its removal
 * takes with it, down the connections that remove their rows too.
 */
function removalChecks(design: DatabaseDesign, table: DesignTable): { sql: string; message: string }[] {
  const one = words(singular(table.name));
  const checks: { sql: string; message: string }[] = [];
  const names = new Set(design.tables.map(other => other.name));
  let trees = 0;
  // The ids of `current`'s rows a removal takes: `seed` (SQL selecting some), and, where the table
  // removes its own rows (a tree: categories within categories), every row below them.
  const closure = (current: DesignTable, seed: string): string => {
    const own = design.links.filter(link => link.from === current.id && link.to === current.id && link.onDelete === 'cascade');
    if (!own.length) return seed;
    let name = '';
    do { trees += 1; name = `gone_${trees}`; } while (names.has(name));
    const down = own.map(link => `SELECT ${current.name}.id FROM ${current.name} JOIN ${name} ON ${current.name}.${link.column} = ${name}.id`).join(' UNION ');
    return `WITH RECURSIVE ${name}(id) AS (${seed} UNION ${down}) SELECT id FROM ${name}`;
  };
  // `rows`: SQL whose every ? is the removed row's id, selecting the ids of `current`'s rows it takes.
  const visit = (current: DesignTable, rows: string, path: string[]) => {
    for (const link of design.links.filter(other => other.to === current.id)) {
      const from = tableById(design, link.from);
      if (!from || (link.from === current.id && link.onDelete === 'cascade')) continue;
      const where = rows === 'SELECT ?' ? `${link.column} = ?` : `${link.column} IN (${rows})`;
      if (link.onDelete === 'restrict') {
        // A row of the same table refuses only when it is not itself taken.
        const itself = link.from === current.id && rows !== 'SELECT ?' ? ` AND id NOT IN (${rows})` : '';
        checks.push({ sql: `SELECT id FROM ${from.name} WHERE ${where}${itself} LIMIT 1`, message: path.length === 1 ? `This ${one} still has ${words(from.name)}: remove those first` : `This ${one} still has ${words(from.name)}, through its ${words(current.name)}: remove those first` });
      } else if (link.onDelete === 'cascade' && !path.includes(from.id) && path.length < 12) {
        visit(from, closure(from, `SELECT id FROM ${from.name} WHERE ${where}`), [...path, from.id]);
      }
    }
  };
  visit(table, closure(table, 'SELECT ?'), [table.id]);
  return checks;
}

/** The arguments of a check: the removed row's id, once for each ? in its SQL. */
function idFor(sql: string): string {
  return Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'id').join(', ');
}

/** What a table can be changed in: a table with nothing but its id and its date has nothing to change. */
function changeable(design: DatabaseDesign, table: DesignTable): boolean {
  return table.fields.length > 0 || design.links.some(link => link.from === table.id);
}

/** The routes the design's API serves, in order: what the manifest lists and the review shows. */
export function designRoutes(design: DatabaseDesign): DesignRoute[] {
  const names = handlerNames(design);
  const routes: DesignRoute[] = [];
  for (const table of design.tables) {
    const handler = names.get(table.id)!;
    const path = `/api/${table.name}`;
    const one = words(singular(table.name));
    if (table.api.read) routes.push({ table: table.id, method: 'GET', path, handler: handler.list, does: `Lists ${words(table.name)}; ?id= reads one` });
    if (table.api.add) routes.push({ table: table.id, method: 'POST', path, handler: handler.add, does: `Adds ${article(one)}` });
    if (table.api.change && changeable(design, table)) routes.push({ table: table.id, method: 'PUT', path, handler: handler.change, does: `Changes ${article(one)}, by its id` });
    if (table.api.remove) routes.push({ table: table.id, method: 'DELETE', path, handler: handler.remove, does: `Removes ${article(one)}, by its id` });
  }
  return routes;
}

const js = (value: unknown) => JSON.stringify(value);

/** The JavaScript value a field takes when a new row is given none. */
function fallbackOf(field: DesignField): string {
  const value = field.defaultValue.trim();
  if (!value) return field.kind === 'boolean' && field.required ? '0' : 'null';
  if (field.kind === 'boolean') return value === 'yes' ? '1' : '0';
  if (field.kind === 'integer' || field.kind === 'decimal') return String(Number(value));
  return js(value);
}

/** The backend's code: a handler for each route, and the few functions they share. */
export function backendLogic(design: DatabaseDesign): string {
  const names = handlerNames(design);
  const routes = designRoutes(design);
  const out: string[] = [
    '// The API of this app\'s database, made by FormLogic\'s database designer. It is yours to change:',
    '// the designer does not read it back. Every route is listed in manifest.json. Each answers JSON:',
    '// a list as {rows}, one row as {row}, a refusal as {error} with a 4xx status.',
  ];
  for (const table of design.tables) {
    const handler = names.get(table.id)!;
    const served = routes.filter(route => route.table === table.id);
    if (!served.length) continue;
    const one = words(singular(table.name));
    const links = design.links.filter(link => link.from === table.id);
    const fields = [
      // Written as true or false whatever the design holds: nothing of it reaches the code unformed.
      ...table.fields.map(field => `    {name: ${js(field.name)}, kind: ${js(field.kind)}, required: ${field.required === true}, fallback: ${fallbackOf(field)}${field.kind === 'choice' ? `, choices: ${js(field.choices.map(choice => choice.trim()))}` : ''}}`),
      ...links.map(link => `    {name: ${js(link.column)}, kind: "link", required: ${link.required === true}, fallback: null}`),
    ];
    const columns = [...table.fields.map(field => field.name), ...links.map(link => link.column)];
    // Checks a write makes before it writes: every row it names is there, and nothing unique is taken.
    const checks = (changing: boolean): string[] => {
      const lines: string[] = [];
      for (const link of links) {
        const to = tableById(design, link.to);
        if (!to) continue;
        const named = `softn.sql.first(${js(`SELECT id FROM ${to.name} WHERE id = ?`)}, [values[${js(link.column)}]])`;
        lines.push(`  if (${link.required ? '' : `values[${js(link.column)}] !== null && `}!${named}) return {status: 422, body: {error: ${js(`${link.column}: there is no ${words(singular(to.name))} with that id`)}}};`);
      }
      for (const field of table.fields.filter(field => field.unique)) {
        const sql = `SELECT id FROM ${table.name} WHERE ${field.name} = ?${changing ? ' AND id <> ?' : ''}`;
        lines.push(`  if (values[${js(field.name)}] !== null && softn.sql.first(${js(sql)}, [values[${js(field.name)}]${changing ? ', id' : ''}])) return {status: 409, body: {error: ${js(`${field.name}: another ${one} has it already`)}}};`);
      }
      for (const link of links.filter(link => link.unique)) {
        const to = tableById(design, link.to);
        const sql = `SELECT id FROM ${table.name} WHERE ${link.column} = ?${changing ? ' AND id <> ?' : ''}`;
        lines.push(`  if (values[${js(link.column)}] !== null && softn.sql.first(${js(sql)}, [values[${js(link.column)}]${changing ? ', id' : ''}])) return {status: 409, body: {error: ${js(`${link.column}: that ${words(singular(to?.name ?? 'row'))} has ${article(one)} already`)}}};`);
      }
      if (table.uniqueLinks && links.length >= 2) {
        const sql = `SELECT id FROM ${table.name} WHERE ${links.map(link => `${link.column} = ?`).join(' AND ')}${changing ? ' AND id <> ?' : ''}`;
        lines.push(`  if (softn.sql.first(${js(sql)}, [${links.map(link => `values[${js(link.column)}]`).join(', ')}${changing ? ', id' : ''}])) return {status: 409, body: {error: ${js(`That combination is in ${words(table.name)} already`)}}};`);
      }
      return lines;
    };
    out.push('', `// ---------------------------------------------------------------- ${table.name}`, '', `function ${handler.fields}() {`, '  return [', fields.join(',\n'), '  ];', '}');
    if (served.some(route => route.method === 'GET')) {
      const filters = links.map(link => [
        `  if (query[${js(link.column)}] !== undefined) {`,
        `    let by = wholeNumber(query[${js(link.column)}]);`,
        `    if (by === null) return {status: 422, body: {error: ${js(`${link.column} must be a whole number`)}}};`,
        `    return {status: 200, body: {rows: softn.sql.query(${js(`SELECT * FROM ${table.name} WHERE ${link.column} = ? ORDER BY id DESC LIMIT ? OFFSET ?`)}, [by, page.limit, page.offset])}};`,
        '  }',
      ].join('\n'));
      const most = pageMost(design, table);
      out.push('', `// GET /api/${table.name}: the newest first, ${Math.min(50, most)} at a time (?limit= up to ${most}, ?offset=)${links.length ? `; ?${links[0].column}= lists those of one` : ''}. ?id= reads one.`,
        `function ${handler.list}(req) {`,
        '  let query = req.query || {};',
        '  if (query.id !== undefined) {',
        '    let id = wholeNumber(query.id);',
        '    if (id === null) return {status: 422, body: {error: "id must be a whole number"}};',
        `    let row = softn.sql.first(${js(`SELECT * FROM ${table.name} WHERE id = ?`)}, [id]);`,
        `    if (!row) return {status: 404, body: {error: ${js(`There is no ${one} with that id`)}}};`,
        '    return {status: 200, body: {row: row}};',
        '  }',
        `  let page = paging(query, ${pageMost(design, table)});`,
        '  if (page.error) return {status: 422, body: {error: page.error}};',
        ...filters,
        `  return {status: 200, body: {rows: softn.sql.query(${js(`SELECT * FROM ${table.name} ORDER BY id DESC LIMIT ? OFFSET ?`)}, [page.limit, page.offset])}};`,
        '}');
    }
    if (served.some(route => route.method === 'POST')) {
      const insert = columns.length
        ? `  let made = softn.sql.execute(${js(`INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)}, [${columns.map(column => `values[${js(column)}]`).join(', ')}]);`
        : `  let made = softn.sql.execute(${js(`INSERT INTO ${table.name} DEFAULT VALUES`)}, []);`;
      out.push('', `// POST /api/${table.name}: adds ${article(one)} from the body's ${columns.length ? 'fields' : 'nothing'}, and answers it with its id.`,
        `function ${handler.add}(req) {`,
        `  let row = rowFrom(req.body || {}, ${handler.fields}(), null);`,
        '  if (row.error) return {status: 422, body: {error: row.error}};',
        '  let values = row.values;',
        ...checks(false),
        insert,
        `  return {status: 201, body: {row: softn.sql.first(${js(`SELECT * FROM ${table.name} WHERE id = ?`)}, [made.lastInsertRowid])}};`,
        '}');
    }
    if (served.some(route => route.method === 'PUT')) {
      out.push('', `// PUT /api/${table.name}: changes the ${one} the body's id names; what the body leaves out stays as it is.`,
        `function ${handler.change}(req) {`,
        '  let body = req.body || {};',
        '  let id = wholeNumber(body.id);',
        `  if (id === null) return {status: 422, body: {error: ${js(`Give the id of the ${one} to change`)}}};`,
        `  let current = softn.sql.first(${js(`SELECT * FROM ${table.name} WHERE id = ?`)}, [id]);`,
        `  if (!current) return {status: 404, body: {error: ${js(`There is no ${one} with that id`)}}};`,
        `  let row = rowFrom(body, ${handler.fields}(), current);`,
        '  if (row.error) return {status: 422, body: {error: row.error}};',
        '  let values = row.values;',
        ...checks(true),
        `  softn.sql.execute(${js(`UPDATE ${table.name} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE id = ?`)}, [${columns.map(column => `values[${js(column)}]`).join(', ')}, id]);`,
        `  return {status: 200, body: {row: softn.sql.first(${js(`SELECT * FROM ${table.name} WHERE id = ?`)}, [id])}};`,
        '}');
    }
    if (served.some(route => route.method === 'DELETE')) {
      // Rows that may not lose this one, or a row its removal takes with it, say so first.
      const holds = removalChecks(design, table).map(check => `  if (softn.sql.first(${js(check.sql)}, [${idFor(check.sql)}])) return {status: 409, body: {error: ${js(check.message)}}};`);
      const goes = design.links.filter(link => link.to === table.id && link.onDelete === 'cascade').map(link => words(tableById(design, link.from)?.name ?? ''));
      out.push('', `// DELETE /api/${table.name}?id=: removes that ${one}${goes.length ? `, and its ${goes.join(' and ')} with it` : ''}.`,
        `function ${handler.remove}(req) {`,
        '  let id = wholeNumber((req.query || {}).id);',
        '  if (id === null) id = wholeNumber((req.body || {}).id);',
        `  if (id === null) return {status: 422, body: {error: ${js(`Give the id of the ${one} to remove`)}}};`,
        `  if (!softn.sql.first(${js(`SELECT id FROM ${table.name} WHERE id = ?`)}, [id])) return {status: 404, body: {error: ${js(`There is no ${one} with that id`)}}};`,
        ...holds,
        `  softn.sql.execute(${js(`DELETE FROM ${table.name} WHERE id = ?`)}, [id]);`,
        '  return {status: 200, body: {removed: id}};',
        '}');
    }
  }
  out.push('', '// ---------------------------------------------------------------- what the routes share', '', SHARED);
  return `${out.join('\n')}\n`;
}

// The functions the handlers share: plain JavaScript, no regular expressions, for the runner's engine.
const SHARED = `// A whole number from a number or its digits (a query's values are text), or null. Never one past
// 2^53 - 1 either way: the database is not handed a number it cannot keep exactly.
function wholeNumber(value) {
  if (typeof value === "number") return Math.floor(value) === value && Math.abs(value) <= 9007199254740991 ? value : null;
  if (typeof value !== "string" || value.length === 0 || value.length > 17) return null;
  let start = value.charAt(0) === "-" ? 1 : 0;
  if (start === value.length) return null;
  for (let i = start; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  let number = Number(value);
  return Math.abs(number) <= 9007199254740991 ? number : null;
}

// A number from a number or its digits (9.95, -3, 12), or null; none past a thousand million million.
function decimalNumber(value) {
  let number = null;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && value.length > 0 && value.length <= 32) {
    let start = value.charAt(0) === "-" ? 1 : 0;
    let digits = 0;
    let points = 0;
    for (let i = start; i < value.length; i++) {
      let code = value.charCodeAt(i);
      if (code === 46) points++;
      else if (code >= 48 && code <= 57) digits++;
      else return null;
    }
    if (digits > 0 && points <= 1) number = Number(value);
  }
  return number !== null && isFinite(number) && Math.abs(number) <= 1000000000000000 ? number : null;
}

function isDigits(text, from, to) {
  for (let i = from; i < to; i++) {
    let code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

// 2026-01-31
function isDate(text) {
  if (text.length !== 10 || text.charAt(4) !== "-" || text.charAt(7) !== "-") return false;
  if (!isDigits(text, 0, 4) || !isDigits(text, 5, 7) || !isDigits(text, 8, 10)) return false;
  let month = Number(text.substring(5, 7));
  let day = Number(text.substring(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// 2026-01-31 09:30, or with seconds, or a T between the two
function isDateTime(text) {
  if (text.length !== 16 && text.length !== 19) return false;
  let between = text.charAt(10);
  if (!isDate(text.substring(0, 10)) || (between !== " " && between !== "T") || text.charAt(13) !== ":") return false;
  if (!isDigits(text, 11, 13) || !isDigits(text, 14, 16) || Number(text.substring(11, 13)) > 23 || Number(text.substring(14, 16)) > 59) return false;
  return text.length === 16 || (text.charAt(16) === ":" && isDigits(text, 17, 19) && Number(text.substring(17, 19)) <= 59);
}

// ?limit= and ?offset= of a list
// ?limit= and ?offset= of a list. most: the rows one answer can carry, as long as this table's rows may be.
function paging(query, most) {
  let limit = query.limit === undefined ? (most < 50 ? most : 50) : wholeNumber(query.limit);
  let offset = query.offset === undefined ? 0 : wholeNumber(query.offset);
  if (limit === null || limit < 1 || limit > most) return {error: "limit must be a whole number from 1 to " + most};
  if (offset === null || offset < 0) return {error: "offset must be a whole number, 0 or more"};
  return {limit: limit, offset: offset};
}

// The values of a row from what the page sent: a new row (current null) takes each detail's
// default where it was sent none; a changed one keeps what it has, as it is.
function rowFrom(body, fields, current) {
  let values = {};
  for (let i = 0; i < fields.length; i++) {
    let field = fields[i];
    let given = body[field.name];
    if (given === undefined && current) {
      values[field.name] = current[field.name];
      continue;
    }
    if (given === undefined) given = field.fallback;
    if (given === null || given === "") {
      if (field.required) return {error: field.name + " is required"};
      values[field.name] = null;
      continue;
    }
    let checked = checkValue(field, given);
    if (checked.error) return {error: field.name + " " + checked.error};
    values[field.name] = checked.value;
  }
  return {values: values};
}

function checkValue(field, value) {
  let kind = field.kind;
  if (kind === "integer" || kind === "link") {
    let number = wholeNumber(value);
    return number === null ? {error: "must be a whole number"} : {value: number};
  }
  if (kind === "decimal") {
    let number = decimalNumber(value);
    return number === null ? {error: "must be a number"} : {value: number};
  }
  if (kind === "boolean") {
    if (value === true || value === 1 || value === "1" || value === "true" || value === "yes") return {value: 1};
    if (value === false || value === 0 || value === "0" || value === "false" || value === "no") return {value: 0};
    return {error: "must be true or false"};
  }
  if (typeof value !== "string") return {error: "must be text"};
  if (value.length > (kind === "longText" ? 20000 : 1000)) return {error: "is too long"};
  if (kind === "email") {
    let at = value.indexOf("@");
    if (at < 1 || at === value.length - 1 || value.indexOf(" ") >= 0 || value.indexOf("@", at + 1) >= 0) return {error: "must be an email address"};
  }
  if (kind === "url" && value.substring(0, 7) !== "http://" && value.substring(0, 8) !== "https://") return {error: "must start with http:// or https://"};
  if (kind === "date" && !isDate(value)) return {error: "must be a date written 2026-01-31"};
  if (kind === "dateTime" && !isDateTime(value)) return {error: "must be a date and time written 2026-01-31 09:30"};
  if (kind === "choice" && field.choices.indexOf(value) < 0) return {error: "must be one of: " + field.choices.join(", ")};
  return {value: value};
}`;

/**
 * The backend a design makes: its server block, where the page calls it, and its two files. A
 * design with anything to fix is refused here too, whatever let it through: its names and defaults
 * are written into SQL and code only once designProblems has passed them.
 */
export function designedBackend(design: DatabaseDesign): SoftnBackend {
  const problems = designProblems(design);
  if (problems.length) throw new Error(problems[0].text);
  return {
    server: {
      entry: 'server/main.logic',
      requires: { apiVersion: 1, capabilities: ['sql'] },
      database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
      routes: designRoutes(design).map(route => ({ path: route.path, method: route.method, handler: route.handler, transaction: route.method === 'GET' ? 'read' : 'write', authorization: 'anonymous' })),
    },
    config: { server: { allowedOrigins: [STARTER_ORIGIN] } },
    files: { 'server/main.logic': backendLogic(design), 'server/migrations/001.sql': migrationSql(design) },
  };
}

// ---------------------------------------------------------------- designs from elsewhere

/** A name from another database or diagram as one here: OrderLines, "Order Lines" and ORDER_LINES are order_lines. */
export function snakeName(text: string): string {
  return cleanName(text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2'));
}

/**
 * A name that can be one and is not in `taken`, made from one that may not be: one that starts
 * with a digit takes t_ before it, a word the database keeps for itself becomes the word suggested
 * for it (order is orders) or takes _value, and a name taken takes _2, _3.
 */
export function fixName(name: string, taken: ReadonlySet<string>): string {
  let base = name || 'unnamed';
  if (!/^[a-z]/.test(base)) base = `t_${base}`;
  if (base.startsWith('sqlite_')) base = `my_${base}`;
  base = base.slice(0, DESIGN_LIMITS.nameLength);
  // A table of orders or groups is called that; any other word keeps its meaning with _value after it.
  if (base.startsWith('pragma_')) base = `my_${base}`.slice(0, DESIGN_LIMITS.nameLength);
  if (SQL_WORDS.has(base)) base = base === 'order' || base === 'group' ? INSTEAD[base] : `${base}_value`;
  if (base === 'dbstat' || base === 'constructor') base = `${base}_value`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base.slice(0, DESIGN_LIMITS.nameLength - String(n).length - 1)}_${n}`;
    if (!taken.has(next)) return next;
  }
}

/**
 * `next` (a design read again from text or a schema) keeping what `previous` had of the same
 * tables, matched by name: their ids and places on the diagram, what the page may do with them and
 * whether each combination is kept once (no text says), and of each connection still there, its
 * id, and what removing a row does where `keepOnDelete` (Mermaid does not say it). A table renamed
 * in the text (the one table gone and the one new, the rest as they were) is the same table, and
 * keeps all of it too.
 */
export function adoptIds(previous: DatabaseDesign, next: DatabaseDesign, keepOnDelete: boolean): DatabaseDesign {
  const before = new Map(previous.tables.map(table => [table.name, table]));
  const gone = previous.tables.filter(old => !next.tables.some(table => table.name === old.name));
  const arrived = next.tables.filter(table => !before.has(table.name));
  if (gone.length === 1 && arrived.length === 1) before.set(arrived[0].name, gone[0]);
  const ids = new Map<string, string>();
  const tables = next.tables.map(table => {
    const old = before.get(table.name);
    if (!old) return table;
    ids.set(table.id, old.id);
    const fieldIds = new Map(old.fields.map(field => [field.name, field.id]));
    return { ...table, id: old.id, at: old.at, api: old.api, uniqueLinks: table.uniqueLinks || old.uniqueLinks, fields: table.fields.map(field => ({ ...field, id: fieldIds.get(field.name) ?? field.id })) };
  });
  const oldLinks = new Map(previous.links.map(link => [`${link.from}|${link.to}|${link.column}`, link]));
  const links = next.links.map(link => {
    const from = ids.get(link.from) ?? link.from;
    const to = ids.get(link.to) ?? link.to;
    const old = oldLinks.get(`${from}|${to}|${link.column}`);
    if (!old) return { ...link, from, to };
    const onDelete = keepOnDelete && !(link.required && old.onDelete === 'setNull') ? old.onDelete : link.onDelete;
    return { ...link, from, to, id: old.id, onDelete };
  });
  return withPairsKept({ version: 1, tables, links });
}

/** `incoming`'s tables added to `current`'s, each renamed where `current` has its name already; and what was renamed, said. */
export function mergeDesigns(current: DatabaseDesign, incoming: DatabaseDesign): { design: DatabaseDesign; renamed: string[] } {
  const taken = new Set(current.tables.map(table => table.name));
  const renamed: string[] = [];
  const tables = incoming.tables.map(table => {
    const name = fixName(table.name, taken);
    taken.add(name);
    if (name !== table.name) renamed.push(`${table.name} is added as ${name}: the design has a ${table.name} already.`);
    return { ...table, name };
  });
  return { design: { version: 1, tables: [...current.tables, ...tables], links: [...current.links, ...incoming.links] }, renamed };
}

/**
 * A design read back from where it was kept, or null when it is not one. Old or damaged copies are
 * dropped, never half-read: every flag a true or false, every name and choice text, a place two
 * numbers, as a design made here has them.
 */
export function readDesign(value: unknown): DatabaseDesign | null {
  if (!value || typeof value !== 'object') return null;
  const design = value as Partial<DatabaseDesign>;
  if (design.version !== 1 || !Array.isArray(design.tables) || !Array.isArray(design.links)) return null;
  const kinds = new Set(FIELD_KINDS.map(entry => entry.kind));
  const flag = (value: unknown) => typeof value === 'boolean';
  const text = (value: unknown) => typeof value === 'string';
  const tablesOk = design.tables.every(table => table && text(table.id) && text(table.name) && Array.isArray(table.fields) && flag(table.stamped) && flag(table.uniqueLinks)
    && table.api && typeof table.api === 'object' && flag(table.api.read) && flag(table.api.add) && flag(table.api.change) && flag(table.api.remove)
    && (table.at === undefined || (table.at && Number.isFinite(table.at.x) && Number.isFinite(table.at.y)))
    && table.fields.every(field => field && text(field.id) && text(field.name) && kinds.has(field.kind) && flag(field.required) && flag(field.unique)
      && text(field.defaultValue) && Array.isArray(field.choices) && field.choices.every(text)));
  const linksOk = design.links.every(link => link && text(link.id) && text(link.from) && text(link.to) && text(link.column) && flag(link.required)
    && (link.unique === undefined || flag(link.unique)) && (link.onDelete === 'cascade' || link.onDelete === 'setNull' || link.onDelete === 'restrict'));
  return tablesOk && linksOk ? design as DatabaseDesign : null;
}
