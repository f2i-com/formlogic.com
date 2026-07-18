// Shared theming for the sandboxed custom-screen runtimes (app + form). Screens get a standard CSS
// variable palette that flips with the viewer's light/dark mode, plus a tiny shim that toggles the
// `fl-dark` root class when the parent posts a theme change (so toggling is instant, no reload).
//
// Screens should build their UI on these variables so they adapt automatically:
//   --fl-bg        page background
//   --fl-surface   card surface        --fl-surface-2  subtle inner surface
//   --fl-border    hairline border     --fl-track      progress/bar track
//   --fl-text      primary text        --fl-muted      secondary text   --fl-faint  tertiary text
//   --fl-accent    the app/form accent (owner-chosen)  --fl-accent-contrast  on-accent text
//   --fl-good / --fl-warn / --fl-bad   semantic status colors
//   --fl-shadow    card shadow

/** Palette CSS. `accent` is the owner's primary colour; `onAccent` is a legible on-accent text colour. */
export function screenPaletteCss(accent: string, onAccent: string): string {
  const a = /^#|rgb|hsl/.test(accent) ? accent : '#6366f1';
  return (
    ':root{'
    + '--fl-bg:#f5f7fb;--fl-surface:#ffffff;--fl-surface-2:#f1f5f9;--fl-border:rgba(15,23,42,.10);'
    + '--fl-text:#0f172a;--fl-muted:#475569;--fl-faint:#8a97a8;--fl-track:rgba(15,23,42,.08);'
    + '--fl-accent:' + a + ';--fl-accent-contrast:' + (onAccent || '#ffffff') + ';'
    + '--fl-good:#16a34a;--fl-warn:#d97706;--fl-bad:#dc2626;--fl-shadow:0 1px 2px rgba(15,23,42,.06);'
    + '}'
    + 'html.fl-dark{'
    + '--fl-bg:#0b1220;--fl-surface:rgba(255,255,255,.04);--fl-surface-2:rgba(255,255,255,.03);--fl-border:rgba(255,255,255,.09);'
    + '--fl-text:#e8edf5;--fl-muted:#93a1b8;--fl-faint:#64748b;--fl-track:rgba(255,255,255,.07);'
    + '--fl-good:#34d399;--fl-warn:#fbbf24;--fl-bad:#f87171;--fl-shadow:0 1px 2px rgba(0,0,0,.35);'
    + '}'
    // Native widget chrome (select POPUPS, scrollbars, date pickers) follows
    // CSS color-scheme, not the token palette — without this the app's dark
    // theme over a light OS rendered a white option list with --fl-text white
    // text (live report 2026-07-18, Receptionist Settings dropdowns). The CSS
    // property beats the runtime's <meta color-scheme> and flips live with
    // the fl-dark class.
    + 'html{color-scheme:light;}html.fl-dark{color-scheme:dark;}'
    + 'html,body{background:var(--fl-bg);color:var(--fl-text);}'
    + '*{scrollbar-color:var(--fl-faint) transparent;}'
  );
}

/** Injected into the iframe: flips the `fl-dark` root class when the parent posts { __flTheme }. */
export const SCREEN_THEME_SHIM =
  '(function(){window.addEventListener("message",function(e){var m=e.data;if(!m||!m.__flTheme)return;'
  + 'document.documentElement.classList.toggle("fl-dark",m.__flTheme==="dark");});})();';
