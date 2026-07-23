// @vitest-environment node
// The poll screen the demo writes is GENERATED TypeScript that only ever compiles at
// runtime inside the sandbox bundler — a syntax slip would hide until a visitor runs
// the guided build. This suite compiles the generated source with real esbuild.
import { describe, expect, it } from 'vitest';
import { transform } from 'esbuild';
import { pollScreenFiles } from './demoChatScript';

describe('demo poll screen (generated code)', () => {
  it('emits valid TS that esbuild compiles, with the SVG art and field id embedded', async () => {
    const files = pollScreenFiles('fld-sample-123', ['Pizza', 'Sushi', 'Tacos', 'Salad']);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'styles.css', 'index.ts']);

    const ts = files[2].content;
    const out = await transform(ts, { loader: 'ts' });
    expect(out.code).toContain('Team lunch poll');
    expect(out.code.length).toBeGreaterThan(500);

    // Bound to the real field id; polished: logo + per-option icons + leader crown.
    expect(ts).toContain('fld-sample-123');
    expect(ts).toContain('<svg');
    expect(ts).toContain('CROWN');
    for (const label of ['Pizza', 'Sushi', 'Tacos', 'Salad']) {
      expect(ts).toContain(label);
    }
    // The stylesheet themes on the sandbox palette (light AND dark), never hardcoded.
    const css = files[1].content;
    expect(css).toContain('var(--fl-accent)');
    expect(css).toContain('var(--fl-surface)');
    expect(css).not.toMatch(/#0f172a|#111827/);
  });
});
