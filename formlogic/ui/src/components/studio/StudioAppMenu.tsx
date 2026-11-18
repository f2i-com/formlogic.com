import { ChevronRight, Play, Rocket, Search, Sparkles } from 'lucide-react';
import { BottomSheet } from '../ui/BottomSheet';
import { cn } from '../../lib/utils';

/** On a narrow header the actions have a sheet; navigation stays in the app's section picker. */
export function StudioAppMenu({
  aiAvailable,
  aiPrompt,
  onClose,
  onOpenApp,
  onOpenSearch,
  onOpenPublish,
  onAskAi,
}: {
  aiAvailable: boolean;
  aiPrompt: string;
  onClose: () => void;
  onOpenApp: () => void;
  onOpenSearch: () => void;
  onOpenPublish: () => void;
  onAskAi: () => void;
}) {
  const choose = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <BottomSheet title="App actions" open onClose={onClose}>
      <div className="min-h-0 overflow-y-auto py-2">
        <Row icon={Play} label="Open app" detail="Preview the app as a member" onClick={() => choose(onOpenApp)} />
        <Row icon={Rocket} label="Review & publish" detail="Review changes and release the app" onClick={() => choose(onOpenPublish)} />
        <Row icon={Search} label="Search App Studio" detail="Find a form, automation, role or section" onClick={() => choose(onOpenSearch)} />
        {aiAvailable && <Row icon={Sparkles} label="Ask AI about this app" detail={aiPrompt} accent onClick={() => choose(onAskAi)} />}
      </div>
    </BottomSheet>
  );
}

function Row({
  icon: Icon,
  label,
  detail,
  accent,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  detail: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The accessible name matches the desktop control exactly, so voice control
      // ("tap Open app") behaves the same at every width.
      aria-label={label}
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-white/[0.035] dark:active:bg-white/[0.06]"
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          accent
            ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300'
            : 'bg-gray-100 text-gray-500 dark:bg-white/[0.05] dark:text-slate-400'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-gray-900 dark:text-white">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-slate-400">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
    </button>
  );
}
