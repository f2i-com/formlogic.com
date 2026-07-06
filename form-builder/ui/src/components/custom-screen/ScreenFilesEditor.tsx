import { useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import {
  Braces,
  FileCode,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  FolderUp,
  Palette,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { CodeEditor } from '../ui/CodeEditor';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../../stores/toastStore';
import type { ScreenFile } from '../../lib/screenCompile';
import { NewFileModal, RenameFileModal } from './ScreenFileModals';
import { readUploadedScreenFiles } from './screenFileUpload';

function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'css') return 'css';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'json') return 'json';
  return 'plaintext';
}

/** Type-appropriate mini icon + accent for a file-list row (muted so it works in both themes). */
function fileIcon(path: string): { Icon: LucideIcon; className: string } {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return { Icon: FileCode2, className: 'text-orange-500 dark:text-orange-400' };
    case 'css':
      return { Icon: Palette, className: 'text-sky-500 dark:text-sky-400' };
    case 'ts':
    case 'tsx':
      return { Icon: FileCode, className: 'text-blue-500 dark:text-blue-400' };
    case 'js':
    case 'jsx':
      return { Icon: FileCode, className: 'text-yellow-500 dark:text-yellow-400' };
    case 'json':
      return { Icon: Braces, className: 'text-amber-500 dark:text-amber-400' };
    case 'svg':
      return { Icon: FileImage, className: 'text-purple-500 dark:text-purple-400' };
    default:
      return { Icon: FileText, className: 'text-gray-400 dark:text-slate-500' };
  }
}

