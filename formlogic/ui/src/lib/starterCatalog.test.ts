import { describe, expect, it } from 'vitest';
import { browseStarters, starterCatalog } from './starterCatalog';
describe('public bundled starter catalogue', () => {
  it('includes an Aokie listing and its actual form composition', () => {
    const aokie = starterCatalog.find(pack => pack.slug === 'aokie-receptionist');
    expect(aokie?.formTitles).toContain('Appointments');
    expect(aokie?.formCount).toBe(10);
    expect(browseStarters('AOKIE').packs[0].slug).toBe('aokie-receptionist');
  });
  it('filters and paginates without fabricating live ratings', () => {
    expect(browseStarters('no-such-starter').packs).toHaveLength(0);
    expect(browseStarters('', '', 'aokie').packs).toHaveLength(1);
    const first = browseStarters('', '', '', 'name', 1, 5).packs;
    const next = browseStarters('', '', '', 'name', 2, 5).packs;
    expect(first).toHaveLength(5);
    expect(next.some(pack => first.some(previous => previous.id === pack.id))).toBe(false);
    expect(first.every(pack => pack.ratingCount === 0 && pack.downloadCount === 0)).toBe(true);
  });
});
