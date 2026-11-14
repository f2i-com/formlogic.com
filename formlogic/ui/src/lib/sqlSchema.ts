// A schema made for another database, read as a database design (lib/databaseDesign): the
// CREATE TABLE statements of MySQL (and MariaDB), SQL Server or SQLite, as a tool exports them or
// as someone wrote them, with the ALTER TABLE … ADD FOREIGN KEY / PRIMARY KEY / UNIQUE / DEFAULT FOR
// and CREATE UNIQUE INDEX statements dumps put after them. Everything else (rows, views, routines,
// triggers, temporary tables, settings) is passed over and counted. A design says less than SQL
// can: what does not fit is said in the notes, never dropped without a word.
//
// One reader for the three, reading each as its own database does: MySQL's `name`, "text",
// backslash escapes, # comments and its client's DELIMITER lines; SQL Server's [name], N'…', GO
// lines and #temp tables; SQLite's "name". A routine's body (a procedure, a function, a trigger)
// is read whole, so a statement inside it is never taken for one of the schema's.
import {
  defaultApi, defaultProblem, fixName, newField, newId, newTable, snakeName,
  type DatabaseDesign, type DesignField, type DesignLink, type DesignTable, type FieldKind, type OnDelete,
} from './databaseDesign';

export type SqlDialect = 'MySQL' | 'SQL Server' | 'SQLite' | 'SQL';

export interface SchemaImport {
  design: DatabaseDesign;
  /** Which database the schema reads as written for, by its words: how it is read, and to say so. */
  dialect: SqlDialect;
  /** What was read differently from how it was written, or left out, one line each. */
  notes: string[];
}

/** The most text read: a schema, not a dump with its rows. */
export const SCHEMA_TEXT_LIMIT = 2 * 1024 * 1024;

/** `end`: where a statement ends (`;`, the mysql client's own delimiter); its text is what ended it. */
interface Token { kind: 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'end'; text: string; upper: string; line: number }

function detect(text: string): SqlDialect {
  // A # that starts a comment (# then a space, or # alone on its line) is MySQL's: elsewhere #name is a temporary table.
  if (/`|\bAUTO_INCREMENT\b|\bENGINE\s*=|\bUNSIGNED\b|\bENUM\s*\(|^\s*DELIMITER\s|(^|[\s;,)])#+(?:[ \t!=*-]|$)/im.test(text)) return 'MySQL';
  if (/\[[^\]\n]+\]|\bIDENTITY\s*\(|\bNVARCHAR\b|^\s*GO\s*$|\bdbo\.|\bDATETIME2\b|\bUNIQUEIDENTIFIER\b/im.test(text)) return 'SQL Server';
  if (/\bAUTOINCREMENT\b|\bWITHOUT\s+ROWID\b|\bINTEGER\s+PRIMARY\s+KEY\b|\)\s*STRICT\b/i.test(text)) return 'SQLite';
  return 'SQL';
}

// Space between words, the kinds a page pasted from the web has too (no-break, zero-width).
const SPACE = new RegExp('[\\s\\u200b]');

function tokenize(sql: string, dialect: SqlDialect): Token[] {
  const mysql = dialect === 'MySQL';
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let delimiter = ';';
  let lineStart = true;
  const push = (kind: Token['kind'], text: string) => tokens.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : text, line });
  const lines = (from: number, to: number) => { for (let k = from; k < to; k += 1) if (sql[k] === '\n') line += 1; };
  /** Text in quotes from `from` (just past the opening quote) to its close, doubled closes inside; a backslash escapes only in MySQL. */
  const quoted = (from: number, close: string, escapes: boolean): [string, number] => {
    let j = from;
    let text = '';
    while (j < sql.length) {
      if (escapes && sql[j] === '\\' && j + 1 < sql.length) { text += sql[j + 1]; j += 2; continue; }
      if (sql[j] === close && sql[j + 1] === close) { text += close; j += 2; continue; }
      if (sql[j] === close) break;
      text += sql[j];
      j += 1;
    }
    return [text, j + 1];
  };
  // What a word is made of: MySQL's # starts a comment even inside one; the delimiter ($$, //) ends one.
  const wordChar = (at: number) => {
    const ch = sql[at];
    if (delimiter !== ';' && sql.startsWith(delimiter, at)) return false;
    if (/[A-Za-z0-9_@$]/.test(ch)) return true;
    if (ch === '#') return !mysql;
    return ch > '\u007f' && !SPACE.test(ch);
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '\n') { line += 1; i += 1; lineStart = true; continue; }
    if (SPACE.test(c)) { i += 1; continue; }
    // The mysql client's DELIMITER line, between statements: what ends a statement from here (;; or $$ round a routine's body).
    if (mysql && lineStart && (c === 'd' || c === 'D') && (!tokens.length || tokens[tokens.length - 1].kind === 'end')) {
      const match = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(sql.slice(i, i + 256));
      if (match) { delimiter = match[1]; i += match[0].length; continue; }
    }
    lineStart = false;
    // -- to the end of the line; MySQL's # too, wherever it stands (elsewhere #name is a temporary table).
    if ((c === '-' && n === '-') || (mysql && c === '#')) { while (i < sql.length && sql[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { const end = sql.indexOf('*/', i + 2); const stop = end < 0 ? sql.length : end + 2; lines(i, stop); i = stop; continue; }
    if (delimiter === ';' ? c === ';' : sql.startsWith(delimiter, i)) { push('end', delimiter); i += delimiter.length; continue; }
    // 'text', N'text' (SQL Server), and MySQL's "text".
    if (c === "'" || ((c === 'N' || c === 'n') && n === "'" && !/[\w$]/.test(sql[i - 1] ?? '')) || (mysql && c === '"')) {
      const close = c === '"' ? '"' : "'";
      const [text, next] = quoted(c === 'N' || c === 'n' ? i + 2 : i + 1, close, mysql);
      lines(i, next);
      push('string', text);
      i = next;
      continue;
    }
    // `name` (MySQL), [name] (SQL Server), "name" (SQLite, SQL Server and the standard).
    if (c === '`' || c === '"' || c === '[') {
      const [text, next] = quoted(i + 1, c === '[' ? ']' : c, false);
      lines(i, next);
      push('quoted', text);
      i = next;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(n ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i, i + 64))!;
      push('number', match[0]);
      i += match[0].length;
      continue;
    }
    if (!/[0-9]/.test(c) && wordChar(i)) {
      let j = i + 1;
      while (j < sql.length && wordChar(j)) j += 1;
      push('word', sql.slice(i, j));
      i = j;
      continue;
    }
    push('punct', c);
    i += 1;
  }
  return tokens;
}

