import type { ReactNode } from 'react';
import { ChevronRightIcon } from './Icons';

/**
 * One Overview module card: icon tile, headline metric, secondary detail and
 * an optional progress bar. Clicking opens the matching workspace section.
 */
export function SectionCard({
  icon,
  tone,
  title,
  value,
  detail,
  progress,
  onOpen,
}: {
  icon: ReactNode;
  tone: 'blue' | 'violet' | 'green' | 'amber';
  title: string;
  value: string;
  detail: string;
  /** 0–100, omit to hide the bar. */
  progress?: number;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="desktop-module-card" onClick={onOpen}>
      <span className={`desktop-module-card__icon is-${tone}`}>{icon}</span>
      <span className="desktop-module-card__arrow" aria-hidden="true">
        <ChevronRightIcon size={15} />
      </span>
      <small>{title}</small>
      <strong>{value}</strong>
      <p>{detail}</p>
      {progress !== undefined && (
        <span className="desktop-progress">
          <i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </span>
      )}
    </button>
  );
}
