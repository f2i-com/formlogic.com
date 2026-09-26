import { useState } from 'react';
import { usePublicConfig } from './usePublicConfig';
import { chooseSiteAi } from '../lib/siteAi';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';

/**
 * Choosing FormLogic Site AI in one click where something needs AI. `offered` only when the
 * operator offers Site AI (the Settings card's rule) and the account can change its settings (not
 * the shared demo). `choose` switches, says so, and calls `onChosen` to check readiness again.
 */
export function useSiteAiChoice(onChosen?: () => Promise<unknown> | void) {
  const { plans } = usePublicConfig();
  const isDemo = useAuthStore(s => !!s.user?.isDemo);
  const [choosing, setChoosing] = useState(false);
  const choose = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      const result = await chooseSiteAi();
      if (!result.ok) { toast.error('Could not switch to Site AI', result.error); return; }
      toast.success('Site AI is your default AI', 'You can change it any time in Settings → AI.');
      await onChosen?.();
    } finally { setChoosing(false); }
  };
  return { offered: plans.siteAiEnabled && !isDemo, choosing, choose };
}
