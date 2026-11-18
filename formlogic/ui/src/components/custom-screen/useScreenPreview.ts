import { useState } from 'react';
import { useMatches } from '../design/useMatches';

/** A narrow editor uses one pane at a time. The desktop opens with code and preview side by side. */
export function useScreenPreview() {
  const compact = useMatches('(width < 64rem)');
  const [preference, setPreference] = useState<boolean | null>(null);
  const previewOpen = preference ?? !compact;
  return {
    previewOpen,
    showEditor: !compact || !previewOpen,
    previewLabel: previewOpen ? (compact ? 'Edit code' : 'Hide preview') : 'Preview',
    togglePreview: () => setPreference(!previewOpen),
  };
}
