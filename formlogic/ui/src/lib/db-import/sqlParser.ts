import {
  gunzipBytes,
  parseDelimitedText,
  parseJsonDataText,
  stripBom,
  unpackZipBytes,
} from './dataParser';
import { isSqliteBinary, readSqliteFile } from './sqliteReader';
import type {
  ImportedColumn,
  ImportedForeignKey,
  ImportedSchema,
  ImportedTable,
  ResolvedDialect,
  SqlDialect,
} from './types';

interface Token {
  type: 'word' | 'ident' | 'string' | 'number' | 'symbol';
  value: string;
  upper: string;
  quoted?: boolean;
}

const MAX_INLINE_ROWS_PER_TABLE = 50_000;

/** Normalize a table name into a stable lowercase identifier key. */
export function normalizeTableKey(name: string): string {
  return name
    .trim()
    .replace(/^["`[\]]+|["`[\]]+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'table';
}

/** Auto-detect SQL / schema dialect from input text. */
export function detectSchemaDialect(raw: string): ResolvedDialect {
  const sample = stripBom(raw).slice(0, 32_768);
  const trimmed = sample.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (/^\s*(?:datasource|generator|model|enum)\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/m.test(sample)) {
    return 'prisma';
  }
  if (
    /\bGO\b/m.test(sample) &&
    (/\[dbo\]/i.test(sample) || /\bIDENTITY\s*\(/i.test(sample) || /\bNVARCHAR\b/i.test(sample))
  ) {
    return 'mssql';
  }
  if (
    /\[[A-Za-z_][A-Za-z0-9_ ]*\]\.\[[A-Za-z_][A-Za-z0-9_ ]*\]/.test(sample) ||
    /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i.test(sample) ||
    /\bUNIQUEIDENTIFIER\b/i.test(sample) ||
    /\bDATETIME2\b/i.test(sample)
  ) {
    return 'mssql';
  }
  if (
    /\b(?:BIGSERIAL|SMALLSERIAL|SERIAL|TIMESTAMPTZ|JSONB|BYTEA)\b/i.test(sample) ||
    /\bCREATE\s+TYPE\b[\s\S]{0,80}\bAS\s+ENUM\b/i.test(sample) ||
    /\bCOPY\s+[\w."]+\s*(?:\([^)]*\))?\s+FROM\s+stdin\s*;/i.test(sample) ||
    /::[a-z_]+/i.test(sample)
  ) {
    return 'postgresql';
  }
  if (
    /`[A-Za-z_][A-Za-z0-9_]*`/.test(sample) ||
    /\bAUTO_INCREMENT\b/i.test(sample) ||
    /\bENGINE\s*=\s*(?:InnoDB|MyISAM)/i.test(sample)
  ) {
    return 'mysql';
  }
  if (
    /\bAUTOINCREMENT\b/i.test(sample) ||
    /\bWITHOUT\s+ROWID\b/i.test(sample) ||
    /^\s*PRAGMA\s+/im.test(sample)
  ) {
    return 'sqlite';
  }
  if (/\bVARCHAR2\b/i.test(sample) || /\bNVARCHAR2\b/i.test(sample) || /\bNUMBER\s*\(\s*\d+/i.test(sample)) {
    return 'oracle';
  }
  if (/\bCREATE\s+TABLE\b/i.test(sample)) {
    return 'mysql';
  }
  return 'csv';
}

/**
 * Preprocess PostgreSQL `COPY table (cols) FROM stdin; ... \.` blocks before SQL tokenization,
 * extracting rows and stripping the stdin data block cleanly.
 */
function extractPostgresCopyBlocks(
  raw: string,
): { sql: string; copyRowsByTable: Map<string, Array<Record<string, unknown>>>; warnings: string[] } {
  const copyRowsByTable = new Map<string, Array<Record<string, unknown>>>();
  const warnings: string[] = [];
  if (!/\bCOPY\s+/i.test(raw)) {
    return { sql: raw, copyRowsByTable, warnings };
  }

  const lines = raw.split(/\r?\n/);
  const outLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(
      /^\s*COPY\s+((?:"[^"]+"|[\w]+)(?:\.(?:"[^"]+"|[\w]+))?)\s*(?:\(([^)]*)\))?\s+FROM\s+stdin\s*;\s*$/i,
    );
    if (!match) {
      outLines.push(line);
      i++;
      continue;
    }

    const fullTable = match[1];
    const tablePart = fullTable.includes('.') ? fullTable.split('.').pop()! : fullTable;
    const tableKey = normalizeTableKey(tablePart);
    const cols = match[2]
      ? match[2]
          .split(',')
          .map((c) => c.trim().replace(/^"+|"+$/g, ''))
          .filter(Boolean)
      : [];

    const existing = copyRowsByTable.get(tableKey) ?? [];
    i++;
    while (i < lines.length) {
      const dataLine = lines[i];
      if (dataLine === '\\.' || dataLine === '\\.\r') {
        i++;
        break;
      }
      if (existing.length < MAX_INLINE_ROWS_PER_TABLE) {
        const rawCells = dataLine.split('\t');
        const row: Record<string, unknown> = {};
        for (let c = 0; c < rawCells.length; c++) {
          const colName = cols[c] || `col_${c + 1}`;
          const cell = rawCells[c];
          if (cell === '\\N') {
            row[colName] = null;
          } else {
            row[colName] = unescapeCopyCell(cell);
          }
        }
        existing.push(row);
      }
      i++;
    }
    copyRowsByTable.set(tableKey, existing);
  }

  return { sql: outLines.join('\n'), copyRowsByTable, warnings };
}

function unescapeCopyCell(cell: string): string {
  let out = '';
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] === '\\' && i + 1 < cell.length) {
      const next = cell[i + 1];
      if (next === 't') out += '\t';
      else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === '\\') out += '\\';
      else out += next;
      i++;
    } else {
      out += cell[i];
    }
  }
  return out;
}

/**
 * Strip T-SQL `GO` batch separators and Oracle `/` standalone lines, plus MySQL `DELIMITER` lines,
 * turning batch separators into semicolons so statement splitting works uniformly.
 */
function normalizeBatchSeparators(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^DELIMITER\s+/i.test(trimmed)) continue;
    if (/^GO(?:\s+\d+)?$/i.test(trimmed) || trimmed === '/') {
      out.push(';');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Tokenize SQL across MySQL, PostgreSQL, MSSQL, SQLite, and Oracle. */
function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }

    // Line comments: -- or # (MySQL)
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      i += ch === '-' ? 2 : 1;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // Block comments: /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // PostgreSQL dollar-quoted strings: $tag$...$tag$ or $$...$$
    if (ch === '$') {
      const tagMatch = sql.slice(i, i + 40).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const delim = tagMatch[0];
        const start = i + delim.length;
        const end = sql.indexOf(delim, start);
        if (end >= 0) {
          const val = sql.slice(start, end);
          tokens.push({ type: 'string', value: val, upper: val.toUpperCase() });
          i = end + delim.length;
          continue;
        }
      }
    }

    // Prefixed strings: N'...', E'...', B'...', X'...'
    if (
      (ch === 'N' || ch === 'n' || ch === 'E' || ch === 'e' || ch === 'B' || ch === 'b' || ch === 'X' || ch === 'x') &&
      sql[i + 1] === "'"
    ) {
      const prefix = ch.toUpperCase();
      i += 2;
      const parsed = readSingleQuotedString(sql, i, prefix === 'E');
      tokens.push({ type: 'string', value: parsed.value, upper: parsed.value.toUpperCase() });
      i = parsed.nextIndex;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      const parsed = readSingleQuotedString(sql, i + 1, true);
      tokens.push({ type: 'string', value: parsed.value, upper: parsed.value.toUpperCase() });
      i = parsed.nextIndex;
      continue;
    }

    // Quoted identifiers: `...`, "...", [...]
    if (ch === '`' || ch === '"') {
      const quote = ch;
      i++;
      let val = '';
      while (i < len) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            val += quote;
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          val += sql[i++];
        }
      }
      tokens.push({ type: 'ident', value: val, upper: val.toUpperCase(), quoted: true });
      continue;
    }

    if (ch === '[') {
      i++;
      let val = '';
      while (i < len && sql[i] !== ']') {
        if (sql[i] === ']' && sql[i + 1] === ']') {
          val += ']';
          i += 2;
        } else {
          val += sql[i++];
        }
      }
      if (sql[i] === ']') i++;
      tokens.push({ type: 'ident', value: val, upper: val.toUpperCase(), quoted: true });
      continue;
    }

    // Numbers (including negative numbers only handled as symbol '-' + number in values)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && sql[i + 1] >= '0' && sql[i + 1] <= '9')) {
      const start = i;
      i++;
      while (i < len && ((sql[i] >= '0' && sql[i] <= '9') || sql[i] === '.')) i++;
      if (i < len && (sql[i] === 'e' || sql[i] === 'E')) {
        i++;
        if (i < len && (sql[i] === '+' || sql[i] === '-')) i++;
        while (i < len && sql[i] >= '0' && sql[i] <= '9') i++;
      }
      const val = sql.slice(start, i);
      tokens.push({ type: 'number', value: val, upper: val });
      continue;
    }

    // Identifiers / keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      i++;
      while (
        i < len &&
        ((sql[i] >= 'a' && sql[i] <= 'z') ||
          (sql[i] >= 'A' && sql[i] <= 'Z') ||
          (sql[i] >= '0' && sql[i] <= '9') ||
          sql[i] === '_' ||
          sql[i] === '$')
      ) {
        i++;
      }
      const val = sql.slice(start, i);
      tokens.push({ type: 'word', value: val, upper: val.toUpperCase() });
      continue;
    }

    // Two-character symbols (::, !=, <>, <=, >=)
    if (
      (ch === ':' && sql[i + 1] === ':') ||
      (ch === '!' && sql[i + 1] === '=') ||
      (ch === '<' && (sql[i + 1] === '>' || sql[i + 1] === '=')) ||
      (ch === '>' && sql[i + 1] === '=')
    ) {
      const val = sql.slice(i, i + 2);
      tokens.push({ type: 'symbol', value: val, upper: val });
      i += 2;
      continue;
    }

    tokens.push({ type: 'symbol', value: ch, upper: ch });
    i++;
  }

  return tokens;
}

