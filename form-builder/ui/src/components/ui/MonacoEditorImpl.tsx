import { useCallback } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { CodeEditorProps } from './CodeEditor';

// Use the BUNDLED monaco (no CDN — works offline / self-hosted) and wire its web workers for Vite.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return (label === 'typescript' || label === 'javascript') ? new tsWorker() : new editorWorker();
  },
};
loader.config({ monaco });

// FormLogic SDK type definitions, so window.FormLogic autocompletes inside the editor.
const COMMON = `
interface FlRecord { id: string; answers: Record<string, any>; submittedAt: string; status?: string; tags?: string[]; }
interface FlUser { id: string; name: string; email: string; }
interface FlField { id: string; label: string; type: string; }
interface FlToast { success(msg: string): void; error(msg: string): void; }
`;
const FORM_SDK_DTS = COMMON + `
interface FlFormSdk {
  /** Save a response to THIS form (runs validation + the onSubmit script). */
  submit(answers: Record<string, any>): Promise<any>;
  /** List this form's records, newest first. */
  records(opts?: { limit?: number }): Promise<FlRecord[]>;
  /** The signed-in user, or null. */
  currentUser(): Promise<FlUser | null>;
  /** This screen's context. */
  context(): Promise<{ formId: string; title: string; fields: FlField[] }>;
  toast: FlToast;
  /** Escape a value for safe innerHTML interpolation (use for any record/user data). */
  escapeHtml(v: unknown): string;
}
declare const FormLogic: FlFormSdk;
`;
const APP_SDK_DTS = COMMON + `
interface FlFormRef { formId: string; displayName: string; fields: FlField[]; }
interface FlAppSdk {
  /** App context: { appName, appSlug, forms }. */
  context(): Promise<{ appName: string; appSlug: string; forms: FlFormRef[] }>;
  /** The app's forms. */
  forms(): Promise<FlFormRef[]>;
  /** Save a response to one of the app's forms. */
  submit(formId: string, answers: Record<string, any>): Promise<any>;
  /** List a form's records, newest first. */
  records(formId: string, opts?: { limit?: number }): Promise<FlRecord[]>;
  /** The signed-in user, or null. */
  currentUser(): Promise<FlUser | null>;
  /** Navigate the app to a form (or 'dashboard'). */
  navigate(target: string): void;
  toast: FlToast;
  /** Escape a value for safe innerHTML interpolation (use for any record/user data). */
  escapeHtml(v: unknown): string;
}
declare const FormLogic: FlAppSdk;
`;

let compilerConfigured = false;

export default function MonacoEditorImpl({ value, onChange, language = 'typescript', sdk = 'form', height }: CodeEditorProps) {
  const onMount: OnMount = useCallback((_editor, m) => {
    const ts = m.languages.typescript;
    if (!compilerConfigured) {
      ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ES2020,
        lib: ['es2020', 'dom'],
        allowNonTsExtensions: true,
        noEmit: true,
        strict: false,
      });
      // The screen is a top-level script, not a module — don't flag missing exports/top-level await etc.
      ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [1375, 1378] });
      compilerConfigured = true;
    }
    ts.typescriptDefaults.addExtraLib(sdk === 'app' ? APP_SDK_DTS : FORM_SDK_DTS, 'ts:formlogic-sdk.d.ts');
  }, [sdk]);

  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <Editor
      height={height ?? '100%'}
      language={language}
      theme={dark ? 'vs-dark' : 'light'}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        lineNumbersMinChars: 3,
        padding: { top: 10, bottom: 10 },
      }}
    />
  );
}
