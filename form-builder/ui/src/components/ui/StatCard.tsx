import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent } from './Card';

// Shared metric card used on the Dashboard and Analytics so the same-role stat tiles
// look identical across the app: number-first, icon chip top-right, optional subtext,
// optional period-over-period trend pill.
export function StatCard({
  icon: Icon,
  iconBg,
  iconColor,
  value,
  label,
  subtext,
  trend,
  className,
}: {
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
  subtext?: string;
  /** Period-over-period delta rendered as a compact pill under the label.
   *  pct null = no prior period to compare against (shows a neutral "New"). */
  trend?: { pct: number | null; label?: string };
  className?: string;
}) {
  return (
    <Card className={`hover:shadow-md hover:shadow-gray-900/[0.04] transition-all duration-300 hover:-translate-y-0.5 group ${className ?? ''}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          {/* break-words: a long value (e.g. "+1200%") must wrap under the icon chip,
              never overflow into it — these cards get narrow on dense grids. */}
          <div className="min-w-0 flex-1">
            <p className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight tabular-nums leading-tight break-words">{value}</p>
            <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mt-1">{label}</p>
            {trend && (
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                    trend.pct === null
                      ? 'bg-gray-500/10 text-gray-500 dark:text-slate-400'
                      : trend.pct >= 0
                        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                        : 'bg-red-500/10 text-red-600 dark:text-red-400'
                  }`}
                >
                  {trend.pct !== null && (trend.pct >= 0
                    ? <TrendingUp className="h-3 w-3" aria-hidden="true" />
                    : <TrendingDown className="h-3 w-3" aria-hidden="true" />)}
                  {trend.pct === null ? 'New' : `${trend.pct >= 0 ? '+' : ''}${trend.pct}%`}
                </span>
                {trend.label && (
                  <span className="text-[11px] text-gray-400 dark:text-slate-500">{trend.label}</span>
                )}
              </p>
            )}
            {subtext && (
              <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{subtext}</p>
            )}
          </div>
          <div className={`p-2.5 rounded-xl flex-shrink-0 ${iconBg} group-hover:scale-105 transition-transform duration-300`}>
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
