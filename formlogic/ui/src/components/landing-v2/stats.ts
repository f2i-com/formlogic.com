/**
 * Landing-page marketing facts. Deliberately lightweight constants — the hero
 * must not import the pack catalogue or the builder just to render numbers —
 * but they are REAL: stats.test.ts asserts each against its source of truth
 * (packCatalog / FIELD_TYPE_INFO), so a drift fails CI instead of shipping a
 * stale claim.
 */

/** Marketplace size — must equal packCatalog.length. */
export const PACK_COUNT = 29;

/** Form field types — must equal Object.keys(FIELD_TYPE_INFO).length. */
export const FIELD_TYPE_COUNT = 23;

/** Public source repo — a star is the cheapest way visitors can say "keep going". */
export const GITHUB_URL = 'https://github.com/f2i-com/formlogic.com';
