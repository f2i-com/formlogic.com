import {DatabaseSync} from 'node:sqlite';
import {workerData,parentPort} from 'node:worker_threads';
import {
  readFileSync,
  lstatSync,
  realpathSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join,relative,isAbsolute,basename} from 'node:path';

const runtimeDir = realpathSync(process.env.SOFTN_RUNTIME_DIR || '');
const importRuntime = name => import(pathToFileURL(join(runtimeDir, name)).href);

const [
  {createWasmHost,validateWasmSource,logFailure},
  {applyMigration,setupDeadlineMs},
  {SQL_LIMITS},
  {configureRecordEvents,RECORD_OUTBOX},
  {invokeWithHook},
  {isContainerBackendManifest,handleContainerRequest},
] = await Promise.all([
  importRuntime('wasm-host.mjs'),
  importRuntime('migrations.mjs'),
  importRuntime('sql.mjs'),
  importRuntime('record-events.mjs'),
  importRuntime('request-hook.mjs'),
  importRuntime('container-backend.mjs'),
]);

const root = realpathSync(process.env.SOFTN_BACKEND_ROOT || '');
const sharedDataRaw = process.env.SOFTN_DATA_ROOT || '';
const sharedDatabaseMode = sharedDataRaw !== '';
const contained = (parent, child) => {
  const path = relative(parent, child);
  return path !== '' && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'));
};

const MIGRATION_ATTEMPTS = 3;
const HIDDEN_NAMES = /password|token|secret|code_?hash|key_?hash|api_?key|access_?key|private_?key|challenge|encrypted|sealed/i;
const HIDDEN_WORDS = new Set(['hash', 'salt', 'otp', 'pin', 'passcode', 'passphrase', 'credential', 'credentials']);
const SNAPSHOT_ROW_LIMIT = 5000;

function isHiddenColumn(name) {
  if (HIDDEN_NAMES.test(name)) return true;
  const words = name
    .replace(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g, '_')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.some(w => HIDDEN_WORDS.has(w));
}

function quoteIdent(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

function markLimited(minute, bucket) {
  try {
    const all = join(root, 'private/limited');
    const now = join(all, String(minute));
    mkdirSync(now, {recursive: true, mode: 0o700});
    writeFileSync(join(now, bucket), '', {mode: 0o600});
    for (const name of readdirSync(all)) {
      if (name !== String(minute)) rmSync(join(all, name), {recursive: true, force: true});
    }
  } catch {}
}

function emit(result) {
  const valid =
    result &&
    typeof result === 'object' &&
    Number.isInteger(result.status) &&
    result.status >= 200 &&
    result.status <= 599 &&
    Object.hasOwn(result, 'body');
  const status = valid ? result.status : 500;
  const body = valid ? result.body : {error: 'The request could not be completed.', code: 'host_error'};
  process.stdout.write('{"status":' + status + ',"body":' + (JSON.stringify(body) ?? 'null') + '}');
}

function emitContainer(result) {
  const valid =
    result &&
    typeof result === 'object' &&
    Number.isInteger(result.status) &&
    result.status >= 100 &&
    result.status <= 599 &&
    Array.isArray(result.headers) &&
    typeof result.bodyBase64 === 'string';
  if (!valid) {
    emit({status: 500, body: {error: 'The request could not be completed.', code: 'host_error'}});
    return;
  }
  process.stdout.write(JSON.stringify({status: result.status, headers: result.headers, bodyBase64: result.bodyBase64}));
}

const busy = e => e?.errcode === 5 || e?.errcode === 6 || /database is (locked|busy)/i.test(String(e?.message));
const unwritable = e =>
  /database or disk is full|attempt to write a readonly database|disk I\/O error|read-only file system|no space left on device|input\/output error/i.test(
    String(e?.message)
  ) || /^E(?:ROFS|NOSPC|IO): /.test(String(e?.message));

function resolveDataDir() {
  if (sharedDatabaseMode) {
    if (lstatSync(sharedDataRaw).isSymbolicLink()) throw new Error('Invalid shared data path');
    return realpathSync(sharedDataRaw);
  }
  const dataPath = join(root, 'private/data');
  const data = realpathSync(dataPath);
  if (lstatSync(dataPath).isSymbolicLink() || !contained(realpathSync(join(root, 'private')), data)) {
    throw new Error('Invalid data path');
  }
  return data;
}

function parseSubscribedTables(subscriptions) {
  const byTable = new Map();
  if (!Array.isArray(subscriptions)) return byTable;
  for (const sub of subscriptions) {
    if (!sub || typeof sub.event !== 'string' || !Array.isArray(sub.bindings) || sub.bindings.length === 0) continue;
    const match = /^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/.exec(sub.event);
    if (!match) continue;
    const [, op, table] = match;
    if (!byTable.has(table)) byTable.set(table, {created: [], updated: [], deleted: []});
    const entry = byTable.get(table);
    for (const bid of sub.bindings) {
      if (typeof bid === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(bid) && !entry[op].includes(bid)) {
        entry[op].push(bid);
      }
    }
  }
  return byTable;
}

function previewRowValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return null;
  if (typeof val === 'string') return val.length > 400 ? val.slice(0, 400) : val;
  return val;
}

