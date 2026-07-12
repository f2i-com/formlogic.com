import { Database } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface DeleteFieldDialogProps {
  isOpen: boolean;
  onClose: () => void;
  fieldLabel: string;
  /** Responses that hold a value in this field. */
  usageCount: number;
  /** Convert the field to a hidden field: gone from the form, data kept. */
  onKeepData: () => void;
  /** Delete the field AND purge its data from every response. */
  onDeleteData: () => void;
  isDeleting?: boolean;
}

/**
 * Shown instead of the plain delete confirmation when the doomed field has
 * response data: the author chooses between keeping the data (the field turns
 * into a hidden field — off the form, still in records and exports) and
 * removing the field together with every stored value.
 */
export function DeleteFieldDialog({ isOpen, onClose, fieldLabel, usageCount, onKeepData, onDeleteData, isDeleting = false }: DeleteFieldDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false} ariaLabel="This field has data">
      <div className="p-6">
        <div className="flex gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center">
            <Database className="h-5 w-5 text-amber-500 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white tracking-tight">This field has data</h3>
            <p className="mt-1.5 text-sm text-gray-500 dark:text-slate-400">
              {usageCount === 1 ? '1 record has' : `${usageCount} records have`} a value in{' '}
              <span className="font-medium text-gray-700 dark:text-slate-300">“{fieldLabel}”</span>. You can keep that data — the
              field becomes a hidden field (off the form, still in your records and exports) — or delete the field together with
              its data. Deleting the data can't be undone.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 mt-6">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={onKeepData} disabled={isDeleting}>
            Keep data (hide field)
          </Button>
          <Button variant="danger" size="sm" onClick={onDeleteData} isLoading={isDeleting}>
            Delete field & data
          </Button>
        </div>
      </div>
    </Modal>
  );
}
