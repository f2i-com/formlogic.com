import { Modal } from '../ui/Modal';
import { CustomScreenRuntime } from './CustomScreenRuntime';
import { FormWidgetDashboard } from './FormWidgetDashboard';
import type { CustomScreen } from '../../types/form';

/**
 * Shows a form's custom screen (its "dashboard") as a flexible popup. The Modal caps to the visible
 * viewport (max-h-[90dvh]) and the screen area is a fixed fraction of the viewport (h-[72dvh]) so the
 * content always has a definite height: on tall windows the popup is large; on short windows it shrinks
 * and the content scrolls INSIDE that smaller area.
 *
 * A custom screen is one of two kinds and needs a DIFFERENT renderer — rendering the wrong one shows a
 * blank popup: a `dashboard`-kind screen is a no-code widget grid (FormWidgetDashboard), while a
 * `code`/`sdk` screen is a sandboxed HTML/CSS/JS frontend (CustomScreenRuntime iframe).
 */
export function ScreenModal({
  isOpen,
  onClose,
  screen,
  formId,
  formTitle,
  fields,
  accent,
}: {
  isOpen: boolean;
  onClose: () => void;
  screen: CustomScreen;
  formId: string;
  formTitle: string;
  fields: Array<{ id: string; label: string; type: string }>;
  accent?: string;
}) {
  const isDashboard = screen.kind === 'dashboard' && !!screen.dashboard;
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={formTitle || 'Dashboard'} size="full">
      <div className="h-[72dvh] max-h-full overflow-y-auto">
        {isDashboard ? (
          <div className="p-4 md:p-6">
            <FormWidgetDashboard
              dashboard={screen.dashboard!}
              formId={formId}
              fields={fields}
              formTitle={formTitle}
              publicMode={false}
              accent={accent}
            />
          </div>
        ) : (
          <CustomScreenRuntime
            screen={screen}
            formId={formId}
            formTitle={formTitle}
            fields={fields}
            className="w-full h-full border-0"
          />
        )}
      </div>
    </Modal>
  );
}
