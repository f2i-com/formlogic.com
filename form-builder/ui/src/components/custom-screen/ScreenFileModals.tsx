// Form modals for the multi-file custom-screen editor: create a new file and rename an existing
// one. Both validate the path live (safe characters, known text extension, no duplicates) and
// follow the app's Modal/Input/Button idioms — Enter submits, Esc cancels (handled by Modal).

import { useMemo, useState, type FormEvent } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { TEXT_FILE_EXTENSIONS, hasAllowedExtension } from './screenFileUpload';

const PATH_CHARS_RE = /^[A-Za-z0-9._/-]+$/;

const EXTENSION_HINT = TEXT_FILE_EXTENSIONS.map((e) => `.${e}`).join(' ');

/**
 * Validate a screen-file path. Returns an error message, or null when the path is valid.
 * `currentPath` (rename) is excluded from the duplicate check.
 * (Kept un-exported: react-refresh/only-export-components forbids non-component exports here.)
 */
function validateScreenFilePath(path: string, existingPaths: string[], currentPath?: string): string | null {
  if (!path) return 'Enter a file path.';
  if (!PATH_CHARS_RE.test(path)) return 'Only letters, digits and . _ / - are allowed.';
  if (path.startsWith('/')) return 'Use a relative path — no leading /.';
  const segments = path.split('/');
  if (segments.some((s) => s === '')) return 'Path has an empty segment (check for // or a trailing /).';
  if (segments.some((s) => /^\.+$/.test(s))) return 'Path segments can’t be only dots (no "..").';
  if (!hasAllowedExtension(path)) return `End with a text extension: ${EXTENSION_HINT}`;
  if (path !== currentPath && existingPaths.includes(path)) return 'A file with this path already exists.';
  return null;
}

interface PathFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingPaths: string[];
}

export function NewFileModal({
  isOpen,
  onClose,
  existingPaths,
  onCreate,
}: PathFormModalProps & { onCreate: (path: string) => void }) {
  // The shared Modal renders children ONLY while open, so the inner form component below mounts
  // fresh on every open — its useState initializer IS the reset (no reset-on-open effect needed).
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New file" size="sm">
      <NewFileForm onClose={onClose} existingPaths={existingPaths} onCreate={onCreate} />
    </Modal>
  );
}

function NewFileForm({
  onClose,
  existingPaths,
  onCreate,
}: Omit<PathFormModalProps, 'isOpen'> & { onCreate: (path: string) => void }) {
  const [value, setValue] = useState('');

  const path = value.trim();
  const error = useMemo(() => validateScreenFilePath(path, existingPaths), [path, existingPaths]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (error) return;
    onCreate(path);
    onClose();
  };

  return (
    <form onSubmit={submit} className="p-4 sm:p-6 space-y-4">
      <Input
        label="File path"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="components/Board.ts"
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-sm"
        error={path ? error ?? undefined : undefined}
        hint={`e.g. components/Board.ts or styles.css — ends with ${EXTENSION_HINT}`}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!!error}>Create file</Button>
      </div>
    </form>
  );
}

export function RenameFileModal({
  isOpen,
  onClose,
  existingPaths,
  currentPath,
  onRename,
}: PathFormModalProps & { currentPath: string; onRename: (nextPath: string) => void }) {
  // Same remount-per-open pattern as NewFileModal — the initializer seeds from currentPath.
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Rename file" description={currentPath} size="sm">
      <RenameFileForm onClose={onClose} existingPaths={existingPaths} currentPath={currentPath} onRename={onRename} />
    </Modal>
  );
}

function RenameFileForm({
  onClose,
  existingPaths,
  currentPath,
  onRename,
}: Omit<PathFormModalProps, 'isOpen'> & { currentPath: string; onRename: (nextPath: string) => void }) {
  const [value, setValue] = useState(currentPath);

  const path = value.trim();
  const unchanged = path === currentPath;
  const error = useMemo(
    () => validateScreenFilePath(path, existingPaths, currentPath),
    [path, existingPaths, currentPath]
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (error || unchanged) return;
    onRename(path);
    onClose();
  };

  return (
    <form onSubmit={submit} className="p-4 sm:p-6 space-y-4">
      <Input
        label="New path"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="components/Board.ts"
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-sm"
        error={path && !unchanged ? error ?? undefined : undefined}
        hint={`Folders are part of the path — ends with ${EXTENSION_HINT}`}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!!error || unchanged}>Rename</Button>
      </div>
    </form>
  );
}
