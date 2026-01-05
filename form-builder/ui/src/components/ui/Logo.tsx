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

        {/* Simple form/document icon centered */}
        <g transform="translate(10, 8)">
          {/* Document body */}
          <rect
            x="2"
            y="0"
            width="16"
            height="24"
            rx="3"
            fill="white"
            fillOpacity="0.95"
          />

          {/* Form lines */}
          <rect x="5" y="5" width="10" height="2" rx="1" fill="#6366f1" fillOpacity="0.4" />
          <rect x="5" y="10" width="7" height="2" rx="1" fill="#6366f1" fillOpacity="0.4" />

          {/* Checkmark circle */}
          <circle cx="10" cy="18" r="4" fill="#6366f1" fillOpacity="0.15" />
          <path
            d="M7.5 18L9 19.5L12.5 16"
            stroke="#6366f1"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        <defs>
          <linearGradient id="logoGradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#818cf8" />
            <stop offset="1" stopColor="#6366f1" />
          </linearGradient>
        </defs>
      </svg>

      {showText && (
        <span className={`font-semibold text-gray-900 dark:text-white tracking-tight ${text}`}>
          Form<span className="text-primary-600 dark:text-indigo-400">Logic</span>
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

        {/* Simple form/document icon centered */}
        <g transform="translate(10, 8)">
          {/* Document body */}
          <rect
            x="2"
            y="0"
            width="16"
            height="24"
            rx="3"
            fill="white"
            fillOpacity="0.95"
          />

          {/* Form lines */}
          <rect x="5" y="5" width="10" height="2" rx="1" fill="#6366f1" fillOpacity="0.5" />
          <rect x="5" y="10" width="7" height="2" rx="1" fill="#6366f1" fillOpacity="0.5" />

          {/* Checkmark circle */}
          <circle cx="10" cy="18" r="4" fill="#6366f1" fillOpacity="0.2" />
          <path
            d="M7.5 18L9 19.5L12.5 16"
            stroke="#6366f1"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>

      {showText && (
        <span className={`font-semibold text-white tracking-tight ${text}`}>
          Form<span className="text-indigo-200">Logic</span>
        </span>
      )}
    </div>
  );
}
