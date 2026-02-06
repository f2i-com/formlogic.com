import { useMemo } from 'react';
import type { AppTheme } from '../../types/app';
import { DEFAULT_APP_THEME } from '../../types/app';

interface AppRuntimeThemeProviderProps {
  theme?: Partial<AppTheme>;
  children: React.ReactNode;
}

export function AppRuntimeThemeProvider({ theme, children }: AppRuntimeThemeProviderProps) {
  const mergedTheme = useMemo(() => ({ ...DEFAULT_APP_THEME, ...theme }), [theme]);

  const style = useMemo(() => ({
    '--app-primary': mergedTheme.primaryColor,
    '--app-bg': mergedTheme.backgroundColor,
    '--app-text': mergedTheme.textColor,
    '--app-font': mergedTheme.fontFamily,
  } as React.CSSProperties), [mergedTheme]);

  return (
    <div style={style} className="min-h-screen" data-app-runtime>
      <style>{`
        [data-app-runtime] {
          font-family: var(--app-font), system-ui, sans-serif;
          color: var(--app-text);
          background-color: var(--app-bg);
        }
        [data-app-runtime] .app-btn-primary {
          background-color: var(--app-primary);
        }
        [data-app-runtime] .app-btn-primary:hover {
          filter: brightness(0.9);
        }
        [data-app-runtime] .app-text-primary {
          color: var(--app-primary);
        }
        [data-app-runtime] .app-border-primary {
          border-color: var(--app-primary);
        }
        [data-app-runtime] .app-bg-primary-light {
          background-color: color-mix(in srgb, var(--app-primary) 10%, transparent);
        }
      `}</style>
      {children}
    </div>
  );
}
