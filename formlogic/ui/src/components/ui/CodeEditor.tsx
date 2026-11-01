import { Suspense } from 'react';
import { lazyWithRetry } from '../../lib/lazyWithRetry';
import { ErrorBoundary } from '../ErrorBoundary';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id. Defaults to 'typescript'. Use 'html' / 'css' for the markup/style tabs. */
  language?: string;
  /** Model path (e.g. 'index.tsx') — the extension tells the TS worker to parse JSX in .tsx files. */
  path?: string;
  /** Which FormLogic SDK type defs to surface for autocomplete (only meaningful for the code tab). */
  sdk?: 'form' | 'app' | 'none';
  readOnly?: boolean;
  ariaLabel?: string;
  wordWrap?: 'on' | 'off';
  height?: string | number;
  /** Called once with the mounted editor instance (e.g. to insert selectors at the cursor). */
  onMount?: (editor: import('monaco-editor').editor.IStandaloneCodeEditor) => void;
}

// Monaco is heavy — load it (and its workers) as a separate chunk, only when an editor is shown.
const MonacoEditorImpl = lazyWithRetry(() => import('./MonacoEditorImpl'));

/**
 * A code editor (Monaco) with TypeScript + FormLogic SDK autocomplete. Lazy-loaded. Monaco is left
 * out of the precache, so its chunk can be gone even under an old worker, and an editor that can't
 * load must not take the page and its unsaved work down with it.
 */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <ErrorBoundary fallback={<div role="alert" className="flex h-full min-h-[200px] items-center justify-center p-4 text-center text-sm text-gray-500 dark:text-slate-400">The code editor couldn’t load. Reload this page to try again.</div>}>
      <Suspense fallback={<div className="flex h-full min-h-[200px] items-center justify-center text-sm text-gray-400 dark:text-slate-500">Loading editor…</div>}>
        <MonacoEditorImpl {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
