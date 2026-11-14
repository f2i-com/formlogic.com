// A database design as a Mermaid entity-relationship diagram (mermaid.js.org/syntax/entityRelationshipDiagram.html),
// and one read back as a design: written in the designer's Mermaid view, in Mermaid's own editor, or by
// an AI, which all write it well.
//
//   erDiagram
//     customers {
//       integer id PK
//       text name "required"
//       email email UK
//       choice status "required; default: new; one of: new, paid"
//       datetime created_at "added"
//     }
//     orders {
//       integer id PK
//       integer customer_id FK "required"
//     }
//     customers ||--o{ orders : customer_id
//
// Each entity is a table (named by its alias, p[Person], where it has one) and each attribute a
// detail: its type is the kind of detail (text, long_text, integer, decimal, boolean, date, datetime,
// email, url, choice, or a type of SQL's, read as lib/sqlSchema reads one), PK the id, UK no two the
// same, and the comment says what Mermaid cannot: required, the default and a list's choices (a ; , "
// % or | in a value is written %XX, so it reads back as it was). A relationship with many at one end
// is a connection from that end, named by its label where the label is a column's name; one at both
// ends a connection each row may have once (from the side its column is on, or the side there may be
// none of); many at both ends adds a table that joins them. What removing a row does is not Mermaid's
// to say: a connection read back keeps what it had (lib/databaseDesign adoptIds).
import {
  defaultApi, defaultProblem, fixName, newField, newId, newTable, singular, snakeName, tableById, withJoin,
  type DatabaseDesign, type DesignField, type DesignTable, type FieldKind,
} from './databaseDesign';
import { kindOfType } from './sqlSchema';

const TYPE_OF: Record<FieldKind, string> = { text: 'text', longText: 'long_text', integer: 'integer', decimal: 'decimal', boolean: 'boolean', date: 'date', dateTime: 'datetime', email: 'email', url: 'url', choice: 'choice' };
const KIND_OF: Record<string, FieldKind> = Object.fromEntries(Object.entries(TYPE_OF).map(([kind, type]) => [type, kind as FieldKind]));

