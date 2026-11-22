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
    ...(conn.driver === 'mssql' && conn.trustedConnection ? { trustedConnection: true } : {}),
  };
}

/** Fetch the list of user databases from the local DB server via the 127.0.0.1 loopback bridge. */
export async function listLocalDatabases(conn: LocalBridgeConnection): Promise<string[]> {
  if (conn.driver === 'sqlite') return [];
  const origin = assertLoopbackBridgeUrl(conn.bridgeUrl);
  const payload = buildConnectionPayload(conn);
  const res = await fetch(`${origin}/databases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conn.token.trim() ? { 'X-Bridge-Token': conn.token.trim() } : {}),
    },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    databases?: string[];
  };
  if (!res.ok || json.error) {
    throw new Error(json.error || `Could not list databases (HTTP ${res.status})`);
  }
  return Array.isArray(json.databases) ? json.databases.map(String) : [];
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
  orderByColumn?: string | null,
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
      orderBy: orderByColumn || undefined,
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
 * FormLogic Local Database Bridge v1.1 (Strictly Local 127.0.0.1)
 *
 * Runs on YOUR computer so the FormLogic browser tab can browse databases,
 * inspect tables/PKs/FKs, and stream batches from your local MySQL, PostgreSQL,
 * SQL Server (MSSQL), or SQLite database into FormLogic forms — your DB host
 * and password NEVER touch FormLogic's server.
 *
 * Usage:
 *   node formlogic-local-db-bridge.mjs
 *
 * Install whichever driver you need in the same folder (or set NODE_PATH):
 *   npm install mysql2         # MySQL / MariaDB
 *   npm install pg             # PostgreSQL
 *   npm install mssql          # Microsoft SQL Server
 *   npm install better-sqlite3 # SQLite (or use Node 22+ built-in node:sqlite)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const PORT = Number(process.env.PORT || ${port});
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '${safeOrigin}';
const TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');
const require = createRequire(import.meta.url);

async function loadDriver(pkgName, installHint) {
  try {
    return await import(pkgName);
  } catch {
    try {
      return require(pkgName);
    } catch {
      throw new Error('Driver "' + pkgName + '" is not installed. Run: ' + installHint);
    }
  }
}

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
  if (!/^[A-Za-z0-9_$.\\- ]+$/.test(String(name || ''))) {
    throw new Error('Unsafe identifier: ' + name);
  }
  return String(name);
}

/** Normalize Date, Buffer/Uint8Array, and BigInt values into JSON-safe scalars. */
function cleanValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString();
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    if (v.length === 1) return v[0];
    return Buffer.from(v).toString('hex');
  }
  return v;
}

function cleanRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    out[k] = cleanValue(v);
  }
  return out;
}

function parseCheckChoices(expr) {
  const str = String(expr || '');
  const inMatch = /\\bIN\\s*\\(([^)]+)\\)/i.exec(str);
  if (inMatch) {
    const vals = [];
    const re = /'((?:''|[^'])*)'/g;
    let m;
    while ((m = re.exec(inMatch[1])) !== null) {
      vals.push(m[1].replace(/''/g, "'"));
    }
    if (vals.length >= 2) return vals;
  }
  return undefined;
}

function parseMssqlServer(cfg) {
  const rawHost = String(cfg.host || '127.0.0.1').trim();
  let server = rawHost;
  let instanceName;
  const slashIdx = rawHost.indexOf('\\\\');
  if (slashIdx > 0) {
    server = rawHost.slice(0, slashIdx) || '127.0.0.1';
    instanceName = rawHost.slice(slashIdx + 1) || undefined;
  }
  const options = {
    encrypt: Boolean(cfg.ssl),
    trustServerCertificate: true,
    ...(instanceName ? { instanceName } : {}),
    ...(cfg.trustedConnection ? { trustedConnection: true } : {}),
  };
  return {
    server,
    ...(instanceName ? {} : { port: Number(cfg.port || 1433) }),
    ...(cfg.trustedConnection ? {} : { user: cfg.user, password: cfg.password }),
    ...(cfg.database ? { database: cfg.database } : {}),
    options,
  };
}

async function listDatabasesMysql(cfg) {
  const mysqlMod = await loadDriver('mysql2/promise', 'npm install mysql2');
  const mysql = mysqlMod.default ?? mysqlMod;
  const conn = await mysql.createConnection({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 3306),
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const [rows] = await conn.query('SHOW DATABASES');
    const hidden = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
    return rows
      .map((r) => String(Object.values(r)[0] || ''))
      .filter((d) => d && !hidden.has(d.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } finally {
    await conn.end();
  }
}

async function introspectMysql(cfg) {
  const mysqlMod = await loadDriver('mysql2/promise', 'npm install mysql2');
  const mysql = mysqlMod.default ?? mysqlMod;
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
      list.push({
        column: fk.COLUMN_NAME,
        targetTable: fk.REFERENCED_TABLE_NAME,
        targetColumn: fk.REFERENCED_COLUMN_NAME,
        source: 'explicit',
      });
      fkMap.set(fk.TABLE_NAME, list);
    }

    // InnoDB TABLE_ROWS is an estimate and often reports 0 for small lookup tables (1-20 rows).
    // Compute exact COUNT(*) for small tables when the schema has <= 120 tables.
    const exactCounts = new Map();
    if (tables.length <= 120) {
      for (const t of tables) {
        const est = Number(t.TABLE_ROWS || 0);
        if (est < 1000) {
          try {
            const [cntRows] = await conn.query('SELECT COUNT(*) AS cnt FROM \`' + safeIdent(t.TABLE_NAME) + '\`');
            exactCounts.set(t.TABLE_NAME, Number(cntRows[0]?.cnt || 0));
          } catch {
            exactCounts.set(t.TABLE_NAME, est);
          }
        }
      }
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
        rowCount: exactCounts.has(t.TABLE_NAME) ? exactCounts.get(t.TABLE_NAME) : Number(t.TABLE_ROWS || 0),
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
  const mysqlMod = await loadDriver('mysql2/promise', 'npm install mysql2');
  const mysql = mysqlMod.default ?? mysqlMod;
  const conn = await mysql.createConnection({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 3306),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    dateStrings: true,
  });
  try {
    const tbl = safeIdent(cfg.table);
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const orderClause = cfg.orderBy ? ' ORDER BY \`' + safeIdent(cfg.orderBy) + '\`' : '';
    const [rows] = await conn.query('SELECT * FROM \`' + tbl + '\`' + orderClause + ' LIMIT ? OFFSET ?', [limit + 1, offset]);
    return { rows: rows.slice(0, limit).map(cleanRow), hasMore: rows.length > limit };
  } finally {
    await conn.end();
  }
}

async function listDatabasesPostgres(cfg) {
  const pgMod = await loadDriver('pg', 'npm install pg');
  const Client = pgMod.Client ?? pgMod.default?.Client;
  const client = new Client({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port || 5432),
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || 'postgres',
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const res = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
    return res.rows.map((r) => String(r.datname));
  } finally {
    await client.end();
  }
}

async function introspectPostgres(cfg) {
  const pgMod = await loadDriver('pg', 'npm install pg');
  const Client = pgMod.Client ?? pgMod.default?.Client;
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
      "SELECT t.table_schema, t.table_name, COALESCE(s.n_live_tup, 0) AS row_count FROM information_schema.tables t LEFT JOIN pg_stat_user_tables s ON s.schemaname = t.table_schema AND s.relname = t.table_name WHERE t.table_type = 'BASE TABLE' AND t.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY t.table_schema, t.table_name"
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
    const enumRes = await client.query(
      "SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid ORDER BY t.typname, e.enumsortorder"
    );
    const enumMap = new Map();
    for (const r of enumRes.rows) {
      const list = enumMap.get(r.typname) || [];
      list.push(r.enumlabel);
      enumMap.set(r.typname, list);
    }
    return tablesRes.rows.map((t) => {
      const pks = new Set(pkRes.rows.filter((p) => p.table_name === t.table_name && p.table_schema === t.table_schema).map((p) => p.column_name));
      const fks = fkRes.rows.filter((f) => f.table_name === t.table_name && f.table_schema === t.table_schema).map((f) => ({
        column: f.column_name, targetTable: f.target_table, targetColumn: f.target_column, source: 'explicit',
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
        enumValues: c.data_type === 'USER-DEFINED' ? enumMap.get(c.udt_name) : undefined,
        foreignKey: fks.find((f) => f.column === c.column_name),
      }));
      return {
        name: t.table_name,
        schemaName: t.table_schema,
        rowCount: Number(t.row_count || 0),
        columns: tCols,
        primaryKeys: Array.from(pks),
        foreignKeys: fks,
      };
    });
  } finally {
    await client.end();
  }
}

async function rowsPostgres(cfg) {
  const pgMod = await loadDriver('pg', 'npm install pg');
  const Client = pgMod.Client ?? pgMod.default?.Client;
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
    const orderClause = cfg.orderBy ? ' ORDER BY "' + safeIdent(cfg.orderBy) + '"' : '';
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const res = await client.query('SELECT * FROM ' + schema + tbl + orderClause + ' LIMIT $1 OFFSET $2', [limit + 1, offset]);
    return { rows: res.rows.slice(0, limit).map(cleanRow), hasMore: res.rows.length > limit };
  } finally {
    await client.end();
  }
}

async function listDatabasesMssql(cfg) {
  const mssqlMod = await loadDriver('mssql', 'npm install mssql');
  const mssql = mssqlMod.default ?? mssqlMod;
  const pool = await mssql.connect(parseMssqlServer({ ...cfg, database: 'master' }));
  try {
    const res = await pool.request().query("SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name");
    return res.recordset.map((r) => String(r.name));
  } finally {
    await pool.close();
  }
}

async function introspectMssql(cfg) {
  const mssqlMod = await loadDriver('mssql', 'npm install mssql');
  const mssql = mssqlMod.default ?? mssqlMod;
  const pool = await mssql.connect(parseMssqlServer(cfg));
  try {
    const tablesRes = await pool.request().query(
      "SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, COALESCE(SUM(p.row_count), 0) AS ROW_COUNT " +
      "FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id " +
      "LEFT JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1) " +
      "WHERE t.is_ms_shipped = 0 GROUP BY s.name, t.name ORDER BY s.name, t.name"
    );
    const colsRes = await pool.request().query(
      "SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME, ty.name AS DATA_TYPE, " +
      "c.max_length, c.is_nullable, c.is_identity, dc.definition AS COLUMN_DEFAULT " +
      "FROM sys.columns c JOIN sys.tables t ON c.object_id = t.object_id " +
      "JOIN sys.schemas s ON t.schema_id = s.schema_id " +
      "JOIN sys.types ty ON c.user_type_id = ty.user_type_id " +
      "LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id " +
      "WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name, c.column_id"
    );
    const pkRes = await pool.request().query(
      "SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME " +
      "FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id " +
      "JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id " +
      "JOIN sys.tables t ON i.object_id = t.object_id JOIN sys.schemas s ON t.schema_id = s.schema_id " +
      "WHERE i.is_primary_key = 1"
    );
    const fkRes = await pool.request().query(
      "SELECT ps.name AS parent_schema, pt.name AS table_name, pc.name AS column_name, " +
      "rt.name AS target_table, rc.name AS target_column " +
      "FROM sys.foreign_key_columns fkc " +
      "JOIN sys.tables pt ON fkc.parent_object_id = pt.object_id " +
      "JOIN sys.schemas ps ON pt.schema_id = ps.schema_id " +
      "JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id " +
      "JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id " +
      "JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id"
    );
    const chkRes = await pool.request().query(
      "SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME, cc.definition " +
      "FROM sys.check_constraints cc JOIN sys.tables t ON cc.parent_object_id = t.object_id " +
      "JOIN sys.schemas s ON t.schema_id = s.schema_id " +
      "LEFT JOIN sys.columns c ON cc.parent_object_id = c.object_id AND cc.parent_column_id = c.column_id"
    );

    const chkMap = new Map();
    for (const r of chkRes.recordset) {
      if (!r.COLUMN_NAME) continue;
      const choices = parseCheckChoices(r.definition);
      if (choices) {
        chkMap.set(r.TABLE_SCHEMA + '.' + r.TABLE_NAME + '.' + r.COLUMN_NAME, choices);
      }
    }

    return tablesRes.recordset.map((t) => {
      const pks = new Set(pkRes.recordset.filter((p) => p.TABLE_NAME === t.TABLE_NAME && p.TABLE_SCHEMA === t.TABLE_SCHEMA).map((p) => p.COLUMN_NAME));
      const fks = fkRes.recordset.filter((f) => f.table_name === t.TABLE_NAME && f.parent_schema === t.TABLE_SCHEMA).map((f) => ({
        column: f.column_name, targetTable: f.target_table, targetColumn: f.target_column, source: 'explicit',
      }));
      const tCols = colsRes.recordset.filter((c) => c.TABLE_NAME === t.TABLE_NAME && c.TABLE_SCHEMA === t.TABLE_SCHEMA).map((c) => {
        const dt = String(c.DATA_TYPE || '').toLowerCase();
        const isMax = (dt === 'nvarchar' || dt === 'varchar') && Number(c.max_length) === -1;
        const rawType = isMax ? dt + '(MAX)' : dt;
        return {
          name: c.COLUMN_NAME,
          rawType,
          normalizedType: dt,
          nullable: Boolean(c.is_nullable),
          isPrimaryKey: pks.has(c.COLUMN_NAME),
          isAutoIncrement: Boolean(c.is_identity),
          isUnique: pks.has(c.COLUMN_NAME),
          defaultValue: c.COLUMN_DEFAULT || undefined,
          enumValues: chkMap.get(t.TABLE_SCHEMA + '.' + t.TABLE_NAME + '.' + c.COLUMN_NAME),
          foreignKey: fks.find((f) => f.column === c.COLUMN_NAME),
        };
      });
      return {
        name: t.TABLE_NAME,
        schemaName: t.TABLE_SCHEMA,
        rowCount: Number(t.ROW_COUNT || 0),
        columns: tCols,
        primaryKeys: Array.from(pks),
        foreignKeys: fks,
      };
    });
  } finally {
    await pool.close();
  }
}

async function rowsMssql(cfg) {
  const mssqlMod = await loadDriver('mssql', 'npm install mssql');
  const mssql = mssqlMod.default ?? mssqlMod;
  const pool = await mssql.connect(parseMssqlServer(cfg));
  try {
    const schema = cfg.schemaName ? '[' + safeIdent(cfg.schemaName) + '].' : '';
    const tbl = '[' + safeIdent(cfg.table) + ']';
    const orderExpr = cfg.orderBy ? '[' + safeIdent(cfg.orderBy) + ']' : '(SELECT NULL)';
    const limit = Math.min(1000, Math.max(1, Number(cfg.limit || 250)));
    const offset = Math.max(0, Number(cfg.offset || 0));
    const res = await pool.request().query('SELECT * FROM ' + schema + tbl + ' ORDER BY ' + orderExpr + ' OFFSET ' + offset + ' ROWS FETCH NEXT ' + (limit + 1) + ' ROWS ONLY');
    return { rows: res.recordset.slice(0, limit).map(cleanRow), hasMore: res.recordset.length > limit };
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
    const mod = await loadDriver('better-sqlite3', 'npm install better-sqlite3');
    const Database = mod.default ?? mod;
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
        column: f.from, targetTable: f.table, targetColumn: f.to || 'id', source: 'explicit',
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
    const orderClause = cfg.orderBy ? ' ORDER BY "' + safeIdent(cfg.orderBy) + '"' : '';
    const rows = db.all('SELECT * FROM "' + tbl + '"' + orderClause + ' LIMIT ? OFFSET ?', limit + 1, offset);
    return { rows: rows.slice(0, limit).map(cleanRow), hasMore: rows.length > limit };
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
      return send(res, 200, { ok: true, version: '1.1.0', drivers: ['mysql', 'postgresql', 'mssql', 'sqlite'] });
    }
    if (req.url === '/databases' && req.method === 'POST') {
      const cfg = await readJson(req);
      const databases =
        cfg.driver === 'mysql' ? await listDatabasesMysql(cfg)
        : cfg.driver === 'postgresql' ? await listDatabasesPostgres(cfg)
        : cfg.driver === 'mssql' ? await listDatabasesMssql(cfg)
        : null;
      if (!databases) return send(res, 400, { error: 'Database listing not supported for driver: ' + cfg.driver });
      return send(res, 200, { databases });
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
  console.log('FormLogic Local DB Bridge v1.1 listening on http://127.0.0.1:' + PORT);
  console.log('Allowed Origin : ' + ALLOWED_ORIGIN);
  console.log('Pairing Token  : ' + TOKEN);
  console.log('');
  console.log('Paste the Pairing Token into FormLogic -> Import Database -> Connect Locally.');
  console.log('Press Ctrl+C to stop.');
});
`;
}
