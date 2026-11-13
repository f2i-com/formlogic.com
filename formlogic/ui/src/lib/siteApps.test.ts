/**
 * JavaScript apps: the .zip of a built web app becomes a hosted project (its files under site/,
 * a manifest that names the first page), a project's own export comes back as it was, what will
 * not work when hosted is said, and a zip this host cannot take creates no app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync, type Zippable } from 'fflate';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  saveNativeProject: vi.fn(),
  deleteApp: vi.fn(),
  setState: vi.fn(),
  storeError: null as string | null,
  demo: false,
}));
vi.mock('./api', () => ({ api: { saveNativeProject: mocks.saveNativeProject, deleteApp: mocks.deleteApp, isDemoMode: () => mocks.demo } }));
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ createApp: mocks.createApp, error: mocks.storeError }), setState: mocks.setState } }));

const { SITE_PATH, SITE_RUNS, createSiteApp, importSiteBuild, siteBuildWarnings, siteOf, sitePathProblem } = await import('./siteApps');
const { NATIVE_LIMITS, exportNativeProject } = await import('./nativeHosting');

const MB = 1024 * 1024;
const b64 = (text: string) => btoa(text);
/** A zip of the files given: text as it is, a number as that many bytes. Nested objects are folders, with their own entries. */
type Tree = { [path: string]: string | number | Tree };
const zippable = (tree: Tree): Zippable => Object.fromEntries(Object.entries(tree).map(([path, value]) =>
  [path, typeof value === 'string' ? strToU8(value) : typeof value === 'number' ? new Uint8Array(value) : zippable(value)]));
const zip = (tree: Tree, name = 'dist.zip') => new File([zipSync(zippable(tree), { level: 1 })], name);
const manifestOf = (name: string) => `${JSON.stringify({ name, version: '1.0.0', site: { entry: 'index.html' } }, null, 2)}\n`;
const PAGE = '<!doctype html><script type="module" src="./assets/app.js"></script>';

