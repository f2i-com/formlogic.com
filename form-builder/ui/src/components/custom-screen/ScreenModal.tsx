import { Modal } from '../ui/Modal';
import { CustomScreenRuntime, type CustomScreen } from './CustomScreenRuntime';

/**
 * Shows a form's custom screen (its "dashboard") as a flexible popup. The Modal caps to the visible
 * viewport (max-h-[90dvh]) and the screen area is a fixed fraction of the viewport (h-[72dvh]) so the
 * sandboxed iframe always has a definite height: on tall windows the popup is large; on short windows it
 * shrinks and the dashboard scrolls INSIDE that smaller area. Flexible for any window height/size.
 */
export function ScreenModal({
  isOpen,
  onClose,
  screen,
  formId,
  formTitle,
  fields,
}: {
  isOpen: boolean;
  onClose: () => void;
  screen: CustomScreen;
  formId: string;
  formTitle: string;
  fields: Array<{ id: string; label: string; type: string }>;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={formTitle || 'Dashboard'} size="full">
      <div className="h-[72dvh] max-h-full">
        <CustomScreenRuntime
          screen={screen}
          formId={formId}
          formTitle={formTitle}
          fields={fields}
          className="w-full h-full border-0"
        />
      </div>
    </Modal>
  );
}
