import { useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cn } from '../../lib/utils';
import { DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_PANEL, DIALOG_TITLE, GROUP_TITLE } from './builderDialog';

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
      { keys: `${cmdKey}+S`, description: 'Save the form' },
      { keys: `${cmdKey}+P`, description: 'Preview the form' },
      { keys: `${cmdKey}+Shift+?`, description: 'Show these shortcuts' },
      { keys: 'Esc', description: 'Close a dialog, or deselect the field' },
    ],
  },
  {
    title: 'Fields',
    shortcuts: [
      { keys: `${cmdKey}+D`, description: 'Duplicate the selected field' },
      { keys: `${cmdKey}+Z`, description: 'Undo' },
      { keys: `${cmdKey}+Shift+Z`, description: 'Redo' },
      { keys: 'Delete / Backspace', description: 'Delete the selected field' },
      { keys: '↑ / ↓', description: 'Go to the field above or below' },
      { keys: `${cmdKey}+↑`, description: 'Move the field up' },
      { keys: `${cmdKey}+↓`, description: 'Move the field down' },
    ],
  },
  {
    title: 'Add a field',
    shortcuts: [
      { keys: 'T', description: 'Short text' },
      { keys: 'E', description: 'Email' },
      { keys: 'N', description: 'Number' },
      { keys: 'R', description: 'Rating' },
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
    <div className={DIALOG_OVERLAY} onKeyDown={handleKeyDown}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="keyboard-shortcuts-title" className={cn(DIALOG_PANEL, 'max-w-3xl')}>
        {/* Header */}
        <div className={DIALOG_HEADER}>
          <div className="min-w-0 flex-1 pr-2">
            <h2 id="keyboard-shortcuts-title" className={DIALOG_TITLE}>Keyboard shortcuts</h2>
            <p className={DIALOG_DESCRIPTION}>For the form builder. Single letters and arrows work while no text box has the cursor.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={DIALOG_CLOSE}
            aria-label="Close"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content: the groups flow into two columns where there is room, so the whole list is
            in sight without scrolling. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:columns-2 sm:gap-8 sm:p-6">
          {shortcutSections.map((section) => (
            <div key={section.title} className="mb-5 break-inside-avoid last:mb-0">
              <h3 className={cn(GROUP_TITLE, 'mb-1.5')}>
                {section.title}
              </h3>
              <dl className="divide-y divide-gray-100 dark:divide-slate-800">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex min-h-9 items-center justify-between gap-3 py-1"
                  >
                    <dt className="min-w-0 text-sm text-gray-700 dark:text-slate-300">{shortcut.description}</dt>
                    <dd className="flex flex-none items-center gap-1">
                      {shortcut.keys.split('+').map((key, index) => (
                        <span key={index}>
                          {index > 0 && <span className="text-gray-400 dark:text-slate-500 mx-0.5">+</span>}
                          <kbd className="px-1.5 py-0.5 font-mono text-xs font-semibold text-gray-600 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md">
                            {key.trim()}
                          </kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className={cn(DIALOG_FOOTER, 'flex justify-end')}>
          <Button variant="outline" onClick={onClose} className="max-sm:min-h-11">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