function readSingleQuotedString(
  sql: string,
  startIdx: number,
  allowBackslashEscape: boolean,
): { value: string; nextIndex: number } {
  let i = startIdx;
  const len = sql.length;
  let val = '';
  while (i < len) {
    const ch = sql[i];
    if (allowBackslashEscape && ch === '\\' && i + 1 < len) {
      const next = sql[i + 1];
      if (next === 'n') val += '\n';
      else if (next === 'r') val += '\r';
      else if (next === 't') val += '\t';
      else if (next === '0') val += '\0';
      else val += next;
      i += 2;
    } else if (ch === "'") {
      if (sql[i + 1] === "'") {
        val += "'";
        i += 2;
      } else {
        i++;
        break;
      }
    } else {
      val += ch;
      i++;
    }
  }
  return { value: val, nextIndex: i };
}

/** Split flat tokens into statements separated by top-level `;`. */
function splitStatements(tokens: Token[]): Token[][] {
  const stmts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;

  for (const tok of tokens) {
    if (tok.type === 'symbol' && tok.value === '(') {
      depth++;
      cur.push(tok);
    } else if (tok.type === 'symbol' && tok.value === ')') {
      depth = Math.max(0, depth - 1);
      cur.push(tok);
    } else if (tok.type === 'symbol' && tok.value === ';' && depth === 0) {
      if (cur.length > 0) stmts.push(cur);
      cur = [];
    } else {
      cur.push(tok);
    }
  }
  if (cur.length > 0) stmts.push(cur);
  return stmts;
}

function isIdentLike(tok: Token | undefined): boolean {
  return !!tok && (tok.type === 'word' || tok.type === 'ident');
}

/** Read a possibly schema-qualified identifier (`dbo.Users`, `public."orders"`, `catalog.schema.tbl`). */
function readQualifiedName(
  tokens: Token[],
  startIdx: number,
): { schemaName?: string; name: string; nextIndex: number } | null {
  if (!isIdentLike(tokens[startIdx])) return null;
  const parts: string[] = [tokens[startIdx].value];
  let idx = startIdx + 1;
  while (tokens[idx]?.type === 'symbol' && tokens[idx].value === '.' && isIdentLike(tokens[idx + 1])) {
    parts.push(tokens[idx + 1].value);
    idx += 2;
  }
  const name = parts[parts.length - 1];
  const schemaName = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return { schemaName, name, nextIndex: idx };
}

