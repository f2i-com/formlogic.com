import { useId } from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  /** When false (e.g. a collapsed sidebar), render just the brand mark. */
  showText?: boolean;
  className?: string;
}

const textSizes: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'text-base',
  md: 'text-lg',
  lg: 'text-xl',
};

const markSizes: Record<NonNullable<LogoProps['size']>, number> = {
  sm: 22,
  md: 26,
  lg: 32,
};

/**
 * The FormLogic brand mark (2026-07 identity): three white bars on the purple
 * gradient tile — the same mark as the landing page, favicon, PWA and the
 * desktop app icon. Inline SVG so it renders crisply at any size with no
 * asset request.
 */
export function LogoMark({ size = 26, className = '' }: { size?: number; className?: string }) {
  // Unique per instance: duplicate SVG ids across multiple logos break
  // gradient resolution (Chromium resolves the FIRST id in the document —
  // if that copy sits in a display:none responsive variant, every logo
  // loses its fill).
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#896eff" />
          <stop offset="1" stopColor="#6345e3" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="150" fill={`url(#${gradientId})`} />
      <rect x="120" y="256" width="68" height="136" rx="34" fill="#ffffff" opacity="0.76" />
      <rect x="222" y="137" width="68" height="255" rx="34" fill="#ffffff" />
      <rect x="324" y="205" width="68" height="187" rx="34" fill="#ffffff" opacity="0.86" />
    </svg>
  );
}

/** Brand lockup: the mark plus the FormLogic wordmark. */
export function Logo({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={markSizes[size]} />
      {showText && (
        <span
          className={`font-bold text-gray-900 dark:text-white tracking-tight ${textSizes[size]}`}
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
        >
          Form<span className="text-primary-600 dark:text-primary-400">Logic</span>
        </span>
      )}
    </div>
  );
}

// White variant for dark / colored brand panels.
export function LogoWhite({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={markSizes[size]} />
      {showText && (
        <span
          className={`font-bold text-white tracking-tight ${textSizes[size]}`}
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
        >
          Form<span className="text-primary-200">Logic</span>
        </span>
      )}
    </div>
  );
}
