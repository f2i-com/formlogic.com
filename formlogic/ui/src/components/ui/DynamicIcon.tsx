import React from 'react';
import { FileText } from 'lucide-react';
import { getLucideIcon } from '../../lib/iconUtils';

interface DynamicIconProps {
  name: string | undefined | null;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
}

export const DynamicIcon = React.memo(function DynamicIcon({
  name,
  className,
  style,
  fallback,
}: DynamicIconProps) {
  if (!name) {
    return <>{fallback ?? <FileText className={className} style={style} />}</>;
  }

  const Icon = getLucideIcon(name);
  if (!Icon) {
    return <>{fallback ?? <FileText className={className} style={style} />}</>;
  }

  // `Icon` is a stable module-level reference from ICON_MAP, not a component constructed during
  // render — so it does not remount/reset on each render. The lint can't see through the lookup.
  // eslint-disable-next-line react-hooks/static-components
  return <Icon className={className} style={style} />;
});
