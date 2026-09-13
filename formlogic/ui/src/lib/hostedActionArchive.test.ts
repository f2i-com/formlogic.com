import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { hostedPackageFromArchive } from './hostedActionArchive';
import { reviewAppArchive } from './appImportReview';

function fixture() {
  return Object.fromEntries(Object.entries({
    'manifest.json': JSON.stringify({ name: 'Pack app', main: 'ui/main.ui' }),
    'permission.json': '{"permissions":{}}',
    'ui/main.ui': '<Text>Example</Text>',
    'formlogic.json': JSON.stringify({ formatVersion: 1, storage: 'formlogic-forms-sqlite', actions: { info: { file: 'server/info.logic', access: 'member', mode: 'read' } } }),
    'server/info.logic': 'function onRequest(ctx) { return {name:"Example"}; }',
  }).map(([path, text]) => [path, strToU8(text)]));
}
describe('portable named-action projects', () => {
  it('imports private actions without leaking their files into the public client', () => {
    const files = fixture();
    const { review } = reviewAppArchive(zipSync(files));
    expect(review.backend).toBe('actions');
    expect(review.blockers).toEqual([]);
    const pkg = hostedPackageFromArchive(files);
    expect(pkg.actions.info.source).toContain('onRequest');
    expect(pkg.client).not.toHaveProperty('server/info.logic');
    expect(pkg.client).not.toHaveProperty('formlogic.json');
  });
  it('refuses missing actions and undeclared private files instead of discarding them', () => {
    const files = fixture();
    delete files['server/info.logic'];
    expect(() => reviewAppArchive(zipSync(files))).toThrow('Invalid backend action');
    expect(() => hostedPackageFromArchive({ ...fixture(), 'server/extra.logic': strToU8('private') })).toThrow('Undeclared private files');
  });
});