const OBJECTS = new Set(['TABLE', 'INDEX', 'VIEW', 'PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'EVENT', 'SCHEMA', 'DATABASE', 'SEQUENCE', 'TYPE', 'USER', 'ROLE', 'SYNONYM']);
const ROUTINES = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'EVENT']);

/** Whether a statement makes a routine: one whose body holds statements of its own. */
function routine(tokens: Token[]): boolean {
  if (tokens[0]?.kind !== 'word' || (tokens[0].upper !== 'CREATE' && tokens[0].upper !== 'ALTER')) return false;
  const object = tokens.slice(1, 24).find(token => token.kind === 'word' && OBJECTS.has(token.upper));
  return !!object && ROUTINES.has(object.upper);
}

/** How many blocks of a routine's body are open: BEGIN, CASE, IF, LOOP, WHILE and REPEAT, each closed by its END. */
function depthOf(tokens: Token[]): number {
  let depth = 0;
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.kind !== 'word') continue;
    const next = tokens[k + 1];
    const call = next?.kind === 'punct' && next.text === '(';
    if (token.upper === 'END') {
      depth -= 1;
      if (next?.kind === 'word' && ['IF', 'LOOP', 'WHILE', 'REPEAT', 'CASE'].includes(next.upper)) k += 1;
    } else if (token.upper === 'BEGIN' || token.upper === 'CASE' || token.upper === 'LOOP' || token.upper === 'WHILE') depth += 1;
    else if ((token.upper === 'IF' || token.upper === 'REPEAT') && !call && !(next?.kind === 'word' && (next.upper === 'NOT' || next.upper === 'EXISTS'))) depth += 1;
  }
  return depth;
}

/**
 * The statements: split where each ends, and at SQL Server's GO on a line of its own; a routine's
 * body is kept whole (to its GO in SQL Server, which runs a routine alone in its batch; elsewhere to
 * the END that closes it, or the client's delimiter after it).
 */
function statements(tokens: Token[], dialect: SqlDialect): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  const close = () => { if (current.length) out.push(current); current = []; };
  tokens.forEach((token, index) => {
    if (token.kind === 'word' && token.upper === 'GO' && tokens[index - 1]?.line !== token.line && tokens[index + 1]?.line !== token.line) { close(); return; }
    if (token.kind !== 'end') { current.push(token); return; }
    if (token.text === ';' && routine(current) && (dialect === 'SQL Server' || depthOf(current) > 0)) { current.push({ ...token, kind: 'punct' }); return; }
    close();
  });
  close();
  return out;
}

const NAMED = new Set<Token['kind']>(['word', 'quoted', 'string']);

class Cursor {
  at = 0;
  readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(offset = 0): Token | undefined { return this.tokens[this.at + offset]; }
  next(): Token | undefined { return this.tokens[this.at++]; }
  done(): boolean { return this.at >= this.tokens.length; }
  /** Whether these words come next. */
  is(...words: string[]): boolean { return words.every((word, k) => { const token = this.peek(k); return token?.kind === 'word' && token.upper === word; }); }
  take(...words: string[]): boolean { if (!this.is(...words)) return false; this.at += words.length; return true; }
  punct(text: string): boolean { const token = this.peek(); return token?.kind === 'punct' && token.text === text; }
  /**
   * A name, schema-qualified or not (db.dbo.table is table). Text in quotes where a name goes is
   * one too: SQLite takes 'name' so, and MySQL "name" when it quotes as the standard does.
   */
  name(): string | null {
    const token = this.peek();
    if (!token || !NAMED.has(token.kind)) return null;
    this.at += 1;
    let name = token.text;
    while (this.punct('.') && NAMED.has(this.peek(1)?.kind ?? 'end')) { this.at += 1; name = this.next()!.text; }
    return name;
  }
  /** The tokens inside the ( … ) that comes next, and past it; null when no ( comes next. */
  group(): Token[] | null {
    if (!this.punct('(')) return null;
    const start = this.at;
    let depth = 0;
    for (; this.at < this.tokens.length; this.at += 1) {
      const token = this.tokens[this.at];
      if (token.kind !== 'punct') continue;
      if (token.text === '(') depth += 1;
      else if (token.text === ')' && (depth -= 1) === 0) { this.at += 1; return this.tokens.slice(start + 1, this.at - 1); }
    }
    return this.tokens.slice(start + 1);
  }
  rest(): Token[] { const rest = this.tokens.slice(this.at); this.at = this.tokens.length; return rest; }
}

/** Tokens split at the commas outside any ( ). */
function splitTop(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === '(') depth += 1;
    if (token.kind === 'punct' && token.text === ')') depth -= 1;
    if (depth === 0 && token.kind === 'punct' && token.text === ',') { if (current.length) parts.push(current); current = []; continue; }
    current.push(token);
  }
  if (current.length) parts.push(current);
  return parts;
}