function snapshotSubscribedTables(dbFile, subscribedTables) {
  const snap = new Map();
  if (!existsSync(dbFile) || subscribedTables.size === 0) return snap;
  if (lstatSync(dbFile).isSymbolicLink()) return snap;
  const sdb = new DatabaseSync(dbFile, {allowExtension: false, limits: SQL_LIMITS, readOnly: true});
  try {
    sdb.exec('PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF;');
    const existing = new Set(
      sdb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,1)!='_' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map(r => r.name)
    );
    for (const table of subscribedTables.keys()) {
      if (!existing.has(table)) continue;
      const cols = sdb.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
      const pkCols = cols
        .filter(c => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map(c => c.name);
      const visibleCols = cols
        .filter(c => !isHiddenColumn(c.name))
        .sort((a, b) => Number(b.pk) - Number(a.pk))
        .slice(0, 40)
        .map(c => c.name);
      const keyCols = pkCols.length > 0 ? pkCols : ['rowid'];
      const selectCols = [...new Set([...keyCols, ...visibleCols])];
      const rows = sdb
        .prepare(`SELECT ${selectCols.map(c => quoteIdent(c)).join(',')} FROM ${quoteIdent(table)} LIMIT ${SNAPSHOT_ROW_LIMIT + 1}`)
        .all();
      if (rows.length > SNAPSHOT_ROW_LIMIT) continue;
      const map = new Map();
      for (const row of rows) {
        const keyVal = JSON.stringify(keyCols.map(k => row[k] ?? null));
        const preview = {};
        for (const col of visibleCols) preview[col] = previewRowValue(row[col]);
        const hash = createHash('sha256').update(JSON.stringify(preview)).digest('hex');
        map.set(keyVal, {hash, preview});
      }
      snap.set(table, map);
    }
  } catch {
    // Best-effort snapshot
  } finally {
    try {
      sdb.close();
    } catch {}
  }
  return snap;
}