// What a value in a comment may not hold as it is: the comment's own marks (; between parts, ,
// between choices, " round it), % (which marks these), | and line breaks. Each is written %XX.
const encode = (text: string) => text.replace(/[%";,|\r\n]/g, mark => `%${mark.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const decode = (text: string) => text.replace(/%(25|22|3B|2C|7C|0D|0A)/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function commentOf(field: DesignField): string {
  const parts: string[] = [];
  if (field.required) parts.push('required');
  if (field.defaultValue.trim()) parts.push(`default: ${encode(field.defaultValue.trim())}`);
  if (field.kind === 'choice') parts.push(`one of: ${field.choices.map(choice => encode(choice.trim())).join(', ')}`);
  return parts.length ? ` "${parts.join('; ')}"` : '';
}

/** The design as Mermaid's erDiagram. */
export function toMermaid(design: DatabaseDesign): string {
  const lines = ['erDiagram'];
  for (const table of design.tables) {
    lines.push(`  ${table.name || 'unnamed'} {`, '    integer id PK');
    for (const field of table.fields) lines.push(`    ${TYPE_OF[field.kind]} ${field.name || 'unnamed'}${field.unique ? ' UK' : ''}${commentOf(field)}`);
    for (const link of design.links.filter(other => other.from === table.id)) lines.push(`    integer ${link.column} FK${link.unique ? ', UK' : ''}${link.required ? ' "required"' : ''}`);
    if (table.stamped) lines.push('    datetime created_at "added"');
    lines.push('  }');
  }
  for (const link of design.links) {
    const from = tableById(design, link.from);
    const to = tableById(design, link.to);
    if (from && to) lines.push(`  ${to.name} ${link.required ? '||' : '|o'}--${link.unique ? 'o|' : 'o{'} ${from.name} : ${link.column}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface MermaidProblem { line: number; text: string }
export interface MermaidRead { design: DatabaseDesign | null; problems: MermaidProblem[]; notes: string[] }

interface Attribute { type: string; size: number[]; name: string; keys: string[]; comment: string; line: number }
interface Entity { name: string; alias: string | null; attributes: Attribute[]; line: number }
interface Relation { left: string; leftCard: string; right: string; rightCard: string; label: string; line: number }

// A name: a letter, then letters, digits, _, - and . (dbo.orders), or anything in double quotes.
const NAME = String.raw`(?:[A-Za-z_\u0080-￿][\w\u0080-￿.-]*|"[^"]+")`;
// An entity: NAME, NAME[Alias] or NAME["An alias"], then { to open its attributes (and } on the same line to close them).
const ENTITY = new RegExp(String.raw`^(${NAME})(?:\s*\[\s*(?:"([^"]*)"|([^\]"]*?))\s*\])?\s*(?:\{(.*))?$`);
const ATTRIBUTE = new RegExp(String.raw`\s*([A-Za-z][\w-]*)(\([^)]*\))?(\[\])?\s+([A-Za-z_*\u0080-￿][\w\u0080-￿-]*)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)(?:\s+"([^"]*)")?\s*`, 'y');
// Mermaid's words for the ends, newer than its symbols: only one, zero or one, zero or more, one or more.
const WORDS: Record<string, [string, string]> = {
  'only one': ['||', '||'], '1': ['||', '||'], 'zero or one': ['|o', 'o|'], 'one or zero': ['|o', 'o|'],
  'zero or more': ['}o', 'o{'], 'zero or many': ['}o', 'o{'], 'many(0)': ['}o', 'o{'], '0+': ['}o', 'o{'],
  'one or more': ['}|', '|{'], 'one or many': ['}|', '|{'], 'many(1)': ['}|', '|{'], '1+': ['}|', '|{'],
};
const WORD_ENDS = Object.keys(WORDS).map(word => word.replace(/[()+]/g, match => `\\${match}`)).join('|');
// A relationship: each end a symbol (written up to the line between them) or words (with a space
// round them), the line -- or .. (or .- -.), or the words to and optionally to.
const RELATION = new RegExp(String.raw`^(${NAME})(?:\s*(\|o|\|\||\}o|\}\|)|\s+(${WORD_ENDS}))(?:\s+(?:to|optionally to)\s+|\s*(?:--|\.\.|\.-|-\.)\s*)(?:(o\||\|\||o\{|\|\{)\s*|(${WORD_ENDS})\s+)(${NAME})\s*:\s*(.*)$`, 'i');

const unquote = (text: string) => text.startsWith('"') && text.endsWith('"') && text.length > 1 ? text.slice(1, -1) : text;

/** What a comment says: required, a default, a list's choices. */
function readComment(comment: string): { required: boolean; defaultValue: string; choices: string[] | null } {
  let required = false;
  let defaultValue = '';
  let choices: string[] | null = null;
  for (const part of comment.split(';').map(piece => piece.trim()).filter(Boolean)) {
    if (/^required$/i.test(part)) required = true;
    else if (/^default\s*:/i.test(part)) defaultValue = decode(part.replace(/^default\s*:/i, '').trim());
    else if (/^one of\s*:/i.test(part)) choices = part.replace(/^one of\s*:/i, '').split(',').map(choice => decode(choice.trim())).filter(Boolean);
  }
  return { required, defaultValue, choices };
}

/** A line without its %% comment: Mermaid's take a line of their own, but one after a statement is read as one too. */
function withoutComment(raw: string): string {
  let quoted = false;
  for (let k = 0; k < raw.length - 1; k += 1) {
    if (raw[k] === '"') quoted = !quoted;
    else if (!quoted && raw[k] === '%' && raw[k + 1] === '%') return raw.slice(0, k);
  }
  return raw;
}

/** The attributes in some text: one a line, or several on the line an entity opens and closes on; null if any is not one. */
function attributesIn(text: string, line: number): Attribute[] | null {
  const found: Attribute[] = [];
  ATTRIBUTE.lastIndex = 0;
  while (ATTRIBUTE.lastIndex < text.length) {
    const match = ATTRIBUTE.exec(text);
    if (!match) return null;
    const size = (match[2] ?? '').replace(/[()]/g, '').split(',').map(part => Number(part.trim())).filter(Number.isFinite);
    found.push({ type: match[1], size, name: match[4], keys: (match[5] ?? '').split(/[\s,]+/).filter(Boolean).map(key => key.toUpperCase()), comment: match[6] ?? '', line });
  }
  return found;
}

const NOT_AN_ATTRIBUTE = (text: string) => `“${text}” is not an attribute: write its type, then its name, then PK, FK or UK if it is one, then a "comment" if you like.`;

/** A Mermaid ER diagram as a design, or what stops it being one, by line. */
export function readMermaid(text: string, access?: 'members' | 'application'): MermaidRead {
  const problems: MermaidProblem[] = [];
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];
  let header = false;
  let open: Entity | null = null;
  let skipping: 'front matter' | 'description' | null = null;
  const entity = (raw: string, line: number, alias?: string | null) => {
    const name = unquote(raw);
    const key = name.toLowerCase();
    if (!entities.has(key)) entities.set(key, { name, alias: null, attributes: [], line });
    const found = entities.get(key)!;
    if (alias) found.alias = alias;
    return found;
  };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = lines[index].trim();
    // Settings before the diagram (--- title: … ---), and a description over several lines (accDescr { … }).
    if (skipping === 'front matter') { if (trimmed === '---') skipping = null; continue; }
    if (skipping === 'description') { if (trimmed.includes('}')) skipping = null; continue; }
    if (!header && trimmed === '---') { skipping = 'front matter'; continue; }
    if (trimmed.startsWith('%%')) continue;
    let s = withoutComment(trimmed).trim();
    if (!s) continue;
    if (!header) {
      header = true;
      if (!/^erDiagram\b/.test(s)) { problems.push({ line, text: 'A Mermaid ER diagram starts with erDiagram, on a line of its own.' }); continue; }
      s = s.slice('erDiagram'.length).trim();
      if (!s) continue;
    }
    if (open) {
      const closes = s.endsWith('}');
      const body = closes ? s.slice(0, -1).trim() : s;
      const found = body ? attributesIn(body, line) : [];
      if (found) open.attributes.push(...found);
      else problems.push({ line, text: NOT_AN_ATTRIBUTE(body) });
      if (closes) open = null;
      continue;
    }
    if (/^direction\s+(TB|BT|LR|RL)$/i.test(s) || /^(title|accTitle)\b/.test(s) || /^accDescr\s*:/.test(s) || /^(style|classDef|class)\s/.test(s)) continue;
    if (/^accDescr\s*\{/.test(s)) { if (!s.includes('}')) skipping = 'description'; continue; }
    // A class given to an entity (NAME:::class) changes how it looks, nothing more.
    s = s.replace(/(\S):::[\w-]+(?:\s*,\s*[\w-]+)*/g, '$1');
    const related = RELATION.exec(s);
    if (related) {
      const [, leftName, leftSymbol, leftWords, rightSymbol, rightWords, rightName, label] = related;
      entity(leftName, line);
      entity(rightName, line);
      relations.push({
        left: unquote(leftName).toLowerCase(), leftCard: leftSymbol ?? WORDS[leftWords.toLowerCase()][0],
        right: unquote(rightName).toLowerCase(), rightCard: rightSymbol ?? WORDS[rightWords.toLowerCase()][1],
        label: unquote(label.trim()), line,
      });
      continue;
    }
    const declared = ENTITY.exec(s);
    if (declared) {
      const found = entity(declared[1], line, (declared[2] ?? declared[3] ?? '').trim() || null);
      if (declared[4] === undefined) continue;
      let rest = declared[4].trim();
      const closes = rest.endsWith('}');
      if (closes) rest = rest.slice(0, -1).trim();
      const attributes = rest ? attributesIn(rest, line) : [];
      if (attributes) found.attributes.push(...attributes);
      else problems.push({ line, text: NOT_AN_ATTRIBUTE(rest) });
      if (!closes) open = found;
      continue;
    }
    problems.push({ line, text: `“${s}” is not something an ER diagram says: an entity is NAME { … }, and a relationship NAME ||--o{ OTHER : label.` });
  }
  if (!header) problems.push({ line: 1, text: 'A Mermaid ER diagram starts with erDiagram.' });
  if (open) problems.push({ line: open.line, text: `${open.name}’s { is not closed with }.` });
  if (problems.length) return { design: null, problems, notes: [] };

  const notes: string[] = [];
  const taken = new Set<string>();
  interface Built { table: DesignTable; foreignKeys: Attribute[]; columns: Set<string> }
  const tables = new Map<string, Built>();
  for (const [key, found] of entities) {
    // Its alias where it has one; dbo.orders is orders.
    const shown = found.alias ?? found.name.split('.').filter(Boolean).pop() ?? found.name;
    const wanted = snakeName(shown) || snakeName(found.name) || 'table';
    const name = fixName(wanted, taken);
    taken.add(name);
    if (name !== wanted) notes.push(`${shown} is called ${name} here.`);
    const table: DesignTable = { ...newTable(name, access), stamped: false, api: defaultApi(access) };
    const columns = new Set(['id']);
    const foreignKeys: Attribute[] = [];
    const keys = found.attributes.filter(attribute => attribute.keys.includes('PK'));
    for (const attribute of found.attributes) {
      const wantedColumn = snakeName(attribute.name) || 'detail';
      const type = attribute.type.toLowerCase();
      const comment = readComment(attribute.comment);
      if (attribute.keys.includes('PK') && keys.length === 1) {
        const numbered = KIND_OF[type] === 'integer' || kindOfType([attribute.type.toUpperCase()], attribute.size, false, '', 'SQL')?.kind === 'integer';
        if (numbered && !attribute.keys.includes('FK')) { if (wantedColumn !== 'id') notes.push(`${name}: its key ${attribute.name} is its id here.`); continue; }
        if (!numbered) notes.push(`${name}: its key ${attribute.name} is not a number; it is kept as a detail no two rows share, and each row is numbered by its id.`);
      }
      if (attribute.keys.includes('FK')) { foreignKeys.push(attribute); continue; }
      if (wantedColumn === 'created_at' && /date/.test(type)) { table.stamped = true; continue; }
      const kind: FieldKind | null = KIND_OF[type] ?? kindOfType([attribute.type.toUpperCase()], attribute.size, false, wantedColumn, 'SQL')?.kind ?? null;
      if (!kind) { notes.push(`${name}.${attribute.name}: ${attribute.type} (binary data) is left out.`); continue; }
      const column = fixName(wantedColumn, columns);
      columns.add(column);
      const choices = comment.choices ?? (kind === 'choice' ? [] : null);
      const field: DesignField = {
        ...newField(column, choices ? 'choice' : kind),
        choices: choices ?? [],
        required: comment.required || (attribute.keys.includes('PK') && keys.length === 1),
        unique: attribute.keys.includes('UK') || (attribute.keys.includes('PK') && keys.length === 1),
      };
      if (comment.defaultValue) {
        const problem = defaultProblem({ ...field, defaultValue: comment.defaultValue });
        if (problem) notes.push(`${name}.${column}: its default ${comment.defaultValue} is left out: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
        else field.defaultValue = comment.defaultValue;
      }
      table.fields.push(field);
    }
    if (keys.length > 1) notes.push(`${name}: its key of ${keys.length} attributes is left out; each row is numbered by its id.`);
    tables.set(key, { table, foreignKeys, columns });
  }

  let design: DatabaseDesign = { version: 1, tables: [...tables.values()].map(entry => entry.table), links: [] };
  const usedKeys = new Set<Attribute>();
  // Whole numbers that turned out to be a connection's column, by table.
  const turned = new Map<string, Set<string>>();
  /**
   * The column in `holder` that holds a `target` row's id: an FK attribute the label names, else one
   * named for the target (library_member_id, or member_id by its last word), else a whole number so named.
   */
  const columnIn = (holder: Built, target: Built, label: string): { attribute: Attribute } | { field: DesignField } | null => {
    const one = singular(target.table.name);
    const ones = [...new Set([one, one.slice(one.lastIndexOf('_') + 1)])];
    const attribute = holder.foreignKeys.find(found => !usedKeys.has(found) && snakeName(found.name) === label)
      ?? holder.foreignKeys.find(found => !usedKeys.has(found) && ones.some(name => snakeName(found.name).startsWith(name)));
    if (attribute) return { attribute };
    const gone = turned.get(holder.table.id);
    const free = holder.table.fields.filter(found => found.kind === 'integer' && !gone?.has(found.name));
    const field = free.find(found => found.name === label && /_id$/.test(label)) ?? ones.map(name => free.find(found => found.name === `${name}_id`)).find(Boolean);
    return field ? { field } : null;
  };
  for (const relation of relations) {
    const left = tables.get(relation.left)!;
    const right = tables.get(relation.right)!;
    const leftMany = relation.leftCard.startsWith('}');
    const rightMany = relation.rightCard.endsWith('{');
    if (leftMany && rightMany) {
      if (left.table.id === right.table.id) { notes.push(`Line ${relation.line}: ${left.table.name} with many of itself is left out.`); continue; }
      design = withJoin(design, left.table, right.table, access);
      notes.push(`${left.table.name} and ${right.table.name} have many of each other: the table ${design.tables[design.tables.length - 1].name} keeps which goes with which.`);
      continue;
    }
    const label = snakeName(relation.label);
    // The end with many rows holds the other's id. With one at both ends: the side with a column for
    // the other's id, else the side there may be none of (|o beside it), else the right-hand one.
    const leftHolds = leftMany || (!rightMany && !columnIn(right, left, label) && (!!columnIn(left, right, label) || (relation.leftCard === '|o' && relation.rightCard === '||')));
    const [holder, target, targetCard] = leftHolds ? [left, right, relation.rightCard] : [right, left, relation.leftCard];
    const found = columnIn(holder, target, label);
    let column: string;
    let saysRequired = false;
    let saysUnique = false;
    if (found && 'attribute' in found) {
      usedKeys.add(found.attribute);
      column = fixName(snakeName(found.attribute.name), holder.columns);
      saysRequired = readComment(found.attribute.comment).required;
      saysUnique = found.attribute.keys.includes('UK');
    } else if (found) {
      column = found.field.name;
      turned.set(holder.table.id, new Set([...(turned.get(holder.table.id) ?? []), column]));
      saysRequired = found.field.required;
      saysUnique = found.field.unique;
    } else {
      column = fixName(/_id$/.test(label) ? label : `${singular(target.table.name)}_id`, holder.columns);
    }
    holder.columns.add(column);
    const required = targetCard.includes('||') || saysRequired;
    const unique = (!leftMany && !rightMany) || saysUnique;
    design = { ...design, links: [...design.links, { id: newId(), from: holder.table.id, to: target.table.id, column, required, onDelete: required ? 'cascade' : 'setNull', ...(unique ? { unique: true } : {}) }] };
  }
  // A whole number that became a connection's column is that connection only; an FK attribute no relationship uses is a whole number.
  design = {
    ...design,
    tables: design.tables.map(table => {
      const entry = [...tables.values()].find(other => other.table.id === table.id);
      if (!entry) return table;
      const gone = turned.get(table.id);
      const loose = entry.foreignKeys.filter(attribute => !usedKeys.has(attribute));
      if (!gone && !loose.length) return table;
      const extra = loose.map(attribute => {
        const column = fixName(snakeName(attribute.name) || 'detail', entry.columns);
        entry.columns.add(column);
        notes.push(`${table.name}.${column}: no relationship says what it refers to; it is kept as a whole number.`);
        return { ...newField(column, 'integer'), required: readComment(attribute.comment).required };
      });
      return { ...table, fields: [...table.fields.filter(field => !gone?.has(field.name)), ...extra] };
    }),
  };
  return { design, problems: [], notes };
}
