import { useState } from 'react';
import { FilePlus, Trash2, Pencil } from 'lucide-react';
import { CodeEditor } from '../ui/CodeEditor';
import type { ScreenFile } from '../../lib/screenCompile';

function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'css') return 'css';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'json') return 'json';
  return 'plaintext';
}

/**
 * A small multi-file editor: a file list (add / rename / delete / select) + a Monaco editor for the active
 * file. Files are TS/TSX/CSS/HTML with relative imports between them (bundled by esbuild-wasm elsewhere).
 */
export function ScreenFilesEditor({ files, onChange, sdk }: { files: ScreenFile[]; onChange: (files: ScreenFile[]) => void; sdk: 'form' | 'app' }) {
  const [active, setActive] = useState<string>(files[0]?.path || '');
  const activeFile = files.find((f) => f.path === active) || files[0];

  const setContent = (path: string, content: string) => onChange(files.map((f) => (f.path === path ? { ...f, content } : f)));

  const addFile = () => {
    const path = window.prompt('New file path (e.g. components/Board.ts, styles.css):')?.trim();
    if (!path) return;
    if (files.some((f) => f.path === path)) { setActive(path); return; }
    onChange([...files, { path, content: '' }]);
    setActive(path);
  };
  const renameFile = (old: string) => {
    const path = window.prompt('Rename file to:', old)?.trim();
    if (!path || path === old || files.some((f) => f.path === path)) return;
    onChange(files.map((f) => (f.path === old ? { ...f, path } : f)));
    if (active === old) setActive(path);
  };
  const deleteFile = (path: string) => {
    if (files.length <= 1 || !window.confirm(`Delete ${path}?`)) return;
    const next = files.filter((f) => f.path !== path);
    onChange(next);
    if (active === path) setActive(next[0]?.path || '');
  };

  return (
    <div className="flex-1 min-h-0 flex border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden m-3 mt-2">
      <div className="w-44 shrink-0 border-r border-gray-200 dark:border-slate-800 flex flex-col bg-gray-50 dark:bg-slate-900/40">
        <div className="flex items-center justify-between px-2 h-8 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
          <span>Files</span>
          <button type="button" onClick={addFile} title="New file" className="p-1 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"><FilePlus className="h-3.5 w-3.5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {files.map((f) => (
            <div
              key={f.path}
              onClick={() => setActive(f.path)}
              className={`group flex items-center gap-1 px-2 py-1.5 text-xs cursor-pointer ${active === f.path ? 'bg-gray-200/70 dark:bg-slate-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800/50'}`}
            >
              <span className="flex-1 truncate font-mono">{f.path}</span>
              <button type="button" onClick={(e) => { e.stopPropagation(); renameFile(f.path); }} title="Rename" className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"><Pencil className="h-3 w-3" /></button>
              {files.length > 1 && <button type="button" onClick={(e) => { e.stopPropagation(); deleteFile(f.path); }} title="Delete" className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-500 cursor-pointer"><Trash2 className="h-3 w-3" /></button>}
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {activeFile ? (
          <CodeEditor key={activeFile.path} value={activeFile.content} onChange={(v) => setContent(activeFile.path, v)} language={langOf(activeFile.path)} sdk={sdk} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400 dark:text-slate-500">No file selected</div>
        )}
      </div>
    </div>
  );
}
