import FormLogicCloudSection from './FormLogicCloudSection';
import PairingSection from './PairingSection';

/**
 * Connections workspace (redesign 2026-07): the FormLogic Cloud account link
 * and the trusted-browser pairing controls, promoted out of the bottom of
 * Settings so account/runtime state is discoverable. Both sections are the
 * existing, mature implementations — this panel only hosts them.
 */
export default function ConnectionsPanel() {
  return (
    <div className="panel">
      <FormLogicCloudSection />
      <PairingSection />
    </div>
  );
}
