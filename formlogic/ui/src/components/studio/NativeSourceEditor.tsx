import type { ReactNode } from 'react';
import { CodeEditor } from '../ui/CodeEditor';

export function NativeSourceEditor({ appId, file, value, onChange, label, readOnly = false, height = 'clamp(320px, 55dvh, 560px)', note, actions }: {
  appId: string; file: string; value: string; onChange(value: string): void; label: string; readOnly?: boolean;
  /** The editing area's height (CSS); the source pane gives it the rest of its dialog. */
  height?: string;
  /** The line under the editor, in place of the one about drafts. */
  note?: string;
  /** Controls for this file, at the end of its header. */
  actions?: ReactNode;
}) {
  const language = /\.(ui|html)$/.test(file) ? 'softn' : /\.(logic|js)$/.test(file) ? 'javascript' : file.endsWith('.css') ? 'css' : file.endsWith('.py') ? 'python' : file.endsWith('.sql') ? 'sql' : file.endsWith('.json') ? 'json' : 'plaintext';
  const languageName = { softn: 'UI · Logic · CSS', javascript: 'Logic', css: 'CSS', python: 'Python', sql: 'SQL', json: 'JSON', plaintext: 'Text' }[language];
  return <section aria-label={`${label} editor`} className="min-w-0 overflow-hidden rounded-xl border border-slate-300 dark:border-slate-700">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900">
      <span className="min-w-0 break-all font-mono text-slate-700 dark:text-slate-200">{file}</span>
      <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><span>{languageName}{readOnly ? ' · Read-only' : ''}</span>{actions}</span>
    </div>
    <CodeEditor key={file} path={`native/${encodeURIComponent(appId)}/${file}`} sdk="none" language={language} value={value} onChange={onChange} readOnly={readOnly} ariaLabel={label} wordWrap="on" height={height} />
    <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">{note ?? (file.endsWith('.sql') ? 'Installed migrations stay unchanged. Add a new migration to update the database.' : 'Changes stay in your draft until you publish.')} <span className="hidden sm:inline">Ctrl/Cmd+F to search.</span></p>
  </section>;
}
