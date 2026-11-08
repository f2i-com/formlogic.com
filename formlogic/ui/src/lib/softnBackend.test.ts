import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backendOf, backendOrigin, STARTER_BACKEND, withBackend } from './softnBackend';
import type { NativeProject } from './nativeHosting';

const project = (files: Record<string, string>): NativeProject => ({ version: 1, files, assets: { 'assets/icon.svg': 'PHN2Zy8+' }, access: 'application' });
const pageOnly = () => project({
  'manifest.json': JSON.stringify({ id: 'com.example.coffee', name: 'Coffee', version: '1.0.0', main: 'ui/main.ui', config: { theme: { mode: 'light' } } }),
  'ui/main.ui': '<Text>Page, newer</Text>',
  'logic/main.logic': 'var API_BASE = "https://coffee.example";',
});
const fullApp = () => project({
  'manifest.json': JSON.stringify({ id: 'com.example.coffee', name: 'Coffee', version: '1.0.0', main: 'ui/main.ui',
    config: { theme: { mode: 'dark' }, server: { allowedOrigins: ['https://coffee.example'], maxBodySize: 5600100 }, app: { verificationProvider: 'twilio-verify' } },
    server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] }, routes: [{ path: '/api/me', method: 'GET', handler: 'me', transaction: 'read', authorization: 'anonymous' }] } }),
  'ui/main.ui': '<Text>Page, older</Text>',
  'logic/main.logic': 'var API_BASE = "https://coffee.example"; // older',
  'server/main.logic': 'function me(req) { return {status:200, body:{}}; }',
  'server/migrations/001.sql': 'CREATE TABLE people(id INTEGER PRIMARY KEY);',
});

describe('adding an API backend to a SoftN app that has none', () => {
  it("gives the starter's backend, the one a new app starts with", () => {
    const starter = JSON.parse(readFileSync(resolve(__dirname, '../../../backend/resources/native-app-starter.json'), 'utf8'));
    const manifest = JSON.parse(starter.files['manifest.json']);
    expect(STARTER_BACKEND.server).toEqual(manifest.server);
    expect(STARTER_BACKEND.config.server).toEqual(manifest.config.server);
    for (const [path, source] of Object.entries(STARTER_BACKEND.files)) expect(source, path).toBe(starter.files[path]);
  });

  it('adds it to the page as it is, with the address the page calls it at', () => {
    const next = withBackend(pageOnly(), STARTER_BACKEND);
    const manifest = JSON.parse(next.files['manifest.json']);
    expect(manifest.server).toEqual(STARTER_BACKEND.server);
    expect(manifest.config).toEqual({ theme: { mode: 'light' }, server: { allowedOrigins: ['https://app.example'] } });
    expect(next.files['ui/main.ui']).toBe('<Text>Page, newer</Text>');
    expect(next.files['server/main.logic']).toBe(STARTER_BACKEND.files['server/main.logic']);
    expect(next.assets).toEqual(pageOnly().assets);
    expect(backendOrigin(next)).toBe('https://app.example');
  });

  it("puts an app built in two halves back together: the page kept, the full app's backend taken", () => {
    const backend = backendOf(fullApp())!;
    expect(Object.keys(backend.files).sort()).toEqual(['server/main.logic', 'server/migrations/001.sql']);
    const next = withBackend(pageOnly(), backend);
    const manifest = JSON.parse(next.files['manifest.json']);
    expect(manifest.server).toEqual(JSON.parse(fullApp().files['manifest.json']).server);
    // The page's own settings stand; what the backend reads (and the address it is called at) is added.
    expect(manifest.config).toEqual({ theme: { mode: 'light' }, server: { allowedOrigins: ['https://coffee.example'], maxBodySize: 5600100 }, app: { verificationProvider: 'twilio-verify' } });
    expect(next.files['ui/main.ui']).toBe('<Text>Page, newer</Text>');
    expect(next.files['logic/main.logic']).toBe('var API_BASE = "https://coffee.example";');
  });

  it("takes server/ alone from the file: never the old host's private/ (its key) or backend/", () => {
    const full = fullApp();
    full.files['private/config.json'] = '{"keyHex":"00"}';
    full.files['backend/notes.txt'] = 'kept by the old host';
    const backend = backendOf(full)!;
    expect(Object.keys(backend.files).sort()).toEqual(['server/main.logic', 'server/migrations/001.sql']);
    expect(Object.keys(withBackend(pageOnly(), backend).files).filter(path => !/^(server|ui|logic)\//.test(path))).toEqual(['manifest.json']);
  });

  it("keeps the page's id, takes the backend's where the page names none, and refuses another app's backend", () => {
    const named = (id: unknown) => { const page = pageOnly(); page.files['manifest.json'] = JSON.stringify({ ...JSON.parse(page.files['manifest.json']), id }); return page; };
    const unnamed = pageOnly(); unnamed.files['manifest.json'] = JSON.stringify({ name: 'Coffee', version: '1.0.0', main: 'ui/main.ui' });
    const backend = backendOf(fullApp())!;
    expect(backend.id).toBe('com.example.coffee');
    expect(JSON.parse(withBackend(unnamed, backend).files['manifest.json']).id).toBe('com.example.coffee');
    expect(JSON.parse(withBackend(named(null), backend).files['manifest.json']).id).toBe('com.example.coffee');
    expect(JSON.parse(withBackend(named('com.example.coffee'), backend).files['manifest.json']).id).toBe('com.example.coffee');
    expect(() => withBackend(named('com.example.tea'), backend)).toThrow("another app's backend: this page is com.example.tea, and the file is com.example.coffee");
    // The starter names no app: the page keeps its own id, or none.
    expect(JSON.parse(withBackend(unnamed, STARTER_BACKEND).files['manifest.json']).id).toBeUndefined();
  });

  it('refuses a result over what this host keeps, before anything is created', () => {
    const crowded = pageOnly();
    for (let i = 0; i < 199; i++) crowded.files[`ui/page-${i}.ui`] = '<Text>Page</Text>';
    expect(() => withBackend(crowded, STARTER_BACKEND)).toThrow('would have 204 source files; this host keeps up to 200');
    const heavy = pageOnly();
    heavy.assets = { 'assets/big.bin': 'A'.repeat(Math.ceil((64 * 1024 * 1024) / 3) * 4) };
    expect(() => withBackend(heavy, STARTER_BACKEND)).toThrow(/would be 64\.0 MB; this host keeps apps up to 64 MB/);
  });

  it('refuses an app that has a backend, a file that has none, and a backend this host would not run', () => {
    expect(() => withBackend(fullApp(), STARTER_BACKEND)).toThrow('already has a backend');
    expect(backendOf(pageOnly())).toBeNull();
    const broken = { ...STARTER_BACKEND, files: { 'server/main.logic': STARTER_BACKEND.files['server/main.logic'] } };
    expect(() => withBackend(pageOnly(), broken)).toThrow(/migration/);
  });
});
