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

  return <Icon className={className} style={style} />;
});
