// FormLogic Flows workspace - shared right-panel header.
//
// The Triggers, Run history, and Test run panels should read as one family: same padding,
// soft primary icon chip, compact title block, and a right-aligned action/count area.
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ReactNode } from 'react';

interface PanelHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  count?: number;
  actions?: ReactNode;
}

export function PanelHeader({ icon: Icon, title, subtitle, count, actions }: PanelHeaderProps) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-200/80 px-3 py-2 dark:border-slate-700/60">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-300">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
        {subtitle && <p className="truncate font-mono text-[11px] text-gray-400 dark:text-slate-500">{subtitle}</p>}
      </div>
      {typeof count === 'number' && (
        <span className={cn(
          'flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold',
          'border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/25 dark:bg-primary-500/10 dark:text-primary-200',
        )}>
          {count}
        </span>
      )}
      {actions && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
    </div>
  );
}
