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
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="flex-shrink-0"
      >
        {/* Background rounded square */}
        <rect width="40" height="40" rx="8" fill="url(#gradient)" />

        {/* Form icon - stylized document with checkmark */}
        <g transform="translate(8, 6)">
          {/* Document outline */}
          <path
            d="M4 4C4 2.89543 4.89543 2 6 2H14L20 8V24C20 25.1046 19.1046 26 18 26H6C4.89543 26 4 25.1046 4 24V4Z"
            fill="white"
            fillOpacity="0.9"
          />
          {/* Folded corner */}
          <path
            d="M14 2V8H20L14 2Z"
            fill="white"
            fillOpacity="0.6"
          />
          {/* Lines representing form fields */}
          <rect x="7" y="12" width="10" height="2" rx="1" fill="#6366f1" fillOpacity="0.6" />
          <rect x="7" y="16" width="7" height="2" rx="1" fill="#6366f1" fillOpacity="0.6" />
          {/* Checkmark - representing logic/validation */}
          <path
            d="M9 21L11.5 23.5L15.5 19.5"
            stroke="#6366f1"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* Code brackets - representing scripting */}
        <g transform="translate(26, 22)">
          <path
            d="M2 4L0 6L2 8"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.8"
          />
          <path
            d="M6 4L8 6L6 8"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.8"
          />
        </g>

        <defs>
          <linearGradient id="gradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6366f1" />
            <stop offset="1" stopColor="#4f46e5" />
          </linearGradient>
        </defs>
      </svg>

      {showText && (
        <span className={`font-semibold text-gray-900 ${text}`}>
          Form<span className="text-primary-600">Logic</span>
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
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="flex-shrink-0"
      >
        {/* Background rounded square */}
        <rect width="40" height="40" rx="8" fill="white" fillOpacity="0.15" />
        <rect width="40" height="40" rx="8" stroke="white" strokeOpacity="0.3" strokeWidth="1" />

        {/* Form icon - stylized document with checkmark */}
        <g transform="translate(8, 6)">
          {/* Document outline */}
          <path
            d="M4 4C4 2.89543 4.89543 2 6 2H14L20 8V24C20 25.1046 19.1046 26 18 26H6C4.89543 26 4 25.1046 4 24V4Z"
            fill="white"
            fillOpacity="0.9"
          />
          {/* Folded corner */}
          <path
            d="M14 2V8H20L14 2Z"
            fill="white"
            fillOpacity="0.6"
          />
          {/* Lines representing form fields */}
          <rect x="7" y="12" width="10" height="2" rx="1" fill="#6366f1" fillOpacity="0.7" />
          <rect x="7" y="16" width="7" height="2" rx="1" fill="#6366f1" fillOpacity="0.7" />
          {/* Checkmark - representing logic/validation */}
          <path
            d="M9 21L11.5 23.5L15.5 19.5"
            stroke="#6366f1"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* Code brackets - representing scripting */}
        <g transform="translate(26, 22)">
          <path
            d="M2 4L0 6L2 8"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
          <path
            d="M6 4L8 6L6 8"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
        </g>
      </svg>

      {showText && (
        <span className={`font-semibold text-white ${text}`}>
          Form<span className="text-indigo-300">Logic</span>
        </span>
      )}
    </div>
  );
}
