import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { reviewAppArchive } from './appImportReview';

const make = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])));
const base = { 'manifest.json': JSON.stringify({ name: 'My app', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Hello</Text>', 'logic/main.logic': 'let message = "Hello";' };
describe('app import review', () => {
  it('recognises a compatible text app and keeps source bytes unchanged', () => {
    const { review, files } = reviewAppArchive(make(base));
    expect(review.blockers).toEqual([]);
    expect(review.backend).toBe('client');
    expect(files['logic/main.logic']).toEqual(strToU8(base['logic/main.logic']));
  });
  it('finds the app in a source ZIP without importing build tools or notes', () => {
    const archive = Object.fromEntries(Object.entries(base).map(([path, value]) => [`Project/app/${path}`, value]));
    const { review, files } = reviewAppArchive(make({ ...archive, 'Project/tools/build.py': 'print("build")' }));
    expect(review.root).toBe('Project/app/');
    expect(Object.keys(files)).toEqual(Object.keys(base));
    expect(review.blockers).toEqual([]);
  });
  it('reports native routes, migrations, assets and permissions without discarding them', () => {
    const manifest = { name: 'Coffee example', main: 'ui/main.ui', server: { entry: 'server/main.logic', requires: { capabilities: ['sql', 'crypto'] }, routes: [{ method: 'POST', path: '/api/auth/verify' }], database: { migrations: ['server/migrations/001.sql'] } } };
    const { review, files } = reviewAppArchive(make({ ...base, 'manifest.json': JSON.stringify(manifest), 'server/main.logic': 'function authenticate() {}', 'server/migrations/001.sql': 'CREATE TABLE users (id INTEGER);', 'assets/photo.png': new Uint8Array([1, 2, 3]), 'permission.json': JSON.stringify({ permissions: { net: { enabled: true } } }) }));
    expect(review).toMatchObject({ backend: 'native', routes: 1, migrations: 1, assets: 1, capabilities: ['sql', 'crypto'] });
    expect(review.blockers).toHaveLength(3);
    expect(files['server/main.logic']).toEqual(strToU8('function authenticate() {}'));
  });
  it('rejects ambiguous source archives rather than choosing an app silently', () => {
    const archive = Object.fromEntries(['one/', 'two/'].flatMap(root => Object.entries(base).map(([path, value]) => [root + path, value])));
    expect(() => reviewAppArchive(make(archive))).toThrow('several apps');
  });
  it('reports a large normal asset instead of a generic compressed-file size error', () => {
    const { review } = reviewAppArchive(make({ ...base, 'assets/photo.png': new Uint8Array(2_100_000) }));
    expect(review.blockers.some(message => message.includes('hosting limits'))).toBe(true);
    expect(review.assets).toBe(1);
  });
});
