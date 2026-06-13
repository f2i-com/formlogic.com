interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  /** When false (e.g. a collapsed sidebar), render the compact "FL" wordmark. */
  showText?: boolean;
  className?: string;
}

const textSizes: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'text-base',
  md: 'text-lg',
  lg: 'text-xl',
};

// Minimalist text wordmark — no icon mark.
export function Logo({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center ${className}`}>
      <span
        className={`font-bold text-gray-900 dark:text-white tracking-tight ${textSizes[size]}`}
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        {showText ? (
          <>Form<span className="text-primary-600 dark:text-primary-400">Logic</span></>
        ) : (
          <span className="text-primary-600 dark:text-primary-400">FL</span>
        )}
      </span>
    </div>
  );
}

// White variant for dark / colored brand panels.
export function LogoWhite({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center ${className}`}>
      <span
        className={`font-bold text-white tracking-tight ${textSizes[size]}`}
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        {showText ? (
          <>Form<span className="text-primary-200">Logic</span></>
        ) : (
          <span className="text-primary-200">FL</span>
        )}
      </span>
    </div>
  );
}