/** The column names a ( … ) lists: (a, `b` DESC, c(10)) is a, b and c. */
function names(group: Token[] | null): string[] {
  return group ? splitTop(group).map(part => part.find(token => NAMED.has(token.kind))?.text).filter((name): name is string => !!name) : [];
}

// Operators of two marks, written together; and words a ( follows with a space between.
const PAIRED = new Set(['>=', '<=', '<>', '!=', '==', '||', '!<', '!>']);
const SPACED_BEFORE = new Set(['IN', 'AND', 'OR', 'NOT', 'EXISTS', 'BETWEEN', 'CHECK', 'AS', 'ON', 'THEN', 'ELSE', 'WHEN', 'IS']);

/** Some SQL as it was written, to say what was left out: lower('A'), price >= 0, status IN ('a', 'b'). */
function textOf(tokens: Token[]): string {
  const sign = (k: number) => {
    const token = tokens[k];
    const before = tokens[k - 1];
    return token?.kind === 'punct' && (token.text === '-' || token.text === '+') && (!before || (before.kind === 'punct' && before.text !== ')') || (before.kind === 'word' && SPACED_BEFORE.has(before.upper)));
  };
  return tokens.map((token, index) => {
    const text = token.kind === 'string' ? `'${token.text.replace(/'/g, "''")}'` : token.text;
    const before = tokens[index - 1];
    if (!before) return text;
    const tight = (token.kind === 'punct' && (token.text === ')' || token.text === ',' || token.text === '.'))
      || (before.kind === 'punct' && (before.text === '(' || before.text === '.'))
      || (token.kind === 'punct' && token.text === '(' && (before.kind === 'quoted' || (before.kind === 'word' && !SPACED_BEFORE.has(before.upper))))
      || (token.kind === 'punct' && before.kind === 'punct' && PAIRED.has(before.text + token.text))
      || (token.kind === 'number' && sign(index - 1));
    return tight ? text : ` ${text}`;
  }).join('');
}

type RawDefault = { kind: 'value'; text: string } | { kind: 'null' } | { kind: 'now' } | { kind: 'other'; text: string };
interface RawRef { table: string; columns: string[]; onDelete: string | null }
interface RawColumn {
  name: string; type: string[]; size: number[]; max: boolean; values: string[];
  notNull: boolean; primary: boolean; auto: boolean; unique: boolean; generated: boolean;
  defaultValue: RawDefault | null; references: RawRef | null; choices: string[] | null;
  /** Its CHECKs that list no choices, as written. */
  checks: string[];
}
interface RawTable {
  name: string; columns: RawColumn[]; primary: string[]; uniques: string[][]; foreignKeys: { columns: string[]; ref: RawRef }[];
  choices: Map<string, string[]>;
  /** The table's CHECKs that list no choices, as written. */
  checks: string[];
}

const lower = (text: string) => text.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

/** What a DEFAULT says: a value, NULL, the time a row is added, or something else. */
function readDefault(c: Cursor): RawDefault {
  let tokens: Token[] = [];
  if (c.punct('(')) tokens = c.group() ?? [];
  else {
    const first = c.next();
    if (first) tokens.push(first);
    if (first?.kind === 'punct' && (first.text === '-' || first.text === '+') && c.peek()?.kind === 'number') tokens.push(c.next()!);
    // b'1', x'0A', and MySQL's _utf8mb4'new'.
    else if (first?.kind === 'word' && (first.upper === 'B' || first.upper === 'X' || /^_\w+$/.test(first.text)) && c.peek()?.kind === 'string') tokens.push(c.next()!);
    else if (first?.kind === 'word' && c.punct('(')) { const start = c.at; c.group(); tokens.push(...c.tokens.slice(start, c.at)); }
  }
  // SQL Server writes them in brackets, often twice over: ((0)), ('new'), (getdate()). Each ( is
  // matched to its ) once, so brackets however deep are taken off in one pass.
  const closes = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'punct') return;
    if (token.text === '(') open.push(index);
    else if (token.text === ')' && open.length) closes.set(open.pop()!, index);
  });
  let start = 0;
  let end = tokens.length;
  while (end - start > 2 && closes.get(start) === end - 1) { start += 1; end -= 1; }
  tokens = tokens.slice(start, end);
  const [first, second] = tokens;
  if (!first) return { kind: 'other', text: '' };
  const text = textOf(tokens);
  if (first.kind === 'word' && /^(CURRENT_TIMESTAMP|CURRENT_DATE|NOW|GETDATE|GETUTCDATE|SYSDATETIME|SYSUTCDATETIME|SYSDATETIMEOFFSET|LOCALTIMESTAMP|LOCALTIME|UTC_TIMESTAMP)$/.test(first.upper)) return { kind: 'now' };
  if (first.kind === 'word' && /^(DATETIME|DATE|STRFTIME|UNIXEPOCH|JULIANDAY)$/.test(first.upper) && tokens.some(token => token.kind === 'string' && lower(token.text) === 'now')) return { kind: 'now' };
  if (tokens.length === 1 && first.kind === 'word' && first.upper === 'NULL') return { kind: 'null' };
  if (tokens.length === 1 && first.kind === 'word' && (first.upper === 'TRUE' || first.upper === 'FALSE')) return { kind: 'value', text: first.upper === 'TRUE' ? '1' : '0' };
  // "new" too: SQLite reads a name in double quotes where none can be meant as text, and no database takes a column's name as a default.
  if (tokens.length === 1 && (first.kind === 'string' || first.kind === 'number' || first.kind === 'quoted')) return { kind: 'value', text: first.text };
  if (tokens.length === 2 && first.kind === 'punct' && (first.text === '-' || first.text === '+') && second.kind === 'number') return { kind: 'value', text: first.text === '-' ? `-${second.text}` : second.text };
  if (tokens.length === 2 && first.kind === 'word' && first.upper === 'B' && second.kind === 'string') return { kind: 'value', text: second.text };
  // MySQL's charset introducer: _utf8mb4'new'.
  if (tokens.length === 2 && first.kind === 'word' && /^_\w+$/.test(first.text) && second.kind === 'string') return { kind: 'value', text: second.text };
  return { kind: 'other', text };
}

