// Shared harness for the pack-owned TSX screen behavioral tests: bundle a screen's `files`
// with the REAL sandbox pipeline (screenCompile vfs + embedded preact + automatic JSX, driven
// by the native esbuild package via the test seam) and execute the artifact in a JSDOM document
// against a mocked window.FormLogic. Import from a *.test.ts file only.
//
// Usage per test file:
//   beforeAll(() => setupScreenTestEsbuild());
//   afterAll(() => teardownScreenTestEsbuild());
//   const { root } = await runScreen(SCREEN, { records: () => Promise.resolve([]) , ... });

import * as esbuildNative from 'esbuild';
import { JSDOM } from 'jsdom';
import { __setEsbuildForTests, bundleScreenFiles, type EsbuildLike } from '../../lib/screenCompile';

export function setupScreenTestEsbuild(): void {
  __setEsbuildForTests(esbuildNative as unknown as EsbuildLike);
}

export function teardownScreenTestEsbuild(): void {
  __setEsbuildForTests(null);
}

/** Give async renders/effects a beat to settle (preact schedules effects on rAF/microtasks). */
export const flushScreen = (ms = 25) => new Promise((r) => setTimeout(r, ms));

export interface RunScreenResult {
  root: HTMLElement;
  dom: JSDOM;
  /** The compiled bundle, for source-level assertions on the artifact. */
  js: string;
}

/** Bundle a screen's files and run them in a fresh JSDOM with the given FormLogic mock.
 *  `opts.windowGlobals` seed extra properties on the sandbox window before the bundle runs
 *  (e.g. __flPresenceGraceMs — defaulted to 0 so screens settle immediately for steady-state
 *  assertions; a test overrides it to exercise a loading state). */
export async function runScreen(
  screen: { files?: Array<{ path: string; content: string }>; entry?: string },
  formLogic: Record<string, unknown>,
  opts: { windowGlobals?: Record<string, unknown> } = {}
): Promise<RunScreenResult> {
  const r = await bundleScreenFiles(screen.files ?? [], screen.entry);
  if (r.error) throw new Error(`screen bundle failed: ${r.error}`);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(dom.window as unknown as Record<string, unknown>, { __flPresenceGraceMs: 0 }, opts.windowGlobals ?? {});
  (dom.window as unknown as Record<string, unknown>).FormLogic = formLogic;
  // The bundle's free variables (window/document/FormLogic) resolve to the injected sandbox.
  // A fast requestAnimationFrame keeps preact's effect scheduling snappy under node (its
  // fallback is setTimeout(…, 100), slower than the test flush).
  const raf = (cb: () => void) => setTimeout(cb, 0);
  new Function('window', 'document', 'FormLogic', 'requestAnimationFrame', 'cancelAnimationFrame', r.js)(
    dom.window, dom.window.document, formLogic, raf, clearTimeout
  );
  return { root: dom.window.document.getElementById('root') as HTMLElement, dom, js: r.js };
}
