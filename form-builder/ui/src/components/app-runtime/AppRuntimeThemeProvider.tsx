import { useMemo } from 'react';
import type { AppTheme } from '../../types/app';
import { DEFAULT_APP_THEME } from '../../types/app';
import { readableForegroundColor } from '../../lib/color';

interface AppRuntimeThemeProviderProps {
  theme?: Partial<AppTheme>;
  children: React.ReactNode;
}

export function AppRuntimeThemeProvider({ theme, children }: AppRuntimeThemeProviderProps) {
  const mergedTheme = useMemo(() => ({ ...DEFAULT_APP_THEME, ...theme }), [theme]);

  // Derive a foreground that stays legible on the owner-chosen accent, so a
  // light/pastel primary doesn't produce unreadable white-on-light buttons.
  const onPrimary = useMemo(
    () => readableForegroundColor(mergedTheme.primaryColor),
    [mergedTheme.primaryColor]
  );

  const style = useMemo(() => ({
    '--app-primary': mergedTheme.primaryColor,
    '--app-on-primary': onPrimary,
    '--app-font': mergedTheme.fontFamily,
  } as React.CSSProperties), [mergedTheme, onPrimary]);

  return (
    <div style={style} className="min-h-screen" data-app-runtime>
      <style>{`
        [data-app-runtime] {
          font-family: var(--app-font), system-ui, sans-serif;
        }
        [data-app-runtime] .app-btn-primary {
          background-color: var(--app-primary);
          color: var(--app-on-primary);
        }
        [data-app-runtime] .app-btn-primary:hover {
          filter: brightness(0.92);
        }
        [data-app-runtime] .app-text-primary {
          color: var(--app-primary);
        }
        [data-app-runtime] .app-bg-primary {
          background-color: var(--app-primary);
        }
        [data-app-runtime] .app-border-primary {
          border-color: var(--app-primary);
        }
        [data-app-runtime] .app-bg-primary-light {
          background-color: color-mix(in srgb, var(--app-primary) 10%, transparent);
        }
        /* Theme-aware focus ring so keyboard focus uses the app accent, not shell indigo. */
        [data-app-runtime] .app-ring-primary {
          --tw-ring-color: color-mix(in srgb, var(--app-primary) 55%, transparent);
        }
        [data-app-runtime] .app-accent { accent-color: var(--app-primary); }
      `}</style>
      {children}
    </div>
  );
}