describe('SITE_PATH and sitePathProblem', () => {
  it('is the rule the server holds an upload to (NativeAppService::SITE_PATH)', () => {
    const php = readFileSync(resolve(__dirname, '../../../backend/src/Services/NativeAppService.php'), 'utf8');
    const rule = /public const SITE_PATH = '~(.+)~D';/.exec(php)?.[1];
    expect(rule?.replace(/\\~/g, '~').replace(/\//g, '\\/')).toBe(SITE_PATH.source);
    expect(SITE_PATH.flags).toBe('');
    const longest = Number(/public const MAX_SITE_PATH_LENGTH = (\d+);/.exec(php)?.[1]);
    expect(sitePathProblem(`site/${'a'.repeat(longest - 'site/.js'.length)}.js`)).toBeNull();
    expect(sitePathProblem(`site/${'a'.repeat(longest - 'site/.js'.length + 1)}.js`)).toContain(`up to ${longest} characters`);
  });

  it('takes the files a build is made of, in folders', () => {
    for (const path of ['site/index.html', 'site/assets/index-BcD3_x.js', 'site/assets/logo@2x.png', 'site/fonts/inter+latin~v1.woff2', 'site/a/b/c/data.json', 'site/app.webmanifest', 'site/engine.wasm']) {
      expect(SITE_PATH.test(path), path).toBe(true);
      expect(sitePathProblem(path), path).toBeNull();
    }
  });

  it('says in plain words why a path is refused', () => {
    expect(sitePathProblem('site/assets/my logo.png')).toBe('A file or folder name is made of letters, digits and - _ . @ + ~, with no spaces.');
    expect(sitePathProblem('site/a..b.js')).toBe('A file name cannot have two dots together.');
    expect(sitePathProblem('site/../index.html')).toBe('A file name cannot have two dots together.');
    expect(sitePathProblem('site/.well-known/app.json')).toBe('A file or folder name cannot start with a dot.');
    expect(sitePathProblem('site/.htaccess')).toBe('A file or folder name cannot start with a dot.');
    expect(sitePathProblem('assets/logo.png')).toBe('A built file is kept under site/.');
    expect(sitePathProblem('site')).toBe('A built file is kept under site/.');
    expect(sitePathProblem('site//app.js')).toContain('letters, digits');
    // A kind no hosted app keeps (packed or not), and a name with no ending.
    for (const path of ['site/setup.exe', 'site/tool.py', 'site/app.br', 'site/notes.']) expect(sitePathProblem(path), path).toMatch(/^A hosted app keeps what a build is made of: pages, scripts, styles/);
    // An ending a web server runs, wherever in the name it stands: the server's own list (NativeAppService::SITE_RUNS), held equal here.
    for (const path of ['site/server.php', 'site/server.php.gz', 'site/shell.php.js', 'site/a.PHTML.html', 'site/run.cgi.txt']) {
      expect(sitePathProblem(path), path).toBe('A file name cannot hold an ending a web server runs (.php, .cgi, .asp and the like), even in its middle.');
    }
    for (const path of ['site/php.js', 'site/graphql.js', 'site/aspect.css']) expect(sitePathProblem(path), path).toBeNull();
    const runs = /public const SITE_RUNS = '~(.+)~Di';/.exec(readFileSync(resolve(__dirname, '../../../backend/src/Services/NativeAppService.php'), 'utf8'))?.[1];
    expect(runs).toBe(SITE_RUNS.source);
    expect(SITE_RUNS.flags).toBe('i');
    for (const path of ['site/CNAME', 'site/licenses/LICENSE', 'site/_redirects']) expect(sitePathProblem(path), path).toBe('A file\'s name ends in its kind (.html, .js, .css, .png and the like), and this one has no ending.');
    // An ending in capitals is the same kind of file, a game's data is a build's file, and one the build packed is kept as it is.
    for (const path of ['site/Logo.PNG', 'site/v1.2/Index.Html', 'site/DCIM/IMG_0001.JPG', 'site/Scan.TIFF', 'site/Build/game.data', 'site/Build/game.wasm.br', 'site/Build/game.framework.js.gz', 'site/Build/game.unityweb', 'site/export/game.pck']) {
      expect(sitePathProblem(path), path).toBeNull();
    }
    const long = `site/${'a'.repeat(240 - 'site/'.length - '.js'.length)}.js`;
    expect(long).toHaveLength(240);
    expect(sitePathProblem(long)).toBeNull();
    expect(sitePathProblem(long.replace('.js', 'a.js'))).toBe('A file\'s path, folders included, can be up to 240 characters long.');
  });
});

describe('siteOf', () => {
  const withManifest = (manifest: string) => ({ files: { 'manifest.json': manifest } });
  it('reads the first page from the manifest\'s site block, and nothing else as a site', () => {
    expect(siteOf(withManifest(manifestOf('Shop')))).toEqual({ entry: 'index.html' });
    expect(siteOf(withManifest(JSON.stringify({ name: 'Shop', site: { entry: 'app/start.html', more: 1 } })))).toEqual({ entry: 'app/start.html' });
    // A SoftN app, a block that names no page, and a block that is not one.
    expect(siteOf(withManifest(JSON.stringify({ name: 'Notes', main: 'ui/main.ui' })))).toBeNull();
    expect(siteOf(withManifest(JSON.stringify({ site: {} })))).toBeNull();
    expect(siteOf(withManifest(JSON.stringify({ site: { entry: 7 } })))).toBeNull();
    expect(siteOf(withManifest(JSON.stringify({ site: 'index.html' })))).toBeNull();
    expect(siteOf(withManifest(JSON.stringify({ site: ['index.html'] })))).toBeNull();
    expect(siteOf(withManifest('not json'))).toBeNull();
    expect(siteOf(withManifest('null'))).toBeNull();
    expect(siteOf({ files: {} })).toBeNull();
  });
});

describe('importSiteBuild: a plain build', () => {
  it('keeps a build zipped at the root under site/, with a manifest that names its first page', async () => {
    const project = await importSiteBuild(zip({ 'index.html': PAGE, assets: { 'app.js': 'console.log(1)', 'app.css': 'body{}' }, 'favicon.ico': 3 }), 'Shop');
    expect(project).toEqual({
      version: 0,
      files: { 'manifest.json': manifestOf('Shop') },
      assets: { 'site/index.html': b64(PAGE), 'site/assets/app.js': b64('console.log(1)'), 'site/assets/app.css': b64('body{}'), 'site/favicon.ico': b64('\0\0\0') },
      access: 'members',
      home: true,
    });
    expect(siteOf(project)).toEqual({ entry: 'index.html' });
  });

  it('takes the folder its index.html is in as the site\'s root, and nothing outside it', async () => {
    const project = await importSiteBuild(zip({ dist: { 'index.html': PAGE, assets: { 'app.js': '1' } }, 'README.md': 'How to build', src: { 'main.ts': 'export {}' } }), 'Shop');
    expect(Object.keys(project.assets).sort()).toEqual(['site/assets/app.js', 'site/index.html']);
    // A file outside the root is never held to a hosted app's rules: src/main.ts is no kind it keeps.
    expect(project.files).toEqual({ 'manifest.json': manifestOf('Shop') });
  });

  it('roots a build with several pages at the shallowest index.html, the first by name between two as deep', async () => {
    const pages = await importSiteBuild(zip({ 'index.html': 'home', docs: { 'index.html': 'docs' }, admin: { 'index.html': 'admin' } }), 'Shop');
    expect(pages.assets).toEqual({ 'site/index.html': b64('home'), 'site/docs/index.html': b64('docs'), 'site/admin/index.html': b64('admin') });
    const deep = await importSiteBuild(zip({ out: { web: { 'index.html': 'deep' } }, build: { 'index.html': 'build', 'app.js': '1' } }), 'Shop');
    expect(deep.assets).toEqual({ 'site/index.html': b64('build'), 'site/app.js': b64('1') });
    const tie = await importSiteBuild(zip({ b: { 'index.html': 'b' }, a: { 'index.html': 'a' } }), 'Shop');
    expect(tie.assets).toEqual({ 'site/index.html': b64('a') });
  });

  it('leaves out what is no part of a build: system files, dot folders and source maps', async () => {
    const project = await importSiteBuild(zip({
      dist: { 'index.html': PAGE, '.DS_Store': 1, 'Thumbs.db': 1, '.vite': { 'manifest.json': '{}' }, assets: { 'app.js': '1', 'app.js.map': '{}', 'app.css.map': '{}', '.gitkeep': '' } },
      __MACOSX: { dist: { '._index.html': 1, 'index.html': 1 } },
    }), 'Shop');
    expect(Object.keys(project.assets).sort()).toEqual(['site/assets/app.js', 'site/index.html']);
  });

  it('reads the backslash folders Windows PowerShell writes', async () => {
    const project = await importSiteBuild(new File([zipSync({ 'dist\\index.html': strToU8(PAGE), 'dist\\assets\\app.js': strToU8('1') })], 'dist.zip'), 'Shop');
    expect(project.assets).toEqual({ 'site/index.html': b64(PAGE), 'site/assets/app.js': b64('1') });
  });

  it('leaves out a file this host does not keep and still makes the app, naming what it left out', async () => {
    const notes: string[] = [];
    const project = await importSiteBuild(zip({ dist: { 'index.html': PAGE, LICENSE: 'MIT', 'api.php': '<?php', assets: { 'my logo.png': 4, 'app.js': '1' } } }), 'Shop', notes);
    expect(Object.keys(project.assets).sort()).toEqual(['site/assets/app.js', 'site/index.html']);
    expect(notes).toEqual(['3 files were left out of the app: dist/LICENSE, dist/api.php, dist/assets/my logo.png. A hosted app keeps web files named with letters, digits and - _ . @ + ~ (no spaces). If the app needs one of them, rename it and upload the build again.']);
    const one: string[] = [];
    await importSiteBuild(zip({ 'index.html': PAGE, _redirects: '/* /index.html 200' }), 'Shop', one);
    expect(one).toEqual(['1 file was left out of the app: _redirects. A hosted app keeps web files named with letters, digits and - _ . @ + ~ (no spaces). If the app needs it, rename it and upload the build again.']);
    // A build with nothing to leave out says nothing, and the notes are optional.
    const none: string[] = [];
    await importSiteBuild(zip({ 'index.html': PAGE, photos: { 'IMG_0001.JPG': 2 } }), 'Shop', none);
    expect(none).toEqual([]);
    await expect(importSiteBuild(zip({ 'index.html': PAGE, LICENSE: 'MIT' }), 'Shop')).resolves.toBeTruthy();
  });

  it('names the first six it left out and counts the rest', async () => {
    const many: Tree = { 'index.html': PAGE };
    for (let index = 1; index <= 8; index++) many[`photo ${index}.png`] = 1;
    const notes: string[] = [];
    await importSiteBuild(zip(many), 'Shop', notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^8 files were left out of the app: photo 1\.png, photo 2\.png, photo 3\.png, photo 4\.png, photo 5\.png, photo 6\.png and 2 more\. /);
  });

  it('keeps a file the build packed, and leaves out a packed twin of a file that is there too', async () => {
    const notes: string[] = [];
    const project = await importSiteBuild(zip({ 'index.html': PAGE, Build: { 'game.wasm.br': 3, 'game.data.gz': 2 }, assets: { 'app.js': '1', 'app.js.br': 2, 'app.js.gz': 2 } }), 'Shop', notes);
    expect(Object.keys(project.assets).sort()).toEqual(['site/Build/game.data.gz', 'site/Build/game.wasm.br', 'site/assets/app.js', 'site/index.html']);
    expect(notes).toEqual([]);
  });

  it('says to zip the build when the zip is the project itself', async () => {
    const remedy = 'This looks like a project\'s source, not its build: build it, then zip the folder the build made (dist or build).';
    // A Vite project keeps its index.html at its root, beside its source.
    await expect(importSiteBuild(zip({ 'index.html': '<script type="module" src="/src/main.tsx"></script>', 'package.json': '{}', src: { 'main.tsx': 'x', 'App.tsx': 'x', 'app.css': 'x' } }), 'Shop')).rejects.toThrow(remedy);
    await expect(importSiteBuild(zip({ 'index.html': PAGE, 'package.json': '{}', 'vite.config.ts': 'x', src: { 'main.ts': 'x' } }), 'Shop')).rejects.toThrow(remedy);
    await expect(importSiteBuild(zip({ 'index.html': PAGE, src: { 'App.vue': 'x' } }), 'Shop')).rejects.toThrow(remedy);
    // A build with a file of another kind is not a project: .ts is also a video segment, and is left out.
    const notes: string[] = [];
    await expect(importSiteBuild(zip({ 'index.html': PAGE, video: { 'part0.ts': 4 } }), 'Shop', notes)).resolves.toBeTruthy();
    expect(notes[0]).toContain('1 file was left out of the app: video/part0.ts.');
  });

  it('says to choose the file again when it can no longer be read', async () => {
    const gone = { name: 'dist.zip', size: 10, arrayBuffer: () => Promise.reject(new DOMException('A requested file or directory could not be found.', 'NotFoundError')) } as unknown as File;
    await expect(importSiteBuild(gone, 'Shop')).rejects.toThrow('dist.zip could not be read: choose it again.');
  });

  it('refuses a zip with no index.html, and says what to zip', async () => {
    await expect(importSiteBuild(zip({ src: { 'main.ts': 'export {}' }, 'package.json': '{}' }), 'Shop'))
      .rejects.toThrow('This zip has no index.html: zip the folder your build made (dist or build).');
    await expect(importSiteBuild(zip({ 'Index.HTML': PAGE }), 'Shop')).rejects.toThrow('This zip has no index.html');
  });

  it('refuses what is not a zip, and a zip with one path twice', async () => {
    await expect(importSiteBuild(new File([new Uint8Array([1, 2, 3])], 'notes.zip'), 'Shop')).rejects.toThrow('notes.zip could not be read as a .zip file.');
    await expect(importSiteBuild(new File([zipSync({ 'index.html': strToU8(PAGE), 'assets/app.js': strToU8('1'), 'assets\\app.js': strToU8('2') })], 'dist.zip'), 'Shop'))
      .rejects.toThrow('dist.zip has two files named assets/app.js.');
  });
});

describe('importSiteBuild: a project\'s own export', () => {
  const manifest = JSON.stringify({ name: 'Orders', version: '2.3.0', site: { entry: 'index.html' }, server: { entry: 'server/main.logic' } });
  const project = {
    version: 7,
    files: { 'manifest.json': manifest, 'server/main.logic': 'function list() { return []; }', 'server/migrations/001.sql': 'CREATE TABLE orders (id INTEGER);' },
    assets: { 'site/index.html': b64(PAGE), 'site/assets/app.js': b64('1') },
    access: 'application' as const,
  };

  it('comes back as the project it was: its manifest, its backend and its built files', async () => {
    const imported = await importSiteBuild(new File([new Uint8Array(exportNativeProject(project))], 'orders.zip'), 'Another name');
    expect(imported).toEqual({ version: 0, files: project.files, assets: project.assets, access: 'members', home: true });
  });

  it('is read from the one folder a zip holds, and keeps nothing else that is in it', async () => {
    const imported = await importSiteBuild(zip({ orders: {
      'manifest.json': manifest, 'README.md': 'Orders', 'notes.txt': 'x',
      server: { 'main.logic': 'function list() { return []; }', 'notes.md': 'x', 'helper.js': 'x', migrations: { '001.sql': 'CREATE TABLE orders (id INTEGER);' } },
      site: { 'index.html': PAGE, assets: { 'app.js': '1', 'app.js.map': '{}' } },
      assets: { 'logo.png': 2 },
    } }), 'Orders');
    expect(imported.files).toEqual(project.files);
    expect(imported.assets).toEqual(project.assets);
  });

  it('holds its site files to the same rule, and its first page to being one of them', async () => {
    const notes: string[] = [];
    const odd = await importSiteBuild(zip({ 'manifest.json': manifest, site: { 'index.html': PAGE, 'run.exe': 2 } }), 'Orders', notes);
    expect(Object.keys(odd.assets)).toEqual(['site/index.html']);
    expect(notes[0]).toContain('1 file was left out of the app: site/run.exe.');
    await expect(importSiteBuild(zip({ 'manifest.json': manifest, site: { 'home.html': PAGE } }), 'Orders'))
      .rejects.toThrow('manifest.json names index.html as the app\'s first page, which is not a page among the zip\'s site/ files.');
    await expect(importSiteBuild(zip({ 'manifest.json': JSON.stringify({ site: { entry: 'app.js' } }), site: { 'app.js': '1' } }), 'Orders')).rejects.toThrow('manifest.json names app.js as the app\'s first page');
    await expect(importSiteBuild(zip({ 'manifest.json': JSON.stringify({ site: {} }), site: { 'index.html': PAGE } }), 'Orders'))
      .rejects.toThrow('manifest.json\'s site block names no first page: give it "entry", such as "index.html".');
  });

  it('reads a build with a manifest.json of its own (a web app manifest) as a plain build', async () => {
    const web = JSON.stringify({ name: 'Shop', short_name: 'Shop', start_url: '.', display: 'standalone' });
    const imported = await importSiteBuild(zip({ build: { 'index.html': PAGE, 'manifest.json': web, 'broken.json': '{' } }), 'Shop');
    expect(imported.files).toEqual({ 'manifest.json': manifestOf('Shop') });
    expect(imported.assets['site/manifest.json']).toBe(b64(web));
    // One that is not JSON at all is a file of the build like any other.
    const odd = await importSiteBuild(zip({ 'index.html': PAGE, 'manifest.json': '{' }), 'Shop');
    expect(odd.assets['site/manifest.json']).toBe(b64('{'));
  });
});

describe('importSiteBuild: the limits', () => {
  it('refuses a zip past 80 MB before reading it', async () => {
    const arrayBuffer = vi.fn();
    await expect(importSiteBuild({ name: 'huge.zip', size: 80 * MB + 1, arrayBuffer } as unknown as File, 'Shop')).rejects.toThrow('huge.zip is larger than a build\'s zip can be (80 MB).');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a zip with more than 1,500 entries', async () => {
    const many: Tree = { 'index.html': PAGE };
    for (let index = 0; index < 1500; index++) many[`f${index}.txt`] = '';
    await expect(importSiteBuild(zip(many, 'many.zip'), 'Shop')).rejects.toThrow('many.zip has more than 1,500 entries, the most a build\'s zip can hold. Zip only the folder your build made (dist or build).');
  });

  it('refuses a file past 8 MB, naming it, and takes one at the limit', async () => {
    await expect(importSiteBuild(zip({ dist: { 'index.html': PAGE, media: { 'intro.mp4': NATIVE_LIMITS.mediaFileBytes + 1 } } }), 'Shop'))
      .rejects.toThrow('dist/media/intro.mp4 is larger than a hosted app keeps (8 MB per file).');
    const project = await importSiteBuild(zip({ 'index.html': PAGE, 'intro.mp4': NATIVE_LIMITS.mediaFileBytes }), 'Shop');
    expect(atob(project.assets['site/intro.mp4'])).toHaveLength(NATIVE_LIMITS.mediaFileBytes);
    // A source map of any size is left out before it is measured.
    await expect(importSiteBuild(zip({ 'index.html': PAGE, 'app.js.map': NATIVE_LIMITS.mediaFileBytes + 1 }), 'Shop')).resolves.toBeTruthy();
  });

  it('refuses more than 1,000 files to host', async () => {
    const many: Tree = { 'index.html': PAGE };
    for (let index = 0; index < 1000; index++) many[`c${index}.js`] = '';
    await expect(importSiteBuild(zip(many, 'chunks.zip'), 'Shop')).rejects.toThrow('chunks.zip has 1,001 files to host: a hosted app keeps up to 1,000.');
    delete many['c0.js'];
    expect(Object.keys((await importSiteBuild(zip(many, 'chunks.zip'), 'Shop')).assets)).toHaveLength(1000);
  });

  it('refuses a build past 64 MB in all', async () => {
    const big: Tree = { 'index.html': PAGE };
    for (let index = 0; index < 9; index++) big[`video${index}.mp4`] = 7.5 * MB;
    await expect(importSiteBuild(zip(big, 'films.zip'), 'Shop')).rejects.toThrow('films.zip holds more than a hosted app keeps (64 MB in all).');
  });
});

describe('siteBuildWarnings', () => {
  const built = (files: Record<string, string>, entry = 'index.html') => ({
    files: { 'manifest.json': JSON.stringify({ name: 'Shop', site: { entry } }) },
    assets: Object.fromEntries(Object.entries(files).map(([path, text]) => [`site/${path}`, b64(text)])),
  });

  it('says nothing of a build with relative paths, hash routing and no outside files', () => {
    expect(siteBuildWarnings(built({
      'index.html': '<!doctype html><link rel="stylesheet" href="./assets/app.css"><link rel="icon" href="favicon.ico"><link rel="canonical" href="https://shop.example/"><a href="https://example.com/">Site</a><script type="module" src="./assets/app.js"></script>',
      'assets/app.js': 'const router = createHashRouter([{ path: "/" }, { path: "/about" }]); const logo = new URL("logo.png", import.meta.url); fetch("https://api.example.com/v1/items.json");',
      'assets/app.css': '@font-face { src: url(./inter.woff2) } .hero { background: url("data:image/png;base64,AAAA") } .cdn { background: url(//cdn.example/x.png) }',
    }))).toEqual([]);
  });

  it('warns of a script, a stylesheet or a font the first page loads from another site', () => {
    const script = siteBuildWarnings(built({ 'index.html': '<script src="https://cdn.example.com/lib.js"></script>' }));
    expect(script).toEqual(['index.html loads https://cdn.example.com/lib.js from another site. A hosted app reaches another site only when you name it: put the file in your build, or allow the site in Settings, Outside sites.']);
    expect(siteBuildWarnings(built({ 'index.html': '<link href=\'//fonts.example.com/css?family=Inter\' rel=\'stylesheet\'>' }))[0]).toContain('index.html loads //fonts.example.com/css?family=Inter from another site');
    expect(siteBuildWarnings(built({ 'index.html': '<link rel="preload" as="font" href="http://fonts.example.com/inter.woff2">' }))[0]).toContain('http://fonts.example.com/inter.woff2');
    // The page the manifest names is the one read for this, wherever it is.
    expect(siteBuildWarnings(built({ 'app/start.html': '<script src="https://cdn.example.com/lib.js"></script>', 'index.html': 'old' }, 'app/start.html'))[0]).toContain('app/start.html loads https://cdn.example.com/lib.js');
    // A tag in a comment loads nothing, and another page's tags are not the first page's.
    expect(siteBuildWarnings(built({ 'index.html': '<!-- <script src="https://cdn.example.com/lib.js"></script> --><p>Hi</p>', 'other.html': '<script src="https://cdn.example.com/lib.js"></script>' }))).toEqual([]);
  });

  it('says nothing of files named from the site\'s root: the hosted page points them at the app\'s own', () => {
    expect(siteBuildWarnings(built({
      'index.html': '<script type="module" crossorigin src="/assets/index-BcD3.js"></script><link rel="stylesheet" href="/assets/app.css">',
      'assets/index-BcD3.js': 'const logo="/assets/logo-1a2b.svg"; fetch("/data.json")',
      'assets/app.css': '.hero{background:url(/assets/hero.png)}',
    }))).toEqual([]);
  });

  it('says where a router that goes by the path works, and warns of a service worker', () => {
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'assets/app.js': 'const router = createBrowserRouter(routes);' })))
      .toEqual(['assets/app.js picks its screens from the address path (createBrowserRouter). That works as built in Chrome, Edge and Firefox. Safari, on Mac and iPhone, does not let a hosted app change its path, so there it stays on its first screen: for Safari, use hash routing (createHashRouter / createWebHashHistory).']);
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'assets/app.js': 'root.render(h(BrowserRouter, null, h(App)))' }))[0]).toContain('the address path (BrowserRouter)');
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'assets/app.js': 'createRouter({ history: createWebHistory(), routes })' }))[0]).toContain('the address path (createWebHistory)');
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'assets/app.js': 'createRouter({ history: createWebHashHistory(), routes })' }))).toEqual([]);
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'registerSW.js': 'if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js")' })))
      .toEqual(['registerSW.js registers a service worker, and service workers do not run in a hosted app: take the registration out.']);
  });

  it('gives one warning of each kind, the first page\'s before the rest', () => {
    const warnings = siteBuildWarnings(built({
      'index.html': '<link rel="stylesheet" href="https://cdn.example.com/a.css"><script src="https://cdn.example.com/b.js"></script><script src="/assets/app.js"></script><script>navigator.serviceWorker.register("sw.js")</script>',
      'assets/app.js': 'createBrowserRouter([]); const a="/assets/a.png", b="/assets/b.png"; navigator.serviceWorker.register("sw.js")',
      'assets/more.js': 'createWebHistory(); const c="/assets/c.png"',
      'assets/app.css': 'a{background:url(/a.png)}',
    }));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('index.html loads https://cdn.example.com/a.css');
    expect(warnings[1]).toContain('assets/app.js picks its screens from the address path (createBrowserRouter)');
    expect(warnings[2]).toContain('index.html registers a service worker');
  });

  it('reads pages, scripts and stylesheets only, and no more than 2 MB of one', () => {
    const late = `${' '.repeat(2 * MB)}createBrowserRouter()`;
    expect(siteBuildWarnings(built({ 'index.html': PAGE, 'assets/big.js': late, 'data.json': '{"path":"/assets/x.png"}', 'notes.txt': 'createBrowserRouter serviceWorker.register' }))).toEqual([]);
    expect(siteBuildWarnings({ files: {}, assets: { 'assets/app.js': b64('createBrowserRouter()'), 'site/app.js': 'not base64 !!' } })).toEqual([]);
  });
});