/** Find the index of the matching `)` for a `(` at openIdx. */
function findMatchingParen(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === 'symbol' && tokens[i].value === '(') depth++;
    else if (tokens[i].type === 'symbol' && tokens[i].value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a token slice at top-level commas. */
function splitByComma(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.type === 'symbol' && tok.value === '(') {
      depth++;
      cur.push(tok);
    } else if (tok.type === 'symbol' && tok.value === ')') {
      depth = Math.max(0, depth - 1);
      cur.push(tok);
    } else if (tok.type === 'symbol' && tok.value === ',' && depth === 0) {
      if (cur.length > 0) parts.push(cur);
      cur = [];
    } else {
      cur.push(tok);
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** Read a parenthesized list of column names: `(col1, col2 DESC)`. */
function readColumnList(tokens: Token[], openIdx: number): { cols: string[]; nextIndex: number } | null {
  if (tokens[openIdx]?.type !== 'symbol' || tokens[openIdx].value !== '(') return null;
  const closeIdx = findMatchingParen(tokens, openIdx);
  if (closeIdx < 0) return null;
  const cols: string[] = [];
  for (const part of splitByComma(tokens.slice(openIdx + 1, closeIdx))) {
    if (isIdentLike(part[0])) {
      cols.push(part[0].value);
    }
  }
  return { cols, nextIndex: closeIdx + 1 };
}

/** Extract string choices from CHECK (col IN ('a', 'b', ...)) or CHECK (col = 'a' OR col = 'b'). */
function extractCheckChoices(tokens: Token[]): { column?: string; choices: string[] } | null {
  // Unwrap outer parentheses
  let inner = tokens;
  while (
    inner.length >= 2 &&
    inner[0].type === 'symbol' &&
    inner[0].value === '(' &&
    findMatchingParen(inner, 0) === inner.length - 1
  ) {
    inner = inner.slice(1, -1);
  }

  // Pattern 1: col IN ('a', 'b', ...)
  for (let i = 0; i < inner.length - 2; i++) {
    if (isIdentLike(inner[i]) && inner[i + 1].upper === 'IN' && inner[i + 2].value === '(') {
      const close = findMatchingParen(inner, i + 2);
      if (close > i + 2) {
        const vals = inner
          .slice(i + 3, close)
          .filter((t) => t.type === 'string')
          .map((t) => t.value);
        if (vals.length >= 2) {
          return { column: inner[i].value, choices: vals };
        }
      }
    }
  }

  // Pattern 2: col = 'a' OR col = 'b'
  const eqCols = new Set<string>();
  const eqVals: string[] = [];
  for (let i = 0; i < inner.length - 2; i++) {
    if (isIdentLike(inner[i]) && inner[i + 1].value === '=' && inner[i + 2].type === 'string') {
      eqCols.add(inner[i].value);
      eqVals.push(inner[i + 2].value);
    }
  }
  if (eqCols.size === 1 && eqVals.length >= 2) {
    return { column: Array.from(eqCols)[0], choices: eqVals };
  }
  return null;
}

const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  'NOT',
  'NULL',
  'PRIMARY',
  'UNIQUE',
  'DEFAULT',
  'CHECK',
  'REFERENCES',
  'CONSTRAINT',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'IDENTITY',
  'GENERATED',
  'COLLATE',
  'COMMENT',
  'ON',
  'AS',
  'CHARACTER',
  'CHARSET',
  'UNSIGNED',
  'ZEROFILL',
  'STORED',
  'VIRTUAL',
]);

