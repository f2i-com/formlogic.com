import type { ImportedSchema, ImportedTable, LocalBridgeConnection, LocalBridgeDriver } from './types';
import { normalizeTableKey } from './sqlParser';

export const DEFAULT_LOCAL_BRIDGE_URL = 'http://127.0.0.1:17985';

export const DEFAULT_PORTS: Record<LocalBridgeDriver, string> = {
  mysql: '3306',
  postgresql: '5432',
  mssql: '1433',
  sqlite: '',
};

/**
 * Enforce strictly local loopback URLs so browser-entered database credentials
 * can NEVER be sent to FormLogic's server or any remote host.
 */
export function assertLoopbackBridgeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Bridge URL must be a valid local URL such as http://127.0.0.1:17985');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Bridge URL must use http:// on localhost or 127.0.0.1');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]') {
    throw new Error('For security, database connections are strictly local-only (127.0.0.1 / localhost).');
  }
  return parsed.origin;
}

export interface LocalBridgeHealth {
  ok: boolean;
  version: string;
  drivers: LocalBridgeDriver[];
}

export async function pingLocalBridge(bridgeUrl: string, token: string): Promise<LocalBridgeHealth> {
  const origin = assertLoopbackBridgeUrl(bridgeUrl);
  const res = await fetch(`${origin}/health`, {
    method: 'GET',
    headers: token.trim() ? { 'X-Bridge-Token': token.trim() } : {},
  });
  if (!res.ok) {
    throw new Error(`Local bridge returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as Partial<LocalBridgeHealth>;
  return {
    ok: json.ok !== false,
    version: String(json.version ?? '1.0'),
    drivers: Array.isArray(json.drivers) ? (json.drivers as LocalBridgeDriver[]) : ['mysql', 'postgresql', 'mssql', 'sqlite'],
  };
}

export function buildConnectionPayload(conn: LocalBridgeConnection): Record<string, unknown> {
  if (conn.driver === 'sqlite') {
    return { driver: 'sqlite', filePath: conn.filePath.trim() };
  }
  return {
    driver: conn.driver,
    host: conn.host.trim() || '127.0.0.1',
    port: Number(conn.port) || Number(DEFAULT_PORTS[conn.driver]),
    database: conn.database.trim(),
    user: conn.user.trim(),
    password: conn.password,
    ssl: conn.ssl,
  };
}

/** Introspect tables, columns, PKs, FKs, and row counts directly from the user's local loopback bridge. */
export async function introspectLocalDatabase(conn: LocalBridgeConnection): Promise<ImportedSchema> {
  const origin = assertLoopbackBridgeUrl(conn.bridgeUrl);
  const payload = buildConnectionPayload(conn);
  const res = await fetch(`${origin}/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conn.token.trim() ? { 'X-Bridge-Token': conn.token.trim() } : {}),
    },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    tables?: Array<{
      name: string;
      schemaName?: string;
      rowCount?: number;
      columns: ImportedTable['columns'];
      primaryKeys?: string[];
      foreignKeys?: ImportedTable['foreignKeys'];
    }>;
    warnings?: string[];
  };
  if (!res.ok || json.error) {
    throw new Error(json.error || `Local bridge introspection failed (HTTP ${res.status})`);
  }

  const tables: ImportedTable[] = (json.tables ?? []).map((t) => ({
    key: normalizeTableKey(t.name),
    name: t.name,
    schemaName: t.schemaName,
    columns: t.columns ?? [],
    primaryKeys: t.primaryKeys ?? t.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    foreignKeys: t.foreignKeys ?? [],
    rows: [],
    totalRowCount: typeof t.rowCount === 'number' ? t.rowCount : undefined,
    sourceNote: 'Connected via local loopback bridge',
  }));

  return {
    dialect: conn.driver,
    sourceLabel:
      conn.driver === 'sqlite'
        ? conn.filePath.trim() || 'Local SQLite'
        : `${conn.driver}://${conn.host || '127.0.0.1'}/${conn.database}`,
    tables,
    warnings: json.warnings ?? [],
    localBridge: {
      bridgeUrl: origin,
      token: conn.token.trim(),
      driver: conn.driver,
      connectionPayload: payload,
    },
  };
}

