// A .softn file as a project the app host installs: with a backend of its own or none, its seed
// data and media kept, and every refusal naming the file it is about.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { HOSTED_MEDIA, exportNativeProject, importNativeProject } from './nativeHosting';

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
    const again = await importNativeProject(new File([exportNativeProject(project) as BlobPart], 'again.softn'));
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

  it('keeps the media the frame serves: video, models, shaders and more, beside pictures', async () => {
    const media = { 'assets/clip.mp4': png, 'assets/scene.glb': png, 'assets/shaders/add.wgsl': 'fn main() {}', 'assets/fonts/body.ttf': png, 'assets/notes.md': '# Notes' };
    const project = await importNativeProject(softn({ ...client, ...media }));
    expect(Object.keys(project.assets).sort()).toEqual(Object.keys(media).sort());
  });

  it('refuses media the host cannot serve, and other kinds of file, by name', async () => {
    await expect(importNativeProject(softn({ ...client, 'assets/page.htm': '<script>1</script>' }))).rejects.toThrow('assets/page.htm cannot be hosted with this app');
    await expect(importNativeProject(softn({ ...client, 'assets/app.mjs': 'alert(1)' }))).rejects.toThrow('assets/app.mjs cannot be hosted with this app');
    await expect(importNativeProject(softn({ ...client, 'assets/tool.exe': 'MZ' }))).rejects.toThrow('assets/tool.exe cannot be hosted with this app');
    await expect(importNativeProject(softn({ ...client, 'styles/site.scss': 'body {}' }))).rejects.toThrow('styles/site.scss is a kind of file this host cannot keep with an app. Remove it');
  });

  it('says where media goes when it is outside assets/, as an icon beside the manifest is', async () => {
    // A .softn packed with its icon at the top (manifest.json's "icon": "icon.png"): the picture is
    // one this host keeps, only not there.
    await expect(importNativeProject(softn({ ...client, 'icon.png': 'PNG' }))).rejects.toThrow('icon.png is a kind of file this host cannot keep with an app where it is: an app\'s pictures, sound, video, fonts, models and WebAssembly modules go under assets/. Move it to assets/icon.png');
    await expect(importNativeProject(softn({ ...client, 'models/scene.glb': 'glTF' }))).rejects.toThrow('Move it to assets/models/scene.glb');
    await expect(importNativeProject(softn({ ...client, 'wasm/game.wasm': '\0asm' }))).rejects.toThrow('Move it to assets/wasm/game.wasm');
    // Under assets/ it is taken.
    expect(Object.keys((await importNativeProject(softn({ ...client, 'assets/icon.png': 'PNG' }))).assets ?? {})).toEqual(['assets/icon.png']);
  });

  it('keeps a WebAssembly module under assets/ as media, which SoftN v0.0.41 runs in a worker of its own', async () => {
    const imported = await importNativeProject(softn({ ...client, 'assets/game.wasm': '\0asm\u0001\0\0\0' }));
    expect(Object.keys(imported.assets ?? {})).toEqual(['assets/game.wasm']);
    expect(atob(imported.assets?.['assets/game.wasm'] ?? '')).toBe('\0asm\u0001\0\0\0');
  });

  it('never advises a file into assets/ that may not be media, or that is the backend\'s', async () => {
    // assets/ is sent to every visitor. Text, Markdown and .bin files may be notes or a backend's
    // data; whatever is under the private tree stays out of it; a built site's files are not a SoftN app's.
    for (const path of ['private/keys.txt', 'server/data.bin', 'backend/seed.bin', 'server/logo.png', 'Private/photo.jpg', 'docs/guide.md', 'requirements.txt', 'logic/code.bin', 'shaders/blur.wgsl', 'site/logo.png']) {
      const refusal = await importNativeProject(softn({ ...client, [path]: 'x' })).then(() => 'taken', (error: Error) => error.message);
      expect(refusal, path).toBe(`${path} is a kind of file this host cannot keep with an app. Remove it from the .softn file and try again.`);
    }
  });

  it('keeps a SoftN app’s pages, scripts and stylesheets as source, wherever the app put them, never as media', async () => {
    // SoftN writes pages as .html and their logic as .js, with .css beside them: text the app's frame reads as SoftN.
    const imported = await importNativeProject(softn({ ...client, 'assets/page.html': '<App/>', 'assets/app.js': 'let a = 1', 'styles/site.css': 'body {}' }));
    expect(imported.files['assets/page.html']).toBe('<App/>');
    expect(imported.files['assets/app.js']).toBe('let a = 1');
    expect(imported.files['styles/site.css']).toBe('body {}');
    expect(imported.assets).toEqual({});
  });

  it('keeps the same source file kinds as the server', () => {
    // NativeAppService::SOURCE_PATH and this file's must name the same extensions, or a file one takes the other refuses.
    const php = readFileSync(resolve(process.cwd(), '../backend/src/Services/NativeAppService.php'), 'utf8');
    const server = /SOURCE_PATH = '~[^']*\\\.\(\?:([^)]*)\)\$~D'/.exec(php)?.[1];
    const browser = /SOURCE_PATH = \/[^\n]*\\\.\(\?:([^)]*)\)\$\//.exec(readFileSync(resolve(process.cwd(), 'src/lib/nativeHosting.ts'), 'utf8'))?.[1];
    expect(server).toBe('html|ui|js|logic|py|css|json|sql|xdb');
    expect(browser).toBe(server);
  });

  it('keeps the same media list as the server', () => {
    // NativeAppService::MEDIA_PATH and HOSTED_MEDIA must name the same extensions, or a file one
    // takes the other refuses after the app is made.
    const php = readFileSync(resolve(process.cwd(), '../backend/src/Services/NativeAppService.php'), 'utf8');
    const server = /MEDIA_PATH = '~[^']*\\\.\(\?:([^)]*)\)\$~Di'/.exec(php)?.[1];
    const browser = /\\\.\(\?:([^)]*)\)\$/.exec(HOSTED_MEDIA.source)?.[1];
    expect(server).toBeTruthy();
    expect(server).toBe(browser);
  });

  it('holds a file to the server\'s rules before any app is made for it', async () => {
    // Backend code with no server block to run it.
    await expect(importNativeProject(softn({ ...client, 'server/main.logic': 'function list() {}' }))).rejects.toThrow('server/main.logic is backend code, but manifest.json has no server block');
    // Sizes and counts.
    await expect(importNativeProject(softn({ ...client, 'logic/big.logic': 'x'.repeat(1_500_001) }))).rejects.toThrow('logic/big.logic is larger than this host keeps (1.5 MB per source file)');
    // A studio's whole library in its one server file: over the megabyte that was the limit.
    await expect(importNativeProject(softn({ ...client, 'logic/big.logic': 'x'.repeat(1_500_000) }))).resolves.toMatchObject({ files: { 'logic/big.logic': expect.any(String) } });
    // A migration stays at 1 MB: the runner reads no more of one.
    await expect(importNativeProject(softn({ ...client, 'server/migrations/001.sql': '-'.repeat(1_000_001) }))).rejects.toThrow('server/migrations/001.sql is larger than a migration may be (1 MB)');
    const pictures = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`assets/p${i}.png`, png]));
    await expect(importNativeProject(softn({ ...client, ...pictures }))).rejects.toThrow('This app has 1001 media files; this host keeps up to 1000.');
    // A game's hundreds of pictures and sounds are kept.
    const art = Object.fromEntries(Array.from({ length: 334 }, (_, i) => [`assets/art/p${i}.png`, png]));
    await expect(importNativeProject(softn({ ...client, ...art }))).resolves.toMatchObject({ files: expect.any(Object) });
    // Names and the id.
    await expect(importNativeProject(softn({ ...client, 'ui/my page.ui': '<Text>Hi</Text>' }))).rejects.toThrow('ui/my page.ui: this host keeps file names made of letters');
    await expect(importNativeProject(softn({ ...client, 'manifest.json': JSON.stringify({ id: 'my app!', main: 'ui/main.ui' }) }))).rejects.toThrow('manifest.json\'s id can only be');
    // Two dots together, which the server refuses in any name.
    await expect(importNativeProject(softn({ ...client, 'ui/a..b.ui': '<Text>Hi</Text>' }))).rejects.toThrow('ui/a..b.ui: this host keeps file names');
    await expect(importNativeProject(softn({ ...client, 'assets/logo..png': png }))).rejects.toThrow('assets/logo..png: this host keeps file names without two dots together');
    // An apiVersion of 1.0, which JSON reads as 1 here and the server as a fraction.
    const server = '{"entry":"server/main.logic","requires":{"apiVersion":1.0,"capabilities":["sql"]},"database":{"kind":"private-sqlite","migrations":[]}}';
    await expect(importNativeProject(softn({ ...client, 'manifest.json': `{"name":"Notes","main":"ui/main.ui","server":${server}}`, 'server/main.logic': 'function list() {}' }))).rejects.toThrow('write its "apiVersion" as 1, a whole number');
  });

  it('sends a FormLogic project with backend actions to a Forms app, where those run', async () => {
    const actions = { 'formlogic.json': JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions: {} }) };
    await expect(importNativeProject(softn({ 'manifest.json': JSON.stringify({ name: 'Orders', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Orders</Text>', ...actions }))).rejects.toThrow('Screens → Hosting & app tools');
  });
});
