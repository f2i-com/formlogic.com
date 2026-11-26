// A .softn file as a project the app host installs: with a backend of its own or none, its seed
// data and media kept, and every refusal naming the file it is about.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { HOSTED_MEDIA, exportNativeProject, importNativeProject, sourceNameProblem } from './nativeHosting';

const softn = (files: Record<string, string | Uint8Array>) =>
  new File([zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])))], 'app.softn');
const client = { 'manifest.json': JSON.stringify({ name: 'Field notes', main: 'ui/main.ui', files: { xdb: ['xdb/tasks.xdb'] } }), 'ui/main.ui': '<Text>Notes</Text>', 'logic/main.logic': 'var n = 1;', 'xdb/tasks.xdb': '{"collection":"tasks","records":[]}' };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('importNativeProject', () => {
  it('separates a previous host’s key file from app source, even in an older saved draft', async () => {
    const project = await importNativeProject(softn({ ...client, 'private/config.json': '{"keyHex":"fixture"}' }));
    expect(project.files).not.toHaveProperty('private/config.json');
    expect(sourceNameProblem('private/config.json')).toMatch(/host key/);
    const exported = unzipSync(exportNativeProject({ ...project, files: { ...project.files, 'Private/config.json': '{"keyHex":"fixture"}' }, assets: {} }));
    expect(Object.keys(exported)).not.toContain('Private/config.json');
    expect(Object.keys(exported)).toContain('ui/main.ui');
  });

  it('validates the migration list before a backend is attached', async () => {
    const path = 'server/migrations/001.sql';
    const bundle = (migrations: unknown) => softn({ ...client, 'manifest.json': JSON.stringify({ main: 'ui/main.ui', server: {
      entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations },
    } }), 'server/main.logic': 'function list() {}', [path]: 'CREATE TABLE notes(id INTEGER PRIMARY KEY);' });
    for (const value of [undefined, null, [], [path]]) await expect(importNativeProject(bundle(value))).resolves.toMatchObject({ version: 0 });
    for (const value of [path, {}, [1], [path, path]]) await expect(importNativeProject(bundle(value))).rejects.toThrow(/migration/i);
  });
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
    await expect(importNativeProject(withServer({ entry: 'server/main.logic', routes: [{ method: 'GET', path: '/api/notes', handler: 'list', public: true }] }))).rejects.toThrow('its API version is unsupported');
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
      expect(refusal, path).toBe(`${path} is a kind of file this host cannot keep with an app. Remove it from the project ZIP and try again.`);
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

  it('keeps the .htaccess files of an app with a container backend, which the host applies', async () => {
    // A PHP app protects install.php and its includes/ folder with them. Dropped at import, as the
    // one beside the manifest was (and one in a folder refused), nothing protected either.
    const php = {
      'manifest.json': JSON.stringify({ name: 'Shop', main: 'index.html', engine: 2, backend: { runtime: 'php', entry: 'index.php' } }),
      'index.html': '<h1>Shop</h1>', 'index.php': '<?php echo 1;', 'install.php': '<?php echo 2;', 'includes/config.php': '<?php $key = 1;',
    };
    const rules = { '.htaccess': '<Files "install.php">\n  Require all denied\n</Files>\n', 'includes/.htaccess': 'Require all denied\n', 'assets/.htaccess': 'Options -Indexes\n' };
    const project = await importNativeProject(softn({ ...php, ...rules }));
    expect(project.files).toMatchObject(rules);
    expect(project.assets).toEqual({});
    // What the owner downloads carries them, so the app can be brought back as it was.
    const again = await importNativeProject(new File([exportNativeProject(project) as BlobPart], 'again.softn'));
    expect(again.files).toEqual(project.files);
    expect(sourceNameProblem('includes/.htaccess')).toBeNull();
    // The runner reads none of one over 64 KB, so it is refused rather than kept and ignored.
    await expect(importNativeProject(softn({ ...php, '.htaccess': '#'.repeat(64 * 1024 + 1) }))).rejects.toThrow('.htaccess is larger than this host reads of an .htaccess (64 KB), so none of its rules would be applied');
    await expect(importNativeProject(softn({ ...php, '.htaccess': '#'.repeat(64 * 1024) }))).resolves.toMatchObject({ version: 0 });
    await expect(importNativeProject(softn({ ...php, 'includes/.htaccess': new Uint8Array([0xff, 0xfe, 0xfd]) }))).rejects.toThrow('includes/.htaccess is not UTF-8 text');
  });

  it('leaves out the .htaccess of an app with no container backend, as before: nothing here would apply it', async () => {
    // A static package carries one for the web server it was made for.
    const project = await importNativeProject(softn({ ...client, '.htaccess': 'Options -Indexes\n' }));
    expect(Object.keys(project.files)).not.toContain('.htaccess');
    await expect(importNativeProject(softn({ ...client, 'docs/.htaccess': 'Require all denied\n' }))).rejects.toThrow('docs/.htaccess is a kind of file this host cannot keep with an app. Remove it');
  });

  it('names an .htaccess and holds it to the size the server does', () => {
    const php = readFileSync(resolve(process.cwd(), '../backend/src/Services/NativeAppService.php'), 'utf8');
    const browser = readFileSync(resolve(process.cwd(), 'src/lib/nativeHosting.ts'), 'utf8');
    const server = /HTACCESS_PATH = '~([^']*)~D'/.exec(php)?.[1];
    expect(server).toBe('^(?:[a-zA-Z0-9_-]+/)*\\.htaccess$');
    expect(/HTACCESS_PATH = \/([^\n]*)\/;/.exec(browser)?.[1].replace(/\\\//g, '/')).toBe(server);
    expect(/MAX_HTACCESS_BYTES = ([0-9 *]+);/.exec(php)?.[1]).toBe(/HTACCESS_BYTES = ([0-9 *]+);/.exec(browser)?.[1]);
  });

  it('keeps the same source file kinds as the server', () => {
    // NativeAppService::SOURCE_PATH and this file's must name the same extensions, or a file one takes the other refuses.
    const php = readFileSync(resolve(process.cwd(), '../backend/src/Services/NativeAppService.php'), 'utf8');
    const server = /SOURCE_PATH = '~[^']*\\\.\(\?:([^)]*)\)\$~D'/.exec(php)?.[1];
    const browser = /SOURCE_PATH = \/[^\n]*\\\.\(\?:([^)]*)\)\$\//.exec(readFileSync(resolve(process.cwd(), 'src/lib/nativeHosting.ts'), 'utf8'))?.[1];
    expect(server).toBe('html|ui|js|jsx|vue|mjs|cjs|ts|tsx|logic|py|php|phtml|rs|toml|css|json|sql|xdb');
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

  it('takes back the editable copy FormLogic exports of its own app, whose id is past 120 characters', async () => {
    // lib/softn/project.ts names one `formlogic_` and the hex of the site, the kind and the app's id.
    const hex = (value: string) => Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
    const exported = `formlogic_${hex('https://formlogic.com/app/3f2b8c1e-9d4a-4c7b-8e21-5a6f0c9d7b13')}`;
    expect(exported).toHaveLength(134);
    const named = (id: string, more: Record<string, unknown> = {}, files: Record<string, string> = {}) =>
      importNativeProject(softn({ ...client, 'manifest.json': JSON.stringify({ ...JSON.parse(client['manifest.json']), id, ...more }), ...files }));
    await expect(named(exported)).resolves.toMatchObject({ version: 0 });
    await expect(named('a'.repeat(256))).resolves.toMatchObject({ version: 0 });
    await expect(named('a'.repeat(257))).rejects.toThrow('manifest.json\'s id can only be letters, digits, \'.\', \'_\' and \'-\' (up to 256 of them).');
    // An app with a server block runs under its id, and there the server takes 120.
    const server = { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } };
    const backend = { 'server/main.logic': 'function list() {}' };
    await expect(named('a'.repeat(120), { server }, backend)).resolves.toMatchObject({ version: 0 });
    await expect(named('a'.repeat(121), { server }, backend)).rejects.toThrow('manifest.json\'s id is longer than an app with a server block can run under (120 characters)');
  });

  it('sends a FormLogic project with backend actions to a Forms app, where those run', async () => {
    const actions = { 'formlogic.json': JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions: {} }) };
    await expect(importNativeProject(softn({ 'manifest.json': JSON.stringify({ name: 'Orders', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Orders</Text>', ...actions }))).rejects.toThrow('Screens → Hosting & app tools');
  });

  it('imports a SoftN v2 container app with PHP backend and SQLite database, and refuses invalid container manifests', async () => {
    const phpContainer = {
      'manifest.json': JSON.stringify({
        id: 'test.orders',
        name: 'Orders Desk',
        version: '1.0.0',
        engine: 2,
        main: 'index.html',
        backend: { runtime: 'php', entry: 'backend/index.php', mode: 'api', routes: ['/api/'] },
        databases: [{ name: 'app', engine: 'sqlite', file: 'data/app.db', seedSql: 'backend/schema.sql', persist: true }],
      }),
      'index.html': '<!doctype html><html><body>Orders</body></html>',
      'backend/index.php': '<?php echo json_encode(["ok" => true]);',
      'backend/schema.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);',
      '.htaccess': 'RewriteEngine On\nRewriteRule ^api(/.*)?$ backend/index.php [L,QSA]\n',
    };
    const imported = await importNativeProject(softn(phpContainer));
    expect(imported.files['backend/index.php']).toContain('json_encode');
    expect(imported.files['backend/schema.sql']).toContain('CREATE TABLE');
    // A container app's .htaccess is kept, beside the manifest or in a folder: the host applies its
    // rules and sends it to no page. (It was stripped or refused, and protected nothing.)
    expect(imported.files['.htaccess']).toBe(phpContainer['.htaccess']);
    await expect(importNativeProject(softn({ ...phpContainer, 'backend/.htaccess': 'Deny from all' }))).resolves.toMatchObject({ files: { 'backend/.htaccess': 'Deny from all' } });
    // Other dotfiles are still refused.
    await expect(importNativeProject(softn({ ...phpContainer, '.env': 'SECRET=1' }))).rejects.toThrow();

    await expect(
      importNativeProject(softn({
        ...phpContainer,
        'manifest.json': JSON.stringify({
          id: 'test.bad',
          name: 'Bad',
          engine: 2,
          main: 'index.html',
          backend: { runtime: 'ruby', entry: 'backend/index.php' },
        }),
      }))
    ).rejects.toThrow(/runtime/i);

    await expect(
      importNativeProject(softn({
        ...phpContainer,
        'manifest.json': JSON.stringify({
          id: 'test.both',
          name: 'Both',
          engine: 2,
          main: 'index.html',
          server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: [] } },
          backend: { runtime: 'php', entry: 'backend/index.php' },
        }),
        'server/main.logic': 'function ping() { return { status: 200 }; }',
      }))
    ).rejects.toThrow(/both/i);
  });

  it('names a container backend as SoftN names it: runtime and entry, never engine or entrypoint', async () => {
    // This host once took `engine` and `entrypoint` in their place. SoftN's runner reads neither,
    // so such an app was refused as it was installed, for a capability it never asked for, and
    // would run on no other SoftN host.
    const withBackend = (backend: Record<string, unknown>) => softn({
      'manifest.json': JSON.stringify({ id: 'test.alias', name: 'Alias', engine: 2, main: 'index.html', backend }),
      'index.html': '<h1>Alias</h1>',
      ...(String(backend.engine ?? backend.runtime) === 'python' ? { 'backend/main.py': 'def handle(req): pass' } : { 'backend/index.php': '<?php echo 1;' }),
    });
    const runtime = 'manifest.json\'s backend names its runtime as "engine", which SoftN does not read, so the app would run on no SoftN host. Rename "engine" to "runtime".';
    const entry = 'manifest.json\'s backend names its entry as "entrypoint", which SoftN does not read, so the app would run on no SoftN host. Rename "entrypoint" to "entry".';
    await expect(importNativeProject(withBackend({ engine: 'php', entrypoint: 'backend/index.php' }))).rejects.toThrow(runtime);
    await expect(importNativeProject(withBackend({ engine: 'python', entry: 'backend/main.py' }))).rejects.toThrow(runtime);
    await expect(importNativeProject(withBackend({ runtime: 'php', entrypoint: 'backend/index.php' }))).rejects.toThrow(entry);
    await expect(importNativeProject(withBackend({ runtime: 'php', entry: 'backend/index.php' }))).resolves.toMatchObject({ version: 0 });
    // Beside SoftN's own names, another key is one more it does not read.
    await expect(importNativeProject(withBackend({ runtime: 'php', entry: 'backend/index.php', engine: 'cobol', entrypoint: 'missing.php' }))).resolves.toMatchObject({ version: 0 });
  });

  it('holds backend.root to a folder of the project, as it holds backend.entry', async () => {
    // backend.root says which files stay on the server: FormLogic hides them from pages, and the
    // runner refuses to run a script under it by its address. Each reads the name its own way, so
    // one that is not plainly a folder of the project could keep different files private on each.
    const withRoot = (root: unknown) => softn({
      'manifest.json': JSON.stringify({ id: 'test.root', name: 'Root', engine: 2, main: 'index.html', backend: { runtime: 'php', entry: 'api/index.php', root } }),
      'index.html': '<h1>Root</h1>',
      'api/index.php': '<?php echo 1;',
    });
    const refused = 'manifest.json\'s backend.root must name a folder in the project, such as "api" or "server/api": no "..", no leading "/" or drive letter, and at most 240 characters.';
    for (const root of ['api', 'api/', 'server/api_v2', 'a-b/c_d', 'a'.repeat(240), '', null, undefined]) {
      await expect(importNativeProject(withRoot(root)), String(root)).resolves.toMatchObject({ version: 0 });
    }
    for (const root of ['../api', 'api/../..', '..', '/api', '\\api', 'api\\lib', 'C:/api', 'c:api', 'api//lib', './api', 'api.v2', ' api', 7, true, ['api'], { path: 'api' }, `${'a'.repeat(240)}/`, 'a'.repeat(241)]) {
      await expect(importNativeProject(withRoot(root)), JSON.stringify(root)).rejects.toThrow(refused);
    }
  });
});