/**
 * The values a CHECK allows a column, when it lists them: `col IN ('a', 'b')`, or `col = 'a' OR
 * col = 'b'` as SQL Server keeps one, in brackets or not, with MySQL's _utf8mb4'…' introducers
 * (as mysqldump writes them). Else null.
 */
function choicesOf(group: Token[] | null): { column: string; values: string[] } | null {
  if (!group) return null;
  const plain = group.filter(token => !(token.kind === 'punct' && (token.text === '(' || token.text === ')')) && !(token.kind === 'word' && /^_\w+$/.test(token.text)));
  const c = new Cursor(plain);
  const column = c.name();
  if (!column) return null;
  const values: string[] = [];
  const value = () => { const token = c.next(); return token && (token.kind === 'string' || token.kind === 'number') ? token.text : null; };
  if (c.take('IN')) {
    for (;;) {
      const found = value();
      if (found === null) return null;
      values.push(found);
      if (c.done()) return { column, values };
      if (!c.punct(',')) return null;
      c.next();
    }
  }
  c.at = 0;
  for (;;) {
    const name = c.name();
    if (!name || !same(name, column) || !c.punct('=')) return null;
    c.next();
    const found = value();
    if (found === null) return null;
    values.push(found);
    if (c.done()) return { column, values };
    if (!c.take('OR')) return null;
  }
}

function action(c: Cursor): string {
  if (c.take('CASCADE')) return 'CASCADE';
  if (c.take('SET', 'NULL')) return 'SET NULL';
  if (c.take('SET', 'DEFAULT')) return 'SET DEFAULT';
  if (c.take('RESTRICT')) return 'RESTRICT';
  if (c.take('NO', 'ACTION')) return 'NO ACTION';
  c.next();
  return 'NO ACTION';
}

function references(c: Cursor): RawRef | null {
  if (!c.take('REFERENCES')) return null;
  const table = c.name();
  if (!table) return null;
  const columns = names(c.group());
  let onDelete: string | null = null;
  while (!c.done()) {
    if (c.take('ON', 'DELETE')) onDelete = action(c);
    else if (c.take('ON', 'UPDATE')) action(c);
    else if (c.take('MATCH')) c.next();
    else if (c.take('NOT', 'FOR', 'REPLICATION') || c.take('NOT', 'DEFERRABLE') || c.take('DEFERRABLE') || c.take('INITIALLY', 'DEFERRED') || c.take('INITIALLY', 'IMMEDIATE')) continue;
    else break;
  }
  return { table, columns, onDelete };
}

/** Words that end a column's type and start what is said of it. */
const AFTER_TYPE = new Set(['NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COLLATE', 'AUTO_INCREMENT', 'AUTOINCREMENT',
  'IDENTITY', 'COMMENT', 'GENERATED', 'AS', 'ON', 'CHARACTER', 'CHARSET', 'KEY', 'INVISIBLE', 'VISIBLE', 'SPARSE', 'ROWGUIDCOL', 'FILESTREAM', 'MASKED',
  'STORAGE', 'COLUMN_FORMAT', 'SRID', 'ENCRYPTED', 'FOREIGN']);

function column(c: Cursor, table: RawTable): void {
  const name = c.name();
  if (!name) return;
  const raw: RawColumn = { name, type: [], size: [], max: false, values: [], notNull: false, primary: false, auto: false, unique: false, generated: false, defaultValue: null, references: null, choices: null, checks: [] };
  while (!c.done()) {
    const token = c.peek()!;
    if (token.kind === 'word' && AFTER_TYPE.has(token.upper) && !(raw.type.length === 0 && token.upper === 'CHARACTER')) break;
    if (token.kind === 'punct' && token.text === '(') {
      for (const part of splitTop(c.group() ?? [])) {
        const first = part[0];
        if (first?.kind === 'number') raw.size.push(Number(first.text));
        else if (first?.kind === 'string') raw.values.push(first.text);
        else if (first?.kind === 'word' && first.upper === 'MAX') raw.max = true;
      }
      continue;
    }
    if (token.kind === 'word' || token.kind === 'quoted') { raw.type.push(token.text.toUpperCase()); c.next(); continue; }
    break;
  }
  while (!c.done()) {
    if (c.take('CONSTRAINT')) { c.name(); continue; }
    if (c.take('NOT', 'NULL')) { raw.notNull = true; continue; }
    if (c.take('NULL')) continue;
    // SQL Server's column-level FOREIGN KEY REFERENCES …: the REFERENCES that follows says it.
    if (c.take('FOREIGN', 'KEY')) continue;
    if (c.take('PRIMARY', 'KEY') || c.take('KEY')) {
      raw.primary = true;
      if (!c.take('ASC')) c.take('DESC');
      if (!c.take('CLUSTERED')) c.take('NONCLUSTERED');
      if (c.take('ON', 'CONFLICT')) c.next();
      if (c.take('AUTOINCREMENT')) raw.auto = true;
      continue;
    }
    if (c.take('AUTO_INCREMENT') || c.take('AUTOINCREMENT')) { raw.auto = true; continue; }
    if (c.take('IDENTITY')) { raw.auto = true; c.group(); continue; }
    if (c.take('UNIQUE')) { raw.unique = true; c.take('KEY'); if (!c.take('CLUSTERED')) c.take('NONCLUSTERED'); if (c.take('ON', 'CONFLICT')) c.next(); continue; }
    if (c.take('DEFAULT')) { raw.defaultValue = readDefault(c); continue; }
    if (c.is('REFERENCES')) { raw.references = references(c); continue; }
    if (c.take('CHECK')) {
      const group = c.group();
      const found = choicesOf(group);
      if (found && same(found.column, name)) raw.choices = found.values;
      else if (group) raw.checks.push(textOf(group));
      continue;
    }
    if (c.take('ON', 'UPDATE')) { c.next(); c.group(); continue; }
    if (c.take('CHARACTER', 'SET') || c.take('CHARSET') || c.take('COLLATE') || c.take('COMMENT')) { c.next(); continue; }
    if (c.take('GENERATED') || c.take('AS')) { raw.generated = true; break; }
    c.next();
  }
  table.columns.push(raw);
}

