// Locks the custom-screen TSX pipeline end-to-end: bundling (vfs + embedded preact vendor modules +
// automatic JSX) AND execution — the compiled bundle actually renders and re-renders components in a
// DOM. Uses the native `esbuild` package (already a vite dependency) through the test seam, so no
// wasm loader runs under vitest; the plugin/options under test are the exact ones esbuild-wasm gets.
//
// Runs in the NODE environment on purpose: esbuild's load-time TextEncoder/Uint8Array invariant
// check fails under vitest's jsdom globals (cross-realm typed arrays), so the DOM comes from an
// explicit JSDOM instance and the bundle executes with that window/document injected — the same
// free-variable shape the sandbox iframe gives it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as esbuildNative from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  __setEsbuildForTests,
  __setEsmFetchForTests,
  bundleScreenFiles,
  compileScreenCode,
  type EsbuildLike,
  type EsmFetch,
} from './screenCompile';

// The first build call spawns the esbuild service process — slow under full-suite CPU load.
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => __setEsbuildForTests(esbuildNative as unknown as EsbuildLike));
afterAll(() => { __setEsbuildForTests(null); __setEsmFetchForTests(null); });

/** An offline fake esm.sh: url → module source. Unknown urls 404. */
function fakeEsm(registry: Record<string, string>): EsmFetch {
  return (url) => Promise.resolve({
    ok: url in registry,
    status: url in registry ? 200 : 404,
    text: () => Promise.resolve(registry[url] ?? ''),
  });
}

/** Run a compiled screen bundle against a fresh document with a #root, like the sandbox iframe would. */
function execute(js: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  // The bundle is an IIFE; `window`/`document` inside it are free variables — inject the JSDOM ones.
  new Function('window', 'document', js)(dom.window, dom.window.document);
  return { root: dom.window.document.getElementById('root') as HTMLElement, window: dom.window };
}

const flushRender = () => new Promise((r) => setTimeout(r, 20));

