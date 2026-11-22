/**
 * Pure TypeScript read-only SQLite3 binary file reader.
 *
 * Parses the official SQLite3 file format (100-byte header + table B-trees +
 * overflow pages + varint/serial-type record payloads) directly in browser
 * memory with ZERO WebAssembly binaries and ZERO external dependencies —
 * keeping FormLogic's strict zero-binary provenance guard and CSP intact.
 */

const SQLITE_MAGIC = 'SQLite format 3\0';

export interface SqliteMasterEntry {
  type: string;
  name: string;
  tblName: string;
  rootPage: number;
  sql: string;
}

export interface SqliteTableExtract {
  name: string;
  sql: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

export interface SqliteReadResult {
  pageSize: number;
  isWalMode: boolean;
  ddlStatements: string[];
  tables: SqliteTableExtract[];
  warnings: string[];
}

export function isSqliteBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function readVarint(buf: Uint8Array, offset: number): { value: number; length: number } {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if (offset + i >= buf.length) return { value: result, length: i };
    const b = buf[offset + i];
    result = result * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      return { value: result, length: i + 1 };
    }
  }
  // 9th byte uses all 8 bits.
  if (offset + 8 < buf.length) {
    result = result * 256 + buf[offset + 8];
  }
  return { value: result, length: 9 };
}

function readSignedInt(view: DataView, offset: number, byteLen: number): number {
  if (byteLen === 1) return view.getInt8(offset);
  if (byteLen === 2) return view.getInt16(offset, false);
  if (byteLen === 3) {
    const b0 = view.getUint8(offset);
    const val = (b0 << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
    return (b0 & 0x80) ? val - 0x1000000 : val;
  }
  if (byteLen === 4) return view.getInt32(offset, false);
  if (byteLen === 6) {
    const hi = view.getInt16(offset, false);
    const lo = view.getUint32(offset + 2, false);
    return hi * 0x100000000 + lo;
  }
  if (byteLen === 8) {
    const hi = view.getInt32(offset, false);
    const lo = view.getUint32(offset + 4, false);
    return hi * 0x100000000 + lo;
  }
  return 0;
}

function decodeTextBytes(bytes: Uint8Array, encoding: number): string {
  if (encoding === 2) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes);
  }
  if (encoding === 3) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(bytes);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

class SqliteBinaryReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  readonly pageSize: number;
  readonly usableSize: number;
  readonly encoding: number;
  readonly isWalMode: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rawPageSize = this.view.getUint16(16, false);
    this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const reserved = bytes[20];
    this.usableSize = this.pageSize - reserved;
    this.isWalMode = bytes[18] === 2 || bytes[19] === 2;
    this.encoding = this.view.getUint32(56, false) || 1;
  }

  private pageOffset(pageNum: number): number {
    return (pageNum - 1) * this.pageSize;
  }

  /** Assemble cell payload across local page bytes + any overflow page chain. */
  private readPayload(localOffset: number, totalSize: number): Uint8Array {
    const maxLocal = this.usableSize - 35;
    if (totalSize <= maxLocal) {
      return this.bytes.subarray(localOffset, localOffset + totalSize);
    }

    const minLocal = Math.floor(((this.usableSize - 12) * 32) / 255) - 23;
    const k = minLocal + ((totalSize - minLocal) % (this.usableSize - 4));
    const localLen = k <= maxLocal ? k : minLocal;

    const out = new Uint8Array(totalSize);
    out.set(this.bytes.subarray(localOffset, localOffset + localLen), 0);
    let written = localLen;
    let nextPage = this.view.getUint32(localOffset + localLen, false);
    const visited = new Set<number>();

    while (written < totalSize && nextPage > 0 && !visited.has(nextPage)) {
      visited.add(nextPage);
      const off = this.pageOffset(nextPage);
      if (off + 4 > this.bytes.length) break;
      const overflowNext = this.view.getUint32(off, false);
      const chunkMax = this.usableSize - 4;
      const take = Math.min(chunkMax, totalSize - written);
      out.set(this.bytes.subarray(off + 4, off + 4 + take), written);
      written += take;
      nextPage = overflowNext;
    }

    return out;
  }

  private decodeRecord(payload: Uint8Array): unknown[] {
    if (payload.length === 0) return [];
    const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const headerVarint = readVarint(payload, 0);
    const headerSize = headerVarint.value;
    let headerPos = headerVarint.length;
    const serialTypes: number[] = [];

    while (headerPos < headerSize && headerPos < payload.length) {
      const st = readVarint(payload, headerPos);
      if (st.length === 0) break;
      serialTypes.push(st.value);
      headerPos += st.length;
    }

    let bodyPos = headerSize;
    const values: unknown[] = [];

    for (const st of serialTypes) {
      if (st === 0) {
        values.push(null);
      } else if (st === 1) {
        values.push(bodyPos + 1 <= payload.length ? readSignedInt(payloadView, bodyPos, 1) : null);
        bodyPos += 1;
      } else if (st === 2) {
        values.push(bodyPos + 2 <= payload.length ? readSignedInt(payloadView, bodyPos, 2) : null);
        bodyPos += 2;
      } else if (st === 3) {
        values.push(bodyPos + 3 <= payload.length ? readSignedInt(payloadView, bodyPos, 3) : null);
        bodyPos += 3;
      } else if (st === 4) {
        values.push(bodyPos + 4 <= payload.length ? readSignedInt(payloadView, bodyPos, 4) : null);
        bodyPos += 4;
      } else if (st === 5) {
        values.push(bodyPos + 6 <= payload.length ? readSignedInt(payloadView, bodyPos, 6) : null);
        bodyPos += 6;
      } else if (st === 6) {
        values.push(bodyPos + 8 <= payload.length ? readSignedInt(payloadView, bodyPos, 8) : null);
        bodyPos += 8;
      } else if (st === 7) {
        values.push(bodyPos + 8 <= payload.length ? payloadView.getFloat64(bodyPos, false) : null);
        bodyPos += 8;
      } else if (st === 8) {
        values.push(0);
      } else if (st === 9) {
        values.push(1);
      } else if (st === 10 || st === 11) {
        values.push(null);
      } else if (st >= 12 && st % 2 === 0) {
        const len = (st - 12) / 2;
        values.push(len > 0 ? `[binary ${len} bytes]` : null);
        bodyPos += len;
      } else if (st >= 13 && st % 2 === 1) {
        const len = (st - 13) / 2;
        const end = Math.min(payload.length, bodyPos + len);
        values.push(decodeTextBytes(payload.subarray(bodyPos, end), this.encoding));
        bodyPos += len;
      } else {
        values.push(null);
      }
    }

    return values;
  }

  /** Traverse a table B-tree rooted at rootPage, returning { rowid, values } tuples. */
  readTableBTree(
    rootPage: number,
    maxRows: number,
  ): { rows: Array<{ rowid: number; values: unknown[] }>; truncated: boolean } {
    const out: Array<{ rowid: number; values: unknown[] }> = [];
    const visitedPages = new Set<number>();
    let truncated = false;

    const visit = (pageNum: number) => {
      if (truncated || pageNum < 1 || visitedPages.has(pageNum)) return;
      const base = this.pageOffset(pageNum);
      if (base + 12 > this.bytes.length) return;
      visitedPages.add(pageNum);

      const headerStart = pageNum === 1 ? base + 100 : base;
      const pageType = this.bytes[headerStart];
      const cellCount = this.view.getUint16(headerStart + 3, false);

      if (pageType === 0x05) {
        // Interior table B-tree page (12-byte header).
        const ptrArrayStart = headerStart + 12;
        const rightMostChild = this.view.getUint32(headerStart + 8, false);
        for (let i = 0; i < cellCount; i++) {
          const cellPtr = this.view.getUint16(ptrArrayStart + i * 2, false);
          const childPage = this.view.getUint32(base + cellPtr, false);
          visit(childPage);
          if (truncated) return;
        }
        visit(rightMostChild);
      } else if (pageType === 0x0d) {
        // Leaf table B-tree page (8-byte header).
        const ptrArrayStart = headerStart + 8;
        for (let i = 0; i < cellCount; i++) {
          if (out.length >= maxRows) {
            truncated = true;
            return;
          }
          const cellPtr = this.view.getUint16(ptrArrayStart + i * 2, false);
          let pos = base + cellPtr;
          if (pos >= this.bytes.length) continue;
          const payloadSize = readVarint(this.bytes, pos);
          pos += payloadSize.length;
          const rowidVar = readVarint(this.bytes, pos);
          pos += rowidVar.length;
          const payload = this.readPayload(pos, payloadSize.value);
          const values = this.decodeRecord(payload);
          out.push({ rowid: rowidVar.value, values });
        }
      }
    };

    visit(rootPage);
    return { rows: out, truncated };
  }
}

/**
 * Extract ordered column names + any INTEGER PRIMARY KEY alias column index from a CREATE TABLE DDL.
 * Used only to map positional SQLite B-tree record values back to named columns.
 */
