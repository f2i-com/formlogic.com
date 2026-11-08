import { expect, test, type APIRequestContext } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { E2E_FRONTEND_BASE_URL, sessionHeaders } from './session-request';

// A SoftN app moved here from SoftN's own hosting, as Coffee.Dating is: its photo upload route gets
// the photo this server redrew, and its database (and the key it was kept under) comes with it.
const RUN = Date.now().toString(36);
const MIGRATION = 'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL, photo TEXT);\n';

function project() {
  return { home: false, access: 'application', assets: {}, files: {
    'manifest.json': JSON.stringify({ id: `com.formlogic.e2e.photos.${RUN}`, name: 'Photos and data', version: '1.0.0', main: 'ui/main.ui',
      config: { server: { allowedOrigins: ['https://photos.example'] } },
      server: {
        entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql', 'photos'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] },
        routes: [
          { path: '/api/people', method: 'GET', handler: 'people', transaction: 'read', authorization: 'anonymous' },
          { path: '/api/photo', method: 'POST', handler: 'photo', transaction: 'write', authorization: 'anonymous', upload: 'photo' },
          { path: '/api/echo', method: 'POST', handler: 'echo', transaction: 'read', authorization: 'anonymous' },
        ],
      } }),
    'ui/main.ui': '<Text>Photos and data</Text>',
    'server/main.logic': [
      'function people(req) { return {status:200, body:{people: softn.sql.query("SELECT id, name, photo IS NOT NULL AS has_photo FROM people ORDER BY id"), photos: softn.config.photos === true}}; }',
      'function photo(req) { var u = req.upload; if (!u || u.sanitized !== true) return {status:400, body:{error:"no photo"}}; softn.sql.execute("UPDATE people SET photo=? WHERE id=1", [u.thumbnail]); return {status:201, body:{image: u.image.slice(0, 23), thumbnail: u.thumbnail.slice(0, 23), body: req.body}}; }',
      'function echo(req) { return {status:200, body:{size: JSON.stringify(req.body).length}}; }',
    ].join('\n'),
    'server/migrations/001.sql': MIGRATION,
  } };
}

async function owner(request: APIRequestContext) {
  const registered = await request.post('/api/auth/register', { headers: sessionHeaders(), data: { email: `photos-${RUN}@e2e-apps.com`, password: 'photos-e2e-password-1', name: 'Photos owner' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const csrf = (await request.storageState()).cookies.find(cookie => cookie.name === 'formlogic_csrf')!.value;
  return { 'X-CSRF-Token': csrf };
}

test('an app from SoftN hosting gets redrawn photos, and brings its database and key with it', async ({ context }) => {
  test.setTimeout(180_000);
  const headers = await owner(context.request);
  const created = await context.request.post('/api/apps', { headers, data: { name: `photos-${RUN}`, slug: `photos-${RUN}`, settings: { softnApp: true } } });
  expect(created.status(), await created.text()).toBe(201);
  const { app } = await created.json();
  const installed = await context.request.put(`/api/apps/${app.id}/native`, { headers, data: { project: project(), expectedVersion: 0 } });
  expect(installed.status(), await installed.text()).toBe(200);
  expect((await context.request.post(`/api/apps/${app.id}/publish`, { headers })).ok()).toBe(true);

  // Its old database, as SoftN's host kept it: the migration ledger, and a person.
  const folder = mkdtempSync(join(tmpdir(), 'formlogic-e2e-import-'));
  try {
    const old = join(folder, 'application.sqlite');
    const db = new DatabaseSync(old);
    db.exec(MIGRATION);
    db.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    db.prepare('INSERT INTO _migrations VALUES(?,?,?)').run('server/migrations/001.sql', createHash('sha256').update(MIGRATION).digest('hex'), 1);
    db.prepare('INSERT INTO people(name) VALUES(?)').run('Ada from the old site');
    db.close();
    const key = Buffer.from(JSON.stringify({ appId: `com.formlogic.e2e.photos.${RUN}`, keyHex: 'c'.repeat(64), cryptoDomains: { hmac: 'old:hmac:v1', seal: 'old:seal:v1' }, enableRequestHook: true }));
    const brought = await context.request.post(`/api/apps/${app.id}/native/import`, { headers, multipart: {
      database: { name: 'application.sqlite', mimeType: 'application/octet-stream', buffer: readFileSync(old) },
      config: { name: 'config.json', mimeType: 'application/json', buffer: key },
      useVerification: '0',
    } });
    expect(brought.status(), await brought.text()).toBe(200);
    expect(await brought.json()).toMatchObject({ project: { version: 2 }, keyImported: true, verificationFound: false });
  } finally { rmSync(folder, { recursive: true, force: true }); }

  const call = (path: string, method: string, body: object = {}) => context.request.post(`${E2E_FRONTEND_BASE_URL}/api/app/photos-${RUN}/native/request`, { headers: { ...headers, 'Content-Type': 'application/json' }, data: { path, method, body } });
  const people = await (await call('/api/people', 'GET')).json();
  expect(people.result.body).toEqual({ people: [{ id: 1, name: 'Ada from the old site', has_photo: 0 }], photos: true });

  // A PNG, sent as a data: URL, redrawn as JPEGs: the backend gets those and an empty body.
  const png = readFileSync(resolve('public', 'pwa-512x512.png'));
  // 1.6 MB of bytes that are no picture at all, labelled as one.
  const big = Buffer.alloc(1_600_000, 7);
  const uploaded = await (await call('/api/photo', 'POST', { data_url: `data:image/png;base64,${png.toString('base64')}` })).json();
  expect(uploaded.result).toEqual({ status: 201, body: { image: 'data:image/jpeg;base64,', thumbnail: 'data:image/jpeg;base64,', body: {} } });
  expect((await (await call('/api/people', 'GET')).json()).result.body.people[0].has_photo).toBe(1);
  // What is not a photo is answered by the app's backend as refused; nothing of it reaches the app.
  const refused = await (await call('/api/photo', 'POST', { data_url: `data:image/png;base64,${big.toString('base64')}` })).json();
  expect(refused.result.status).toBe(400);
  expect(refused.result.body.code).toBe('photo_rejected');
  // Any other route keeps the 2 MB it always had.
  expect((await call('/api/echo', 'POST', { text: 'x'.repeat(2_200_000) })).status()).toBe(413);
  expect((await (await call('/api/echo', 'POST', { text: 'x'.repeat(100_000) })).json()).result.body.size).toBeGreaterThan(100_000);
});
