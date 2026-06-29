import { useRef } from 'react';
import { X, Keyboard } from 'lucide-react';
import { Button } from '../ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface ShortcutItem {
  keys: string;
  description: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutItem[];
}

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const cmdKey = isMac ? '⌘' : 'Ctrl';

const shortcutSections: ShortcutSection[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: `${cmdKey}+S`, description: 'Save form' },
      { keys: `${cmdKey}+P`, description: 'Preview form' },
      { keys: `${cmdKey}+Shift+?`, description: 'Show keyboard shortcuts' },
      { keys: 'Esc', description: 'Close modals / Deselect' },
    ],
  },
  {
    title: 'Field Operations',
    shortcuts: [
      { keys: `${cmdKey}+D`, description: 'Duplicate selected field' },
      { keys: `${cmdKey}+Z`, description: 'Undo' },
      { keys: `${cmdKey}+Shift+Z`, description: 'Redo' },
      { keys: 'Delete / Backspace', description: 'Delete selected field' },
      { keys: '↑ / ↓', description: 'Navigate between fields' },
      { keys: `${cmdKey}+↑`, description: 'Move field up' },
      { keys: `${cmdKey}+↓`, description: 'Move field down' },
    ],
  },
  {
    title: 'Quick Add Fields',
    shortcuts: [
      { keys: 'T', description: 'Add Text field' },
      { keys: 'E', description: 'Add Email field' },
      { keys: 'N', description: 'Add Number field' },
      { keys: 'R', description: 'Add Rating field' },
    ],
  },
];

export function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onKeyDown={handleKeyDown}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="keyboard-shortcuts-title" className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800 focus:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-slate-50 dark:from-slate-900 dark:to-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-primary-600 rounded-xl flex items-center justify-center shadow-sm">
              <Keyboard className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h2 id="keyboard-shortcuts-title" className="text-lg font-semibold text-gray-900 dark:text-white">Keyboard Shortcuts</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">Speed up your workflow</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center hover:bg-gray-200/70 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {shortcutSections.map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-medium text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-3">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <span className="text-sm text-gray-700 dark:text-slate-300">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.split('+').map((key, index) => (
                        <span key={index}>
                          {index > 0 && <span className="text-gray-400 dark:text-slate-500 mx-0.5">+</span>}
                          <kbd className="px-2 py-1 text-xs font-semibold text-gray-600 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded shadow-sm">
                            {key.trim()}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 flex justify-end">
          <Button onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
