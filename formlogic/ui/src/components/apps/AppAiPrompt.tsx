import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { api } from '../../lib/api';

const remembered = (appId: string) => `formlogic.appAiPrompt.dismissed.${appId}`;

/**
 * One line for the owner of an app that can use AI and has it off: "This app can use AI. Set it up",
 * which opens its AI settings. Dismissing it is remembered for that app in this browser. Rendered by
 * the app's workspace for its owner only: members and visitors never open that page.
 */
export function AppAiPrompt({ appId, onSetUp }: { appId: string; onSetUp: () => void }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem(remembered(appId)) === '1'; } catch { return false; }
  });
  const [off, setOff] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    void api.getAppAi(appId).then((result) => {
      if (!cancelled && result.data) setOff(result.data.declared !== null && result.data.settings.mode === 'off');
    });
    return () => { cancelled = true; };
  }, [appId, dismissed]);

  if (dismissed || !off) return null;
  const dismiss = () => {
    try { window.localStorage.setItem(remembered(appId), '1'); } catch { /* not remembered: it shows again next time */ }
    setDismissed(true);
  };
  return (
    <div role="note" data-testid="app-ai-prompt" className="mt-4 flex items-center gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-2 text-sm text-primary-950 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-100">
      <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        This app can use AI.{' '}
        <button type="button" className="font-semibold underline underline-offset-2" onClick={onSetUp}>Set it up</button>
      </p>
      <button type="button" aria-label="Dismiss" title="Dismiss" onClick={dismiss} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
