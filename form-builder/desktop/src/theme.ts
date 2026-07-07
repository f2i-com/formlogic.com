/**
 * Light/dark theme for the F2I companion — mirrors the web app's cartographic
 * palette. We toggle a single `dark` class on <html>; the bare `:root` in
 * styles.css is the light default. Preference persists to localStorage and
 * falls back to the OS `prefers-color-scheme` on first run.
 */
export type ThemeMode = 'light' | 'dark';

const KEY = 'f2i-theme';

export function initialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage may be unavailable; fall through to system preference
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore persistence failures
  }
}
