import { Boxes, FileText } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { appFormPreviewUrl, openPreviewTab, standalonePreviewUrl } from './previewRouting';
import type { FormAppContext } from '../../types/app';

export interface PreviewContextChooserProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  /** PUBLISHED app contexts only — useFormPreview filters before opening the chooser. */
  contexts: FormAppContext[];
}

/**
 * The "which app do you want to preview this form in?" modal, shown (via useFormPreview)
 * only when a form is published in 2+ apps — companion apps share forms by form_id, so a
 * single formId→app assumption can't disambiguate. Esc/backdrop close via Modal; every
 * choice opens a NEW TAB (noopener). Don't render this directly — use useFormPreview.
 */
export function PreviewContextChooser({ isOpen, onClose, formId, contexts }: PreviewContextChooserProps) {
  const choose = (url: string) => {
    openPreviewTab(url);
    onClose();
  };

  const optionClass =
    'w-full flex items-center gap-3 rounded-xl border border-gray-200 dark:border-slate-700 px-4 py-3 text-left ' +
    'hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-gray-300 dark:hover:border-slate-600 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition-colors cursor-pointer';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Preview form"
      description="This form is part of more than one published app. Choose where to preview it."
      size="sm"
    >
      <div className="p-4 sm:p-6 space-y-2">
        {contexts.map((c) => (
          <button key={c.appId} type="button" onClick={() => choose(appFormPreviewUrl(c.slug, formId))} className={optionClass}>
            <span className="p-2 bg-primary-50 dark:bg-primary-500/10 rounded-lg flex-shrink-0">
              <Boxes className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">
                Preview in {c.appName}
              </span>
              <span className="block text-xs text-gray-500 dark:text-slate-400 truncate">
                Shown as “{c.formDisplayName}” in this app
              </span>
            </span>
          </button>
        ))}
        <button type="button" onClick={() => choose(standalonePreviewUrl(formId))} className={optionClass}>
          <span className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg flex-shrink-0">
            <FileText className="h-4 w-4 text-gray-500 dark:text-slate-400" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">Standalone form</span>
            <span className="block text-xs text-gray-500 dark:text-slate-400 truncate">
              The fillable form on its own, outside any app
            </span>
          </span>
        </button>
      </div>
    </Modal>
  );
}
