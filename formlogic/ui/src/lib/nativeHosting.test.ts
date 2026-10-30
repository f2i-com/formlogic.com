// A .softn file as a project the app host installs: with a backend of its own or none, its seed
// data and media kept, and every refusal naming the file it is about.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { exportNativeProject, importNativeProject } from './nativeHosting';

const softn = (files: Record<string, string | Uint8Array>) =>
  new File([zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])))], 'app.softn');
const client = { 'manifest.json': JSON.stringify({ name: 'Field notes', main: 'ui/main.ui', files: { xdb: ['xdb/tasks.xdb'] } }), 'ui/main.ui': '<Text>Notes</Text>', 'logic/main.logic': 'var n = 1;', 'xdb/tasks.xdb': '{"collection":"tasks","records":[]}' };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('importNativeProject', () => {
  it('takes an app with no backend, keeping its source, seed data and media as they came', async () => {
    const project = await importNativeProject(softn({ ...client, 'assets/logo.png': png, 'README.md': 'notes' }));
    expect(Object.keys(project.files).sort()).toEqual(['logic/main.logic', 'manifest.json', 'ui/main.ui', 'xdb/tasks.xdb']);
    expect(project.files['xdb/tasks.xdb']).toBe(client['xdb/tasks.xdb']);
    expect(Uint8Array.from(atob(project.assets['assets/logo.png']), c => c.charCodeAt(0))).toEqual(png);
    // What the owner downloads again is what was uploaded (the README aside, which is not kept).
    const again = await importNativeProject(new File([exportNativeProject(project)], 'again.softn'));
    expect(again.files).toEqual(project.files);
    expect(again.assets).toEqual(project.assets);
  });

  it('takes an app with a backend of its own', async () => {
    const manifest = { id: 'com.example.notes', name: 'Notes', main: 'ui/main.ui', server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] } } };
    const project = await importNativeProject(softn({ ...client, 'manifest.json': JSON.stringify(manifest), 'server/main.logic': 'function list() {}', 'server/migrations/001.sql': 'CREATE TABLE notes(id INTEGER PRIMARY KEY);' }));
    expect(project.files['server/main.logic']).toBe('function list() {}');
    expect(project.files['server/migrations/001.sql']).toContain('CREATE TABLE notes');
  });

  it('refuses a backend this host does not run, and says what it needs', async () => {
    const withServer = (server: unknown, extra: Record<string, string> = {}) => softn({ ...client, 'manifest.json': JSON.stringify({ name: 'Notes', main: 'ui/main.ui', server }), 'server/main.logic': 'function list() {}', ...extra });
    // SoftN's older backend format: routes and an entry, nothing this host's runner reads.
    await expect(importNativeProject(withServer({ entry: 'server/main.logic', routes: [{ method: 'GET', path: '/api/notes', handler: 'list', public: true }] }))).rejects.toThrow('it was written for another SoftN host');
    const v1 = { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } };
    await expect(importNativeProject(withServer({ ...v1, requires: { apiVersion: 1, capabilities: ['sql', 'websockets'] } }))).rejects.toThrow('it asks for websockets, which this host does not offer');
    await expect(importNativeProject(withServer({ ...v1, entry: 'logic/main.logic' }))).rejects.toThrow('its entry should be a server/….logic file');
    await expect(importNativeProject(withServer({ ...v1, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] } }))).rejects.toThrow('its migration server/migrations/001.sql');
    await expect(importNativeProject(withServer(v1))).resolves.toMatchObject({ version: 0 });
  });

  it('refuses media the host cannot serve, and other kinds of file, by name', async () => {
    await expect(importNativeProject(softn({ ...client, 'assets/shaders/add.wgsl': 'fn main() {}' }))).rejects.toThrow('assets/shaders/add.wgsl cannot be hosted with this app');
    await expect(importNativeProject(softn({ ...client, 'styles/site.css': 'body {}' }))).rejects.toThrow('styles/site.css is a kind of file this host cannot keep with an app');
  });

  it('holds a file to the server\'s rules before any app is made for it', async () => {
    // Backend code with no server block to run it.
    await expect(importNativeProject(softn({ ...client, 'server/main.logic': 'function list() {}' }))).rejects.toThrow('server/main.logic is backend code, but manifest.json has no server block');
    // Sizes and counts.
    await expect(importNativeProject(softn({ ...client, 'logic/big.logic': 'x'.repeat(1_000_001) }))).rejects.toThrow('logic/big.logic is larger than this host keeps (1 MB per source file)');
    const pictures = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`assets/p${i}.png`, png]));
    await expect(importNativeProject(softn({ ...client, ...pictures }))).rejects.toThrow('This app has 101 media files; this host keeps up to 100.');
    // Names and the id.
    await expect(importNativeProject(softn({ ...client, 'ui/my page.ui': '<Text>Hi</Text>' }))).rejects.toThrow('ui/my page.ui: this host keeps file names made of letters');
    await expect(importNativeProject(softn({ ...client, 'manifest.json': JSON.stringify({ id: 'my app!', main: 'ui/main.ui' }) }))).rejects.toThrow('manifest.json\'s id can only be');
  });

  it('sends a FormLogic project with backend actions to a Forms app, where those run', async () => {
    const actions = { 'formlogic.json': JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions: {} }) };
    await expect(importNativeProject(softn({ 'manifest.json': JSON.stringify({ name: 'Orders', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Orders</Text>', ...actions }))).rejects.toThrow('Screens → Hosting & app tools');
  });
});
