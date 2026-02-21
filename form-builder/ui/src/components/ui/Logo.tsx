interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  className?: string;
}

export function Logo({ size = 'md', showText = true, className = '' }: LogoProps) {
  const sizes = {
    sm: { icon: 24, text: 'text-base' },
    md: { icon: 32, text: 'text-lg' },
    lg: { icon: 40, text: 'text-xl' },
  };

  const { icon, text } = sizes[size];

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="flex-shrink-0"
      >
        {/* Background rounded square with gradient */}
        <rect width="40" height="40" rx="10" fill="url(#logoGradient)" />

        {/* Branching flow icon: form input -> logic branches -> outcomes */}
        <g transform="translate(8, 6)">
          {/* Branching curves (behind nodes) */}
          <path
            d="M12 9 C12 15, 5 17, 5 22"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
            opacity="0.5"
          />
          <path
            d="M12 9 C12 15, 19 17, 19 22"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
            opacity="0.5"
          />

          {/* Top rounded bar (form field / input) */}
          <rect x="3" y="0" width="18" height="9" rx="3" fill="white" fillOpacity="0.95" />
          <rect x="6" y="3.5" width="12" height="2" rx="1" fill="#6366f1" fillOpacity="0.35" />

          {/* Bottom-left node (outcome) */}
          <circle cx="5" cy="23" r="3.5" fill="white" fillOpacity="0.9" />

          {/* Bottom-right node (outcome) */}
          <circle cx="19" cy="23" r="3.5" fill="white" fillOpacity="0.9" />
        </g>

        <defs>
          <linearGradient id="logoGradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#818cf8" />
            <stop offset="1" stopColor="#6366f1" />
          </linearGradient>
        </defs>
      </svg>

      {showText && (
        <span className={`font-bold text-gray-900 dark:text-white tracking-tight ${text}`} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Form<span className="text-primary-600 dark:text-primary-400">Logic</span>
        </span>
      )}
    </div>
  );
}

// White version for dark backgrounds
export function LogoWhite({ size = 'md', showText = true, className = '' }: LogoProps) {
  const sizes = {
    sm: { icon: 24, text: 'text-base' },
    md: { icon: 32, text: 'text-lg' },
    lg: { icon: 40, text: 'text-xl' },
  };

  const { icon, text } = sizes[size];

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="flex-shrink-0"
      >
        {/* Background with subtle glass effect */}
        <rect width="40" height="40" rx="10" fill="white" fillOpacity="0.15" />
        <rect width="40" height="40" rx="10" stroke="white" strokeOpacity="0.25" strokeWidth="1" />

        {/* Branching flow icon: form input -> logic branches -> outcomes */}
        <g transform="translate(8, 6)">
          {/* Branching curves (behind nodes) */}
          <path
            d="M12 9 C12 15, 5 17, 5 22"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
            opacity="0.55"
          />
          <path
            d="M12 9 C12 15, 19 17, 19 22"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
            opacity="0.55"
          />

          {/* Top rounded bar (form field / input) */}
          <rect x="3" y="0" width="18" height="9" rx="3" fill="white" fillOpacity="0.95" />
          <rect x="6" y="3.5" width="12" height="2" rx="1" fill="#6366f1" fillOpacity="0.45" />

          {/* Bottom-left node (outcome) */}
          <circle cx="5" cy="23" r="3.5" fill="white" fillOpacity="0.9" />

          {/* Bottom-right node (outcome) */}
          <circle cx="19" cy="23" r="3.5" fill="white" fillOpacity="0.9" />
        </g>
      </svg>

      {showText && (
        <span className={`font-bold text-white tracking-tight ${text}`} style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Form<span className="text-indigo-200">Logic</span>
        </span>
      )}
    </div>
  );
}