function parseColumnDefinition(
  tokens: Token[],
  customEnums: Map<string, string[]>,
): { column: ImportedColumn; tableLevelFks: ImportedForeignKey[] } | null {
  if (!isIdentLike(tokens[0])) return null;
  const colName = tokens[0].value;
  let i = 1;

  // Read SQL data type (may be multi-word like DOUBLE PRECISION, TIMESTAMP WITH TIME ZONE,
  // CHARACTER VARYING(255), INT UNSIGNED, ENUM('a','b'), or schema.enum_type).
  const typeParts: string[] = [];
  let enumValues: string[] | undefined;

  while (i < tokens.length) {
    const tok = tokens[i];
    const upper = tok.upper;

    // Stop when we reach column constraint keywords (except UNSIGNED / CHARACTER VARYING / WITH TIME ZONE).
    if (
      typeParts.length > 0 &&
      COLUMN_CONSTRAINT_KEYWORDS.has(upper) &&
      upper !== 'UNSIGNED' &&
      upper !== 'ZEROFILL' &&
      !(upper === 'CHARACTER' && tokens[i + 1]?.upper === 'VARYING')
    ) {
      break;
    }

    if ((upper === 'ENUM' || upper === 'SET') && tokens[i + 1]?.value === '(') {
      const close = findMatchingParen(tokens, i + 1);
      if (close > i + 1) {
        enumValues = tokens
          .slice(i + 2, close)
          .filter((t) => t.type === 'string')
          .map((t) => t.value);
        typeParts.push(`${upper}(${enumValues.length})`);
        i = close + 1;
        continue;
      }
    }

    if (tok.type === 'symbol' && tok.value === '(') {
      const close = findMatchingParen(tokens, i);
      if (close > i) {
        const args = tokens
          .slice(i + 1, close)
          .map((t) => t.value)
          .join('');
        if (typeParts.length > 0) {
          typeParts[typeParts.length - 1] += `(${args})`;
        } else {
          typeParts.push(`(${args})`);
        }
        i = close + 1;
        continue;
      }
    }

    // Handle PostgreSQL array suffix `[]`
    if (tok.type === 'symbol' && tok.value === '[' && tokens[i + 1]?.value === ']') {
      if (typeParts.length > 0) typeParts[typeParts.length - 1] += '[]';
      i += 2;
      continue;
    }

    // Handle schema-qualified custom enum type (`public.deal_stage`)
    if (tok.type === 'symbol' && tok.value === '.' && typeParts.length > 0 && isIdentLike(tokens[i + 1])) {
      typeParts[typeParts.length - 1] += `.${tokens[i + 1].value}`;
      i += 2;
      continue;
    }

    // Allow multi-word SQL types like WITH TIME ZONE, WITHOUT TIME ZONE, PRECISION, VARYING, INT
    if (
      typeParts.length === 0 ||
      ['VARYING', 'PRECISION', 'WITH', 'WITHOUT', 'TIME', 'ZONE', 'UNSIGNED', 'SIGNED', 'ZEROFILL', 'INT', 'INTEGER', 'DOUBLE', 'LONG', 'BYTE'].includes(upper)
    ) {
      typeParts.push(tok.value);
      i++;
      continue;
    }
    break;
  }

  const rawType = typeParts.join(' ').trim() || 'TEXT';
  const baseTypeKey = rawType.split('(')[0].trim().toLowerCase();
  const unqualifiedTypeKey = baseTypeKey.includes('.') ? baseTypeKey.split('.').pop()! : baseTypeKey;

  if (!enumValues) {
    const registered = customEnums.get(baseTypeKey) ?? customEnums.get(unqualifiedTypeKey);
    if (registered) {
      enumValues = [...registered];
    }
  }

  let nullable = true;
  let isPrimaryKey = false;
  let isAutoIncrement = /\b(?:SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(rawType);
  let isUnique = false;
  let defaultValue: string | undefined;
  let comment: string | undefined;
  let foreignKey: ImportedForeignKey | undefined;
  const tableLevelFks: ImportedForeignKey[] = [];

  while (i < tokens.length) {
    const tok = tokens[i];
    const u = tok.upper;

    if (u === 'NOT' && tokens[i + 1]?.upper === 'NULL') {
      nullable = false;
      i += 2;
      continue;
    }
    if (u === 'NULL') {
      nullable = true;
      i++;
      continue;
    }
    if (u === 'PRIMARY' && tokens[i + 1]?.upper === 'KEY') {
      isPrimaryKey = true;
      nullable = false;
      i += 2;
      continue;
    }
    if (u === 'UNIQUE') {
      isUnique = true;
      i += tokens[i + 1]?.upper === 'KEY' ? 2 : 1;
      continue;
    }
    if (u === 'AUTO_INCREMENT' || u === 'AUTOINCREMENT') {
      isAutoIncrement = true;
      i++;
      continue;
    }
    if (u === 'IDENTITY') {
      isAutoIncrement = true;
      i++;
      if (tokens[i]?.value === '(') {
        const close = findMatchingParen(tokens, i);
        i = close > i ? close + 1 : i + 1;
      }
      continue;
    }
    if (u === 'GENERATED') {
      // GENERATED ALWAYS|BY DEFAULT AS IDENTITY
      let j = i + 1;
      while (j < tokens.length && j < i + 7) {
        if (tokens[j].upper === 'IDENTITY') {
          isAutoIncrement = true;
          i = j + 1;
          break;
        }
        j++;
      }
      if (i <= j) i++;
      continue;
    }
    if (u === 'DEFAULT') {
      i++;
      const defParts: string[] = [];
      let depth = 0;
      while (i < tokens.length) {
        const cur = tokens[i];
        if (cur.value === '(') depth++;
        else if (cur.value === ')') {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && COLUMN_CONSTRAINT_KEYWORDS.has(cur.upper) && cur.upper !== 'NULL') {
          break;
        }
        defParts.push(cur.value);
        i++;
      }
      if (defParts.length > 0) {
        defaultValue = defParts.join(' ');
      }
      continue;
    }
    if (u === 'COMMENT' && tokens[i + 1]?.type === 'string') {
      comment = tokens[i + 1].value;
      i += 2;
      continue;
    }
    if (u === 'CHECK' && tokens[i + 1]?.value === '(') {
      const close = findMatchingParen(tokens, i + 1);
      if (close > i + 1) {
        const check = extractCheckChoices(tokens.slice(i + 2, close));
        if (check && check.choices.length >= 2 && !enumValues) {
          enumValues = check.choices;
        }
        i = close + 1;
        continue;
      }
    }
    if (u === 'REFERENCES') {
      const target = readQualifiedName(tokens, i + 1);
      if (target) {
        i = target.nextIndex;
        let targetColumn = 'id';
        if (tokens[i]?.value === '(') {
          const cols = readColumnList(tokens, i);
          if (cols && cols.cols.length > 0) {
            targetColumn = cols.cols[0];
            i = cols.nextIndex;
          }
        }
        let onDelete: string | undefined;
        if (tokens[i]?.upper === 'ON' && tokens[i + 1]?.upper === 'DELETE') {
          onDelete = tokens[i + 2]?.upper;
          i += 3;
          if (onDelete === 'SET' && tokens[i]?.upper === 'NULL') {
            onDelete = 'SET NULL';
            i++;
          } else if (onDelete === 'NO' && tokens[i]?.upper === 'ACTION') {
            onDelete = 'NO ACTION';
            i++;
          }
        }
        foreignKey = {
          column: colName,
          targetTable: target.name,
          targetColumn,
          onDelete,
        };
        tableLevelFks.push(foreignKey);
        continue;
      }
    }
    i++;
  }

  return {
    column: {
      name: colName,
      rawType,
      normalizedType: baseTypeKey,
      nullable,
      isPrimaryKey,
      isAutoIncrement,
      isUnique,
      defaultValue,
      enumValues,
      foreignKey,
      comment,
    },
    tableLevelFks,
  };
}

/** Parse a SQL value expression inside `INSERT ... VALUES (...)` into a JS scalar. */
function parseSqlValueTokens(tokens: Token[]): unknown {
  if (tokens.length === 0) return null;

  // Strip PostgreSQL type casts like `'foo'::text` or `'2026-01-01'::date`
  const castIdx = tokens.findIndex((t) => t.type === 'symbol' && t.value === '::');
  const core = castIdx >= 0 ? tokens.slice(0, castIdx) : tokens;
  if (core.length === 0) return null;

  if (core.length === 1) {
    const t = core[0];
    if (t.type === 'string') return t.value;
    if (t.type === 'number') return Number(t.value);
    if (t.type === 'word') {
      if (t.upper === 'NULL' || t.upper === 'DEFAULT') return null;
      if (t.upper === 'TRUE') return true;
      if (t.upper === 'FALSE') return false;
      return t.value;
    }
  }
  if (core.length === 2 && core[0].value === '-' && core[1].type === 'number') {
    return -Number(core[1].value);
  }
  if (core.length === 2 && core[0].value === '+' && core[1].type === 'number') {
    return Number(core[1].value);
  }
  return core.map((t) => t.value).join(' ');
}

/** Parse a SQL DDL / SQL dump string across MySQL, PostgreSQL, MSSQL, SQLite, and Oracle. */
export function parseSqlSchema(
  rawSql: string,
  requestedDialect: SqlDialect = 'auto',
  sourceLabel = 'Pasted SQL',
): ImportedSchema {
  const cleaned = stripBom(rawSql);
  const dialect: ResolvedDialect =
    requestedDialect === 'auto' ? detectSchemaDialect(cleaned) : requestedDialect;

  if (dialect === 'prisma') {
    return parsePrismaSchema(cleaned, sourceLabel);
  }
  if (dialect === 'json') {
    return parseJsonSchemaOrData(cleaned, sourceLabel);
  }
  if (dialect === 'csv') {
    return parseCsvAsSchema(cleaned, sourceLabel);
  }

  const { sql: withoutCopy, copyRowsByTable, warnings } = extractPostgresCopyBlocks(cleaned);
  const normalized = normalizeBatchSeparators(withoutCopy);
  const tokens = tokenizeSql(normalized);
  const statements = splitStatements(tokens);

  const customEnums = new Map<string, string[]>();
  const tablesByKey = new Map<string, ImportedTable>();
  const tableOrder: string[] = [];

  for (const stmt of statements) {
    if (stmt.length < 3) continue;
    const w0 = stmt[0].upper;
    const w1 = stmt[1].upper;

    // CREATE TYPE [schema.]name AS ENUM ('a', 'b', ...)
    if (w0 === 'CREATE' && w1 === 'TYPE') {
      const typeName = readQualifiedName(stmt, 2);
      if (typeName) {
        const idx = typeName.nextIndex;
        if (stmt[idx]?.upper === 'AS' && stmt[idx + 1]?.upper === 'ENUM' && stmt[idx + 2]?.value === '(') {
          const close = findMatchingParen(stmt, idx + 2);
          if (close > idx + 2) {
            const vals = stmt
              .slice(idx + 3, close)
              .filter((t) => t.type === 'string')
              .map((t) => t.value);
            if (vals.length > 0) {
              customEnums.set(typeName.name.toLowerCase(), vals);
              if (typeName.schemaName) {
                customEnums.set(`${typeName.schemaName.toLowerCase()}.${typeName.name.toLowerCase()}`, vals);
              }
            }
          }
        }
      }
      continue;
    }

    // CREATE [TEMP|TEMPORARY|UNLOGGED|GLOBAL] TABLE [IF NOT EXISTS] name ( ... )
    if (w0 === 'CREATE') {
      let idx = 1;
      while (idx < stmt.length && ['TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL'].includes(stmt[idx].upper)) {
        idx++;
      }
      if (stmt[idx]?.upper === 'TABLE') {
        idx++;
        if (stmt[idx]?.upper === 'IF' && stmt[idx + 1]?.upper === 'NOT' && stmt[idx + 2]?.upper === 'EXISTS') {
          idx += 3;
        }
        const tbl = readQualifiedName(stmt, idx);
        if (!tbl) continue;
        const openParen = stmt.findIndex((t, pos) => pos >= tbl.nextIndex && t.type === 'symbol' && t.value === '(');
        if (openParen < 0) continue;
        const closeParen = findMatchingParen(stmt, openParen);
        if (closeParen < 0) continue;

        const key = normalizeTableKey(tbl.name);
        const columns: ImportedColumn[] = [];
        const primaryKeys: string[] = [];
        const foreignKeys: ImportedForeignKey[] = [];

        const bodyItems = splitByComma(stmt.slice(openParen + 1, closeParen));
        for (const item of bodyItems) {
          if (item.length === 0) continue;
          let pos = 0;
          if (item[0].upper === 'CONSTRAINT') {
            pos = isIdentLike(item[1]) ? 2 : 1;
          }
          const head = item[pos]?.upper;

          // Ignore non-structural index directives inside MySQL CREATE TABLE.
          if (
            head === 'KEY' ||
            head === 'INDEX' ||
            head === 'FULLTEXT' ||
            head === 'SPATIAL'
          ) {
            continue;
          }

          // Table-level PRIMARY KEY [CLUSTERED|NONCLUSTERED] (col1, ...)
          if (head === 'PRIMARY' && item[pos + 1]?.upper === 'KEY') {
            const pOpen = item.findIndex((t, idx2) => idx2 > pos + 1 && t.value === '(');
            if (pOpen > 0) {
              const list = readColumnList(item, pOpen);
              if (list) {
                for (const c of list.cols) {
                  if (!primaryKeys.includes(c)) primaryKeys.push(c);
                }
              }
            }
            continue;
          }

          // Table-level UNIQUE [KEY|INDEX] [name] (col1, ...)
          if (head === 'UNIQUE') {
            const pOpen = item.findIndex((t, idx2) => idx2 > pos && t.value === '(');
            if (pOpen > 0) {
              const list = readColumnList(item, pOpen);
              if (list && list.cols.length === 1) {
                const targetCol = columns.find((c) => c.name.toLowerCase() === list.cols[0].toLowerCase());
                if (targetCol) targetCol.isUnique = true;
              }
            }
            continue;
          }

          // Table-level CHECK (...)
          if (head === 'CHECK') {
            const pOpen = item.findIndex((t, idx2) => idx2 > pos && t.value === '(');
            if (pOpen > 0) {
              const pClose = findMatchingParen(item, pOpen);
              if (pClose > pOpen) {
                const check = extractCheckChoices(item.slice(pOpen + 1, pClose));
                if (check?.column && check.choices.length >= 2) {
                  const targetCol = columns.find((c) => c.name.toLowerCase() === check.column!.toLowerCase());
                  if (targetCol && !targetCol.enumValues) {
                    targetCol.enumValues = check.choices;
                  }
                }
              }
            }
            continue;
          }

          // Table-level FOREIGN KEY (col) REFERENCES target (targetCol)
          if (head === 'FOREIGN' && item[pos + 1]?.upper === 'KEY') {
            const fkOpen = item.findIndex((t, idx2) => idx2 > pos + 1 && t.value === '(');
            if (fkOpen > 0) {
              const fkCols = readColumnList(item, fkOpen);
              if (fkCols && fkCols.cols.length > 0) {
                const refIdx = item.findIndex((t, idx2) => idx2 >= fkCols.nextIndex && t.upper === 'REFERENCES');
                if (refIdx > 0) {
                  const refTbl = readQualifiedName(item, refIdx + 1);
                  if (refTbl) {
                    const refCols = readColumnList(item, refTbl.nextIndex);
                    const targetCol = refCols?.cols[0] ?? 'id';
                    const fk: ImportedForeignKey = {
                      column: fkCols.cols[0],
                      targetTable: refTbl.name,
                      targetColumn: targetCol,
                    };
                    foreignKeys.push(fk);
                  }
                }
              }
            }
            continue;
          }

          // Column definition
          const parsedCol = parseColumnDefinition(item, customEnums);
          if (parsedCol) {
            columns.push(parsedCol.column);
            if (parsedCol.column.isPrimaryKey && !primaryKeys.includes(parsedCol.column.name)) {
              primaryKeys.push(parsedCol.column.name);
            }
            for (const fk of parsedCol.tableLevelFks) {
              foreignKeys.push(fk);
            }
          }
        }

        // Propagate table-level PKs and FKs onto column records.
        for (const pk of primaryKeys) {
          const col = columns.find((c) => c.name.toLowerCase() === pk.toLowerCase());
          if (col) {
            col.isPrimaryKey = true;
            col.nullable = false;
          }
        }
        for (const fk of foreignKeys) {
          const col = columns.find((c) => c.name.toLowerCase() === fk.column.toLowerCase());
          if (col && !col.foreignKey) {
            col.foreignKey = fk;
          }
        }

        if (columns.length > 0) {
          if (!tablesByKey.has(key)) tableOrder.push(key);
          tablesByKey.set(key, {
            key,
            name: tbl.name,
            schemaName: tbl.schemaName,
            columns,
            primaryKeys,
            foreignKeys,
            rows: [],
          });
        }
      }
      continue;
    }

    // ALTER TABLE name ADD [CONSTRAINT ...] FOREIGN KEY / PRIMARY KEY / COLUMN
    if (w0 === 'ALTER' && w1 === 'TABLE') {
      let idx = 2;
      if (stmt[idx]?.upper === 'ONLY') idx++;
      const tbl = readQualifiedName(stmt, idx);
      if (!tbl) continue;
      const key = normalizeTableKey(tbl.name);
      const table = tablesByKey.get(key);
      if (!table) continue;

      // Scan clauses (an ALTER TABLE can contain comma-separated ADD clauses)
      const clauses = splitByComma(stmt.slice(tbl.nextIndex));
      for (const clause of clauses) {
        let pos = 0;
        // Skip T-SQL WITH CHECK / WITH NOCHECK
        if (clause[pos]?.upper === 'WITH' && (clause[pos + 1]?.upper === 'CHECK' || clause[pos + 1]?.upper === 'NOCHECK')) {
          pos += 2;
        }
        if (clause[pos]?.upper !== 'ADD') continue;
        pos++;
        if (clause[pos]?.upper === 'CONSTRAINT') {
          pos += isIdentLike(clause[pos + 1]) ? 2 : 1;
        }
        const kind = clause[pos]?.upper;
        if (kind === 'FOREIGN' && clause[pos + 1]?.upper === 'KEY') {
          const fkOpen = clause.findIndex((t, k) => k > pos + 1 && t.value === '(');
          const fkCols = fkOpen > 0 ? readColumnList(clause, fkOpen) : null;
          const refIdx = fkCols ? clause.findIndex((t, k) => k >= fkCols.nextIndex && t.upper === 'REFERENCES') : -1;
          if (fkCols && fkCols.cols.length > 0 && refIdx > 0) {
            const refTbl = readQualifiedName(clause, refIdx + 1);
            if (refTbl) {
              const refCols = readColumnList(clause, refTbl.nextIndex);
              const fk: ImportedForeignKey = {
                column: fkCols.cols[0],
                targetTable: refTbl.name,
                targetColumn: refCols?.cols[0] ?? 'id',
              };
              const exists = table.foreignKeys.some(
                (existing) => existing.column.toLowerCase() === fk.column.toLowerCase(),
              );
              if (!exists) {
                table.foreignKeys.push(fk);
                const col = table.columns.find((c) => c.name.toLowerCase() === fk.column.toLowerCase());
                if (col) col.foreignKey = fk;
              }
            }
          }
        } else if (kind === 'PRIMARY' && clause[pos + 1]?.upper === 'KEY') {
          const pkOpen = clause.findIndex((t, k) => k > pos + 1 && t.value === '(');
          const pkCols = pkOpen > 0 ? readColumnList(clause, pkOpen) : null;
          if (pkCols) {
            for (const c of pkCols.cols) {
              if (!table.primaryKeys.includes(c)) table.primaryKeys.push(c);
              const col = table.columns.find((col2) => col2.name.toLowerCase() === c.toLowerCase());
              if (col) {
                col.isPrimaryKey = true;
                col.nullable = false;
              }
            }
          }
        } else if (kind === 'COLUMN' || (isIdentLike(clause[pos]) && !['UNIQUE', 'CHECK', 'INDEX', 'KEY', 'DEFAULT'].includes(kind || ''))) {
          if (kind === 'COLUMN') pos++;
          const parsedCol = parseColumnDefinition(clause.slice(pos), customEnums);
          if (parsedCol && !table.columns.some((c) => c.name.toLowerCase() === parsedCol.column.name.toLowerCase())) {
            table.columns.push(parsedCol.column);
            for (const fk of parsedCol.tableLevelFks) table.foreignKeys.push(fk);
          }
        }
      }
      continue;
    }

    // INSERT [OR ...] [IGNORE] [INTO] table [(cols)] VALUES (...), (...)
    if (w0 === 'INSERT') {
      let idx = 1;
      if (stmt[idx]?.upper === 'OR' && isIdentLike(stmt[idx + 1])) idx += 2;
      if (stmt[idx]?.upper === 'IGNORE') idx++;
      if (stmt[idx]?.upper === 'INTO') idx++;
      const tbl = readQualifiedName(stmt, idx);
      if (!tbl) continue;
      const key = normalizeTableKey(tbl.name);
      const table = tablesByKey.get(key);
      if (!table) continue;

      let pos = tbl.nextIndex;
      let colNames = table.columns.map((c) => c.name);
      if (stmt[pos]?.value === '(') {
        const list = readColumnList(stmt, pos);
        if (list && list.cols.length > 0) {
          colNames = list.cols;
          pos = list.nextIndex;
        }
      }
      const valuesIdx = stmt.findIndex((t, k) => k >= pos && t.upper === 'VALUES');
      if (valuesIdx < 0) continue;

      let cur = valuesIdx + 1;
      while (cur < stmt.length && table.rows.length < MAX_INLINE_ROWS_PER_TABLE) {
        if (stmt[cur].value === '(') {
          const close = findMatchingParen(stmt, cur);
          if (close < 0) break;
          const valueExprs = splitByComma(stmt.slice(cur + 1, close));
          const rowObj: Record<string, unknown> = {};
          for (let c = 0; c < valueExprs.length; c++) {
            const colName = colNames[c] ?? `col_${c + 1}`;
            rowObj[colName] = parseSqlValueTokens(valueExprs[c]);
          }
          table.rows.push(rowObj);
          cur = close + 1;
          if (stmt[cur]?.value === ',') cur++;
        } else {
          // Stop at ON DUPLICATE KEY / ON CONFLICT / RETURNING
          if (stmt[cur].upper === 'ON' || stmt[cur].upper === 'RETURNING') break;
          cur++;
        }
      }
    }
  }

  // Merge PostgreSQL COPY rows into matching tables.
  for (const [key, copyRows] of copyRowsByTable.entries()) {
    const table = tablesByKey.get(key);
    if (table) {
      for (const r of copyRows) {
        if (table.rows.length < MAX_INLINE_ROWS_PER_TABLE) {
          table.rows.push(r);
        }
      }
    }
  }

  const tables = tableOrder
    .map((k) => tablesByKey.get(k)!)
    .filter(Boolean)
    .map((t) => ({
      ...t,
      totalRowCount: t.rows.length > 0 ? t.rows.length : undefined,
    }));

  if (tables.length === 0) {
    warnings.push('No CREATE TABLE statements were found. Paste SQL DDL (CREATE TABLE ...), Prisma schema, JSON, or CSV.');
  }

  return {
    dialect,
    sourceLabel,
    tables,
    warnings,
  };
}

/** Parse a Prisma `.prisma` schema file (models + enums + @id + @relation). */
export function parsePrismaSchema(raw: string, sourceLabel = 'Prisma schema'): ImportedSchema {
  const text = stripBom(raw);
  const warnings: string[] = [];
  const enums = new Map<string, string[]>();

  // Extract enums first
  const enumRe = /enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(text)) !== null) {
    const name = em[1];
    const values = em[2]
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l && !l.startsWith('@@'));
    if (values.length > 0) enums.set(name, values);
  }

  const modelNames = new Set<string>();
  const modelRe = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  const rawModels: Array<{ name: string; body: string }> = [];
  let mm: RegExpExecArray | null;
  while ((mm = modelRe.exec(text)) !== null) {
    modelNames.add(mm[1]);
    rawModels.push({ name: mm[1], body: mm[2] });
  }

  const tables: ImportedTable[] = [];

  for (const model of rawModels) {
    const columns: ImportedColumn[] = [];
    const primaryKeys: string[] = [];
    const foreignKeys: ImportedForeignKey[] = [];
    const relationHints = new Map<string, ImportedForeignKey>();

    const lines = model.body
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean);

    // First pass: capture `@relation(fields: [customerId], references: [id])` lines
    for (const line of lines) {
      if (line.startsWith('@@')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\]|\?)?\s*(.*)$/);
      if (!m) continue;
      const [, , fieldType, , rest] = m;
      if (modelNames.has(fieldType)) {
        const relMatch = rest.match(/@relation\([^)]*fields:\s*\[\s*([A-Za-z0-9_]+)\s*\][^)]*references:\s*\[\s*([A-Za-z0-9_]+)\s*\]/);
        if (relMatch) {
          relationHints.set(relMatch[1], {
            column: relMatch[1],
            targetTable: fieldType,
            targetColumn: relMatch[2],
          });
        }
      }
    }

    // Second pass: capture scalar columns (skipping pure navigation relation fields)
    for (const line of lines) {
      if (line.startsWith('@@')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\]|\?)?\s*(.*)$/);
      if (!m) continue;
      const [, colName, rawType, modifier, rest] = m;
      if (modelNames.has(rawType)) continue; // navigation field, not scalar column

      const nullable = modifier === '?';
      const isPrimaryKey = /@id\b/.test(rest);
      const isAutoIncrement = /@default\(\s*autoincrement\s*\(\s*\)\s*\)/.test(rest);
      const isUnique = /@unique\b/.test(rest);
      const fk = relationHints.get(colName);
      if (isPrimaryKey) primaryKeys.push(colName);
      if (fk) foreignKeys.push(fk);

      columns.push({
        name: colName,
        rawType: modifier ? `${rawType}${modifier}` : rawType,
        normalizedType: rawType.toLowerCase(),
        nullable: isPrimaryKey ? false : nullable,
        isPrimaryKey,
        isAutoIncrement,
        isUnique,
        enumValues: enums.get(rawType),
        foreignKey: fk,
      });
    }

    if (columns.length > 0) {
      tables.push({
        key: normalizeTableKey(model.name),
        name: model.name,
        columns,
        primaryKeys,
        foreignKeys,
        rows: [],
      });
    }
  }

  if (tables.length === 0) {
    warnings.push('No Prisma `model` definitions found.');
  }

  return {
    dialect: 'prisma',
    sourceLabel,
    tables,
    warnings,
  };
}

