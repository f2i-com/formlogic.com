import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { reviewAppArchive } from './appImportReview';
import { hostedPackageFromArchive } from './hostedActionArchive';
import { exportNativeProject, importNativeProject } from './nativeHosting';
import { editorBundle } from './appEditorArchive';

const python = 'count = 0\ndef increment():\n    global count\n    count += 1\n';
const client = {
  'manifest.json': JSON.stringify({ id: 'example.counter', name: 'Counter', main: 'ui/main.ui', files: { logic: ['logic/counter.py'] } }),
  'ui/main.ui': '<logic src="../logic/counter.py" /><Text>{count}</Text>',
  'logic/counter.py': python,
};
const encode = (files: Record<string, string | Uint8Array>) => Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value]));
const file = (files: Record<string, string | Uint8Array>) => {
  const bytes = zipSync(encode(files));
  return { arrayBuffer: async () => bytes.buffer } as File;
};
const native = () => ({
  ...client,
  'manifest.json': JSON.stringify({ ...JSON.parse(client['manifest.json']), server: { entry: 'server/main.logic', requires: { apiVersion: 1, capabilities: ['sql'] }, database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql'] }, routes: [] } }),
  'server/main.logic': 'function noop() { return { status: 200, body: {} }; }',
  'server/migrations/001.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY);',
});
const actions = () => ({
  ...client,
  'formlogic.json': JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions: { info: { file: 'server/info.logic', access: 'member', mode: 'read' } } }),
  'server/info.logic': 'function onRequest() { return { message: "private" }; }',
});

describe('Python client app import', () => {
  it('reviews Python as client source and preserves its module path and bytes', () => {
    const { review, files } = reviewAppArchive(zipSync(encode(client)));
    expect(review).toMatchObject({ backend: 'client', assets: 0, blockers: [] });
    expect(files['logic/counter.py']).toEqual(strToU8(python));
    expect(JSON.parse(strFromU8(files['manifest.json'])).files.logic).toEqual(['logic/counter.py']);
  });

  it('keeps Python client modules separate from named JavaScript actions', () => {
    const { review, files } = reviewAppArchive(zipSync(encode(actions())));
    expect(review).toMatchObject({ backend: 'actions', assets: 0, blockers: [] });
    const pkg = hostedPackageFromArchive(files);
    expect(pkg.client['logic/counter.py']).toBe(python);
    expect(pkg.client).not.toHaveProperty('server/info.logic');
    expect(pkg.actions.info).toEqual({ source: actions()['server/info.logic'], access: 'member', mode: 'read' });
  });

  it('round-trips a native project with Python, private handlers, migration and bundled media', async () => {
    const photo = new Uint8Array([137, 80, 78, 71]);
    const imported = await importNativeProject(file({ ...native(), 'assets/photo.png': photo }));
    expect(imported.files['logic/counter.py']).toBe(python);
    expect(imported.files['server/main.logic']).toBe(native()['server/main.logic']);
    expect(imported.files['server/migrations/001.sql']).toBe(native()['server/migrations/001.sql']);
    const exported = unzipSync(exportNativeProject(imported));
    expect(exported['logic/counter.py']).toEqual(strToU8(python));
    expect(exported['assets/photo.png']).toEqual(photo);
    const returned = await importNativeProject({ arrayBuffer: async () => editorBundle(exportNativeProject(imported)).buffer } as File);
    expect(returned.files['logic/counter.py']).toBe(python);
    expect(returned.assets).toEqual(imported.assets);
  });

  it('repairs interface inventory without activating undeclared logic or changing source bytes', () => {
    const files = { ...native(), 'logic/helper.logic': 'let title = "Counter";', 'private/hidden.py': 'secret = 1', 'Backend/hidden.logic': 'secret', 'logic/upper.PY': 'upper = 1' };
    const prepared = unzipSync(editorBundle(zipSync(encode(files))));
    const manifest = JSON.parse(strFromU8(prepared['manifest.json']));
    expect(manifest.files.logic).toEqual(['logic/counter.py']);
    expect(manifest.files.ui).toEqual(['ui/main.ui']);
    expect(prepared['private/hidden.py']).toEqual(strToU8(files['private/hidden.py']));
    expect(prepared['logic/counter.py']).toEqual(strToU8(python));
  });

  it.each([
    ['logic/main.logic', 'let count = 0;', 'examples/sample.py', 'count = 9'],
    ['logic/main.py', 'count = 0', 'examples/sample.logic', 'let count = 9;'],
  ])('preserves the explicit entry %s without promoting an example of another language', (entry, source, example, unused) => {
    const files = {
      'manifest.json': JSON.stringify({ main: 'ui/main.ui', files: { logic: [entry] } }),
      'ui/main.ui': `<logic src="../${entry}" /><Text>{count}</Text>`,
      [entry]: source, [example]: unused,
    };
    const returned = unzipSync(editorBundle(zipSync(encode(files))));
    expect(JSON.parse(strFromU8(returned['manifest.json'])).files.logic).toEqual([entry]);
    expect(returned[example]).toEqual(strToU8(unused));
  });

  it.each(['logic/main.logic', 'logic/main.py'])('derives a genuinely absent legacy logic inventory with %s', entry => {
    const files = {
      'manifest.json': JSON.stringify({ main: 'ui/main.ui' }),
      'ui/main.ui': `<logic src="../${entry}" /><Text/>`, [entry]: 'count = 0',
      'server/main.logic': 'private', 'Private/helper.py': 'private', 'logic/upper.PY': 'unsupported',
    };
    const returned = unzipSync(editorBundle(zipSync(encode(files))));
    expect(JSON.parse(strFromU8(returned['manifest.json'])).files.logic).toEqual([entry]);
  });

  it('preserves an explicit empty logic inventory', () => {
    const returned = unzipSync(editorBundle(zipSync(encode({ ...client, 'manifest.json': JSON.stringify({ main: 'ui/main.ui', files: { logic: [] } }) }))));
    expect(JSON.parse(strFromU8(returned['manifest.json'])).files.logic).toEqual([]);
  });

  it('applies the existing per-source review limit to Python', () => {
    const { review } = reviewAppArchive(zipSync(encode({ ...client, 'logic/counter.py': 'x'.repeat(200001) })));
    expect(review.assets).toBe(0);
    expect(review.blockers).toEqual([expect.stringContaining('200 KB per text file')]);
  });

  it.each(['server/helper.py', 'backend/helper.py', 'private/helper.py', 'Server/helper.py', 'PRIVATE/helper.py'])('refuses private Python at %s', async path => {
    await expect(importNativeProject(file({ ...native(), [path]: python }))).rejects.toThrow('Python is a client logic language');
    expect(() => hostedPackageFromArchive(encode({ ...actions(), [path]: python }))).toThrow('Undeclared private files');
    expect(reviewAppArchive(zipSync(encode({ ...client, [path]: python }))).review.backend).toBe('native');
  });

  it.each(['logic/counter.PY', 'logic/code.js', 'logic/code.wasm', 'logic/code.bin'])('does not expand the upload surface to %s', async path => {
    const bytes = new Uint8Array([0, 255, 1]);
    await expect(importNativeProject(file({ ...native(), [path]: bytes }))).rejects.toThrow('Unsupported project file');
    expect(() => hostedPackageFromArchive(encode({ ...actions(), [path]: bytes }))).toThrow('native asset hosting');
    const { review } = reviewAppArchive(zipSync(encode({ ...client, [path]: bytes })));
    expect(review.assets).toBe(1);
    expect(review.blockers).toEqual([expect.stringContaining('asset hosting')]);
  });

  it.each(['../counter.py', 'logic/../counter.py', '/counter.py', 'C:/counter.py', 'logic\\counter.py'])('keeps unsafe paths blocked: %s', path => {
    expect(() => reviewAppArchive(zipSync(encode({ ...client, [path]: python })))).toThrow('invalid file path');
  });
});