// Types a size follows in brackets: a column may be called key or index (SQLite's settings tables,
// Chrome's meta), and `key VARCHAR(40)` is that column, where `KEY name (…)` is an index of MySQL's.
const SIZED_TYPES = new Set(['VARCHAR', 'VARCHAR2', 'NVARCHAR', 'NVARCHAR2', 'CHAR', 'NCHAR', 'CHARACTER', 'BINARY', 'VARBINARY', 'BIT', 'INT', 'INTEGER',
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'DECIMAL', 'NUMERIC', 'DEC', 'FIXED', 'NUMBER', 'FLOAT', 'DOUBLE', 'REAL', 'DATETIME', 'DATETIME2',
  'DATETIMEOFFSET', 'TIMESTAMP', 'TIME', 'YEAR', 'ENUM', 'SET', 'TEXT', 'BLOB', 'LONGVARCHAR']);

/** Whether an item defines an index (MySQL's KEY, INDEX, FULLTEXT and SPATIAL, SQL Server's INDEX), not a column so named. */
function indexDefinition(c: Cursor): boolean {
  const first = c.peek();
  if (first?.kind !== 'word') return false;
  if (first.upper === 'FULLTEXT' || first.upper === 'SPATIAL') return true;
  if (first.upper !== 'KEY' && first.upper !== 'INDEX') return false;
  const next = c.peek(1);
  const after = c.peek(2);
  if (next?.kind === 'punct' && next.text === '(') return true;
  if (next?.kind === 'quoted') return true;
  if (next?.kind !== 'word') return false;
  if (after?.kind === 'word' && ['USING', 'CLUSTERED', 'NONCLUSTERED'].includes(after.upper)) return true;
  return after?.kind === 'punct' && after.text === '(' && !SIZED_TYPES.has(next.upper);
}

/** One item of a CREATE TABLE's ( … ), or of an ALTER TABLE's ADD: a column, a key, a check or an index. */
function tableItem(c: Cursor, table: RawTable): void {
  if (c.take('CONSTRAINT')) c.name();
  if (c.take('PRIMARY', 'KEY')) { if (!c.take('CLUSTERED')) c.take('NONCLUSTERED'); table.primary = names(c.group()); return; }
  if (c.take('UNIQUE')) {
    if (!c.take('KEY')) c.take('INDEX');
    if (!c.take('CLUSTERED')) c.take('NONCLUSTERED');
    if (!c.punct('(')) c.name();
    table.uniques.push(names(c.group()));
    return;
  }
  if (c.take('FOREIGN', 'KEY')) {
    if (!c.punct('(')) c.name();
    const columns = names(c.group());
    const ref = references(c);
    if (ref) table.foreignKeys.push({ columns, ref });
    return;
  }
  // SQL Server: ADD CONSTRAINT DF_x DEFAULT (0) FOR col.
  if (c.take('DEFAULT')) {
    const value = readDefault(c);
    if (c.take('FOR')) { const target = c.name(); const found = target ? table.columns.find(other => same(other.name, target)) : undefined; if (found) found.defaultValue = value; }
    return;
  }
  if (c.take('CHECK')) {
    const group = c.group();
    const found = choicesOf(group);
    if (found) table.choices.set(lower(found.column), found.values);
    else if (group) table.checks.push(textOf(group));
    return;
  }
  // An index of MySQL's: the design makes the indexes its connections need.
  if (indexDefinition(c)) return;
  column(c, table);
}

// Words a column's name may have that say it is long text, where its type does not (SQLite's TEXT is every text).
const LONG_NAMES = /(^|_)(description|notes?|body|content|message|comments?|details|bio|summary|text|html|markdown|instructions|address)$/;

