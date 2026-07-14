/**
 * Light/dark theme for the FormLogic companion. We toggle a single `dark`
 * class on <html>; the bare `:root` in styles.css is the light default.
 * Preference persists to localStorage and falls back to the OS
 * `prefers-color-scheme` on first run.
 */
export type ThemeMode = 'light' | 'dark';

const KEY = 'formlogic-theme';
const LIGHT_THEME_COLOR = '#4f46e5';
const DARK_THEME_COLOR = '#0b1020';

function savedTheme(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function systemTheme(): ThemeMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeColor(mode: ThemeMode): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = mode === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

export function initialTheme(): ThemeMode {
  return savedTheme() ?? systemTheme();
}

export function applyTheme(mode: ThemeMode, options: { persist?: boolean } = {}): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  updateThemeColor(mode);
  const persist = options.persist ?? true;
  if (!persist) return;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore persistence failures
  }
}

export function watchSystemTheme(onChange: (mode: ThemeMode) => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return () => {};

  const onSystemChange = (event: MediaQueryListEvent) => {
    if (savedTheme()) return;
    const mode: ThemeMode = event.matches ? 'dark' : 'light';
    applyTheme(mode, { persist: false });
    onChange(mode);
  };

  query.addEventListener('change', onSystemChange);
  return () => query.removeEventListener('change', onSystemChange);
}