// React's TS types don't know the (widely supported) folder-picker attributes.
const FOLDER_INPUT_PROPS = { webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

type EditorModal =
  | { kind: 'new' }
  | { kind: 'rename'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'overwrite'; incoming: ScreenFile[]; skipped: string[]; clashes: string[] };

const toolbarBtn =
  'p-1 rounded text-gray-400 dark:text-slate-500 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';

/**
 * A small multi-file editor: a file list (add / upload / rename / delete / select) + a Monaco editor
 * for the active file. Files are TS/TSX/CSS/HTML with relative imports between them (bundled by
 * esbuild-wasm elsewhere).
 */
export function ScreenFilesEditor({ files, onChange, sdk }: { files: ScreenFile[]; onChange: (files: ScreenFile[]) => void; sdk: 'form' | 'app' }) {
  const [active, setActive] = useState<string>(files[0]?.path || '');
  const [modal, setModal] = useState<EditorModal | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const activeFile = files.find((f) => f.path === active) || files[0];
  const paths = files.map((f) => f.path);

  const setContent = (path: string, content: string) => onChange(files.map((f) => (f.path === path ? { ...f, content } : f)));

  const createFile = (path: string) => {
    onChange([...files, { path, content: '' }]);
    setActive(path);
  };
  const renameFile = (old: string, next: string) => {
    onChange(files.map((f) => (f.path === old ? { ...f, path: next } : f)));
    if (active === old) setActive(next);
  };
  const deleteFile = (path: string) => {
    const next = files.filter((f) => f.path !== path);
    onChange(next);
    if (active === path) setActive(next[0]?.path || '');
  };

  /** Merge uploaded files in (replacing clashing paths), select the first new file, toast a summary. */
  const applyUpload = (incoming: ScreenFile[], skipped: string[]) => {
    const existing = new Set(paths);
    const incomingByPath = new Map(incoming.map((f) => [f.path, f]));
    const added = incoming.filter((f) => !existing.has(f.path));
    onChange([...files.map((f) => incomingByPath.get(f.path) ?? f), ...added]);
    const select = added[0]?.path ?? incoming[0]?.path;
    if (select) setActive(select);

    const replaced = incoming.length - added.length;
    const summary = [
      added.length ? `${added.length} added` : null,
      replaced ? `${replaced} replaced` : null,
      skipped.length ? `${skipped.length} skipped` : null,
    ].filter(Boolean).join(' · ');
    if (skipped.length) {
      toast.warning('Files uploaded', `${summary}. Skipped: ${skipped[0]}${skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ''}`);
    } else {
      toast.success('Files uploaded', summary);
    }
  };

  const handleUploadSelection = async (selection: File[]) => {
    if (selection.length === 0) return;
    const { files: incoming, skipped } = await readUploadedScreenFiles(selection);
    if (incoming.length === 0) {
      toast.warning('No files uploaded', skipped.length ? `${skipped.length} skipped — e.g. ${skipped[0]}` : 'Nothing readable in that selection.');
      return;
    }
    const clashes = incoming.filter((f) => paths.includes(f.path)).map((f) => f.path);
    if (clashes.length > 0) {
      setModal({ kind: 'overwrite', incoming, skipped, clashes });
    } else {
      applyUpload(incoming, skipped);
    }
  };

  // Snapshot the FileList before clearing the input (clearing empties the live FileList).
  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selection = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    void handleUploadSelection(selection);
  };

  const overwriteMessage = (clashes: string[]) => {
    const shown = clashes.slice(0, 8).join('\n');
    const more = clashes.length > 8 ? `\n…and ${clashes.length - 8} more` : '';
    return `These files already exist and will be overwritten:\n\n${shown}${more}`;
  };

  return (
    <div className="flex-1 min-h-0 flex border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden m-3 mt-2">
      <div className="w-48 shrink-0 border-r border-gray-200 dark:border-slate-800 flex flex-col bg-gray-50 dark:bg-slate-900/40">
        <div className="flex items-center gap-0.5 px-2 h-8 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
          <span className="flex-1 truncate">Files</span>
          <button type="button" onClick={() => fileInputRef.current?.click()} title="Upload files" aria-label="Upload files" className={toolbarBtn}>
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => folderInputRef.current?.click()} title="Upload a folder" aria-label="Upload a folder" className={toolbarBtn}>
            <FolderUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setModal({ kind: 'new' })} title="New file" aria-label="New file" className={toolbarBtn}>
            <FilePlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onInputChange} />
        <input ref={folderInputRef} type="file" multiple {...FOLDER_INPUT_PROPS} className="hidden" onChange={onInputChange} />
        <div className="flex-1 overflow-y-auto">
          {files.map((f) => {
            const { Icon, className: iconClass } = fileIcon(f.path);
            const isActive = active === f.path;
            return (
              <div
                key={f.path}
                className={`group flex items-center pr-1 text-xs ${isActive ? 'bg-gray-200/70 dark:bg-slate-800 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800/50'}`}
              >
                <button
                  type="button"
                  onClick={() => setActive(f.path)}
                  title={f.path}
                  className="flex-1 min-w-0 flex items-center gap-1.5 pl-2 py-1.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                  aria-current={isActive ? 'true' : undefined}
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                  <span className="flex-1 truncate font-mono">{f.path}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setModal({ kind: 'rename', path: f.path })}
                  title={`Rename ${f.path}`}
                  aria-label={`Rename ${f.path}`}
                  className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                {files.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setModal({ kind: 'delete', path: f.path })}
                    title={`Delete ${f.path}`}
                    aria-label={`Delete ${f.path}`}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:text-red-500 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {activeFile ? (
          <CodeEditor key={activeFile.path} value={activeFile.content} onChange={(v) => setContent(activeFile.path, v)} language={langOf(activeFile.path)} sdk={sdk} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400 dark:text-slate-500">No file selected</div>
        )}
      </div>

      <NewFileModal
        isOpen={modal?.kind === 'new'}
        onClose={() => setModal(null)}
        existingPaths={paths}
        onCreate={createFile}
      />
      {modal?.kind === 'rename' && (
        <RenameFileModal
          isOpen
          onClose={() => setModal(null)}
          existingPaths={paths}
          currentPath={modal.path}
          onRename={(next) => renameFile(modal.path, next)}
        />
      )}
      {modal?.kind === 'delete' && (
        <ConfirmDialog
          isOpen
          onClose={() => setModal(null)}
          onConfirm={() => { deleteFile(modal.path); setModal(null); }}
          title="Delete file"
          message={`Delete ${modal.path}? This can’t be undone.`}
          confirmLabel="Delete"
          variant="danger"
        />
      )}
      {modal?.kind === 'overwrite' && (
        <ConfirmDialog
          isOpen
          onClose={() => setModal(null)}
          onConfirm={() => { applyUpload(modal.incoming, modal.skipped); setModal(null); }}
          title="Replace existing files?"
          message={overwriteMessage(modal.clashes)}
          confirmLabel={`Replace ${modal.clashes.length} file${modal.clashes.length === 1 ? '' : 's'}`}
          variant="danger"
        />
      )}
    </div>
  );
}