/** Infer a table schema + rows from a JSON array, multi-table JSON object, or JSON Schema. */
export function parseJsonSchemaOrData(raw: string, sourceLabel = 'JSON data'): ImportedSchema {
  const warnings: string[] = [];
  const text = stripBom(raw).trim();
  const tables: ImportedTable[] = [];

  try {
    const parsed: unknown = JSON.parse(text);

    // Case 1: Multi-table export `{ tables: [...] }` or `{ customers: [...], orders: [...] }`
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const arrayEntries = Object.entries(rec).filter(
        ([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null,
      );
      if (arrayEntries.length > 0) {
        for (const [tableName, list] of arrayEntries) {
          const rows = (list as unknown[]).filter(
            (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
          );
          tables.push(inferTableFromRows(tableName, rows));
        }
        return { dialect: 'json', sourceLabel, tables, warnings };
      }

      // Case 2: JSON Schema `{ title, properties: { ... }, required: [...] }`
      if (rec.properties && typeof rec.properties === 'object' && !Array.isArray(rec.properties)) {
        const requiredSet = new Set(Array.isArray(rec.required) ? rec.required.map(String) : []);
        const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : 'records';
        const columns: ImportedColumn[] = [];
        for (const [colName, prop] of Object.entries(rec.properties as Record<string, unknown>)) {
          const p = (prop && typeof prop === 'object' ? prop : {}) as Record<string, unknown>;
          const rawType = typeof p.format === 'string' ? p.format : String(p.type || 'string');
          columns.push({
            name: colName,
            rawType,
            normalizedType: rawType.toLowerCase(),
            nullable: !requiredSet.has(colName),
            isPrimaryKey: colName.toLowerCase() === 'id',
            isAutoIncrement: false,
            isUnique: false,
            enumValues: Array.isArray(p.enum) ? p.enum.map(String) : undefined,
          });
        }
        tables.push({
          key: normalizeTableKey(title),
          name: title,
          columns,
          primaryKeys: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
          foreignKeys: [],
          rows: [],
        });
        return { dialect: 'json', sourceLabel, tables, warnings };
      }
    }
  } catch {
    // Fall through to NDJSON parser below.
  }

  const parsedData = parseJsonDataText(text);
  warnings.push(...parsedData.warnings);
  if (parsedData.rows.length > 0) {
    const baseName = sourceLabel.replace(/\.[^.]+$/, '') || 'records';
    tables.push(inferTableFromRows(baseName, parsedData.rows));
  } else {
    warnings.push('No JSON objects or schema properties were found.');
  }

  return { dialect: 'json', sourceLabel, tables, warnings };
}

/** Infer a table schema + rows from a CSV/TSV file. */
export function parseCsvAsSchema(raw: string, sourceLabel = 'CSV table'): ImportedSchema {
  const parsed = parseDelimitedText(raw);
  const baseName = sourceLabel.replace(/\.[^.]+$/, '') || 'imported_table';
  if (parsed.headers.length === 0) {
    return { dialect: 'csv', sourceLabel, tables: [], warnings: [...parsed.warnings, 'No columns found in CSV.'] };
  }
  const table = inferTableFromRows(baseName, parsed.rows, parsed.headers);
  return {
    dialect: 'csv',
    sourceLabel,
    tables: [table],
    warnings: parsed.warnings,
  };
}

/** Infer SQL-like column types from sampled tabular rows. */
export function inferTableFromRows(
  name: string,
  rows: Array<Record<string, unknown>>,
  explicitHeaders?: string[],
): ImportedTable {
  const headers = explicitHeaders && explicitHeaders.length > 0
    ? explicitHeaders
    : Array.from(new Set(rows.slice(0, 300).flatMap((r) => Object.keys(r))));

  const sample = rows.slice(0, 250);
  const columns: ImportedColumn[] = headers.map((col) => {
    const vals = sample.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
    const inferred = inferColumnTypeFromValues(col, vals);
    const isPk = col.toLowerCase() === 'id';
    return {
      name: col,
      rawType: inferred,
      normalizedType: inferred.toLowerCase(),
      nullable: vals.length < sample.length,
      isPrimaryKey: isPk,
      isAutoIncrement: false,
      isUnique: isPk,
    };
  });

  return {
    key: normalizeTableKey(name),
    name,
    columns,
    primaryKeys: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    foreignKeys: [],
    rows,
    totalRowCount: rows.length,
  };
}

function inferColumnTypeFromValues(colName: string, values: unknown[]): string {
  if (values.length === 0) return 'TEXT';
  let allBool = true;
  let allNum = true;
  let allDate = true;
  let allDatetime = true;
  let maxLen = 0;

  for (const v of values) {
    if (typeof v === 'boolean') {
      allNum = false;
      allDate = false;
      allDatetime = false;
      continue;
    }
    const s = String(v).trim();
    if (s.length > maxLen) maxLen = s.length;
    const lower = s.toLowerCase();
    if (!['true', 'false', '0', '1', 'yes', 'no'].includes(lower)) allBool = false;
    if (typeof v !== 'number' && !/^-?\d+(?:\.\d+)?$/.test(s)) allNum = false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) allDate = false;
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) allDatetime = false;
  }

  if (allBool && !/^id$|_id$/i.test(colName)) return 'BOOLEAN';
  if (allNum) return 'NUMERIC';
  if (allDate) return 'DATE';
  if (allDatetime) return 'DATETIME';
  if (maxLen > 160) return 'TEXT';
  return 'VARCHAR(255)';
}