/** Fetch one batch of rows from a table via the user's local loopback bridge (browser -> 127.0.0.1 only). */
export async function fetchLocalTableBatch(
  session: NonNullable<ImportedSchema['localBridge']>,
  tableName: string,
  schemaName: string | undefined,
  offset: number,
  limit: number,
): Promise<{ rows: Array<Record<string, unknown>>; hasMore: boolean }> {
  const origin = assertLoopbackBridgeUrl(session.bridgeUrl);
  const res = await fetch(`${origin}/rows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session.token ? { 'X-Bridge-Token': session.token } : {}),
    },
    body: JSON.stringify({
      ...session.connectionPayload,
      table: tableName,
      schemaName,
      offset,
      limit,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    rows?: Array<Record<string, unknown>>;
    hasMore?: boolean;
  };
  if (!res.ok || json.error) {
    throw new Error(json.error || `Failed to read rows from ${tableName} (HTTP ${res.status})`);
  }
  const rows = Array.isArray(json.rows) ? json.rows : [];
  return { rows, hasMore: Boolean(json.hasMore ?? rows.length === limit) };
}

export interface SchemaExportCheatSheet {
  dialect: string;
  schemaOnlyCmd: string;
  withDataCmd: string;
  tip: string;
}

export const SCHEMA_EXPORT_CHEATSHEET: readonly SchemaExportCheatSheet[] = [
  {
    dialect: 'MySQL / MariaDB',
    schemaOnlyCmd: 'mysqldump -u root -p --no-data your_database > schema.sql',
    withDataCmd: 'mysqldump -u root -p --complete-insert --skip-extended-insert=false your_database > dump.sql',
    tip: 'Drop the resulting .sql (or .sql.gz) file into FormLogic to import tables, FKs, and rows.',
  },
  {
    dialect: 'PostgreSQL',
    schemaOnlyCmd: 'pg_dump -U postgres --schema-only --no-owner your_database > schema.sql',
    withDataCmd: 'pg_dump -U postgres --no-owner --inserts your_database > dump.sql',
    tip: 'Supports both COPY ... FROM stdin and INSERT INTO dumps, plus CREATE TYPE ... AS ENUM.',
  },
  {
    dialect: 'SQL Server (MSSQL)',
    schemaOnlyCmd: 'In SSMS: Right-click DB -> Tasks -> Generate Scripts -> Schema only (.sql)',
    withDataCmd: 'In SSMS: Generate Scripts -> Advanced -> Types of data to script -> Schema and data',
    tip: 'Parses [dbo] brackets, IDENTITY(1,1), NVARCHAR(MAX), GO separators, and ALTER TABLE FKs.',
  },
  {
    dialect: 'SQLite',
    schemaOnlyCmd: 'sqlite3 your_database.db ".schema" > schema.sql',
    withDataCmd: 'Drop your .sqlite / .db file directly — FormLogic reads schema & rows in-browser!',
    tip: 'No export needed for SQLite: FormLogic reads .sqlite/.db files locally without uploading the binary.',
  },
];

/**
 * Build a self-contained Node.js loopback bridge script that runs ONLY on the user's
 * own computer (127.0.0.1), guarded by a per-run secret token and strict Origin CORS.
 * FormLogic's server never touches DB credentials or connects to the user's database.
 */
export function buildLocalBridgeScript(allowedOrigin: string, port = 17985): string {
  const safeOrigin = allowedOrigin.replace(/['"\\]/g, '');
  return `#!/usr/bin/env node
/**
 * FormLogic Local Database Bridge (Strictly Local 127.0.0.1)
 *
 * Runs on YOUR computer so the FormLogic browser tab can inspect your local
 * MySQL, PostgreSQL, SQL Server (MSSQL), or SQLite database and stream batches
 * into FormLogic forms — your DB host & password NEVER touch FormLogic's server.
 *
 * Usage:
 *   node formlogic-local-db-bridge.mjs
 *
 * Install whichever driver you need in the same folder:
 *   npm install mysql2        # MySQL / MariaDB
 *   npm install pg            # PostgreSQL
 *   npm install mssql         # Microsoft SQL Server
 *   npm install better-sqlite3 # SQLite (or use Node 22+ built-in node:sqlite)
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || ${port});
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '${safeOrigin}';
const TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function safeIdent(name) {
  if (!/^[A-Za-z0-9_$.-]+$/.test(String(name || ''))) {
    throw new Error('Unsafe identifier: ' + name);
  }
  return String(name);
}

async function introspectMysql(cfg) {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 3306),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const [tables] = await conn.query(
      'SELECT TABLE_NAME, TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE" ORDER BY TABLE_NAME',
      [cfg.database]
    );
    const [cols] = await conn.query(
      'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
      [cfg.database]
    );
    const [fks] = await conn.query(
      'SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
      [cfg.database]
    );
    const fkMap = new Map();
    for (const fk of fks) {
      const list = fkMap.get(fk.TABLE_NAME) || [];
      list.push({ column: fk.COLUMN_NAME, targetTable: fk.REFERENCED_TABLE_NAME, targetColumn: fk.REFERENCED_COLUMN_NAME });
      fkMap.set(fk.TABLE_NAME, list);
    }
    return tables.map((t) => {
      const tFks = fkMap.get(t.TABLE_NAME) || [];
      const tCols = cols.filter((c) => c.TABLE_NAME === t.TABLE_NAME).map((c) => {
        const enumMatch = /^enum\\((.+)\\)$/i.exec(c.COLUMN_TYPE || '');
        const enumValues = enumMatch ? enumMatch[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')) : undefined;
        const fk = tFks.find((f) => f.column === c.COLUMN_NAME);
        return {
          name: c.COLUMN_NAME,
          rawType: c.COLUMN_TYPE,
          normalizedType: String(c.COLUMN_TYPE || '').split('(')[0].toLowerCase(),
          nullable: c.IS_NULLABLE === 'YES',
          isPrimaryKey: c.COLUMN_KEY === 'PRI',
          isAutoIncrement: String(c.EXTRA || '').includes('auto_increment'),
          isUnique: c.COLUMN_KEY === 'UNI' || c.COLUMN_KEY === 'PRI',
          defaultValue: c.COLUMN_DEFAULT != null ? String(c.COLUMN_DEFAULT) : undefined,
          enumValues,
          foreignKey: fk,
        };
      });
      return {
        name: t.TABLE_NAME,
        rowCount: Number(t.TABLE_ROWS || 0),
        columns: tCols,
        primaryKeys: tCols.filter((c) => c.isPrimaryKey).map((c) => c.name),
        foreignKeys: tFks,
      };
    });
  } finally {
    await conn.end();
  }
}

async function rowsMysql(cfg) {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 3306),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const tbl = safeIdent(cfg.table);
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const [rows] = await conn.query('SELECT * FROM \`' + tbl + '\` LIMIT ? OFFSET ?', [limit + 1, offset]);
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  } finally {
    await conn.end();
  }
}

async function introspectPostgres(cfg) {
  const { Client } = await import('pg');
  const client = new Client({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 5432),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const tablesRes = await client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name"
    );
    const colsRes = await client.query(
      "SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name, ordinal_position"
    );
    const pkRes = await client.query(
      "SELECT tc.table_schema, tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY'"
    );
    const fkRes = await client.query(
      "SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_name AS target_table, ccu.column_name AS target_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY'"
    );
    return tablesRes.rows.map((t) => {
      const pks = new Set(pkRes.rows.filter((p) => p.table_name === t.table_name && p.table_schema === t.table_schema).map((p) => p.column_name));
      const fks = fkRes.rows.filter((f) => f.table_name === t.table_name && f.table_schema === t.table_schema).map((f) => ({
        column: f.column_name, targetTable: f.target_table, targetColumn: f.target_column,
      }));
      const tCols = colsRes.rows.filter((c) => c.table_name === t.table_name && c.table_schema === t.table_schema).map((c) => ({
        name: c.column_name,
        rawType: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
        normalizedType: String(c.data_type || '').toLowerCase(),
        nullable: c.is_nullable === 'YES',
        isPrimaryKey: pks.has(c.column_name),
        isAutoIncrement: String(c.column_default || '').includes('nextval('),
        isUnique: pks.has(c.column_name),
        defaultValue: c.column_default || undefined,
        foreignKey: fks.find((f) => f.column === c.column_name),
      }));
      return { name: t.table_name, schemaName: t.table_schema, columns: tCols, primaryKeys: Array.from(pks), foreignKeys: fks };
    });
  } finally {
    await client.end();
  }
}

async function rowsPostgres(cfg) {
  const { Client } = await import('pg');
  const client = new Client({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 5432),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const schema = cfg.schemaName ? '"' + safeIdent(cfg.schemaName) + '".' : '';
    const tbl = '"' + safeIdent(cfg.table) + '"';
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const res = await client.query('SELECT * FROM ' + schema + tbl + ' LIMIT $1 OFFSET $2', [limit + 1, offset]);
    return { rows: res.rows.slice(0, limit), hasMore: res.rows.length > limit };
  } finally {
    await client.end();
  }
}

async function introspectMssql(cfg) {
  const mssql = (await import('mssql')).default;
  const pool = await mssql.connect({
    server: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 1433),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: { encrypt: Boolean(cfg.ssl), trustServerCertificate: true },
  });
  try {
    const tablesRes = await pool.request().query("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME");
    const colsRes = await pool.request().query("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION");
    const pkRes = await pool.request().query("SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'");
    const fkRes = await pool.request().query("SELECT OBJECT_NAME(fkc.parent_object_id) AS table_name, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name, OBJECT_NAME(fkc.referenced_object_id) AS target_table, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS target_column FROM sys.foreign_key_columns fkc");
    return tablesRes.recordset.map((t) => {
      const pks = new Set(pkRes.recordset.filter((p) => p.TABLE_NAME === t.TABLE_NAME && p.TABLE_SCHEMA === t.TABLE_SCHEMA).map((p) => p.COLUMN_NAME));
      const fks = fkRes.recordset.filter((f) => f.table_name === t.TABLE_NAME).map((f) => ({
        column: f.column_name, targetTable: f.target_table, targetColumn: f.target_column,
      }));
      const tCols = colsRes.recordset.filter((c) => c.TABLE_NAME === t.TABLE_NAME && c.TABLE_SCHEMA === t.TABLE_SCHEMA).map((c) => ({
        name: c.COLUMN_NAME,
        rawType: c.DATA_TYPE,
        normalizedType: String(c.DATA_TYPE || '').toLowerCase(),
        nullable: c.IS_NULLABLE === 'YES',
        isPrimaryKey: pks.has(c.COLUMN_NAME),
        isAutoIncrement: false,
        isUnique: pks.has(c.COLUMN_NAME),
        defaultValue: c.COLUMN_DEFAULT || undefined,
        foreignKey: fks.find((f) => f.column === c.COLUMN_NAME),
      }));
      return { name: t.TABLE_NAME, schemaName: t.TABLE_SCHEMA, columns: tCols, primaryKeys: Array.from(pks), foreignKeys: fks };
    });
  } finally {
    await pool.close();
  }
}

async function rowsMssql(cfg) {
  const mssql = (await import('mssql')).default;
  const pool = await mssql.connect({
    server: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 1433),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: { encrypt: Boolean(cfg.ssl), trustServerCertificate: true },
  });
  try {
    const schema = cfg.schemaName ? '[' + safeIdent(cfg.schemaName) + '].' : '';
    const tbl = '[' + safeIdent(cfg.table) + ']';
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const res = await pool.request().query('SELECT * FROM ' + schema + tbl + ' ORDER BY (SELECT NULL) OFFSET ' + offset + ' ROWS FETCH NEXT ' + (limit + 1) + ' ROWS ONLY');
    return { rows: res.recordset.slice(0, limit), hasMore: res.recordset.length > limit };
  } finally {
    await pool.close();
  }
}

async function openSqlite(filePath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(filePath, { readOnly: true });
    return { all: (sql, ...args) => db.prepare(sql).all(...args), close: () => db.close() };
  } catch {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(filePath, { readonly: true });
    return { all: (sql, ...args) => db.prepare(sql).all(...args), close: () => db.close() };
  }
}

async function introspectSqlite(cfg) {
  const db = await openSqlite(cfg.filePath);
  try {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return tables.map((t) => {
      const tbl = safeIdent(t.name);
      const cols = db.all('PRAGMA table_info("' + tbl + '")');
      const fks = db.all('PRAGMA foreign_key_list("' + tbl + '")').map((f) => ({
        column: f.from, targetTable: f.table, targetColumn: f.to || 'id',
      }));
      const countRow = db.all('SELECT COUNT(*) AS cnt FROM "' + tbl + '"')[0];
      return {
        name: t.name,
        rowCount: Number(countRow?.cnt || 0),
        columns: cols.map((c) => ({
          name: c.name,
          rawType: c.type || 'TEXT',
          normalizedType: String(c.type || 'text').toLowerCase(),
          nullable: c.notnull === 0 && c.pk === 0,
          isPrimaryKey: c.pk > 0,
          isAutoIncrement: c.pk > 0 && /int/i.test(c.type || ''),
          isUnique: c.pk > 0,
          defaultValue: c.dflt_value != null ? String(c.dflt_value) : undefined,
          foreignKey: fks.find((f) => f.column === c.name),
        })),
        primaryKeys: cols.filter((c) => c.pk > 0).map((c) => c.name),
        foreignKeys: fks,
      };
    });
  } finally {
    db.close();
  }
}

async function rowsSqlite(cfg) {
  const db = await openSqlite(cfg.filePath);
  try {
    const tbl = safeIdent(cfg.table);
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const rows = db.all('SELECT * FROM "' + tbl + '" LIMIT ? OFFSET ?', limit + 1, offset);
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  } finally {
    db.close();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    return send(res, 403, { error: 'Origin not allowed: ' + origin });
  }
  if ((req.headers['x-bridge-token'] || '') !== TOKEN) {
    return send(res, 401, { error: 'Invalid or missing X-Bridge-Token' });
  }
  try {
    if (req.url === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, version: '1.0.0', drivers: ['mysql', 'postgresql', 'mssql', 'sqlite'] });
    }
    if (req.url === '/introspect' && req.method === 'POST') {
      const cfg = await readJson(req);
      const tables =
        cfg.driver === 'mysql' ? await introspectMysql(cfg)
        : cfg.driver === 'postgresql' ? await introspectPostgres(cfg)
        : cfg.driver === 'mssql' ? await introspectMssql(cfg)
        : cfg.driver === 'sqlite' ? await introspectSqlite(cfg)
        : null;
      if (!tables) return send(res, 400, { error: 'Unsupported driver: ' + cfg.driver });
      return send(res, 200, { tables });
    }
    if (req.url === '/rows' && req.method === 'POST') {
      const cfg = await readJson(req);
      const data =
        cfg.driver === 'mysql' ? await rowsMysql(cfg)
        : cfg.driver === 'postgresql' ? await rowsPostgres(cfg)
        : cfg.driver === 'mssql' ? await rowsMssql(cfg)
        : cfg.driver === 'sqlite' ? await rowsSqlite(cfg)
        : null;
      if (!data) return send(res, 400, { error: 'Unsupported driver: ' + cfg.driver });
      return send(res, 200, data);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: err?.message || 'Bridge error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('FormLogic Local DB Bridge listening on http://127.0.0.1:' + PORT);
  console.log('Allowed Origin : ' + ALLOWED_ORIGIN);
  console.log('Pairing Token  : ' + TOKEN);
  console.log('');
  console.log('Paste the Pairing Token into FormLogic -> Import Database -> Connect Locally.');
  console.log('Press Ctrl+C to stop.');
});
`;
}