/** The kind of detail a column's type is, or null for what a design cannot hold (binary data). */
export function kindOfType(type: string[], size: number[], max: boolean, columnName: string, dialect: SqlDialect): { kind: FieldKind; note?: string } | null {
  const word = type[0] ?? '';
  const all = type.join(' ');
  if (!word) return { kind: LONG_NAMES.test(columnName) ? 'longText' : 'text' };
  if (/^(BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY|VARBINARY|IMAGE|BYTEA|ROWVERSION|GEOMETRY|GEOGRAPHY|POINT|LINESTRING|POLYGON|HIERARCHYID|SQL_VARIANT)$/.test(word)) return null;
  if (word === 'TIMESTAMP' && dialect === 'SQL Server') return null;
  if (word === 'TINYINT' && size[0] === 1) return { kind: 'boolean' };
  if (word === 'BIT') return size.length && size[0] > 1 ? { kind: 'integer' } : { kind: 'boolean' };
  if (/^(BOOL|BOOLEAN)$/.test(word)) return { kind: 'boolean' };
  if (/^(INT|INTEGER|BIGINT|SMALLINT|MEDIUMINT|TINYINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|YEAR)$/.test(word)) return { kind: 'integer' };
  if (/^(DECIMAL|NUMERIC|DEC|FIXED|FLOAT|DOUBLE|REAL|MONEY|SMALLMONEY|NUMBER|FLOAT4|FLOAT8)$/.test(word)) return { kind: 'decimal' };
  if (word === 'DATE') return { kind: 'date' };
  if (/^(DATETIME|DATETIME2|SMALLDATETIME|DATETIMEOFFSET|TIMESTAMP|TIMESTAMPTZ)$/.test(word)) return { kind: 'dateTime' };
  if (word === 'ENUM') return { kind: 'choice' };
  if (/^(TEXT|MEDIUMTEXT|LONGTEXT|NTEXT|CLOB|NCLOB)$/.test(word)) {
    if (word === 'TEXT' && dialect !== 'MySQL' && !LONG_NAMES.test(columnName)) return { kind: 'text' };
    return { kind: 'longText' };
  }
  if (word === 'TINYTEXT') return { kind: 'text' };
  if (/^(CHAR|VARCHAR|NCHAR|NVARCHAR|VARCHAR2|NVARCHAR2|CHARACTER|STRING|CITEXT|VARYING)$/.test(word) || /^CHARACTER VARYING|^NATIONAL/.test(all)) {
    return max || (size[0] ?? 0) > 1000 ? { kind: 'longText' } : { kind: 'text' };
  }
  if (/^(JSON|JSONB|XML)$/.test(word)) return { kind: 'longText', note: `${word} is kept as long text` };
  if (/^(UUID|UNIQUEIDENTIFIER)$/.test(word)) return { kind: 'text' };
  if (word === 'TIME') return { kind: 'text', note: 'a time of day is kept as text' };
  if (word === 'SET') return { kind: 'text', note: 'a SET of values is kept as text' };
  return { kind: 'text', note: `${all} is read as text` };
}

const CREATED = new Set(['created_at', 'created', 'created_on', 'created_date', 'date_created', 'creation_date', 'inserted_at', 'added_at']);
const ON_DELETE: Record<string, OnDelete> = { CASCADE: 'cascade', 'SET NULL': 'setNull', RESTRICT: 'restrict', 'NO ACTION': 'restrict', 'SET DEFAULT': 'restrict' };

/** A default as the design keeps one for this detail, or why it is left out. */
function defaultFor(field: DesignField, raw: RawDefault | null): { value: string; dropped?: string } {
  if (!raw || raw.kind === 'null') return { value: '' };
  if (raw.kind === 'now') return { value: '', dropped: 'its default, the time a row is added, is left out (a table keeps that in created_at)' };
  if (raw.kind === 'other') return { value: '', dropped: `its default ${raw.text} is worked out by the database, and is left out` };
  let value = raw.text.trim();
  if (field.kind === 'boolean') value = /^(1|true|t|y|yes|b'1')$/i.test(value) ? 'yes' : /^(0|false|f|n|no|b'0')$/i.test(value) ? 'no' : value;
  if (field.kind === 'integer' && /^-?\d+\.0+$/.test(value)) value = value.replace(/\.0+$/, '');
  if (field.kind === 'dateTime' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d\.\d+$/.test(value)) value = value.replace(/\.\d+$/, '');
  const problem = defaultProblem({ ...field, defaultValue: value });
  return problem ? { value: '', dropped: `its default ${raw.text} is left out: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` } : { value };
}

const keysOf = (raw: RawTable) => raw.primary.length ? raw.primary : raw.columns.filter(col => col.primary).map(col => col.name);

/**
 * The tables a schema creates, as a design: each table's whole-number key (or the column that
 * numbers its rows) is its id, each single-column foreign key a connection (one to one where its
 * column is unique), and each column a detail of the kind its type is. `access` gives each table
 * the API a new one has.
 */