describe('bundleScreenFiles — TSX components', () => {
  it('bundles a React-style TSX component (react alias → preact/compat) that renders and updates state', async () => {
    const r = await bundleScreenFiles([
      {
        path: 'index.tsx',
        content: `
          import { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          function Counter() {
            const [n, setN] = useState(0);
            return <button id="inc" onClick={() => setN(n + 1)}>count:{n}</button>;
          }
          createRoot(document.getElementById('root')!).render(<Counter />);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    // No index.html in the project — the shell falls back to a root mount node.
    expect(r.html).toBe('<div id="root"></div>');
    // The bundle must be self-contained: no leftover module syntax.
    expect(r.js).not.toMatch(/\bfrom\s*["']react["']/);

    const { root } = execute(r.js);
    await flushRender();
    expect(root.textContent).toContain('count:0');
    root.querySelector<HTMLButtonElement>('#inc')!.click();
    await flushRender();
    expect(root.textContent).toContain('count:1');
  });

  it('supports preact imports directly and relative imports between files', async () => {
    const r = await bundleScreenFiles([
      { path: 'lib/greet.ts', content: `export const greet = (n: string) => 'Hello ' + n;` },
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import { useMemo } from 'preact/hooks';
          import { greet } from './lib/greet';
          function App() {
            const msg = useMemo(() => greet('TSX'), []);
            return <h1>{msg}</h1>;
          }
          render(<App />, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('h1')?.textContent).toBe('Hello TSX');
  });

  it('tolerates JS-side css imports as no-ops (css is injected separately)', async () => {
    const r = await bundleScreenFiles([
      { path: 'styles.css', content: '.a { color: var(--fl-accent); }' },
      {
        path: 'index.tsx',
        content: `
          import './styles.css';
          import './missing.css';
          import { render } from 'preact';
          render(<p id="ok">css imports ignored</p>, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.css).toContain('--fl-accent'); // still collected from the file itself
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('#ok')?.textContent).toBe('css imports ignored');
  });

});

describe('bundleScreenFiles — formlogic/kit built-in', () => {
  it('renders kit components with the stylesheet injected exactly once', async () => {
    const r = await bundleScreenFiles([
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import { Card, Button, Stat, Badge, EmptyState } from 'formlogic/kit';
          render(
            <Card title="Kit card" actions={<Badge tone="ok">live</Badge>}>
              <Stat label="records" value={7} />
              <Button variant="primary">Go</Button>
              <EmptyState title="Nothing yet" hint="hint text" />
            </Card>,
            document.getElementById('root')!
          );
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root, window } = execute(r.js);
    await flushRender();
    expect(root.querySelector('.flk-card-title')?.textContent).toBe('Kit card');
    expect(root.querySelector('.flk-stat b')?.textContent).toBe('7');
    expect(root.querySelector('.flk-btn.primary')?.textContent).toBe('Go');
    expect(root.querySelector('.flk-badge.ok')?.textContent).toBe('live');
    expect(root.querySelector('.flk-empty p')?.textContent).toBe('Nothing yet');
    // ensureKitStyles is idempotent — many components, ONE stylesheet.
    expect(window.document.querySelectorAll('#flk-styles').length).toBe(1);
  });

  it("resolves the '@formlogic/kit' alias to the same built-in", async () => {
    const r = await bundleScreenFiles([
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import { Badge } from '@formlogic/kit';
          render(<Badge tone="warn">aliased</Badge>, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('.flk-badge.warn')?.textContent).toBe('aliased');
  });
});

describe('bundleScreenFiles — npm via esm.sh (compile-time, offline-faked)', () => {
  it('resolves a bare import through esm.sh, following the module graph', async () => {
    __setEsmFetchForTests(fakeEsm({
      'https://esm.sh/greeting-lib@1.0.0': `import { base } from '/base-lib@2.0.0/index.mjs'; export const greet = (n) => base + ' ' + n;`,
      'https://esm.sh/base-lib@2.0.0/index.mjs': `export const base = 'Hello';`,
    }));
    const r = await bundleScreenFiles([
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import { greet } from 'greeting-lib@1.0.0';
          render(<p id="npm">{greet('esm')}</p>, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('#npm')?.textContent).toBe('Hello esm');
  });

  it("maps 'react' INSIDE fetched packages onto the embedded preact runtime (one runtime, hooks work)", async () => {
    __setEsmFetchForTests(fakeEsm({
      'https://esm.sh/use-flag@1.0.0': `import { useState } from 'react'; export function useFlag() { const [v] = useState('esm-flag'); return v; }`,
    }));
    const r = await bundleScreenFiles([
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import { useFlag } from 'use-flag@1.0.0';
          function App() { return <b id="flag">{useFlag()}</b>; }
          render(<App />, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('#flag')?.textContent).toBe('esm-flag');
  });

  it('reports an honest error when the package cannot be fetched', async () => {
    __setEsmFetchForTests(fakeEsm({}));
    const r = await bundleScreenFiles([
      { path: 'index.ts', content: `import x from 'no-such-pkg@9.9.9'; console.log(x);` },
    ]);
    expect(r.error).toContain('esm.sh');
    expect(r.error).toContain('no-such-pkg');
  });

  it('refuses full-URL imports from any origin other than esm.sh', async () => {
    __setEsmFetchForTests(fakeEsm({}));
    const r = await bundleScreenFiles([
      { path: 'index.ts', content: `import x from 'https://evil.example/x.js'; console.log(x);` },
    ]);
    expect(r.error).toContain('Only https://esm.sh URL imports are allowed');
  });

  it('never fetches another origin through a slash-led specifier, in the screen or in a fetched package', async () => {
    const fetched: string[] = [];
    const registry: Record<string, string> = {
      'https://esm.sh/hop-lib@1.0.0': `import y from '//evil.example/y.js'; export const hop = y;`,
    };
    __setEsmFetchForTests((url) => { fetched.push(url); return fakeEsm(registry)(url); });
    // `'/' + '/evil.example/x.js'` and `'//evil.example/y.js'` both parse as a URL whose host is evil.example.
    const direct = await bundleScreenFiles([
      { path: 'index.ts', content: `import x from '/evil.example/x.js'; console.log(x);` },
    ]);
    const nested = await bundleScreenFiles([
      { path: 'index.ts', content: `import { hop } from 'hop-lib@1.0.0'; console.log(hop);` },
    ]);
    expect(fetched.filter((url) => !url.startsWith('https://esm.sh/'))).toEqual([]);
    expect(direct.error).toContain('Only https://esm.sh');
    expect(nested.error).toContain('Only https://esm.sh');
  });

  it('holds the origin for every spelling of another host that a URL parser accepts', async () => {
    const fetched: string[] = [];
    __setEsmFetchForTests((url) => { fetched.push(url); return fakeEsm({})(url); });
    const spellings = [
      '\\\\evil.example/x.js', // backslashes read as slashes
      '/\\evil.example/x.js',
      '\t//evil.example/x.js', // tabs and newlines are dropped by the parser
      'HTTPS://evil.example/x.js',
      'http://esm.sh/x.js', // esm.sh over plain http is another origin
      'https://esm.sh@evil.example/x.js',
      'https://esm.sh.evil.example/x.js',
    ];
    for (const spec of spellings) {
      const r = await bundleScreenFiles([
        { path: 'index.ts', content: `import x from ${JSON.stringify(spec)}; console.log(x);` },
      ]);
      expect(r.js, spec).toBe('');
      expect(r.error, spec).toContain('Only https://esm.sh');
    }
    expect(fetched.filter((url) => new URL(url).origin !== 'https://esm.sh')).toEqual([]);
  });

  // fetch follows redirects, and esm.sh uses them (an unpinned version to the pinned one). The
  // shell's CSP stops a hop to an origin it does not list, but it lists more than esm.sh (the app
  // itself, the API, the desktop bridges on loopback), and a dev server sends no CSP at all: the
  // compiler holds its own rule and bundles nothing that was answered from anywhere else.
  it('does not bundle what a redirect off esm.sh answered', async () => {
    __setEsmFetchForTests(() => Promise.resolve({
      ok: true,
      status: 200,
      url: 'http://127.0.0.1:17872/anything',
      text: () => Promise.resolve(`export default 'answered by another host';`),
    }));
    const r = await bundleScreenFiles([
      { path: 'index.ts', content: `import x from 'moved-lib@1.0.0'; console.log(x);` },
    ]);
    expect(r.js).toBe('');
    expect(r.error).toContain('redirected to another site');
    expect(r.error).not.toContain('answered by another host');
  });

  it('still follows a redirect that stays on esm.sh', async () => {
    __setEsmFetchForTests(() => Promise.resolve({
      ok: true,
      status: 200,
      url: 'https://esm.sh/moved-lib@1.0.1',
      text: () => Promise.resolve(`export default 'pinned';`),
    }));
    const r = await bundleScreenFiles([
      { path: 'index.ts', content: `import x from 'moved-lib'; console.log(x);` },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.js).toContain('pinned');
  });

  it('asks esm.sh without the session: no credentials are sent', async () => {
    __setEsmFetchForTests(null);
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({ ok: true, status: 200, url, text: () => Promise.resolve(`export default 1;`) });
    });
    try {
      const r = await bundleScreenFiles([
        { path: 'index.ts', content: `import x from 'plain-lib@1.0.0'; console.log(x);` },
      ]);
      expect(r.error).toBeUndefined();
      expect(calls).toEqual([['https://esm.sh/plain-lib@1.0.0', { credentials: 'omit' }]]);
    } finally {
      vi.unstubAllGlobals();
      __setEsmFetchForTests(null);
    }
  });
});

describe('bundleScreenFiles — image assets', () => {
  it('imports an .svg file as a utf8 data: URI usable in <img src>', async () => {
    const r = await bundleScreenFiles([
      { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' },
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import logo from './assets/logo.svg';
          render(<img id="logo" src={logo} />, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    const src = root.querySelector('img')?.getAttribute('src') ?? '';
    expect(src.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(src)).toContain('<circle r="4"/>');
  });

  it('imports a binary image stored as a data: URI verbatim', async () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const r = await bundleScreenFiles([
      { path: 'assets/pic.png', content: uri },
      {
        path: 'index.tsx',
        content: `
          import { render } from 'preact';
          import pic from './assets/pic.png';
          render(<img id="pic" src={pic} />, document.getElementById('root')!);
        `,
      },
    ]);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('img')?.getAttribute('src')).toBe(uri);
  });

  it('refuses a binary image that is not stored as a data: URI', async () => {
    const r = await bundleScreenFiles([
      { path: 'pic.png', content: 'not-a-data-uri' },
      { path: 'index.ts', content: `import pic from './pic.png'; console.log(pic);` },
    ]);
    expect(r.error).toContain('data: URIs');
  });
});

describe('compileScreenCode — single-file sources', () => {
  it('compiles plain TypeScript exactly as before', async () => {
    const r = await compileScreenCode(`const el = document.getElementById('root')!; el.textContent = 'plain ts';`);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    expect(root.textContent).toBe('plain ts');
  });

  it('keeps angle-bracket type assertions working via the plain-TS fallback pass', async () => {
    const r = await compileScreenCode(`const w = <any>window; w.__flAssert = 'ok';`);
    expect(r.error).toBeUndefined();
    const { window } = execute(r.js);
    expect((window as unknown as { __flAssert?: string }).__flAssert).toBe('ok');
  });

  it('compiles single-file JSX with react-style hooks (no files project needed)', async () => {
    const r = await compileScreenCode(`
      import { useState } from 'react';
      import { render } from 'preact';
      function Chip() {
        const [label] = useState('single-file tsx');
        return <span class="chip">{label}</span>;
      }
      render(<Chip />, document.getElementById('root')!);
    `);
    expect(r.error).toBeUndefined();
    const { root } = execute(r.js);
    await flushRender();
    expect(root.querySelector('.chip')?.textContent).toBe('single-file tsx');
  });

  it('reports the TSX-dialect error when a source fails both passes', async () => {
    const r = await compileScreenCode(`const broken = <div>`);
    expect(r.js).toBe('');
    expect(r.error).toBeTruthy();
  });
});