/**
 * Unified local file importer: accepts one or more local files (.sql, .ddl, .sqlite/.db,
 * .prisma, .json, .csv/.tsv, .sql.gz, or .zip archives containing schema + CSV/JSON files)
 * and parses everything strictly inside the browser.
 */
export async function parseUploadedSchemaFiles(
  files: File[],
  requestedDialect: SqlDialect = 'auto',
): Promise<ImportedSchema> {
  const warnings: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const sqlChunks: string[] = [];
  const dataFiles: Array<{ baseName: string; ext: string; text: string }> = [];
  const sqliteSchemas: ImportedSchema[] = [];
  const extraSchemas: ImportedSchema[] = [];

  const handleBytes = (filename: string, bytes: Uint8Array) => {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.gz')) {
      try {
        const inflated = gunzipBytes(bytes);
        handleBytes(filename.slice(0, -3), inflated);
      } catch {
        warnings.push(`Could not decompress "${filename}".`);
      }
      return;
    }

    if (lower.endsWith('.zip')) {
      try {
        const inner = unpackZipBytes(bytes);
        for (const item of inner) {
          handleBytes(item.name, item.bytes);
        }
      } catch {
        warnings.push(`Could not open ZIP archive "${filename}".`);
      }
      return;
    }

    if (
      lower.endsWith('.sqlite') ||
      lower.endsWith('.sqlite3') ||
      lower.endsWith('.db') ||
      isSqliteBinary(bytes)
    ) {
      const read = readSqliteFile(bytes, MAX_INLINE_ROWS_PER_TABLE);
      warnings.push(...read.warnings);
      const ddl = read.ddlStatements.join('\n\n');
      const parsed = parseSqlSchema(ddl, 'sqlite', filename);
      warnings.push(...parsed.warnings);
      const rowsByKey = new Map(read.tables.map((t) => [normalizeTableKey(t.name), t.rows]));
      for (const tbl of parsed.tables) {
        const rows = rowsByKey.get(tbl.key);
        if (rows && rows.length > 0) {
          tbl.rows = rows;
          tbl.totalRowCount = rows.length;
        }
      }
      sqliteSchemas.push(parsed);
      return;
    }

    const text = decoder.decode(bytes);
    if (lower.endsWith('.prisma')) {
      extraSchemas.push(parsePrismaSchema(text, filename));
    } else if (lower.endsWith('.sql') || lower.endsWith('.ddl') || lower.endsWith('.txt')) {
      sqlChunks.push(text);
    } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.json') || lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) {
      const dot = filename.lastIndexOf('.');
      const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
      const baseName = dot >= 0 ? filename.slice(0, dot) : filename;
      dataFiles.push({ baseName, ext, text });
    } else {
      sqlChunks.push(text);
    }
  };

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    handleBytes(file.name, new Uint8Array(buffer));
  }

  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  let primary: ImportedSchema | null = null;

  if (sqlChunks.length > 0) {
    primary = parseSqlSchema(sqlChunks.join('\n\n'), requestedDialect, label);
  } else if (sqliteSchemas.length > 0) {
    primary = sqliteSchemas[0];
    for (let i = 1; i < sqliteSchemas.length; i++) {
      primary.tables.push(...sqliteSchemas[i].tables);
    }
  } else if (extraSchemas.length > 0) {
    primary = extraSchemas[0];
    for (let i = 1; i < extraSchemas.length; i++) {
      primary.tables.push(...extraSchemas[i].tables);
    }
  }

  // Merge any additional schemas and attach matching CSV/JSON data files to matching tables!
  if (primary) {
    for (const s of sqliteSchemas) {
      if (s !== primary) primary.tables.push(...s.tables);
    }
    for (const s of extraSchemas) {
      if (s !== primary) primary.tables.push(...s.tables);
    }
    const byKey = new Map(primary.tables.map((t) => [t.key, t]));
    for (const df of dataFiles) {
      const key = normalizeTableKey(df.baseName);
      const parsed = df.ext === 'json' || df.ext === 'ndjson' || df.ext === 'jsonl'
        ? parseJsonDataText(df.text)
        : parseDelimitedText(df.text, df.ext === 'tsv' ? '\t' : undefined);
      warnings.push(...parsed.warnings);
      const match = byKey.get(key);
      if (match) {
        match.rows.push(...parsed.rows.slice(0, Math.max(0, MAX_INLINE_ROWS_PER_TABLE - match.rows.length)));
        match.totalRowCount = match.rows.length;
        match.sourceNote = `Matched ${df.baseName}.${df.ext}`;
      } else if (parsed.rows.length > 0) {
        const inferred = inferTableFromRows(df.baseName, parsed.rows, parsed.headers);
        primary.tables.push(inferred);
        byKey.set(inferred.key, inferred);
      }
    }
    primary.warnings = [...warnings, ...primary.warnings];
    return primary;
  }

  // Only CSV/JSON files were uploaded — infer tables directly from each file.
  const tables: ImportedTable[] = [];
  let dialect: ResolvedDialect = 'csv';
  for (const df of dataFiles) {
    if (df.ext === 'json' || df.ext === 'ndjson' || df.ext === 'jsonl') {
      dialect = 'json';
      const sub = parseJsonSchemaOrData(df.text, `${df.baseName}.${df.ext}`);
      tables.push(...sub.tables);
      warnings.push(...sub.warnings);
    } else {
      const sub = parseCsvAsSchema(df.text, `${df.baseName}.${df.ext}`);
      tables.push(...sub.tables);
      warnings.push(...sub.warnings);
    }
  }

  return {
    dialect,
    sourceLabel: label,
    tables,
    warnings,
  };
}
