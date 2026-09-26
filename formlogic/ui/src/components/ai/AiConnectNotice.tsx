// Shown where something needs the person's AI and it cannot answer yet (AI Studio, "describe it
// and AI builds it"): why, and the ways on — FormLogic Site AI in one click where the operator
// offers it, the person's own AI in Settings → AI, and a check again once they have connected one.
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { useSiteAiChoice } from '../../hooks/useSiteAiChoice';

export function AiConnectNotice({ lead, reason, onConnected, className }: {
  /** What needs the AI, as a sentence without its full stop ("AI Studio needs an AI connection"). */
  lead: string;
  reason?: string | null;
  /** Check readiness again (fresh); called after Site AI is chosen, and by "Check again". */
  onConnected: () => Promise<unknown> | void;
  className?: string;
}) {
  const siteAi = useSiteAiChoice(onConnected);
  return <div className={className ?? 'mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400'}>
    <p>{lead}.{reason ? ` ${reason}` : ''}</p>
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      {siteAi.offered && <Button size="sm" variant="secondary" isLoading={siteAi.choosing} leftIcon={<Sparkles className="h-4 w-4" />} onClick={() => void siteAi.choose()}>Use FormLogic Site AI</Button>}
      <Link className="inline-flex min-h-9 items-center font-medium text-indigo-600 dark:text-indigo-300" to="/settings#ai">{siteAi.offered ? 'Or connect your own' : 'Connect one'}</Link>
      <button type="button" className="inline-flex min-h-9 items-center font-medium text-indigo-600 dark:text-indigo-300" onClick={() => void onConnected()}>Check again</button>
    </div>
  </div>;
}