describe('createSiteApp', () => {
  const app = { id: 'app-1', name: 'Shop', slug: 'shop', settings: { softnApp: true } };
  const build = () => zip({ dist: { 'index.html': '<script src="/assets/app.js"></script>', LICENSE: 'MIT', assets: { 'app.js': '1' } } });

  beforeEach(() => {
    for (const mock of [mocks.createApp, mocks.saveNativeProject, mocks.deleteApp, mocks.setState]) mock.mockReset();
    mocks.demo = false;
    mocks.storeError = null;
    mocks.createApp.mockResolvedValue(app);
    mocks.saveNativeProject.mockImplementation(async (_id: string, project: unknown) => ({ data: { project } }));
    mocks.deleteApp.mockResolvedValue({ data: { success: true, trashed: true } });
  });

  it('creates an app kept as a SoftN app\'s project is, saves the build as its first version, and says what will not work', async () => {
    const created = await createSiteApp('  Shop ', build());
    expect(mocks.createApp).toHaveBeenCalledWith({ name: 'Shop', settings: { softnApp: true } });
    expect(mocks.saveNativeProject).toHaveBeenCalledWith('app-1', {
      version: 0,
      files: { 'manifest.json': manifestOf('Shop') },
      assets: { 'site/index.html': b64('<script src="/assets/app.js"></script>'), 'site/assets/app.js': b64('1') },
      access: 'members',
      home: true,
    }, 0);
    expect(created.app).toBe(app);
    // What the importer left out comes first, then what in the build will not work everywhere (none here).
    expect(created.warnings).toEqual([expect.stringContaining('1 file was left out of the app: dist/LICENSE.')]);
    expect(mocks.deleteApp).not.toHaveBeenCalled();
  });

  it('creates nothing for a zip this host cannot take, with no name, or in the shared demo', async () => {
    await expect(createSiteApp('Shop', zip({ 'readme.txt': 'x' }))).rejects.toThrow('This zip has no index.html');
    await expect(createSiteApp('   ', build())).rejects.toThrow('Give the app a name.');
    mocks.demo = true;
    await expect(createSiteApp('Shop', build())).rejects.toThrow('available after sign-up');
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.saveNativeProject).not.toHaveBeenCalled();
  });

  it('says why when the app itself could not be created', async () => {
    mocks.createApp.mockResolvedValue(null);
    mocks.storeError = 'You have reached your plan\'s app limit.';
    await expect(createSiteApp('Shop', build())).rejects.toThrow('You have reached your plan\'s app limit.');
    expect(mocks.saveNativeProject).not.toHaveBeenCalled();
  });

  it('takes the app back when its build could not be saved, and says why', async () => {
    mocks.saveNativeProject.mockResolvedValue({ error: 'Native project exceeds 64 MB' });
    await expect(createSiteApp('Shop', build())).rejects.toThrow(/^Native project exceeds 64 MB$/);
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-1');
    // …and out of the list of apps this browser holds.
    const update = mocks.setState.mock.calls[0][0] as (state: { apps: { id: string }[] }) => { apps: { id: string }[] };
    expect(update({ apps: [{ id: 'app-0' }, { id: 'app-1' }] })).toEqual({ apps: [{ id: 'app-0' }] });
    // A save that never reached the server is one too.
    mocks.deleteApp.mockClear();
    mocks.saveNativeProject.mockRejectedValue(new Error('Failed to fetch'));
    await expect(createSiteApp('Shop', build())).rejects.toThrow(/^Failed to fetch$/);
    expect(mocks.deleteApp).toHaveBeenCalledWith('app-1');
  });

  it('says an empty app was left when it could not be taken back either', async () => {
    mocks.saveNativeProject.mockResolvedValue({ error: 'Native project exceeds 64 MB' });
    mocks.deleteApp.mockResolvedValue({ error: 'Failed to delete app' });
    await expect(createSiteApp('Shop', build())).rejects.toThrow('Native project exceeds 64 MB An empty app named Shop was left in Apps: delete it there before trying again.');
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
