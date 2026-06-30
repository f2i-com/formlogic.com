import { lazy, Suspense } from 'react';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco language id. Defaults to 'typescript'. Use 'html' / 'css' for the markup/style tabs. */
  language?: string;
  /** Which FormLogic SDK type defs to surface for autocomplete (only meaningful for the code tab). */
  sdk?: 'form' | 'app';
  height?: string | number;
}

// Monaco is heavy — load it (and its workers) as a separate chunk, only when an editor is shown.
const MonacoEditorImpl = lazy(() => import('./MonacoEditorImpl'));

/** A code editor (Monaco) with TypeScript + FormLogic SDK autocomplete. Lazy-loaded. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="flex h-full min-h-[200px] items-center justify-center text-sm text-gray-400 dark:text-slate-500">Loading editor…</div>}>
      <MonacoEditorImpl {...props} />
    </Suspense>
  );
}
