// Pack-owned Calls transcript record screen (plan APP-505 — self-contained apps).
//
// TSX edition: the screen is REAL SOURCE FILES under ./aokie-screens/transcript/ (index.tsx +
// sort.ts + styles.css), imported here as strings (?raw) and shipped in customScreen.files.
// The sandbox runtime bundles them on render (esbuild-wasm + embedded Preact — screenCompile.ts);
// the sources are type-checked by the repo's tsc and unit tests import them as normal modules.
// The compiled registry screen `aokie-call-transcript` + its registry entry stay untouched for
// rollback (flip the Calls form's customScreen.recordScreen back to the sdk reference).
//
// Runtime contract (CustomScreenRuntime + RecordScreenPanel): opaque-origin iframe, strict CSP;
// `window.FormLogic` is the only bridge (related() is TRUSTED_ONLY — the form's
// custom_screen_trust must be owner/verified); theme = injected --fl-* variables.

import transcriptIndexTsx from './transcript/index.tsx?raw';
import transcriptSortTs from './transcript/sort.ts?raw';
import transcriptCss from './transcript/styles.css?raw';

// The ordering rule is shared source: the shipped file IS the tested module.
export { compareTurns } from './transcript/sort';

/**
 * The customScreen.recordScreen payload for the Calls form (kind 'code').
 * consumesRelated keeps hiding the transcript-turns.call_link group from the generic
 * related panel — this widget renders that data itself.
 */
export const AOKIE_CALL_TRANSCRIPT_SCREEN = {
  kind: 'code' as const,
  title: 'Transcript',
  consumesRelated: ['transcript-turns.call_link'],
  height: 480,
  entry: 'index.tsx',
  files: [
    { path: 'index.tsx', content: transcriptIndexTsx },
    { path: 'sort.ts', content: transcriptSortTs },
    { path: 'styles.css', content: transcriptCss },
  ],
};