function recordContainerDiffEvents(dbFile, subscribedTables, beforeSnap) {
  if (!existsSync(dbFile) || subscribedTables.size === 0) return;
  if (lstatSync(dbFile).isSymbolicLink()) return;
  const afterSnap = snapshotSubscribedTables(dbFile, subscribedTables);
  const events = [];
  for (const [table, ops] of subscribedTables.entries()) {
    const before = beforeSnap.get(table) || new Map();
    const after = afterSnap.get(table) || new Map();
    if (ops.created.length > 0) {
      for (const [k, row] of after.entries()) {
        if (!before.has(k)) {
          events.push({
            eventName: `app.record.created.${table}`,
            bindings: ops.created,
            data: {table, operation: 'created', record: row.preview, recordPreview: true},
          });
        }
      }
    }
    if (ops.updated.length > 0) {
      for (const [k, row] of after.entries()) {
        const prev = before.get(k);
        if (prev && prev.hash !== row.hash) {
          events.push({
            eventName: `app.record.updated.${table}`,
            bindings: ops.updated,
            data: {table, operation: 'updated', record: row.preview, recordPreview: true},
          });
        }
      }
    }
    if (ops.deleted.length > 0) {
      for (const [k, row] of before.entries()) {
        if (!after.has(k)) {
          events.push({
            eventName: `app.record.deleted.${table}`,
            bindings: ops.deleted,
            data: {table, operation: 'deleted', record: row.preview, recordPreview: true},
          });
        }
      }
    }
  }
  if (events.length === 0) return;
  const wdb = new DatabaseSync(dbFile, {allowExtension: false, limits: SQL_LIMITS});
  try {
    wdb.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;');
    wdb.exec(
      `CREATE TABLE IF NOT EXISTS ${RECORD_OUTBOX}(id TEXT PRIMARY KEY,event_name TEXT NOT NULL,data_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`
    );
    const countRow = wdb.prepare(`SELECT count(*) AS cnt FROM ${RECORD_OUTBOX}`).get();
    if (Number(countRow?.cnt || 0) + events.length > 10000) return;
    const insert = wdb.prepare(
      `INSERT INTO ${RECORD_OUTBOX}(id,event_name,data_json,bindings_json,created_at) VALUES(?,?,?,?,?)`
    );
    const now = Math.floor(Date.now() / 1000);
    wdb.exec('BEGIN IMMEDIATE');
    try {
      for (const ev of events.slice(0, 200)) {
        insert.run(
          randomBytes(16).toString('hex'),
          ev.eventName,
          JSON.stringify(ev.data),
          JSON.stringify(ev.bindings),
          now
        );
      }
      wdb.exec('COMMIT');
    } catch (e) {
      try {
        wdb.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  } finally {
    try {
      wdb.close();
    } catch {}
  }
}

let db;
let startupStage = 'configuration_read';

try {
  const config = JSON.parse(readFileSync(join(root, 'private/config.json'), 'utf8'));
  startupStage = 'configuration_values';
  if (!/^[a-f0-9]{64}$/.test(config.keyHex) || typeof config.development !== 'boolean') {
    throw new Error('Invalid configuration');
  }
  startupStage = 'bundle_directory';
  const bundle = realpathSync(join(root, 'app'));
  if (lstatSync(join(root, 'app')).isSymbolicLink() || !contained(root, bundle)) {
    throw new Error('Invalid bundle directory');
  }
  const inside = rel => {
    if (
      typeof rel !== 'string' ||
      rel.startsWith('/') ||
      rel.includes('\\') ||
      rel.split('/').some(s => s === '..' || s === '.')
    ) {
      throw new Error('Invalid bundle path');
    }
    const file = realpathSync(join(bundle, rel));
    if (!contained(bundle, file)) throw new Error('Bundle path escaped');
    return file;
  };
  startupStage = 'manifest_read';
  const manifest = JSON.parse(readFileSync(inside('manifest.json'), 'utf8'));
  startupStage = 'data_directory';
  const data = resolveDataDir();

  if (isContainerBackendManifest(manifest)) {
    startupStage = 'application_identity';
    if (typeof manifest.id === 'string' && manifest.id && config.appId !== manifest.id) {
      throw new Error('Operator configuration belongs to another app');
    }
    startupStage = 'request_input';
    const input = workerData;
    if (typeof input !== 'string' || Buffer.byteLength(input) > 7_900_000) throw new Error('Input limit');
    const request = JSON.parse(input);
    if (!request || typeof request.path !== 'string' || !request.path.startsWith('/') || typeof request.method !== 'string') {
      throw new Error('Invalid request');
    }
    startupStage = 'container_backend';
    const hostContext = config.enableHostContext === true ? JSON.parse(process.env.SOFTN_HOST_CONTEXT || '{}') : null;
    const recordSubscriptions =
      config.enableHostContext === true ? JSON.parse(process.env.SOFTN_RECORD_EVENTS || '[]') : [];
    const methodUpper = String(request.method || 'GET').toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(methodUpper);
    const subscribedTables = isMutating ? parseSubscribedTables(recordSubscriptions) : new Map();
    const primaryDbFile = config.containerPrimaryDatabase === 'application.sqlite' ? join(data, 'application.sqlite') : null;
    const beforeSnap =
      primaryDbFile && subscribedTables.size > 0 ? snapshotSubscribedTables(primaryDbFile, subscribedTables) : new Map();

    const containerResult = await handleContainerRequest({
      root,
      bundle,
      data,
      manifest,
      config,
      request,
      hostContext,
      markLimited,
    });
    if (
      !containerResult.isMeta &&
      primaryDbFile &&
      subscribedTables.size > 0 &&
      Number(containerResult.status) < 500
    ) {
      try {
        recordContainerDiffEvents(primaryDbFile, subscribedTables, beforeSnap);
      } catch (e) {
        logFailure('container record events', e);
      }
    }
    if (containerResult.isMeta) emit({status: containerResult.status, body: containerResult.body});
    else emitContainer(containerResult);
  } else {
    startupStage = 'application_identity';
    if (config.appId !== manifest.id) throw new Error('Operator configuration belongs to another app');
    const supported = ['sql', 'crypto', 'time', 'trusted-client-ip', 'transaction-scope', 'photos'];
    const required = manifest.server?.requires;
    startupStage = 'application_capabilities';
    if (
      !required ||
      required.apiVersion !== 1 ||
      !Array.isArray(required.capabilities) ||
      required.capabilities.some(c => !supported.includes(c) || !config.capabilities?.includes(c)) ||
      manifest.server.sync?.enabled
    ) {
      throw new Error('Unsupported application capabilities');
    }
    startupStage = 'crypto_domains';
    if (
      !config.cryptoDomains ||
      !['hmac', 'seal'].every(k => typeof config.cryptoDomains[k] === 'string' && /^[!-~]{1,128}$/.test(config.cryptoDomains[k])) ||
      config.cryptoDomains.hmac === config.cryptoDomains.seal
    ) {
      throw new Error('Invalid crypto domains');
    }
    startupStage = 'route_configuration';
    const declared = manifest.server.routes;
    if (!Array.isArray(declared) || declared.length > 256) throw new Error('Unsupported route declaration');
    const unserved = [];
    const routes = [];
    for (const r of declared) {
      if (!r || typeof r !== 'object' || typeof r.path !== 'string' || typeof r.method !== 'string' || !/^[$A-Z_a-z][$\w]*$/.test(r.handler)) {
        throw new Error('Unsupported route declaration');
      }
      const transaction = r.transaction === undefined || r.transaction === 'none' ? (r.method === 'GET' ? 'read' : 'write') : r.transaction;
      const authorization =
        r.authorization === undefined ? 'application' : r.authorization === 'host-token' ? 'hosttoken' : r.authorization;
      if (!['read', 'write'].includes(transaction) || !['application', 'anonymous', 'hosttoken'].includes(authorization)) {
        throw new Error('Unsupported route declaration');
      }
      let reason = null;
      if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(r.path)) reason = 'path outside /api/ is not routed to this host';
      else if (!['GET', 'POST', 'PUT', 'DELETE'].includes(r.method)) reason = 'method not served by this host';
      else if (authorization === 'hosttoken') reason = 'hosttoken authorization: this host holds no token';
      if (reason) {
        unserved.push({method: r.method, path: r.path, reason});
        continue;
      }
      routes.push({...r, transaction, authorization});
    }
    if (declared.some(r => r.upload !== undefined && (r.upload !== 'photo' || !required.capabilities.includes('photos') || r.method !== 'POST'))) {
      throw new Error('Unsupported upload capability');
    }
    if (new Set(declared.map(r => r.method + ' ' + r.path)).size !== declared.length) throw new Error('Duplicate route');
    if (routes.some(r => r.poll !== undefined && (typeof r.poll !== 'boolean' || (r.poll && (r.method !== 'GET' || r.transaction !== 'read'))))) {
      throw new Error('Invalid polling route');
    }
    startupStage = 'application_source';
    validateWasmSource(
      readFileSync(inside(manifest.server.entry), 'utf8'),
      manifest.config?.app || {},
      config.development,
      declared,
      required.capabilities.includes('photos')
    );
    startupStage = 'request_input';
    const input = workerData;
    if (typeof input !== 'string' || Buffer.byteLength(input) > 6_000_000) throw new Error('Input limit');
    const request = JSON.parse(input);
    if (
      !request ||
      typeof request.path !== 'string' ||
      !request.path.startsWith('/api/') ||
      !['GET', 'POST', 'PUT', 'DELETE'].includes(request.method) ||
      typeof request.client_ip !== 'string'
    ) {
      throw new Error('Invalid request');
    }
    startupStage = 'database_open';
    const file = join(data, 'application.sqlite');
    let mode = null;
    try {
      const found = lstatSync(file);
      if (found.isSymbolicLink()) throw new Error('Invalid database');
      mode = found.mode;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (mode !== null && (mode & 0o400)) {
      try {
        chmodSync(file, 0o600);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    for (const companion of [file + '-wal', file + '-shm']) {
      try {
        const found = lstatSync(companion);
        if (found.isFile() && (found.mode & 0o400)) chmodSync(companion, 0o600);
      } catch {}
    }
    db = new DatabaseSync(file, {allowExtension: false, limits: SQL_LIMITS});
    chmodSync(file, 0o600);
    db.exec(
      'PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=131072;'
    );
    startupStage = 'database_lock';
    db.exec('BEGIN IMMEDIATE');
    try {
      startupStage = 'database_migrations';
      db.exec('CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
      const migrations = [...(manifest.server.database?.migrations || [])];
      if (migrations.some(name => typeof name !== 'string')) throw new Error('Invalid migration list');
      migrations.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      if (migrations.some((name, i) => i > 0 && name === migrations[i - 1])) throw new Error('Duplicate migration path');
      const stoppedNote = join(root, 'private/data/migration-stopped.json');
      const operatorRun = setupDeadlineMs(process.env) !== null;
      let stopped = null;
      try {
        stopped = JSON.parse(readFileSync(stoppedNote, 'utf8'));
      } catch {}
      for (const name of migrations) {
        const sql = readFileSync(inside(name), 'utf8');
        const hash = createHash('sha256').update(sql).digest('hex');
        const ledgerName = sharedDatabaseMode ? `${config.appId}:${name}` : name;
        const old = db.prepare('SELECT sha256 FROM _migrations WHERE name=?').get(ledgerName);
        if (old) {
          if (old.sha256 !== hash) throw new Error('Migration mismatch');
          continue;
        }
        if (sharedDatabaseMode) {
          // If this database was cloned from the same app (e.g. marketplace sandbox) or already
          // had this exact migration applied under its unprefixed name, record and skip cleanly.
          const unprefixed = db.prepare('SELECT sha256 FROM _migrations WHERE name=?').get(name);
          if (unprefixed && unprefixed.sha256 === hash) {
            db.prepare('INSERT OR IGNORE INTO _migrations VALUES(?,?,?)').run(ledgerName, hash, Math.floor(Date.now() / 1000));
            continue;
          }
        }
        const fileName = basename(name);
        if (!operatorRun && stopped?.name === name && stopped.sha256 === hash && stopped.stops >= MIGRATION_ATTEMPTS) {
          startupStage = 'migration_stopped';
          throw new Error(`Migration ${fileName} was stopped at the deadline ${stopped.stops} times`);
        }
        parentPort?.postMessage({migration: {name, file: fileName, sha256: hash, marker: stoppedNote, attempts: MIGRATION_ATTEMPTS}});
        applyMigration(db, sql);
        db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run(ledgerName, hash, Math.floor(Date.now() / 1000));
        parentPort?.postMessage({migration: null});
      }
      if (stopped) rmSync(stoppedNote, {force: true});
      if (!sharedDatabaseMode) {
        const listed = new Set(migrations);
        if (db.prepare('SELECT name FROM _migrations').all().some(row => !listed.has(row.name))) {
          throw new Error('Deployment removed a previously applied migration');
        }
      }
      startupStage = 'request_limits';
      db.exec('CREATE TABLE IF NOT EXISTS _request_limits(ip TEXT PRIMARY KEY, minute INTEGER NOT NULL, count INTEGER NOT NULL) STRICT');
      const rateKey = typeof request.rate_key === 'string' && request.rate_key ? request.rate_key : request.client_ip;
      const minute = Math.floor(Date.now() / 60000);
      const ip = createHash('sha256').update(rateKey).digest('hex');
      db.prepare('DELETE FROM _request_limits WHERE minute<?').run(minute - 1);
      db.prepare(
        'INSERT INTO _request_limits VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END,minute=excluded.minute'
      ).run(ip, minute);
      const count = db.prepare('SELECT count FROM _request_limits WHERE ip=?').get(ip).count;
      db.exec('COMMIT');
      const declaredLimit = manifest.config?.server?.requestsPerMinute;
      const perMinute = Number.isInteger(declaredLimit) && declaredLimit >= 0 ? declaredLimit : 120;
      if (perMinute > 0 && count > perMinute) {
        markLimited(minute, ip);
        emit({status: 429, body: {error: 'Too many requests.', code: 'rate_limited'}});
        process.exit(0);
      }
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
    if (request.refused === 'photo') {
      emit({
        status: 400,
        body: {
          error: 'Photo rejected. Use a still JPEG, PNG or WebP under 4 MB, 16 megapixels and 8192 pixels a side.',
          code: 'photo_rejected',
        },
      });
      process.exit(0);
    }
    startupStage = 'record_events';
    const recordSubscriptions =
      config.enableHostContext === true ? JSON.parse(process.env.SOFTN_RECORD_EVENTS || '[]') : [];
    const authorizeRecordEvent = configureRecordEvents(db, recordSubscriptions);
    startupStage = 'wasm_initialization';
    const host = createWasmHost(db, {
      authorizeRecordEvent,
      key: Buffer.from(config.keyHex, 'hex'),
      cryptoDomains: config.cryptoDomains,
      development: config.development,
      capabilities: required.capabilities,
      appConfig: manifest.config?.app || {},
      source: readFileSync(inside(manifest.server.entry), 'utf8'),
    });
    let result;
    const route = routes.find(r => r.path === request.path && r.method === request.method);
    if (request.path === '/api/meta' && request.method === 'GET') {
      result = {
        status: 200,
        body: {
          development: config.development,
          photos: required.capabilities.includes('photos') && request.photos === true,
          version: manifest.version,
          runtime: 'zipp-wasm-on-demand',
          appId: manifest.id,
          sharedDatabase: sharedDatabaseMode,
          ...(unserved.length ? {unservedRoutes: unserved} : {}),
        },
      };
    } else if (!route) {
      const aside = unserved.find(u => u.path === request.path && u.method === request.method);
      result =
        aside && aside.reason.startsWith('hosttoken')
          ? {status: 401, body: {error: 'Authorization required'}}
          : {status: 404, body: {error: 'Endpoint not found.', code: 'not_found'}};
    } else {
      delete request.rate_key;
      if (!required.capabilities.includes('trusted-client-ip')) delete request.client_ip;
      if (route.upload !== 'photo') delete request.upload;
      startupStage = 'request_integration';
      const hostContext = config.enableHostContext === true ? JSON.parse(process.env.SOFTN_HOST_CONTEXT || '{}') : {};
      result = await invokeWithHook({
        request,
        route,
        host,
        config,
        db,
        hostContext,
        loadHook: () => import(pathToFileURL(join(root, 'operator/request.mjs')).href),
      });
    }
    if (config.enableAfterRequestHook === true) {
      try {
        const hook = await import(pathToFileURL(join(root, 'operator/after-request.mjs')).href);
        await hook.afterRequest({db, crypto: host.crypto, config});
      } catch {}
    }
    emit(result);
  }
} catch (e) {
  if (!busy(e)) logFailure('startup stage ' + startupStage, e);
  emit(
    busy(e)
      ? {status: 503, body: {error: 'The server is busy. Please retry.', code: 'database_busy'}}
      : unwritable(e)
        ? {
            status: 503,
            body: {
              error: 'The backend cannot write its database: the disk may be full or read-only, or the database may be at its size limit.',
              code: 'backend_unavailable',
              diagnostic: 'database_unwritable',
            },
          }
        : {
            status: 503,
            body: {
              error: 'The backend is unavailable. Check its private configuration.',
              code: 'backend_unavailable',
              diagnostic: startupStage,
            },
          }
  );
} finally {
  try {
    db?.close();
  } catch {}
}