function extractSqliteColumnMeta(
  ddl: string,
): { columns: string[]; rowidAliasIndex: number; withoutRowid: boolean } {
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(ddl);
  const openIdx = ddl.indexOf('(');
  const closeIdx = ddl.lastIndexOf(')');
  if (openIdx < 0 || closeIdx <= openIdx) {
    return { columns: [], rowidAliasIndex: -1, withoutRowid };
  }

  const body = ddl.slice(openIdx + 1, closeIdx);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (body[i + 1] === quote) {
          current += body[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
    } else if (ch === '[') {
      quote = ']';
      current += ch;
    } else if (ch === '-' && body[i + 1] === '-') {
      while (i < body.length && body[i] !== '\n') i++;
    } else if (ch === '/' && body[i + 1] === '*') {
      i += 2;
      while (i < body.length - 1 && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i++;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  const columns: string[] = [];
  let rowidAliasIndex = -1;
  let tableLevelPkCol: string | null = null;

  for (const part of parts) {
    if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(part)) {
      const pkMatch = part.match(/PRIMARY\s+KEY\s*\(\s*([^,)]+)\s*\)/i);
      if (pkMatch) {
        tableLevelPkCol = pkMatch[1].trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase();
      }
      continue;
    }
    const colMatch = part.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))\s*(.*)$/s);
    if (!colMatch) continue;
    const colName = colMatch[1] || colMatch[2] || colMatch[3] || colMatch[4];
    const rest = colMatch[5] || '';
    const idx = columns.length;
    columns.push(colName);
    if (!withoutRowid && /^\s*INTEGER\b/i.test(rest) && /\bPRIMARY\s+KEY\b/i.test(rest)) {
      rowidAliasIndex = idx;
    }
  }

  // Handle single-column `PRIMARY KEY (id)` where column `id` has exact type INTEGER.
  if (!withoutRowid && rowidAliasIndex < 0 && tableLevelPkCol) {
    for (const part of parts) {
      const colMatch = part.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))\s+INTEGER\b/i);
      if (colMatch) {
        const name = colMatch[1] || colMatch[2] || colMatch[3] || colMatch[4];
        if (name.toLowerCase() === tableLevelPkCol) {
          rowidAliasIndex = columns.findIndex((c) => c.toLowerCase() === tableLevelPkCol);
          break;
        }
      }
    }
  }

  return { columns, rowidAliasIndex, withoutRowid };
}

/**
 * Read schema DDL and table rows from a local SQLite3 binary buffer in-browser.
 */
export function readSqliteFile(bytes: Uint8Array, maxRowsPerTable = 50_000): SqliteReadResult {
  if (!isSqliteBinary(bytes)) {
    throw new Error('This file is not a valid SQLite 3 database.');
  }

  const reader = new SqliteBinaryReader(bytes);
  const warnings: string[] = [];

  if (reader.isWalMode) {
    warnings.push(
      'This SQLite file uses WAL mode. Any uncommitted changes sitting only in a separate -wal file will not appear until checkpointed.',
    );
  }

  const master = reader.readTableBTree(1, 10_000);
  const entries: SqliteMasterEntry[] = [];
  for (const row of master.rows) {
    const [type, name, tblName, rootPage, sql] = row.values;
    if (typeof type !== 'string' || typeof name !== 'string') continue;
    entries.push({
      type,
      name,
      tblName: typeof tblName === 'string' ? tblName : name,
      rootPage: typeof rootPage === 'number' ? rootPage : 0,
      sql: typeof sql === 'string' ? sql : '',
    });
  }

  const ddlStatements: string[] = [];
  const tables: SqliteTableExtract[] = [];

  for (const entry of entries) {
    if (entry.type !== 'table') continue;
    if (entry.name.startsWith('sqlite_')) continue;
    if (!entry.sql.trim()) continue;

    ddlStatements.push(entry.sql.trim().replace(/;?\s*$/, ';'));
    const meta = extractSqliteColumnMeta(entry.sql);

    if (meta.withoutRowid) {
      warnings.push(
        `Table "${entry.name}" uses WITHOUT ROWID; its schema was imported, but export its rows as CSV or SQL INSERTs to import data.`,
      );
      tables.push({
        name: entry.name,
        sql: entry.sql,
        columns: meta.columns,
        rows: [],
        truncated: false,
      });
      continue;
    }

    if (entry.rootPage < 2) {
      tables.push({
        name: entry.name,
        sql: entry.sql,
        columns: meta.columns,
        rows: [],
        truncated: false,
      });
      continue;
    }

    const extracted = reader.readTableBTree(entry.rootPage, maxRowsPerTable);
    const namedRows: Array<Record<string, unknown>> = extracted.rows.map(({ rowid, values }) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < meta.columns.length; i++) {
        const colName = meta.columns[i];
        let val = i < values.length ? values[i] : null;
        if (i === meta.rowidAliasIndex && val === null) {
          val = rowid;
        }
        obj[colName] = val;
      }
      return obj;
    });

    if (extracted.truncated) {
      warnings.push(
        `Table "${entry.name}" has more than ${maxRowsPerTable.toLocaleString()} rows; loaded the first ${maxRowsPerTable.toLocaleString()} rows.`,
      );
    }

    tables.push({
      name: entry.name,
      sql: entry.sql,
      columns: meta.columns,
      rows: namedRows,
      truncated: extracted.truncated,
    });
  }

  return {
    pageSize: reader.pageSize,
    isWalMode: reader.isWalMode,
    ddlStatements,
    tables,
    warnings,
  };
}
