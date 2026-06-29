import { Card, CardContent } from './Card';

// Shared metric card used on the Dashboard and Analytics so the same-role stat tiles
// look identical across the app: number-first, icon chip top-right, optional subtext.
export function StatCard({
  icon: Icon,
  iconBg,
  iconColor,
  value,
  label,
  subtext,
  className,
}: {
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
  subtext?: string;
  className?: string;
}) {
  return (
    <Card className={`hover:shadow-md hover:shadow-gray-900/[0.04] transition-all duration-300 hover:-translate-y-0.5 group ${className ?? ''}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white tracking-tight tabular-nums">{value}</p>
            <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mt-1">{label}</p>
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