export function importSql(text: string, access?: 'members' | 'application'): SchemaImport {
  const dialect = detect(text);
  const notes: string[] = [];
  const raws: RawTable[] = [];
  const passed = new Map<string, number>();
  const pass = (what: string) => passed.set(what, (passed.get(what) ?? 0) + 1);
  const find = (name: string) => raws.find(table => same(table.name, name));
  // SQLite's virtual tables (full-text search, R*Trees) keep their rows in tables of their own, which a schema lists too.
  const virtuals: string[] = [];
  const shadow = (name: string) => virtuals.some(table => lower(name).startsWith(`${lower(table)}_`) && /_(content|data|idx|docsize|config|segments|segdir|stat|node|parent|rowid)$/i.test(name));
  for (const statement of statements(tokenize(text, dialect), dialect)) {
    const c = new Cursor(statement);
    const first = statement[0]?.kind === 'word' ? statement[0].upper : statement[0]?.text ?? '';
    if (c.take('CREATE')) {
      c.take('OR', 'REPLACE');
      if (!c.take('GLOBAL')) c.take('LOCAL');
      const temporary = c.take('TEMPORARY') || c.take('TEMP');
      if (c.take('VIRTUAL', 'TABLE')) {
        c.take('IF', 'NOT', 'EXISTS');
        const name = c.name();
        if (name) virtuals.push(name);
        pass('CREATE VIRTUAL TABLE');
        continue;
      }
      if (c.take('TABLE')) {
        c.take('IF', 'NOT', 'EXISTS');
        const name = c.name();
        // A temporary table is the session's, not the app's; SQLite's own (sqlite_sequence) are SQLite's.
        if (temporary || name?.startsWith('#')) { pass('CREATE TEMPORARY TABLE'); continue; }
        if (name && (/^sqlite_/i.test(name) || shadow(name))) continue;
        const body = c.group();
        if (!name || !body) { notes.push(`A CREATE TABLE${name ? ` ${name}` : ''} without its columns is left out.`); continue; }
        if (find(name)) { notes.push(`${name} is created twice: the first is kept.`); continue; }
        const table: RawTable = { name, columns: [], primary: [], uniques: [], foreignKeys: [], choices: new Map(), checks: [] };
        for (const item of splitTop(body)) tableItem(new Cursor(item), table);
        raws.push(table);
        continue;
      }
      const unique = c.take('UNIQUE');
      if (!c.take('CLUSTERED')) c.take('NONCLUSTERED');
      if (c.take('INDEX')) {
        c.take('IF', 'NOT', 'EXISTS');
        c.name();
        if (c.take('ON')) {
          const table = find(c.name() ?? '');
          const columns = names(c.group());
          if (unique && table && columns.length) table.uniques.push(columns);
        }
        continue;
      }
      const object = statement.slice(1, 24).find(token => token.kind === 'word' && OBJECTS.has(token.upper));
      pass(`CREATE ${object?.upper ?? ''}`.trim());
      continue;
    }
    if (c.take('ALTER', 'TABLE')) {
      c.take('ONLY');
      const name = c.name();
      const table = name ? find(name) : undefined;
      if (!c.take('WITH', 'CHECK')) c.take('WITH', 'NOCHECK');
      if (!table) { if (c.is('ADD') && !(name && (name.startsWith('#') || /^sqlite_/i.test(name)))) notes.push(`An ALTER TABLE of ${name ?? 'a table'}, which the schema does not create, is left out.`); continue; }
      for (const clause of splitTop(c.rest())) {
        const k = new Cursor(clause);
        if (!k.take('ADD')) continue;
        if (k.take('COLUMN')) { column(k, table); continue; }
        if (k.is('CONSTRAINT') || k.is('PRIMARY') || k.is('UNIQUE') || k.is('FOREIGN') || k.is('CHECK') || k.is('DEFAULT') || indexDefinition(k)) tableItem(k, table);
        else column(k, table);
      }
      continue;
    }
    if (routine(statement)) { pass(`${first} ${statement.slice(1, 24).find(token => token.kind === 'word' && ROUTINES.has(token.upper))?.upper ?? ''}`.trim()); continue; }
    if (first) pass(first);
  }

  const design: DatabaseDesign = { version: 1, tables: [], links: [] };
  if (!raws.length) {
    notes.unshift('No CREATE TABLE statement was found. Paste the statements that create the tables.');
    return { design, dialect, notes };
  }

  const integer = (col: RawColumn) => kindOfType(col.type, col.size, col.max, '', dialect)?.kind === 'integer';
  const foreignOf = (raw: RawTable) => [...raw.columns.filter(col => col.references).map(col => ({ columns: [col.name], ref: col.references! })), ...raw.foreignKeys];
  // Each table's name here, its connections' columns, and the column that becomes its id: its
  // whole-number key, or else the one column that numbers its rows (AUTO_INCREMENT, IDENTITY).
  const takenTables = new Set<string>();
  interface Entry { table: DesignTable; idColumn: string | null; taken: Set<string>; linked: Set<string>; oneToOne: Set<string> }
  const made = new Map<RawTable, Entry>();
  for (const raw of raws) {
    const wanted = snakeName(raw.name);
    const clash = takenTables.has(wanted);
    const name = fixName(wanted, takenTables);
    takenTables.add(name);
    if (name !== wanted) notes.push(`${raw.name} is called ${name} here: ${!/^[a-z]/.test(wanted) ? 'a name starts with a letter' : clash ? 'another table has that name' : 'its name is a word the database keeps for itself'}.`);
    const linked = new Set(foreignOf(raw).filter(fk => fk.columns.length === 1 && find(fk.ref.table)).map(fk => lower(fk.columns[0])));
    const keys = keysOf(raw);
    const keyColumns = keys.map(key => raw.columns.find(col => same(col.name, key))).filter((col): col is RawColumn => !!col);
    const autos = raw.columns.filter(col => col.auto && integer(col));
    const idColumn = keyColumns.length === 1 && integer(keyColumns[0]) && !linked.has(lower(keyColumns[0].name)) ? keyColumns[0].name
      : autos.length === 1 ? autos[0].name : null;
    if (idColumn && !same(idColumn, 'id')) notes.push(`${name}: its ${keys.some(key => same(key, idColumn)) ? 'key' : 'numbering'} ${idColumn} is its id here.`);
    made.set(raw, { table: { ...newTable(name, access), stamped: false, api: defaultApi(access) }, idColumn, taken: new Set(['id']), linked, oneToOne: new Set() });
  }

  for (const raw of raws) {
    const entry = made.get(raw)!;
    const { table, taken, linked, oneToOne } = entry;
    const keys = keysOf(raw);
    for (const fk of foreignOf(raw).filter(fk => fk.columns.length > 1)) notes.push(`${table.name}: a connection of ${fk.columns.length} columns (${fk.columns.join(', ')}) is left out; its columns are kept as details.`);
    // What no two rows may share: one column (a detail, or a connection that is then one to one),
    // or a set of columns, which a design keeps only as each combination of all its connections.
    const allLinks = [...linked];
    const sets = [...(keys.length ? [{ columns: keys, key: true }] : []), ...raw.uniques.filter(columns => columns.length).map(columns => ({ columns, key: false }))];
    for (const { columns, key } of sets) {
      const only = columns.length === 1 ? lower(columns[0]) : null;
      if (only !== null) {
        if (entry.idColumn && same(columns[0], entry.idColumn)) continue;
        if (linked.has(only)) {
          oneToOne.add(only);
          if (key) notes.push(`${table.name}: its key ${columns[0]} is its connection, one each; each row is numbered by its id.`);
        } else if (key && raw.columns.some(other => same(other.name, columns[0]))) {
          notes.push(`${table.name}: its key ${columns[0]} is not a number; it is kept as a detail no two rows share, and each row is numbered by its id.`);
        }
        continue;
      }
      // A key that holds the numbering column says nothing more: that column alone is unique.
      if (entry.idColumn && columns.some(name => same(name, entry.idColumn!))) continue;
      const lowered = columns.map(lower);
      if (lowered.every(name => linked.has(name)) && allLinks.length === lowered.length && allLinks.every(name => lowered.includes(name))) table.uniqueLinks = true;
      else notes.push(`${table.name}: ${key ? 'its key' : 'its rule that no two rows share'} (${columns.join(', ')}) is left out${key ? '; each row is numbered by its id' : ''}.`);
    }

    for (const col of raw.columns) {
      if (entry.idColumn && same(col.name, entry.idColumn)) continue;
      if (linked.has(lower(col.name))) continue;
      const wanted = snakeName(col.name);
      const kindOf = kindOfType(col.type, col.size, col.max, wanted, dialect);
      if (CREATED.has(wanted) && (col.defaultValue?.kind === 'now' || kindOf?.kind === 'dateTime' || kindOf?.kind === 'date')) { table.stamped = true; continue; }
      if (col.generated) { notes.push(`${table.name}.${col.name}: a column the database works out is left out.`); continue; }
      if (!kindOf) { notes.push(`${table.name}.${col.name}: ${col.type.join(' ')} (binary data) is left out.`); continue; }
      const name = fixName(wanted, taken);
      taken.add(name);
      let kind = kindOf.kind;
      let choices = col.values.length && col.type[0] === 'ENUM' ? col.values : col.choices ?? raw.choices.get(lower(col.name)) ?? null;
      // A CHECK of numbers: (0, 1) is SQLite's yes or no; other numbers are no list of choices.
      if (choices && choices.every(value => /^-?\d+(\.\d+)?$/.test(value))) {
        if (new Set(choices).size === 2 && choices.includes('0') && choices.includes('1')) kind = 'boolean';
        else notes.push(`${table.name}.${name}: its check of the numbers it may hold is left out.`);
        choices = null;
      }
      if (choices) kind = 'choice';
      const single = (keys.length === 1 && same(keys[0], col.name)) || raw.uniques.some(columns => columns.length === 1 && same(columns[0], col.name));
      const field: DesignField = {
        ...newField(name, kind), choices: choices ?? [],
        required: col.notNull || (keys.length === 1 && same(keys[0], col.name)),
        unique: col.unique || single,
      };
      const fallback = defaultFor(field, col.defaultValue);
      field.defaultValue = fallback.value;
      if (fallback.dropped) notes.push(`${table.name}.${name}: ${fallback.dropped}.`);
      if (kindOf.note) notes.push(`${table.name}.${name}: ${kindOf.note}.`);
      for (const check of col.checks) notes.push(`${table.name}.${name}: its check ${check} is left out.`);
      if (name !== wanted) notes.push(`${table.name}.${col.name} is called ${name} here.`);
      table.fields.push(field);
    }
    for (const check of raw.checks) notes.push(`${table.name}: its check ${check} is left out.`);
    design.tables.push(table);
  }

  for (const raw of raws) {
    const entry = made.get(raw)!;
    const seen = new Set<string>();
    for (const fk of foreignOf(raw).filter(fk => fk.columns.length === 1)) {
      const key = lower(fk.columns[0]);
      if (seen.has(key)) continue;
      seen.add(key);
      const target = find(fk.ref.table);
      const col = raw.columns.find(other => same(other.name, fk.columns[0]));
      if (!target) {
        notes.push(`${entry.table.name}.${fk.columns[0]}: refers to ${fk.ref.table}, which the schema does not create; it is kept as a whole number.`);
        if (col && !entry.table.fields.some(field => field.name === snakeName(col.name))) {
          const name = fixName(snakeName(col.name), entry.taken);
          entry.taken.add(name);
          entry.table.fields.push({ ...newField(name, 'integer'), required: col.notNull });
        }
        continue;
      }
      const to = made.get(target)!;
      if (fk.ref.columns[0] && to.idColumn && !same(fk.ref.columns[0], to.idColumn)) notes.push(`${entry.table.name}.${fk.columns[0]}: refers to ${target.name}.${fk.ref.columns[0]}; here it holds the ${to.table.name} row’s id.`);
      if (fk.ref.columns[0] && !to.idColumn) notes.push(`${entry.table.name}.${fk.columns[0]}: refers to ${target.name}.${fk.ref.columns[0]}; here it holds the ${to.table.name} row’s id, a number.`);
      const name = fixName(snakeName(fk.columns[0]), entry.taken);
      entry.taken.add(name);
      const keyed = keysOf(raw).length === 1 && same(keysOf(raw)[0], fk.columns[0]);
      const required = !!col?.notNull || keyed;
      let onDelete = ON_DELETE[fk.ref.onDelete ?? 'NO ACTION'] ?? 'restrict';
      if (fk.ref.onDelete === 'SET DEFAULT') notes.push(`${entry.table.name}.${name}: ON DELETE SET DEFAULT is read as not allowing the removal.`);
      if (onDelete === 'setNull' && required) { onDelete = 'restrict'; notes.push(`${entry.table.name}.${name}: it is required, so ON DELETE SET NULL is read as not allowing the removal.`); }
      const link: DesignLink = { id: newId(), from: entry.table.id, to: to.table.id, column: name, required, onDelete, ...(entry.oneToOne.has(key) || col?.unique ? { unique: true } : {}) };
      design.links.push(link);
    }
  }

  const left = [...passed.entries()].filter(([word]) => !['SET', 'USE', 'GO', 'LOCK', 'UNLOCK', 'BEGIN', 'COMMIT', 'PRAGMA', 'START', 'END'].includes(word));
  if (left.length) notes.push(`Passed over: ${left.map(([word, count]) => `${count} ${word}`).join(', ')}.`);
  return { design, dialect, notes };
}
