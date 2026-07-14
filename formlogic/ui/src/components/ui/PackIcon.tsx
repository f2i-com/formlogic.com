import { Package } from 'lucide-react';
import { getLucideIcon } from '../../lib/iconUtils';

/**
 * Pack catalog icon. First-party packs ship flat lucide icon NAMES ('Scissors', 'Wrench', …);
 * third-party publishers may still supply an emoji string — render it as text in that case.
 * No icon at all falls back to the generic Package glyph.
 */
export function PackIcon({
  icon,
  className,
  emojiClassName,
}: {
  icon?: string | null;
  className?: string;
  emojiClassName?: string;
}) {
  const Icon = icon ? getLucideIcon(icon) : null;
  if (Icon) {
    // Stable module-level reference from ICON_MAP (same pattern as DynamicIcon).
    // eslint-disable-next-line react-hooks/static-components
    return <Icon className={className} aria-hidden="true" />;
  }
  if (icon) {
    return <span className={emojiClassName} aria-hidden="true">{icon}</span>;
  }
  return <Package className={className} aria-hidden="true" />;
}
